// ── 数据获取层：复刻 app.py 的 6 个数据源 ──────────────────────
// 所有 fetch 受 manifest host_permissions 覆盖，可跨域

// ── 全局状态（等同 app.py 模块级变量）──────────────────────────
let _sectorMap = {};
let _sectorMapReady = false;
let _sectorMapProgress = "";
let _sectorMapBuilding = false;
let _sectorMapListeners = [];

let _codeList = [];
let _codeListTs = 0;

let _swCache = null;
let _swCacheTs = 0;

const SECTOR_MAP_TTL = 86400;   // 24h
const CODE_LIST_TTL  = 21600;   // 6h
const SW_CACHE_TTL   = 300;     // 5min

// ── 进度回调 ─────────────────────────────────────────────────────
function onSectorProgress(cb) {
  _sectorMapListeners.push(cb);
  if (_sectorMapReady) cb({ ready: true, progress: _sectorMapProgress, count: Object.keys(_sectorMap).length });
}

function _notifyProgress() {
  for (const cb of _sectorMapListeners) {
    try { cb({ ready: _sectorMapReady, progress: _sectorMapProgress, count: Object.keys(_sectorMap).length }); } catch (_) {}
  }
}

// ── 腾讯批量行情（GBK 编码）────────────────────────────────────
async function fetchTencentBatch(codes) {
  try {
    const url = `https://qt.gtimg.cn/q=${codes.join(",")}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const buf = await resp.arrayBuffer();
    const text = new TextDecoder("gbk").decode(buf);
    const results = [];
    for (const raw of text.split(";")) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^v_(\w+)="(.+)"$/);
      if (!m) continue;
      const f = m[2].split("~");
      if (f.length < 46) continue;
      try {
        const vol      = f[37] ? parseFloat(f[37]) : 0;
        if (vol <= 0) continue;                       // 停牌
        const chg      = f[32] ? parseFloat(f[32]) : 0;
        const mktcap   = f[45] ? parseFloat(f[45]) : 0;
        const floatCap = f[44] ? parseFloat(f[44]) : 0;
        if (mktcap <= 0) continue;                    // 异常
        results.push({
          code: m[1], name: f[1],
          chg,           // 涨跌幅 %
          vol,           // 成交额 万元
          mktcap,        // 总市值 亿元
          float_cap: floatCap,
        });
      } catch (_) {}
    }
    return results;
  } catch (_) { return []; }
}

async function fetchAllQuotes(codes, batchSize = 200, maxConcurrent = 10) {
  const batches = [];
  for (let i = 0; i < codes.length; i += batchSize) batches.push(codes.slice(i, i + batchSize));
  const all = [];
  for (let i = 0; i < batches.length; i += maxConcurrent) {
    const chunk = batches.slice(i, i + maxConcurrent);
    const results = await Promise.all(chunk.map(fetchTencentBatch));
    for (const r of results) all.push(...r);
  }
  return all;
}

// ── 大盘指数：从腾讯直接拉 sh000002 ─────────────────────────────
async function fetchMarketIndex() {
  try {
    const rows = await fetchTencentBatch(["sh000002"]);
    if (rows.length) return rows[0].chg / 100;
  } catch (_) {}
  return null;
}

// ── 三交易所代码列表 ─────────────────────────────────────────────
async function fetchSSECodeList(stockType) {
  const params = new URLSearchParams({
    sqlId: "COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L",
    STOCK_TYPE: String(stockType),
    COMPANY_STATUS: "2,4,5,7,8",
    isPagination: "false",
    "pageHelp.cacheSize": "1",
    "pageHelp.beginPage": "0",
    "pageHelp.pageSize": "10000",
  });
  const resp = await fetch(`https://query.sse.com.cn/sseQuery/commonQuery.do?${params}`);
  const data = await resp.json();
  const result = data.result || (data.pageHelp && data.pageHelp.result) || [];
  return result
    .map(r => String(r.COMPANY_CODE || r.A_STOCK_CODE || "").padStart(6, "0"))
    .filter(c => /^\d{6}$/.test(c));
}

async function fetchSZSECodeList() {
  const params = new URLSearchParams({
    SHOWTYPE: "xlsx",
    CATALOGID: "1110",
    TABKEY: "tab1",
    random: String(Math.random()),
  });
  const resp = await fetch(`https://www.szse.cn/api/report/ShowReport?${params}`);
  const buf = await resp.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  const codes = [];
  for (const row of rows) {
    const c = String(row["公司代码"] || row["证券代码"] || row["代码"] || row["A股代码"] || row["证券代码(A股)"] || "").padStart(6, "0");
    if (/^\d{6}$/.test(c) && c !== "000000") codes.push(c);
  }
  return codes;
}

async function fetchBSECodeList() {
  const codes = [];
  let page = 1;
  while (page <= 20) {
    const body = new URLSearchParams({
      page: String(page),
      typejb: "T",
      "xxfcbj[]": "2",
      sortfield: "xxzqdm",
      sorttype: "asc",
    });
    const resp = await fetch("https://www.bse.cn/nqxxController/nqxxCnzq.do", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await resp.text();
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end < 0) break;
    let arr;
    try { arr = JSON.parse(text.slice(start, end + 1)); } catch { break; }
    if (!arr.length) break;
    for (const row of arr) {
      const c = String(row.xxzqdm || row.zqdm || "").padStart(6, "0");
      if (/^\d{6}$/.test(c)) codes.push(c);
    }
    if (arr.length < 20) break;
    page++;
  }
  return codes;
}

async function getCodeList() {
  const now = Date.now() / 1000;
  if (_codeList.length && (now - _codeListTs) < CODE_LIST_TTL) return _codeList;

  let shMain = [], shKcb = [], szAll = [], bj = [];

  try { shMain = await fetchSSECodeList(1); } catch (_) {}
  try { shKcb = await fetchSSECodeList(8); } catch (_) {}
  try { szAll = await fetchSZSECodeList(); } catch (_) {}
  try { bj = await fetchBSECodeList(); } catch (_) {}

  const codes = [
    ...shMain.map(c => `sh${c}`),
    ...shKcb.map(c => `sh${c}`),
    ...szAll.map(c => `sz${c}`),
    ...bj.map(c => `bj${c}`),
  ];

  if (codes.length) {
    _codeList = codes;
    _codeListTs = now;
  }

  return _codeList;
}

// ── 申万一级行业映射 ─────────────────────────────────────────────
async function fetchSwL1List() {
  const url = "https://www.swsresearch.com/institute-sw/api/index_publish/current/?indextype=%E4%B8%80%E7%BA%A7%E8%A1%8C%E4%B8%9A&page=1&page_size=100";
  const resp = await fetch(url);
  const data = await resp.json();
  const results = (data && data.data && data.data.results) || (data && data.results) || [];
  return results.map(r => ({
    code: String(r.swindexcode || r.index_code || ""),
    name: String(r.swindexname || r.index_name || ""),
    chg: (r.close != null && r.tclose != null)
         ? (parseFloat(r.close) - parseFloat(r.tclose)) / parseFloat(r.tclose)
         : 0,
  }));
}

async function fetchSwComponents(swCode) {
  const url = `https://www.swsresearch.com/institute-sw/api/index_publish/details/component_stocks/?swindexcode=${swCode}&page=1&page_size=10000`;
  const resp = await fetch(url);
  const data = await resp.json();
  const results = (data && data.data && data.data.results) || (data && data.results) || [];
  return results
    .map(r => String(r.stockcode || r.code || "").padStart(6, "0"))
    .filter(c => /^\d{6}$/.test(c));
}

const SECTOR_MAP_STORAGE_KEY = "sector_map_cache";

/** 从 chrome.storage.local 读行业映射（24h 内有效，否则返回 null） */
function _loadSectorMapFromStorage() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(SECTOR_MAP_STORAGE_KEY, r => {
        const e = r[SECTOR_MAP_STORAGE_KEY];
        if (e && e.ts && (Date.now() / 1000 - e.ts) < SECTOR_MAP_TTL &&
            e.map && Object.keys(e.map).length) {
          resolve(e.map);
        } else {
          resolve(null);
        }
      });
    } catch (_) { resolve(null); }
  });
}

function _saveSectorMapToStorage(map) {
  try {
    chrome.storage.local.set({ [SECTOR_MAP_STORAGE_KEY]: { ts: Date.now() / 1000, map } });
  } catch (_) {}
}

async function buildSectorMap() {
  if (_sectorMapBuilding || _sectorMapReady) return;
  _sectorMapBuilding = true;
  try {
    // 0. 优先读持久化缓存——避免每次打开标签页都重新拉取全部行业成分股
    const cached = await _loadSectorMapFromStorage();
    if (cached) {
      _sectorMap = cached;
      _sectorMapReady = true;
      _sectorMapProgress = `已从本地缓存加载 ${Object.keys(cached).length} 只股票行业映射`;
      _notifyProgress();
      return;
    }

    _sectorMapProgress = "正在获取申万一级行业列表...";
    _notifyProgress();

    const l1List = await fetchSwL1List();
    if (!l1List.length) {
      _sectorMapProgress = "申万行业列表获取失败";
      _notifyProgress();
      return;
    }

    // 各行业成分股并发拉取（限流 8，复刻 app.py 的 ThreadPoolExecutor(max_workers=8)）
    const mapping = {};
    let done = 0;
    const CONCURRENCY = 8;
    for (let i = 0; i < l1List.length; i += CONCURRENCY) {
      const chunk = l1List.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(async ind => {
        try { return { name: ind.name, codes: await fetchSwComponents(ind.code) }; }
        catch (_) { return { name: ind.name, codes: [] }; }
      }));
      for (const { name, codes } of results) {
        for (const c of codes) mapping[c] = name;
        done++;
        _sectorMapProgress = `行业数据加载中 ${done}/${l1List.length}：${name}`;
      }
      _notifyProgress();
    }

    _sectorMap = mapping;
    _sectorMapReady = true;
    _sectorMapProgress = `申万行业映射完成，覆盖 ${Object.keys(mapping).length} 只股票`;
    _saveSectorMapToStorage(mapping);
    _notifyProgress();
  } catch (e) {
    _sectorMapProgress = `行业映射构建失败: ${e.message || e}`;
    _notifyProgress();
  } finally {
    _sectorMapBuilding = false;
  }
}

function getSectorStatus() {
  return {
    ready: _sectorMapReady,
    progress: _sectorMapProgress,
    count: Object.keys(_sectorMap).length,
  };
}

/** 返回当前可用的板块映射（SW 就绪则用 SW，否则返回空对象由调用方 fallback） */
function _getSectorMapWithFallback() {
  return Promise.resolve(_sectorMap);
}

// ── 申万行业实时涨跌 ─────────────────────────────────────────────
async function fetchSwSectorChg() {
  const now = Date.now() / 1000;
  if (_swCache && (now - _swCacheTs) < SW_CACHE_TTL) return _swCache;
  try {
    const l1List = await fetchSwL1List();
    const result = {};
    for (const ind of l1List) if (ind.name) result[ind.name] = ind.chg;
    if (Object.keys(result).length) {
      _swCache = result;
      _swCacheTs = now;
      return result;
    }
  } catch (_) {}
  return _swCache || {};
}

// ── 股票数据拉取 ─────────────────────────────────────────────────
async function fetchStockData(topN, sizeBy) {
  const codes = await getCodeList();
  if (!codes.length) throw new Error("股票代码列表为空，请稍后重试");

  const allRows = await fetchAllQuotes(codes, 200, 10);
  if (!allRows.length) throw new Error("腾讯行情 API 未返回数据");

  const rows = allRows.map(r => ({
    ...r,
    code_clean: normalizeCode(r.code),
    chg_rate: r.chg / 100,
  }));

  const totalCount = rows.length;
  const sortCol = ({ vol: "vol", mktcap: "mktcap", float_cap: "float_cap" })[sizeBy] || "vol";

  let filtered = rows;
  if (topN > 0) {
    filtered = [...rows].sort((a, b) => (b[sortCol] || 0) - (a[sortCol] || 0)).slice(0, topN);
  }

  return { rows: filtered, totalCount };
}

// ── 导出 ─────────────────────────────────────────────────────────
window.DataLayer = {
  buildSectorMap,
  getSectorStatus,
  onSectorProgress,
  _getSectorMapWithFallback,
  fetchStockData,
  fetchMarketIndex,
  fetchSwSectorChg,
  getCodeList,
};
