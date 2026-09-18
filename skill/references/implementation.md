# A股热力图实现参考（源自 stock-heatmap 仓库）

本文档沉淀 A股热力树图的核心实现知识，供复现、扩展或对接申万行业映射时参考。原仓库：<https://github.com/dxawdc/stock-heatmap>（MIT License）。

## 1. 整体架构

仓库提供两个形态一致、部署方式不同的版本：

| 维度 | 网页版 `web/` | 插件版 `extension/` |
|------|--------------|---------------------|
| 形态 | Python FastAPI 服务 | Chrome MV3 扩展 |
| 数据源 | 腾讯行情 + 新浪指数 + akshare | 腾讯行情 + 三交易所 + 申万官网 + 新浪日历 |
| 跨域/防盗链 | 服务端请求无限制 | declarativeNetRequest 改写 Referer |
| 缓存 | 内存 + 磁盘 JSON | 内存 + chrome.storage.local |
| 交易日历 | akshare | 新浪（前端解码） |

核心数据流（两版一致）：
```
行情拉取（3 路并发）
  ├─ 腾讯批量行情 → 个股涨跌/成交额/市值
  ├─ 大盘指数 sh000002 → 根节点涨跌幅
  └─ 申万行业实时指数 → 板块节点涨跌幅
→ 按申万一级行业（或平铺）分组
→ 组装树图数据（父值 == 子值之和，保证 branchvalues='total' 自洽）
→ Plotly / ECharts Treemap 渲染
```

## 2. 数据源与接口

### 2.1 腾讯行情（核心个股数据）

- 批量接口：`https://qt.gtimg.cn/q={codes}`，逗号分隔，每批最多 200 只。
- 请求头：`Referer: https://finance.qq.com` + `User-Agent: Mozilla/5.0`。
- **返回 GBK 编码**，格式 `v_sh600519="...字段以 ~ 分隔..."`。
- 字段索引（关键）：

| 索引 | 含义 | 单位 |
|------|------|------|
| 1 | 股票名称 | — |
| 32 | 涨跌幅 | % |
| 37 | 成交额 | 万元 |
| 44 | 流通市值 | 亿元 |
| 45 | 总市值 | 亿元 |

- 过滤规则：`f[37]`（成交额）<=0 视为停牌跳过；`f[45]`（总市值）<=0 视为异常跳过。
- 代码前缀：`sh`/`sz`/`bj`；归一化 `normalize_code` 去掉前缀。

### 2.2 大盘指数

- 上证 A股指数 `sh000002`，同样走腾讯批量接口，取涨跌幅（/100 转小数）。

### 2.3 申万行业

- 网页版：`akshare` — `sw_index_first_info()`（一级行业列表）、`index_component_sw(symbol)`（成分股）、`index_realtime_sw()`（实时涨跌）。
- 插件版（纯前端直连申万官网）：
  - 一级行业列表：`https://www.swsresearch.com/institute-sw/api/index_publish/current/?indextype=一级行业&page=1&page_size=100`
  - 成分股：`https://www.swsresearch.com/institute-sw/api/index_publish/details/component_stocks/?swindexcode={code}&page=1&page_size=10000`
  - 涨跌幅由 `close` 与 `tclose`（昨收）计算。

> **本 skill 脚本版直连申万官网（已验证可用，31 个一级行业）**，字段口径：
> - 行业列表返回字段为 `l3`/`l4`/`l5`/`l6`/`l7`/`l8`/`l11`（已非早期 `close`/`tclose`）。
>   - `l4` = 昨收价（验证：纺织服饰/环保等 l4 与 l7 相等）
>   - `l6` = 最新价/收盘价
>   - `l7` = 最低价；`l5` ≈ 成交额（量级）；`l8`/`l11` 为其他指数口径
>   - **行业涨跌幅 = `(l6 - l4) / l4`**
> - 成分股返回 `stockcode`（6 位代码）+ `stockname` + `newweight`（权重）。
> - 请求需带 `Referer: https://www.swsresearch.com/` + UA。
> - 构建映射：遍历 31 个一级行业 → 拉各自成分股 → `code_clean → 行业名`，磁盘缓存 24h。

### 2.4 股票代码列表

- 网页版（akshare）：
  - 沪主板 `stock_info_sh_name_code("主板A股")`
  - 科创板 `stock_info_sh_name_code("科创板")`
  - 深市 `stock_info_sz_name_code("A股列表")`
  - 北交所 `stock_info_bj_name_code()`
- 插件版（直连交易所）：
  - 上交所：`query.sse.com.cn/sseQuery/commonQuery.do`（sqlId=COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L，STOCK_TYPE 1=主板/8=科创板）
  - 深交所：`www.szse.cn/api/report/ShowReport`（xlsx，用 xlsx.mini 解析）
  - 北交所：`www.bse.cn/nqxxController/nqxxCnzq.do`（POST 分页）

> 本 skill 的 `scripts/generate_heatmap.py` 为降低依赖（不装 akshare），代码列表用交易所板块代码段近似兜底（实测覆盖 5207 只真实股票），申万行业映射直连申万官网。若要完整 5000+ 只精确覆盖，请改用原仓库 `web/` 版（akshare）。

## 3. 分组与涨跌计算

### 3.1 申万行业分组（脚本版已接入）

- 直连申万官网构建 `code_clean → 行业名` 映射（24h 磁盘缓存，脚本同目录 `sector_map.json`）。
- 未命中映射时用 `get_board` 交易所板块兜底：
  - `688` → 科创板；`300`/`301` → 创业板；`002`/`003` → 中小板；`60` → 沪市主板；`000`/`001` → 深市主板；`4`/`8` → 北交所。

### 3.2 板块涨跌幅

- 优先取申万行业实时指数涨跌幅（官方指数，`src="申万指数"`），脚本版由 `(l6-l4)/l4` 计算。
- 无申万指数时，用板块内个股**成交额加权均值**（`src="加权均值"`）：
  `sg = Σ(g_i * v_i) / Σ(v_i)`

### 3.3 根节点涨跌幅

- 优先取大盘指数 `sh000002`（`src="A股指数"`）。
- 失败则用全部个股涨跌幅等权均值。

## 4. 多维组合筛选

脚本版提供 `--include`（并集，包含即保留）与 `--exclude`（排除）两组参数，维度标签：

| 维度 key | 含义 | 判断规则 |
|----------|------|----------|
| `ST` | ST/*ST 股 | 名称含 ST / 以 S 开头 / 含「退」 |
| `KCB` | 科创板 | 688 开头 |
| `CYB` | 创业板 | 300/301 开头 |
| `BSE` | 北交所 | 4/8 开头 |
| `SH` | 沪主板 | 60 开头 |
| `SZ` | 深主板 | 00 开头（含 000/001/002/003） |

- 一只股票可命中多个标签（如 ST 创业板股同时命中 `ST` 与 `CYB`）。
- 筛选在 top_n 截断**之前**作用于全量数据，`filtered_total` 记录筛选后的总数。
- 排除优先于包含。

## 5. 市场时间与交易日

- 交易时段：上午 `9:25–11:31`，下午 `13:00–15:01`（含集合竞价容差）。
- 交易日判断：优先交易日历（网页版 akshare、插件版新浪 `klc_td_sh.txt` 解码），失败退回「仅排除周末」。
- `current_trading_date`：非交易日或开盘前（9:30 之前）回退到最近交易日。
- 注意：插件版用本地时区日期（`localDateStr`，非 `toISOString()`，避免 UTC 偏移导致缓存键错位）。

## 6. 缓存策略

- **两级缓存**：内存（盘中 2min TTL）+ 磁盘（按交易日持久化）。
- **single-flight**：同 key 缓存 miss 时只有一个线程真正拉取，其余等待复用，避免打满上游。
- **缓存版本号** `CACHE_VERSION`：数据结构变更时递增，旧缓存自动失效。
- **强制刷新限流**：同 IP 30 秒内只允许一次 `force=true`，超频降级为读缓存。
- 各 TTL：代码列表 6h、申万映射 24h、行业实时 5min、交易日历 24h。

## 7. 树图数据结构

```
root: { n, v, g, cnt, src, vol, mktcap, children }
  ├─ sector node: { n, v, g, cnt, src, vol, mktcap, children }
  │    └─ stock node: { n, c, v, g, vol, mktcap, float_cap }
  └─ ...
```

- `n` 名称、`c` 代码、`v` 色块大小值、`g` 涨跌幅（小数，如 0.0123 = +1.23%）。
- **父值 == 子值之和**（`branchvalues='total'` 要求自洽），`vol`/`mktcap` 同理由子累加。
- 色块大小三种：`vol`（成交额/万元）、`mktcap`（总市值/亿元）、`float_cap`（流通市值/亿元）。

## 8. 渲染配色

遵循 A股惯例：**涨红、跌绿**。Plotly treemap 用自定义 colorscale：

```
[[0, '#16a34a'], [0.4, '#4ade80'], [0.5, '#f3f4f6'], [0.6, '#fca5a5'], [1, '#dc2626']]
```

涨跌幅归一化到 `[0,1]`（对称于 0.5，±10% 封顶）。

## 9. 已知限制

- 数据源为公开接口，仅供学习研究，不构成投资建议。
- 上游字段/防盗链策略可能变动，失败时需检查数据源。
- 网页版建议单 worker 部署（内存缓存不跨进程）。
- 本 skill 脚本版（无 akshare）代码列表为近似兜底（实测覆盖 5207 只真实股票）；申万行业已直连官网接入，失败时自动降级为交易所板块分组。需完整精确代码列表请用原仓库 `web/` 版（akshare）。
