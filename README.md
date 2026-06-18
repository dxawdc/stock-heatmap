# A股热力树图 📊

实时 A股全市场热力树图（Treemap）。从腾讯财经拉取沪深北全市场行情，按**申万一级行业**分组，用**色块大小**表示成交额/市值、**颜色**表示涨跌幅，支持 Plotly / ECharts 双渲染器、全屏查看与图片导出。

> 作者：**@可以叫我才哥**

---

## ✨ 功能特性

- **全市场覆盖**：沪市主板 + 科创板 + 深市 A股 + 北交所，约 5000+ 只股票
- **两种分组**：按申万一级行业分组 / 平铺（不分组）
- **三种色块大小**：成交额（万元）、总市值（亿元）、流通市值（亿元）
- **真实涨跌色**：板块 / 全市场颜色取自官方指数（申万行业指数、上证 A股指数 sh000002），而非简单等权均值
- **Top-N 筛选**：可只看成交额/市值最大的前 N 只
- **双渲染器**：Plotly（桌面，交互强）与 ECharts（移动端友好），按需懒加载
- **全屏 + 导出**：一键全屏，支持导出 PNG/JPEG 图片
- **两级缓存**：内存（盘中 2 分钟）+ 磁盘（按交易日持久化），盘后/重启秒开
- **交易日历感知**：自动识别周末与法定节假日，非交易日不重复拉取

---

## 🏗️ 技术架构

```
浏览器 (static/index.html, 单页)
   │  GET /                → 首页 HTML
   │  GET /api/heatmap     → 热力图 JSON
   │  GET /api/sector-status / cache-status
   ▼
FastAPI (app.py)
   ├─ 两级缓存：_heatmap_mem（内存）+ cache/*.json（磁盘，按交易日）
   ├─ single-flight 锁：缓存 miss 时同 key 只拉一次，避免并发重复打满上游
   └─ 3 路并发拉取
        ├─ 腾讯行情批量 API（200 只/批，10 线程）  → 个股涨跌/成交额/市值
        ├─ 新浪指数 sh000002                        → 大盘根节点涨跌幅
        └─ 申万行业实时指数 (akshare)               → 板块节点涨跌幅
   └─ 申万行业映射 / 交易日历：启动后台预热 + 磁盘缓存
```

**技术栈**：FastAPI · Uvicorn/Gunicorn · pandas · akshare · requests · Plotly · ECharts

---

## 🚀 快速开始

### 1. 环境要求
- Python 3.10+（开发使用 3.12）

### 2. 安装依赖
```bash
pip install -r requirements.txt
```

### 3. 本地启动（开发模式，热重载）
```bash
python app.py
```
浏览器打开 <http://localhost:8000>

> 首次启动会在后台拉取股票代码列表、申万行业映射和交易日历（约 30–60 秒），
> 期间页面顶部会显示「申万行业加载中」进度，加载完成前分组会临时使用交易所板块兜底。

---

## 🔌 API 说明

### `GET /api/heatmap`
返回热力图数据。

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `top_n` | int | `500` | 只取前 N 只（`0` = 全部），范围 0–10000 |
| `group_by` | str | `sector` | `sector`（申万行业） / `none`（平铺） |
| `size_by` | str | `vol` | `vol`（成交额） / `mktcap`（总市值） / `float_cap`（流通市值） |
| `force` | bool | `false` | 跳过缓存强制重拉（**同一 IP 限流 30 秒一次**，超频自动降级为读缓存） |

响应（节选）：
```jsonc
{
  "title": "A股热力树图  ·  2026-06-18 15:00 闭市  | ...",  // 每次响应按当前时间动态生成
  "size_by": "vol", "size_label": "成交额", "size_unit": "万元",
  "root": {
    "n": "A股", "v": 76393422.0, "g": 0.0123, "cnt": 5188,
    "children": [ { "n": "电子", "v": ..., "g": ..., "children": [ ... ] } ]
  },
  "trading_date": "2026-06-18",
  "market_status": "closed",        // open / closed
  "cache_type": "memory"            // fresh / memory / disk
}
```

### `GET /api/sector-status`
申万行业映射构建进度：`{ ready, progress, count }`

### `GET /api/cache-status`
当前磁盘缓存文件列表、交易日与市场状态。

---

## ⚙️ 配置（环境变量）

| 变量 | 默认 | 说明 |
|------|------|------|
| `ALLOW_ORIGINS` | `*` | CORS 允许来源，逗号分隔；如 `https://a.com,https://b.com` |

代码内常量（`app.py` 顶部）：

| 常量 | 默认 | 含义 |
|------|------|------|
| `MARKET_OPEN_TTL` | 120s | 盘中内存缓存有效期 |
| `SW_CACHE_TTL` | 300s | 申万行业实时涨跌缓存 |
| `CODE_LIST_TTL` | 6h | 股票代码列表缓存 |
| `SECTOR_MAP_TTL` / `TRADE_CAL_TTL` | 24h | 行业映射 / 交易日历缓存 |
| `FORCE_MIN_INTERVAL` | 30s | 同一 IP 强制刷新最小间隔 |
| `CACHE_VERSION` | `v4` | 磁盘缓存格式版本，结构变更时递增，旧缓存自动失效 |

---

## 🌐 生产部署（Gunicorn + Nginx + systemd）

### Gunicorn
项目已带 [`gunicorn.conf.py`](gunicorn.conf.py)（单 worker + 4 线程；单 worker 是因为内存缓存不跨进程）：
```bash
gunicorn -c gunicorn.conf.py app:app
```

### systemd 服务示例
`/etc/systemd/system/stock-heatmap.service`：
```ini
[Unit]
Description=A股热力树图
After=network.target

[Service]
WorkingDirectory=/opt/stock-heatmap
ExecStart=/opt/stock-heatmap/.venv/bin/gunicorn -c gunicorn.conf.py app:app
Restart=always
Environment=ALLOW_ORIGINS=https://your-domain.com

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now stock-heatmap
```

### Nginx 反向代理示例
```nginx
server {
    listen 80;
    server_name your-domain.com;
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 180s;   # 首次全市场拉取较慢
    }
}
```

---

## 📁 项目结构

```
stock-heatmap/
├── app.py                 # FastAPI 后端：行情拉取、分组、缓存、API
├── static/
│   ├── index.html         # 单页前端（Plotly/ECharts 双渲染器）
│   ├── plotly-2.35.2.min.js
│   └── echarts-5.5.1.min.js
├── gunicorn.conf.py       # 生产部署配置
├── requirements.txt
├── cache/                 # 运行时缓存（不入库，自动生成/清理）
└── sector_map.json        # 申万行业映射缓存（不入库，自动重建）
```

---

## 📝 说明与已知限制

- 数据来源为腾讯财经 / 新浪 / akshare 公开接口，仅供学习研究，**不构成任何投资建议**。
- 交易日历依赖 akshare，若获取失败会自动退回「仅排除周末」逻辑。
- 单 worker 部署：内存缓存不跨进程，多 worker 会重复拉取上游。

## 📄 License

MIT
