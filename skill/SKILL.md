---
name: a-share-heatmap
description: 生成 A股全市场热力树图（Treemap）。当用户要求生成、查看、制作 A股 / 沪深北股市热力图、行业板块热力图、涨跌幅树图，或需要可视化 A股行情、板块涨跌、成交额/市值分布时使用。基于 stock-heatmap 仓库（腾讯行情 + 申万行业分组）封装，提供一键拉取行情并渲染可交互 Plotly 树图的脚本与自包含 HTML 前端。
agent_created: true
---

# A股热力树图 Skill

## 用途

生成 A股全市场热力树图：从腾讯财经公开行情接口拉取沪深北全市场约 5000+ 只股票的实时行情，按**申万一级行业**（或平铺）分组，用**色块大小**表示成交额/市值、**颜色**表示涨跌幅，输出可交互的 Plotly Treemap（自包含 HTML，浏览器直接打开即可查看，支持全屏与图片导出）。

## 何时使用

- 用户要求「生成 A股热力图」「画个股/板块涨跌树图」「看看今天板块涨跌」「A股行情可视化」等。
- 用户想看成交额/总市值/流通市值分布、行业涨跌对比、全市场涨跌全景。
- 任何需要把 A股行情以树图形式呈现的场景。

## 核心能力（stock-heatmap 仓库封装）

- **全市场覆盖**：沪市主板 + 科创板 + 深市 A股 + 北交所。
- **三种分组**：`sw`（申万一级行业）/ `board`（交易所板块）/ `none`（平铺不分组）。
- **多维度组合筛选**：ST 股、科创板、创业板、北交所、沪主板、深主板，支持包含（并集）与排除两种逻辑。
- **三种色块大小**：`vol`（成交额/万元）、`mktcap`（总市值/亿元）、`float_cap`（流通市值/亿元）。
- **真实涨跌色**：板块/全市场涨跌幅取自官方指数（申万行业指数、上证 A股指数 sh000002），非简单等权均值。
- **Top-N 筛选**：只取成交额/市值最大的前 N 只。
- **涨红跌绿**：遵循 A股配色惯例（涨红、跌绿）。
- **交易日历（识别节假日）**：直连新浪上证指数日K线接口构建交易日集合，正确识别周末与法定节假日（国庆/春节/元旦等），磁盘缓存 24h，失败自动退回「仅排除周末」。

## 使用方式

### 方式一：一键生成带筛选器的交互式 HTML（推荐）

```bash
python scripts/generate_heatmap.py --html --out heatmap.html
```

`--html` 模式输出**自包含的交互式 HTML**，筛选器直接内嵌在页面里：打开即可在浏览器中实时切换分组方式（申万行业/交易所板块/平铺）、色块大小（成交额/总市值/流通市值）、Top-N，以及点击「包含/排除」chip 组合筛选 ST/科创板/创业板/北交所/沪主板/深主板——全程无需重新跑脚本。

### 方式二：生成数据 JSON（脚本端筛选）

```bash
# 基本用法（默认：申万行业分组，成交额前 500 只）
python scripts/generate_heatmap.py --out heatmap.json

# 常用参数
python scripts/generate_heatmap.py \
  --top-n 0 \                 # 0 = 全部，默认 500
  --group-by sw \             # sw(申万行业) | board(交易所板块) | none(平铺)
  --size-by mktcap \          # vol | mktcap | float_cap
  --out heatmap.json

# 多维度组合筛选（脚本端预筛）
python scripts/generate_heatmap.py --include KCB,BSE   # 只看科创板+北交所（并集）
python scripts/generate_heatmap.py --exclude ST        # 剔除所有 ST 股
python scripts/generate_heatmap.py --include KCB --exclude ST   # 科创板且剔除 ST
```

筛选维度：`ST`（ST/*ST 股）、`KCB`（科创板）、`CYB`（创业板）、`BSE`（北交所）、`SH`（沪主板）、`SZ`（深主板）。`--include` 为并集（包含即保留），`--exclude` 为排除，二者可叠加（排除优先）。

生成 JSON 后，渲染为 HTML：

1. 读取 `assets/template.html` 的完整内容；
2. 将其中 `__HEATMAP_DATA__` 占位符替换为 `generate_heatmap.py` 输出的 JSON 字符串；
3. 写成 `<输出目录>/heatmap.html`。

> `--html` 模式已自动完成以上三步（内部调用 `build_frontend_payload` 输出全量数据包，再由 `_render_html` 注入模板）。

脚本不依赖 akshare/plotly（纯标准库 + requests）。申万行业映射与行业涨跌幅直连申万官网（swsresearch.com），磁盘缓存 24h，失败自动退回交易所板块分组；渲染由浏览器端 Plotly CDN 完成。参见 `references/implementation.md` 了解数据 JSON 结构与腾讯/申万字段解析细节。

### 方式三：直接复用原仓库

如需完整服务（FastAPI 后端 + 多用户 + 磁盘缓存 + 交易日历），参考原仓库 `web/` 目录：`pip install -r requirements.txt && python app.py`，浏览器访问 `http://localhost:8000`。数据源与实现逻辑见 `references/implementation.md`。

## 注意事项

- 数据源为腾讯财经等公开接口，仅供学习研究，**不构成投资建议**。
- 腾讯行情接口返回 GBK 编码，字段以 `~` 分隔（字段索引见 `references/implementation.md`）。
- 上游接口字段/防盗链策略可能变动，若拉取失败请检查数据源是否调整。
- 非交易日（周末/节假日）拉取到的是最近交易日的收盘数据，脚本会自动标注市场状态；交易日历基于新浪上证指数日K线，失败时自动退回「仅排除周末」。

## 参考文档

- `references/implementation.md` — 完整实现知识：数据源、腾讯行情字段解析、申万行业映射、分组/涨跌计算逻辑、缓存与市场时间判断、两版（网页版/插件版）架构差异。
