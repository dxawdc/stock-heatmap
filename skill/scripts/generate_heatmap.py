#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A股热力树图数据生成脚本（复刻 stock-heatmap 仓库 web/app.py 核心逻辑）。

从腾讯财经公开行情接口拉取沪深北全市场行情，按【申万一级行业】分组（新增），
或按交易所板块分组、或平铺，生成热力图树图 JSON。输出 JSON 由
assets/template.html 渲染为可交互 Plotly Treemap。

依赖：仅标准库 + requests（可选，若缺失则回退 urllib）。
申万行业映射 + 行业实时涨跌幅直连申万官网（swsresearch.com），磁盘缓存 24h；
失败时自动退回交易所板块分组。

新增能力：
  1. 申万行业分组（--group-by sw）
  2. 多维度组合筛选（--include / --exclude）：
     ST（ST/*ST 股）、KCB（科创板）、CYB（创业板）、BSE（北交所）、
     SH（沪主板）、SZ（深主板）

用法：
    python generate_heatmap.py [--top-n N] [--group-by sw|board|none]
                               [--size-by vol|mktcap|float_cap]
                               [--include ST,KCB] [--exclude ST]
                               [--sector-cache PATH] [--out PATH]
"""
import argparse
import concurrent.futures as cf
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta

try:
    import requests
except ImportError:
    requests = None

# ── 常量 ──────────────────────────────────────────────────────────
TENCENT_URL = "https://qt.gtimg.cn/q={}"
TENCENT_HDR = {"Referer": "https://finance.qq.com", "User-Agent": "Mozilla/5.0"}

# 申万官网接口
SW_HDR = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.swsresearch.com/"}
SW_L1_LIST_URL = ("https://www.swsresearch.com/institute-sw/api/index_publish/current/"
                  "?indextype=%E4%B8%80%E7%BA%A7%E8%A1%8C%E4%B8%9A&page=1&page_size=100")
SW_COMPONENTS_URL = ("https://www.swsresearch.com/institute-sw/api/index_publish/"
                     "details/component_stocks/?swindexcode={}&page=1&page_size=10000")

SIZE_LABELS = {
    "vol": ("成交额", "万元"),
    "mktcap": ("总市值", "亿元"),
    "float_cap": ("流通市值", "亿元"),
}

# 腾讯行情字段索引（以 ~ 分隔）
F_NAME = 1       # 名称
F_CHG = 32       # 涨跌幅 %
F_VOL = 37       # 成交额（万元）
F_FLOAT_CAP = 44 # 流通市值（亿元）
F_MKT_CAP = 45   # 总市值（亿元）

# 市场交易时段
OPEN_AM = (9, 25)
CLOSE_AM = (11, 31)
OPEN_PM = (13, 0)
CLOSE_PM = (15, 1)

SECTOR_CACHE_TTL = 86400  # 24h

# 筛选维度 → 中文名（供标题/展示）
FILTER_DIMENSIONS = {
    "ST":  "ST股",
    "KCB": "科创板",
    "CYB": "创业板",
    "BSE": "北交所",
    "SH":  "沪主板",
    "SZ":  "深主板",
}

# 默认缓存路径（脚本同级）
DEFAULT_SECTOR_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    "sector_map.json")


def _http_get(url, headers, encoding=None, timeout=15):
    """requests 优先，缺失时回退 urllib。"""
    if requests is not None:
        r = requests.get(url, headers=headers, timeout=timeout)
        if encoding:
            r.encoding = encoding
        return r.text
    import urllib.request
    req = urllib.request.Request(url, headers=headers)
    data = urllib.request.urlopen(req, timeout=timeout).read()
    return data.decode(encoding or "utf-8", errors="replace")


def _http_get_json(url, headers=SW_HDR, timeout=15):
    try:
        text = _http_get(url, headers, timeout=timeout)
        return json.loads(text)
    except Exception:
        return None


# ── 市场时间工具 ──────────────────────────────────────────────────
def _hm():
    n = datetime.now()
    return n, (n.hour, n.minute)


def is_market_open():
    """A股是否正在交易（仅排除周末，未接交易日历）。"""
    n, (h, m) = _hm()
    if n.weekday() >= 5:
        return False
    t = (h, m)
    return (OPEN_AM <= t <= CLOSE_AM) or (OPEN_PM <= t <= CLOSE_PM)


def current_trading_date():
    """当前所属交易日 YYYY-MM-DD（开盘前/非交易日回退）。"""
    n, (h, m) = _hm()
    d = n.date()
    if (h, m) < (9, 30):
        d -= timedelta(days=1)
    while d.weekday() >= 5:  # 回退到最近工作日
        d -= timedelta(days=1)
    return d.isoformat()


def normalize_code(code):
    """sh600519 → 600519"""
    return re.sub(r"^(sh|sz|bj)", "", str(code))


def get_board(code):
    """交易所板块分类。"""
    c = normalize_code(code)
    if c.startswith("688"):
        return "科创板"
    if c.startswith("300") or c.startswith("301"):
        return "创业板"
    if c.startswith("002") or c.startswith("003"):
        return "中小板"
    if c.startswith("60"):
        return "沪市主板"
    if c.startswith("000") or c.startswith("001"):
        return "深市主板"
    if _is_bse(c):
        return "北交所"
    return "其他"


def _is_bse(c):
    """北交所代码判断：43/83/87/88 开头（老）+ 920 开头（2024 新）。"""
    return (c.startswith(("43", "83", "87", "88")) or c.startswith("920"))


def classify(row):
    """
    给一行行情数据打筛选标签。
    返回维度 key 集合，如 {'ST','CYB'} 表示该股既是 ST 又属创业板。
    """
    code = normalize_code(row["code"])
    name = row.get("name", "")
    tags = set()

    # ST 判断（名称含 ST / *ST / S 前缀，含退市整理 N 等可扩展）
    upper = name.upper()
    if "ST" in upper or name.startswith("S") or "退" in name:
        tags.add("ST")

    if code.startswith("688"):
        tags.add("KCB")
    elif code.startswith("300") or code.startswith("301"):
        tags.add("CYB")
    elif _is_bse(code):
        tags.add("BSE")
    elif code.startswith("60"):
        tags.add("SH")
    elif code.startswith("000") or code.startswith("001") \
            or code.startswith("002") or code.startswith("003"):
        tags.add("SZ")

    return tags


def apply_filters(rows, include, exclude):
    """
    按 include（并集，包含即保留）与 exclude（排除）筛选。
    include 为空表示不限制；exclude 优先于 include。
    返回筛选后的 rows 与筛选描述文本。
    """
    inc = set(include) if include else set()
    exc = set(exclude) if exclude else set()

    def keep(row):
        tags = row["_tags"]
        if exc and (tags & exc):
            return False
        if inc and not (tags & inc):
            return False
        return True

    result = [r for r in rows if keep(r)]
    desc_parts = []
    if inc:
        desc_parts.append("包含[" + "+".join(FILTER_DIMENSIONS.get(k, k) for k in sorted(inc)) + "]")
    if exc:
        desc_parts.append("排除[" + "+".join(FILTER_DIMENSIONS.get(k, k) for k in sorted(exc)) + "]")
    return result, (" & ".join(desc_parts) if desc_parts else "全市场")


# ── 股票代码列表 ─────────────────────────────────────────────────
def get_code_list():
    """
    返回沪深北全市场代码列表（含 sh/sz/bj 前缀）。

    完整、精确的代码列表需通过交易所官方接口或 akshare 获取
    （见 references/implementation.md 第 2.4 节）。脚本版为降低依赖，
    用交易所板块代码段近似构造全市场代码区间，交给腾讯行情接口批量拉取；
    不存在的代码腾讯会返回空数据、在解析时被自然过滤掉，不影响正确性。
    """
    return _build_fallback_codes()


def _build_fallback_codes():
    """构造近似全市场代码列表（含前缀）。"""
    codes = []
    # 沪市主板 600xxx / 601xxx / 603xxx / 605xxx
    for prefix in ("600", "601", "603", "605"):
        codes += [f"sh{prefix}{i:03d}" for i in range(1000)]
    # 科创板 688xxx
    codes += [f"sh688{i:03d}" for i in range(1000)]
    # 深市主板 000xxx / 001xxx / 002xxx / 003xxx
    for prefix in ("000", "001", "002", "003"):
        codes += [f"sz{prefix}{i:03d}" for i in range(1000)]
    # 创业板 300xxx / 301xxx
    for prefix in ("300", "301"):
        codes += [f"sz{prefix}{i:03d}" for i in range(1000)]
    # 北交所：老代码 43/83/87/88 开头 + 2024 年新代码 920 开头
    for prefix in ("43", "83", "87", "88"):
        codes += [f"bj{prefix}{i:04d}" for i in range(10000)]
    codes += [f"bj920{i:03d}" for i in range(1000)]
    return codes


# ── 申万行业映射与涨跌幅 ─────────────────────────────────────────
def _fetch_sw_l1_list():
    """拉取申万一级行业列表，返回 [{code,name,chg}]。"""
    j = _http_get_json(SW_L1_LIST_URL)
    if not j:
        return []
    results = j.get("data", {}).get("results") or j.get("results") or []
    out = []
    for r in results:
        code = str(r.get("swindexcode", "")).strip()
        name = str(r.get("swindexname", "")).strip()
        if not code or not name:
            continue
        # 涨跌幅 = (最新 l6 - 昨收 l4) / 昨收 l4
        chg = 0.0
        try:
            close = float(r.get("l6"))
            preclose = float(r.get("l4"))
            if preclose:
                chg = (close - preclose) / preclose
        except (TypeError, ValueError):
            chg = 0.0
        out.append({"code": code, "name": name, "chg": chg})
    return out


def _fetch_sw_components(sw_code):
    """拉取某申万一级行业的成分股代码列表。"""
    j = _http_get_json(SW_COMPONENTS_URL.format(sw_code))
    if not j:
        return []
    results = j.get("data", {}).get("results") or j.get("results") or []
    codes = []
    for r in results:
        c = str(r.get("stockcode", "")).strip().zfill(6)
        if re.fullmatch(r"\d{6}", c):
            codes.append(c)
    return codes


def build_sector_map(cache_path=DEFAULT_SECTOR_CACHE):
    """
    构建 code_clean → 申万一级行业名 的映射，并返回行业涨跌幅表。
    磁盘缓存 24h；失败返回 ({}, {}) 由调用方退回交易所板块分组。
    返回 (mapping: dict[str,str], sector_chg: dict[str,float])。
    """
    # 读缓存
    if cache_path and os.path.exists(cache_path):
        try:
            data = json.loads(open(cache_path, encoding="utf-8").read())
            if time.time() - data.get("ts", 0) < SECTOR_CACHE_TTL:
                return data.get("map", {}), data.get("chg", {})
        except Exception:
            pass

    l1 = _fetch_sw_l1_list()
    if not l1:
        return {}, {}

    mapping = {}
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(_fetch_sw_components, ind["code"]): ind
                   for ind in l1}
        for fut in cf.as_completed(futures):
            ind = futures[fut]
            try:
                codes = fut.result()
            except Exception:
                codes = []
            for c in codes:
                mapping[c] = ind["name"]

    sector_chg = {ind["name"]: ind["chg"] for ind in l1}

    # 写缓存
    if cache_path:
        try:
            payload = {"ts": time.time(), "map": mapping, "chg": sector_chg}
            json.dump(payload, open(cache_path, "w", encoding="utf-8"),
                      ensure_ascii=False)
        except Exception:
            pass

    return mapping, sector_chg


# ── 腾讯行情拉取 ─────────────────────────────────────────────────
def _parse_tencent_batch(text):
    """解析腾讯批量行情返回文本。"""
    results = []
    for line in text.split(";"):
        line = line.strip()
        if not line:
            continue
        m = re.match(r'v_(\w+)="(.+)"', line)
        if not m:
            continue
        f = m.group(2).split("~")
        if len(f) < 46:
            continue
        try:
            vol = float(f[F_VOL]) if f[F_VOL] else 0.0
            if vol <= 0:  # 停牌/未交易
                continue
            chg = float(f[F_CHG]) if f[F_CHG] else 0.0
            mktcap = float(f[F_MKT_CAP]) if f[F_MKT_CAP] else 0.0
            float_cap = float(f[F_FLOAT_CAP]) if f[F_FLOAT_CAP] else 0.0
            if mktcap <= 0:  # 数据异常
                continue
            results.append({
                "code": m.group(1),
                "name": f[F_NAME],
                "chg": chg,
                "vol": vol,
                "mktcap": mktcap,
                "float_cap": float_cap,
            })
        except (ValueError, IndexError):
            pass
    return results


def fetch_tencent_batch(codes):
    """拉取一批（最多 200 只）腾讯行情。"""
    try:
        text = _http_get(TENCENT_URL.format(",".join(codes)),
                         TENCENT_HDR, encoding="gbk")
        return _parse_tencent_batch(text)
    except Exception:
        return []


def fetch_stock_data():
    """并发拉取全量行情，返回 (rows, total_count)。"""
    codes = get_code_list()
    if not codes:
        raise RuntimeError("股票代码列表为空，请稍后重试")

    batches = [codes[i:i + 200] for i in range(0, len(codes), 200)]
    all_rows = []
    with cf.ThreadPoolExecutor(max_workers=10) as ex:
        for rows in ex.map(fetch_tencent_batch, batches):
            all_rows.extend(rows)

    if not all_rows:
        raise RuntimeError("腾讯行情 API 未返回数据")

    for row in all_rows:
        row["code_clean"] = normalize_code(row["code"])
        row["chg_rate"] = row["chg"] / 100
        row["_tags"] = classify(row)

    return all_rows, len(all_rows)


def fetch_market_index():
    """大盘指数 sh000002 涨跌幅（返回小数，如 0.0123）。"""
    try:
        rows = fetch_tencent_batch(["sh000002"])
        if rows:
            return rows[0]["chg"] / 100
    except Exception:
        pass
    return None


# ── 核心：构建热力图数据 ───────────────────────────────────────────
def _build_grouped_children(rows, group_key_fn, sector_chg):
    """
    通用分组：按 group_key_fn(row) 分组，返回 children 列表。
    板块涨跌幅优先取 sector_chg（官方指数），否则加权均值。
    """
    groups = {}
    for row in rows:
        key = group_key_fn(row)
        groups.setdefault(key, []).append(row)

    children = []
    for name, group_rows in groups.items():
        stocks = []
        for r in group_rows:
            stocks.append({
                "n": r["name"], "c": r["code"],
                "v": round(r["sz"], 2), "g": round(r["chg_rate"], 5),
                "vol": round(r["vol"], 2),
                "mktcap": round(r["mktcap"], 2),
                "float_cap": round(r["float_cap"], 2),
            })
        sv = sum(s["v"] for s in stocks)
        # 官方行业指数优先
        if name in sector_chg:
            sg = sector_chg[name]
            sg_src = "申万指数"
        else:
            sg = sum(s["g"] * s["v"] for s in stocks) / sv if sv > 0 else 0
            sg_src = "加权均值"
        sec_vol = sum(s["vol"] for s in stocks)
        sec_mktcap = sum(s["mktcap"] for s in stocks)
        children.append({
            "n": name, "v": round(sv, 2), "g": round(sg, 5),
            "cnt": len(stocks), "src": sg_src,
            "vol": round(sec_vol, 2), "mktcap": round(sec_mktcap, 2),
            "children": stocks,
        })
    # 按成交额降序排列板块
    children.sort(key=lambda c: -c["vol"])
    return children


def build_frontend_payload(sector_cache=None):
    """
    构建「前端数据包」：输出全量股票明细 + 申万映射 + 行业涨跌幅，
    由 assets/template.html 在浏览器里实时完成筛选/分组/top-N/色块切换。
    这是 --html 模式的默认输出，让筛选器直接内嵌到 HTML 页面。
    """
    with cf.ThreadPoolExecutor(max_workers=3) as ex:
        f_stocks = ex.submit(fetch_stock_data)
        f_index = ex.submit(fetch_market_index)
        f_sw = ex.submit(build_sector_map, sector_cache or DEFAULT_SECTOR_CACHE)
        rows, market_count = f_stocks.result()
        market_chg = f_index.result()
        sector_map, sector_chg = f_sw.result()

    # 全量股票明细（前端据此筛选/分组/截断）
    stocks = []
    for r in rows:
        stocks.append({
            "c": r["code"],                       # 带前缀代码
            "cc": r["code_clean"],                # 纯净代码
            "n": r["name"],
            "chg": round(r["chg_rate"], 5),       # 涨跌幅（小数）
            "vol": round(r["vol"], 2),            # 成交额（万元）
            "mktcap": round(r["mktcap"], 2),      # 总市值（亿元）
            "float_cap": round(r["float_cap"], 2),# 流通市值（亿元）
            "board": get_board(r["code"]),        # 交易所板块
            "sector": sector_map.get(r["code_clean"]) or get_board(r["code"]),  # 申万行业（兜底板块）
            "tags": sorted(r["_tags"]),           # 筛选标签
        })

    td = current_trading_date()
    now = datetime.now()
    return {
        "mode": "frontend",
        "trading_date": td,
        "generated_at": now.strftime("%Y-%m-%d %H:%M:%S"),
        "market_status": "open" if is_market_open() else "closed",
        "market_count": market_count,
        "market_chg": market_chg,                 # 大盘指数涨跌幅（小数）
        "sector_map": sector_map,                 # code_clean → 申万行业
        "sector_chg": sector_chg,                 # 行业名 → 涨跌幅（官方指数）
        "stocks": stocks,                         # 全量股票明细
    }


def build_heatmap_data(top_n, group_by, size_by, include=None, exclude=None,
                       sector_cache=None):
    size_label, size_unit = SIZE_LABELS.get(size_by, ("成交额", "万元"))

    # 3 路并发：行情 + 大盘指数 + 申万映射/涨跌
    with cf.ThreadPoolExecutor(max_workers=3) as ex:
        f_stocks = ex.submit(fetch_stock_data)
        f_index = ex.submit(fetch_market_index)
        f_sw = ex.submit(build_sector_map, sector_cache or DEFAULT_SECTOR_CACHE)
        rows, market_count = f_stocks.result()
        market_chg_index = f_index.result()
        sector_map, sector_chg = f_sw.result()

    # 筛选（含 top_n 之前的原始全量筛选）
    rows, filter_desc = apply_filters(rows, include, exclude)
    filtered_total = len(rows)

    # 按 size_by 排序截取 top_n
    sort_col = {"vol": "vol", "mktcap": "mktcap", "float_cap": "float_cap"}.get(size_by, "vol")
    if top_n > 0:
        rows = sorted(rows, key=lambda r: r[sort_col], reverse=True)[:top_n]

    n_stocks = len(rows)
    if n_stocks == 0:
        raise RuntimeError("筛选后无符合条件的股票，请调整筛选条件")

    # 根节点涨跌幅：大盘指数（备用等权均值）
    if market_chg_index is not None:
        root_chg = market_chg_index
        root_chg_src = "A股指数(sh000002)"
    else:
        root_chg = sum(r["chg_rate"] for r in rows) / len(rows)
        root_chg_src = "等权均值"

    for row in rows:
        row["sz"] = round(row[size_by], 2)

    def stock_node(row):
        return {
            "n": row["name"], "c": row["code"],
            "v": round(row["sz"], 2), "g": round(row["chg_rate"], 5),
            "vol": round(row["vol"], 2),
            "mktcap": round(row["mktcap"], 2),
            "float_cap": round(row["float_cap"], 2),
        }

    if group_by == "sw":
        # 申万一级行业分组（映射未就绪时退回交易所板块）
        if sector_map:
            children = _build_grouped_children(
                rows,
                lambda r: sector_map.get(r["code_clean"]) or get_board(r["code"]),
                sector_chg)
            group_desc = "申万一级行业"
        else:
            children = _build_grouped_children(rows, lambda r: get_board(r["code"]), {})
            group_desc = "交易所板块（申万映射获取失败，已降级）"
    elif group_by == "board":
        children = _build_grouped_children(rows, lambda r: get_board(r["code"]), {})
        group_desc = "交易所板块"
    else:
        children = [stock_node(row) for row in rows]
        group_desc = "平铺（不分组）"

    title_meta = {
        "size_label": size_label, "top_n": top_n,
        "n_shown": n_stocks, "group_desc": group_desc,
        "filter_desc": filter_desc, "filtered_total": filtered_total,
    }

    total_v = sum(c["v"] for c in children)
    total_vol = sum(c["vol"] for c in children)
    total_mkt = sum(c["mktcap"] for c in children)

    td = current_trading_date()
    now = datetime.now()

    return {
        "title_meta": title_meta,
        "size_by": size_by,
        "size_label": size_label,
        "size_unit": size_unit,
        "root": {
            "n": "A股", "v": round(total_v, 2), "g": round(root_chg, 5),
            "cnt": market_count, "src": root_chg_src,
            "vol": round(total_vol, 2), "mktcap": round(total_mkt, 2),
            "children": children,
        },
        "group_by": group_by,
        "trading_date": td,
        "generated_at": now.strftime("%Y-%m-%d %H:%M:%S"),
        "market_status": "open" if is_market_open() else "closed",
    }


def _parse_list(s):
    """解析逗号分隔的维度列表，统一大写。"""
    if not s:
        return []
    return [x.strip().upper() for x in s.split(",") if x.strip()]


def _render_html(payload):
    """把前端数据包注入 template.html，返回完整 HTML 字符串。"""
    tpl_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "..", "assets", "template.html")
    if not os.path.exists(tpl_path):
        raise RuntimeError(f"模板文件不存在: {tpl_path}")
    tpl = open(tpl_path, encoding="utf-8").read()
    return tpl.replace("__HEATMAP_DATA__", json.dumps(payload, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description="生成 A股热力树图数据 JSON / HTML")
    ap.add_argument("--top-n", type=int, default=500, help="取前 N 只（0=全部），默认 500（仅 JSON 模式生效）")
    ap.add_argument("--group-by", choices=["sw", "board", "none"], default="sw",
                    help="分组方式：sw=申万行业 board=交易所板块 none=平铺（仅 JSON 模式生效）")
    ap.add_argument("--size-by", choices=["vol", "mktcap", "float_cap"], default="vol")
    ap.add_argument("--include", type=str, default=None,
                    help="包含筛选（并集），逗号分隔，可选 ST/KCB/CYB/BSE/SH/SZ")
    ap.add_argument("--exclude", type=str, default=None,
                    help="排除筛选，逗号分隔，可选 ST/KCB/CYB/BSE/SH/SZ")
    ap.add_argument("--sector-cache", type=str, default=None,
                    help="申万行业映射缓存文件路径（默认脚本同级 sector_map.json）")
    ap.add_argument("--html", action="store_true",
                    help="直接输出带交互筛选器的 HTML（前端数据包模式，推荐）")
    ap.add_argument("--out", default="heatmap.json", help="输出路径（--html 时建议 .html）")
    args = ap.parse_args()

    include = _parse_list(args.include)
    exclude = _parse_list(args.exclude)

    if args.html:
        # 前端数据包模式：输出全量数据，筛选/分组/top-N 全在浏览器端交互
        print("拉取 A股全量行情，生成交互式 HTML（筛选器内嵌）...", file=sys.stderr)
        payload = build_frontend_payload(args.sector_cache)
        out = args.out if args.out != "heatmap.json" else "heatmap.html"
        html = _render_html(payload)
        with open(out, "w", encoding="utf-8") as f:
            f.write(html)
        print(f"已生成 {out}（全市场 {payload['market_count']} 只，"
              f"申万行业 {len(payload['sector_chg'])} 个，可在页面内实时筛选/分组/切换）",
              file=sys.stderr)
        print(payload["trading_date"], payload["market_status"])
        return

    # 传统 JSON 模式：脚本端完成筛选/分组/截断
    print(f"拉取 A股行情：top_n={args.top_n}, group_by={args.group_by}, "
          f"size_by={args.size_by}, include={include}, exclude={exclude} ...",
          file=sys.stderr)
    data = build_heatmap_data(args.top_n, args.group_by, args.size_by,
                              include, exclude, args.sector_cache)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"已生成 {args.out}（共 {data['root']['cnt']} 只股票，"
          f"筛选后 {data['title_meta']['filtered_total']} 只，"
          f"显示 {data['title_meta']['n_shown']} 只）", file=sys.stderr)
    print(data["trading_date"], data["market_status"])


if __name__ == "__main__":
    main()
