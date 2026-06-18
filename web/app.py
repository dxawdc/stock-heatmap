import asyncio
import bisect
import json
import logging
import os
import re
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import asynccontextmanager
from datetime import datetime, date, timedelta, time as dt_time
from pathlib import Path

import akshare as ak
import pandas as pd
import requests
import uvicorn
from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# ── 基准路径（绝对路径，gunicorn / systemd 任意 WorkingDirectory 均正确）──
BASE_DIR = Path(__file__).parent

# ── 日志 ──────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("stock-heatmap")

@asynccontextmanager
async def lifespan(app: FastAPI):
    """替代废弃的 on_event('startup')"""
    _load_index_html()                 # 预读首页到内存，避免请求时阻塞事件循环
    cleanup_old_cache(keep_days=5)
    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, _get_code_list)
    loop.run_in_executor(None, _build_sector_map_sync)
    loop.run_in_executor(None, _get_trade_dates)   # 预热交易日历
    yield   # 此后进入运行阶段，yield 之后为 shutdown

app = FastAPI(title="A股热力树图", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=500)

# CORS：默认放开（只读公开 API），可用环境变量 ALLOW_ORIGINS（逗号分隔）收紧
_allow_origins = [o.strip() for o in os.getenv("ALLOW_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_allow_origins,
                   allow_methods=["GET"], allow_headers=["*"])
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

# ── 首页 HTML（启动时读入内存）──────────────────────────────────────
_INDEX_HTML: str = ""


def _load_index_html() -> str:
    global _INDEX_HTML
    try:
        _INDEX_HTML = (BASE_DIR / "static" / "index.html").read_text(encoding="utf-8")
    except Exception as e:
        log.error("读取 index.html 失败: %s", e)
        _INDEX_HTML = "<h1>index.html 缺失</h1>"
    return _INDEX_HTML

# ── 常量 ──────────────────────────────────────────────────────────
TENCENT_URL = "https://qt.gtimg.cn/q={}"
TENCENT_HDR = {"Referer": "https://finance.qq.com",
               "User-Agent": "Mozilla/5.0"}

SECTOR_MAP_FILE  = BASE_DIR / "sector_map.json"
TRADE_CAL_FILE   = BASE_DIR / "cache" / "trade_calendar.json"
CACHE_DIR        = BASE_DIR / "cache"
CACHE_DIR.mkdir(exist_ok=True)

SECTOR_MAP_TTL     = 86400   # 24h
CODE_LIST_TTL      = 21600   # 6h
SW_CACHE_TTL       = 300      # 5min（行业指数实时）
MARKET_OPEN_TTL    = 120      # 2min（盘中内存缓存）
TRADE_CAL_TTL      = 86400    # 24h（交易日历）
FORCE_MIN_INTERVAL = 30       # 同一 IP 强制刷新最小间隔（秒）


def _atomic_write_json(path: Path, data) -> None:
    """原子写 JSON：先写临时文件再 rename，避免中途崩溃留下半截文件。"""
    tmp_fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise

# 磁盘缓存格式版本——修改标题/数据结构时递增，旧缓存自动失效
CACHE_VERSION    = "v4"

SIZE_LABELS = {
    "vol":        ("成交额", "万元"),
    "mktcap":     ("总市值", "亿元"),
    "float_cap":  ("流通市值", "亿元"),
}


def _render_title(meta: dict) -> str:
    """
    根据标题元信息 + 当前时间动态生成图表标题。
    时间戳/盘中状态在每次响应时实时拼接，避免缓存命中后标题显示过期信息。
    """
    now = datetime.now()
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H:%M")

    size_label = meta.get("size_label", "成交额")
    top_n      = meta.get("top_n", 0)
    n_shown    = meta.get("n_shown", 0)
    group_desc = meta.get("group_desc", "")

    # 显示范围
    if top_n == 0:
        scope = f"全部 {n_shown} 只"
    else:
        scope = f"{size_label}前 {top_n} 只（实际显示 {n_shown} 只）"

    # 市场状态
    mstat = "盘中" if is_market_open() else "闭市"

    return (
        f"A股热力树图  ·  {date_str} {time_str} {mstat}"
        f"    |    分组：{group_desc}"
        f"    |    色块大小：{size_label}"
        f"    |    显示范围：{scope}"
        f"    |    颜色：涨跌幅（板块/全市场来自官方指数）"
    )


# ── 全局缓存 ──────────────────────────────────────────────────────
_sector_map:      dict[str, str]   = {}
_sector_map_ready = False
_sector_map_building = False
_sector_map_progress = ""

_code_list:    list[str] = []
_code_list_ts: float     = 0

_sw_cache:    dict[str, float] | None = None
_sw_cache_ts: float               = 0

# 交易日历：交易日字符串集合（YYYY-MM-DD）
_trade_dates:    set[str] = set()
_trade_dates_ts: float    = 0
_trade_dates_lock = threading.Lock()

# 行业映射构建标志保护锁（避免 check-then-set 竞态）
_sector_build_lock = threading.Lock()

# force 刷新限流：IP -> 上次强制刷新时间
_force_last: dict[str, float] = {}
_force_lock = threading.Lock()

# 内存热力图缓存：key -> (timestamp, trading_date, data)
_heatmap_mem: dict[str, tuple[float, str, dict]] = {}

# single-flight：按 key 的构建锁，避免缓存 miss 时并发重复拉取全市场
_build_locks_guard = threading.Lock()
_build_locks: dict[str, threading.Lock] = {}


def _get_build_lock(key: str) -> threading.Lock:
    with _build_locks_guard:
        lock = _build_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _build_locks[key] = lock
        return lock


# ── 市场时间工具 ──────────────────────────────────────────────────

_OPEN_AM  = dt_time(9, 25)
_CLOSE_AM = dt_time(11, 31)
_OPEN_PM  = dt_time(13, 0)
_CLOSE_PM = dt_time(15, 1)


def _get_trade_dates() -> set[str]:
    """
    获取 A股交易日历（YYYY-MM-DD 字符串集合），24h 缓存到磁盘。
    数据源 akshare.tool_trade_date_hist_sina()；任何失败都返回空集合，
    调用方退回「仅排除周末」的兜底逻辑，保证日历不可用时服务仍可运行。
    """
    global _trade_dates, _trade_dates_ts
    now = time.time()
    if _trade_dates and (now - _trade_dates_ts) < TRADE_CAL_TTL:
        return _trade_dates

    with _trade_dates_lock:
        if _trade_dates and (time.time() - _trade_dates_ts) < TRADE_CAL_TTL:
            return _trade_dates

        # 1. 磁盘缓存
        if TRADE_CAL_FILE.exists() and \
           (time.time() - TRADE_CAL_FILE.stat().st_mtime) < TRADE_CAL_TTL:
            try:
                _trade_dates = set(json.loads(TRADE_CAL_FILE.read_text(encoding="utf-8")))
                _trade_dates_ts = time.time()
                return _trade_dates
            except Exception:
                pass

        # 2. 远程拉取
        try:
            df = ak.tool_trade_date_hist_sina()
            dates = {d.isoformat() if hasattr(d, "isoformat") else str(d)
                     for d in pd.to_datetime(df.iloc[:, 0]).dt.date}
            _trade_dates = dates
            _trade_dates_ts = time.time()
            _atomic_write_json(TRADE_CAL_FILE, sorted(dates))
            log.info("交易日历加载完成，共 %d 个交易日", len(dates))
        except Exception as e:
            log.warning("交易日历获取失败，退回仅排除周末逻辑: %s", e)
        return _trade_dates


def is_trading_day(d: date) -> bool:
    """指定日期是否为交易日；日历不可用时退回「非周末即交易日」。"""
    dates = _get_trade_dates()
    if dates:
        return d.isoformat() in dates
    return d.weekday() < 5


def is_market_open() -> bool:
    """A股是否正在交易（含节假日判断，日历不可用时仅排除周末）"""
    now = datetime.now()
    if not is_trading_day(now.date()):
        return False
    t = now.time()
    return (_OPEN_AM <= t <= _CLOSE_AM) or (_OPEN_PM <= t <= _CLOSE_PM)


def market_status() -> str:
    """返回 'open' | 'closed'"""
    return "open" if is_market_open() else "closed"


def _prev_trading_day(d: date) -> date:
    """返回 d 之前最近的一个交易日（最多回溯 14 天，避免长假/日历缺失死循环）。"""
    for _ in range(14):
        d -= timedelta(days=1)
        if is_trading_day(d):
            return d
    return d


def current_trading_date() -> str:
    """
    返回当前所属的 A股交易日（YYYY-MM-DD）。
    非交易日（周末/节假日）或工作日开盘前 → 回退到最近的交易日。
    交易日历不可用时退回「仅排除周末」逻辑。
    """
    now = datetime.now()
    today = now.date()
    t = now.time()

    # 今天不是交易日（周末/节假日）→ 最近交易日
    if not is_trading_day(today):
        return _prev_trading_day(today).isoformat()

    # 交易日 09:30 之前 → 前一交易日
    if t < dt_time(9, 30):
        return _prev_trading_day(today).isoformat()

    return today.isoformat()


def disk_cache_path(top_n: int, group_by: str, size_by: str, td: str) -> Path:
    return CACHE_DIR / f"heatmap_{td}_{top_n}_{group_by}_{size_by}.json"


def cleanup_old_cache(keep_days: int = 5) -> None:
    """清理超过 keep_days 天的旧缓存文件"""
    cutoff = date.today() - timedelta(days=keep_days)
    for f in CACHE_DIR.glob("heatmap_*.json"):
        try:
            # 文件名格式: heatmap_YYYY-MM-DD_...json
            date_str = f.stem.split("_")[1]
            if date.fromisoformat(date_str) < cutoff:
                f.unlink()
        except Exception:
            pass


# ── 工具函数 ──────────────────────────────────────────────────────

def normalize_code(code: str) -> str:
    """sh600519 → 600519"""
    return re.sub(r"^(sh|sz|bj)", "", str(code))


def get_board_fallback(code: str) -> str:
    c = normalize_code(code)
    if c.startswith("688"):                        return "科创板"
    if c.startswith("300") or c.startswith("301"): return "创业板"
    if c.startswith("002") or c.startswith("003"): return "中小板"
    if c.startswith("60"):                         return "沪市主板"
    if c.startswith("000") or c.startswith("001"): return "深市主板"
    if c.startswith("4") or c.startswith("8"):     return "北交所"
    return "其他"


# ── 申万行业映射（后台初始化，每日缓存到磁盘）────────────────────

def _fetch_one_sector(args):
    code, name = args
    try:
        df = ak.index_component_sw(symbol=code)
        return name, [str(c).zfill(6) for c in df.iloc[:, 1].tolist()]
    except Exception:
        return name, []


def _build_sector_map_sync():
    global _sector_map, _sector_map_ready, _sector_map_building, _sector_map_progress
    with _sector_build_lock:
        if _sector_map_building:
            return
        _sector_map_building = True
    try:
        if SECTOR_MAP_FILE.exists() and (time.time() - SECTOR_MAP_FILE.stat().st_mtime) < SECTOR_MAP_TTL:
            _sector_map = json.loads(SECTOR_MAP_FILE.read_text(encoding="utf-8"))
            _sector_map_ready = True
            _sector_map_progress = f"已从缓存加载 {len(_sector_map)} 只股票行业映射"
            return

        _sector_map_progress = "正在获取申万一级行业列表..."
        sw = ak.sw_index_first_info()
        codes = [str(c).replace(".SI", "") for c in sw.iloc[:, 0]]
        names = [str(n) for n in sw.iloc[:, 1]]

        mapping: dict[str, str] = {}
        done = 0
        with ThreadPoolExecutor(max_workers=8) as ex:
            futures = {ex.submit(_fetch_one_sector, (c, n)): n for c, n in zip(codes, names)}
            for f in as_completed(futures):
                done += 1
                name, stock_codes = f.result()
                for sc in stock_codes:
                    mapping[sc] = name
                _sector_map_progress = f"行业数据加载中 {done}/{len(futures)}：{name}"

        _sector_map = mapping
        _sector_map_ready = True
        _sector_map_progress = f"申万行业映射完成，覆盖 {len(mapping)} 只股票"
        _atomic_write_json(SECTOR_MAP_FILE, mapping)
    except Exception as e:
        _sector_map_progress = f"行业映射构建失败: {e}"
        log.warning("行业映射构建失败: %s", e)
    finally:
        with _sector_build_lock:
            _sector_map_building = False


# ── 股票代码列表（SSE + SZSE + BSE，6h 缓存）──────────────────────

def _get_code_list() -> list[str]:
    global _code_list, _code_list_ts
    now = time.time()
    if _code_list and (now - _code_list_ts) < CODE_LIST_TTL:
        return _code_list
    try:
        with ThreadPoolExecutor(max_workers=3) as ex:
            f1 = ex.submit(ak.stock_info_sh_name_code, "主板A股")
            f2 = ex.submit(ak.stock_info_sh_name_code, "科创板")
            f3 = ex.submit(ak.stock_info_sz_name_code, "A股列表")
            sh_main = f1.result().iloc[:, 0].astype(str).str.zfill(6).tolist()
            sh_kcb  = f2.result().iloc[:, 0].astype(str).str.zfill(6).tolist()
            sz_all  = f3.result().iloc[:, 1].astype(str).str.zfill(6).tolist()

        codes = [f"sh{c}" for c in sh_main + sh_kcb] + [f"sz{c}" for c in sz_all]

        try:
            bj = ak.stock_info_bj_name_code()
            codes += [f"bj{c}" for c in bj.iloc[:, 1].astype(str).str.zfill(6).tolist()]
        except Exception:
            pass

        _code_list = codes
        _code_list_ts = now
        log.info("股票代码列表刷新完成：%d 只", len(codes))
    except Exception as e:
        log.error("股票代码列表获取失败: %s", e)
    return _code_list


# ── 腾讯行情批量拉取 ───────────────────────────────────────────────

def _fetch_tencent_batch(codes: list[str]) -> list[dict]:
    try:
        r = requests.get(TENCENT_URL.format(",".join(codes)),
                         headers=TENCENT_HDR, timeout=12)
        r.encoding = "gbk"
    except Exception:
        return []
    results = []
    for line in r.text.split(";"):
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
            vol = float(f[37]) if f[37] else 0.0
            if vol <= 0:          # 停牌 / 未交易
                continue
            chg = float(f[32]) if f[32] else 0.0
            mktcap    = float(f[45]) if f[45] else 0.0
            float_cap = float(f[44]) if f[44] else 0.0
            if mktcap <= 0:       # 数据异常
                continue
            results.append({
                "code":      m.group(1),
                "name":      f[1],
                "chg":       chg,        # 涨跌幅 %
                "vol":       vol,         # 成交额（万元）
                "mktcap":    mktcap,      # 总市值（亿元）
                "float_cap": float_cap,   # 流通市值（亿元）
            })
        except (ValueError, IndexError):
            pass
    return results


def _fetch_stock_data(top_n: int, size_by: str) -> tuple[pd.DataFrame, int]:
    """从腾讯 API 并发拉取全量行情，按 size_by 排序并截取 top_n。"""
    codes = _get_code_list()
    if not codes:
        raise RuntimeError("股票代码列表为空，请稍后重试")

    batches = [codes[i:i + 200] for i in range(0, len(codes), 200)]
    all_rows: list[dict] = []
    with ThreadPoolExecutor(max_workers=10) as ex:
        for rows in ex.map(_fetch_tencent_batch, batches):
            all_rows.extend(rows)

    if not all_rows:
        raise RuntimeError("腾讯行情 API 未返回数据")

    df = pd.DataFrame(all_rows)
    df["code_clean"] = df["code"].apply(normalize_code)
    df["chg_rate"]   = df["chg"] / 100
    total_count = len(df)

    sort_col = {"vol": "vol", "mktcap": "mktcap", "float_cap": "float_cap"}.get(size_by, "vol")
    if top_n > 0:
        df = df.nlargest(top_n, sort_col)

    return df.reset_index(drop=True), total_count


# ── 大盘指数（新浪 sh000002）──────────────────────────────────────

def _fetch_market_index() -> float | None:
    try:
        idx = ak.stock_zh_index_spot_sina()
        idx.columns = ["代码", "名称", "最新价", "涨跌额", "涨跌幅",
                       "开盘", "昨收", "最高", "最低", "成交量", "成交额"]
        row = idx[idx["代码"] == "sh000002"]
        if not row.empty:
            return float(row["涨跌幅"].iloc[0]) / 100
    except Exception:
        pass
    return None


# ── 申万行业实时涨跌（5 min 缓存）───────────────────────────────────

def _fetch_sw_sector_chg() -> dict[str, float]:
    global _sw_cache, _sw_cache_ts
    now = time.time()
    if _sw_cache is not None and (now - _sw_cache_ts) < SW_CACHE_TTL:
        return _sw_cache
    result = _fetch_sw_sector_chg_impl()
    _sw_cache    = result
    _sw_cache_ts = now
    return result


def _fetch_sw_sector_chg_impl() -> dict[str, float]:
    try:
        sw = ak.sw_index_first_info()
        l1_codes = sorted([int(str(c).replace(".SI", "")) for c in sw.iloc[:, 0]])
        l1_names = {int(str(c).replace(".SI", "")): str(n)
                    for c, n in zip(sw.iloc[:, 0], sw.iloc[:, 1])}

        rt = ak.index_realtime_sw()
        rt.columns = ["代码", "名称", "开盘", "昨收", "最新", "成交量", "成交额", "最高", "最低"]
        rt["代码"] = rt["代码"].astype(int)
        rt["chg"]  = (rt["最新"] - rt["昨收"]) / rt["昨收"]

        def find_l1(c):
            i = bisect.bisect_right(l1_codes, c) - 1
            return l1_codes[i] if i >= 0 else None

        rt["L1"]    = rt["代码"].apply(find_l1)
        rt["L1名称"] = rt["L1"].map(l1_names)
        rt = rt.dropna(subset=["L1名称"])
        return rt.groupby("L1名称")["chg"].mean().to_dict()
    except Exception:
        return {}


# ── 核心：构建热力图数据 ───────────────────────────────────────────

def build_heatmap_data(top_n: int, group_by: str, size_by: str) -> dict:
    """3 路并发：腾讯行情 + 大盘指数 + 申万行业"""
    size_label, size_unit = SIZE_LABELS.get(size_by, ("成交额", "万元"))

    with ThreadPoolExecutor(max_workers=3) as ex:
        f_stocks = ex.submit(_fetch_stock_data, top_n, size_by)
        f_index  = ex.submit(_fetch_market_index)
        f_sw     = ex.submit(_fetch_sw_sector_chg)
        df, market_count    = f_stocks.result()
        market_chg_index    = f_index.result()
        sw_sector_chg       = f_sw.result()

    n_stocks  = len(df)

    # 根节点：大盘指数（备用等权均值）
    root_chg = market_chg_index if market_chg_index is not None \
               else float(df["chg_rate"].mean())
    root_chg_src = "A股指数(sh000002)" if market_chg_index is not None else "等权均值"

    # 各股票 size 值（color 块大小，保留 2 位）
    df["sz"] = df[size_by].round(2)

    def stock_node(row):
        return {
            "n": row["name"], "c": row["code"],
            "v": row["sz"], "g": round(row["chg_rate"], 5),
            # 附带所有指标供 hover 使用
            "vol":       round(row["vol"],       2),
            "mktcap":    round(row["mktcap"],    2),
            "float_cap": round(row["float_cap"], 2),
        }

    if group_by == "sector":
        if _sector_map_ready:
            df["板块"] = df["code_clean"].map(lambda c: _sector_map.get(c) or get_board_fallback(c))
            glabel = "申万一级行业"
        else:
            df["板块"] = df["code"].apply(get_board_fallback)
            glabel = "交易所板块"

        sectors: dict[str, list] = {}
        for _, row in df.iterrows():
            sectors.setdefault(row["板块"], []).append(stock_node(row))

        children = []
        for sec_name, stocks in sectors.items():
            sv = sum(s["v"] for s in stocks)
            if sec_name in sw_sector_chg:
                sg, sg_src = sw_sector_chg[sec_name], "申万指数"
            else:
                sg = float(sum(s["g"] * s["v"] for s in stocks) / sv) if sv > 0 else 0
                sg_src = "加权均值"
            # 附带板块总成交额、总市值
            sec_vol   = sum(s["vol"]       for s in stocks)
            sec_mktcap = sum(s["mktcap"]   for s in stocks)
            children.append({
                "n": sec_name, "v": round(sv, 2), "g": round(sg, 5),
                "cnt": len(stocks), "src": sg_src,
                "vol": round(sec_vol, 2), "mktcap": round(sec_mktcap, 2),
                "children": stocks,
            })

        group_desc = f"申万行业 · {glabel}"
    else:
        children = [stock_node(row) for _, row in df.iterrows()]
        group_desc = "平铺（不分组）"

    # 标题元信息：实时部分（时间/盘中状态）在响应时由 _render_title 动态拼接
    title_meta = {
        "size_label": size_label, "top_n": top_n,
        "n_shown": n_stocks, "group_desc": group_desc,
    }

    # 由 children 累加，保证父值 == 子值之和（Plotly branchvalues='total' 要求自洽）
    total_v   = sum(c["v"]      for c in children)
    total_vol = sum(c["vol"]    for c in children)
    total_mkt = sum(c["mktcap"] for c in children)

    return {
        "title_meta": title_meta,
        "size_by":  size_by,
        "size_label": size_label,
        "size_unit":  size_unit,
        "root": {
            "n": "A股", "v": round(total_v, 2), "g": round(root_chg, 5),
            "cnt": market_count, "src": root_chg_src,
            "vol": round(total_vol, 2), "mktcap": round(total_mkt, 2),
            "children": children,
        },
        "group_by": group_by,
    }


def build_heatmap_cached(top_n: int, group_by: str, size_by: str, force: bool = False) -> dict:
    """
    两级缓存：
    - 内存缓存：盘中 2 分钟有效
    - 磁盘缓存：按交易日持久化，闭市/重启后直接读取
    force=True 跳过所有缓存强制重拉
    """
    td  = current_trading_date()
    key = f"{top_n}:{group_by}:{size_by}"

    def _finalize(data: dict, cache_type: str) -> dict:
        """统一出口：title 按当前时间动态渲染，附带缓存类型。"""
        return {**data, "title": _render_title(data.get("title_meta", {})),
                "cache_type": cache_type}

    def _try_cache():
        """命中返回数据，未命中返回 None。"""
        now = time.time()
        # 1. 内存缓存
        if key in _heatmap_mem:
            ts, cached_td, data = _heatmap_mem[key]
            if cached_td == td:
                if not is_market_open():
                    # 闭市：内存命中直接返回
                    return _finalize(data, "memory")
                if now - ts < MARKET_OPEN_TTL:
                    # 盘中：2 分钟内有效
                    return _finalize(data, "memory")

        # 2. 磁盘缓存（版本号不符则忽略）
        disk = disk_cache_path(top_n, group_by, size_by, td)
        if disk.exists():
            try:
                data = json.loads(disk.read_text(encoding="utf-8"))
                if data.get("cache_version") == CACHE_VERSION:
                    _heatmap_mem[key] = (now, td, data)
                    return _finalize(data, "disk")
                # 版本不匹配，删除旧文件
                disk.unlink(missing_ok=True)
            except Exception:
                pass
        return None

    if not force:
        hit = _try_cache()
        if hit is not None:
            return hit

    # single-flight：同 key 同时只有一个线程真正拉取，其余等待复用结果
    with _get_build_lock(key):
        # 双重检查：等锁期间可能已被其他线程填充缓存（force 请求跳过）
        if not force:
            hit = _try_cache()
            if hit is not None:
                return hit

        # 3. 拉取新数据
        data = build_heatmap_data(top_n, group_by, size_by)
        data["trading_date"]  = td
        data["generated_at"]  = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        data["market_status"] = market_status()
        data["cache_version"] = CACHE_VERSION

        # 写内存
        _heatmap_mem[key] = (time.time(), td, data)

        # 写磁盘（盘中也写，保证意外退出有缓存；原子写避免半截文件）
        disk = disk_cache_path(top_n, group_by, size_by, td)
        try:
            _atomic_write_json(disk, data)
        except Exception as e:
            log.warning("写磁盘缓存失败 %s: %s", disk.name, e)

        return _finalize(data, "fresh")


# ── 路由 ──────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index():
    # 启动时已读入内存；为空（极端情况）兜底再读一次
    return _INDEX_HTML or _load_index_html()


def _force_allowed(ip: str) -> bool:
    """同一 IP 强制刷新限流：FORCE_MIN_INTERVAL 秒内只允许一次。"""
    now = time.time()
    with _force_lock:
        last = _force_last.get(ip, 0.0)
        if now - last < FORCE_MIN_INTERVAL:
            return False
        _force_last[ip] = now
        return True


@app.get("/api/heatmap")
async def get_heatmap(
    request:  Request,
    top_n:    int  = Query(default=500, ge=0, le=10000),
    group_by: str  = Query(default="sector", pattern="^(sector|none)$"),
    size_by:  str  = Query(default="vol",    pattern="^(vol|mktcap|float_cap)$"),
    force:    bool = Query(default=False),
):
    # force 限流：超频则降级为普通请求（走缓存），避免全市场重复拉取被滥用
    if force:
        client_ip = request.client.host if request.client else "unknown"
        if not _force_allowed(client_ip):
            force = False
    try:
        data = await asyncio.to_thread(build_heatmap_cached, top_n, group_by, size_by, force)
        return JSONResponse(data)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/cache-status")
async def cache_status_api():
    """列出当前磁盘缓存文件"""
    files = []
    for f in sorted(CACHE_DIR.glob("heatmap_*.json"), reverse=True)[:20]:
        stat = f.stat()
        files.append({
            "file":    f.name,
            "size_kb": round(stat.st_size / 1024, 1),
            "mtime":   datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        })
    return JSONResponse({
        "trading_date":  current_trading_date(),
        "market_status": market_status(),
        "files": files,
    })


@app.get("/api/sector-status")
async def sector_status():
    return JSONResponse({
        "ready":    _sector_map_ready,
        "progress": _sector_map_progress,
        "count":    len(_sector_map),
    })


if __name__ == "__main__":
    # 仅用于本地开发调试，生产环境通过 gunicorn 启动
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
