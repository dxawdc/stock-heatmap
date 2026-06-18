// ── 两级缓存：内存 + chrome.storage.local ──────────────────────

const _memCache = {};           // key → { ts, td, data }
const MARKET_OPEN_TTL = 120;    // 盘中 2min

function _storageKey(topN, groupBy, sizeBy, td) {
  return `heatmap_v3_${td}_${topN}_${groupBy}_${sizeBy}`;
}

async function _tryMemCache(key, td) {
  const entry = _memCache[key];
  if (!entry || entry.td !== td) return null;
  if (!isMarketOpen()) return { ...entry.data, cache_type: "memory" };
  if ((Date.now() / 1000 - entry.ts) < MARKET_OPEN_TTL) return { ...entry.data, cache_type: "memory" };
  return null;
}

async function _tryStorageCache(key) {
  return new Promise(resolve => {
    chrome.storage.local.get(key, result => {
      if (!result[key]) { resolve(null); return; }
      try {
        const data = JSON.parse(result[key]);
        if (data && data.cache_version === "v3") resolve({ ...data, cache_type: "local" });
        else {
          chrome.storage.local.remove(key);
          resolve(null);
        }
      } catch (_) { resolve(null); }
    });
  });
}

async function _writeStorage(key, data) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [key]: JSON.stringify(data) }, resolve);
  });
}

// single-flight：避免同一 key 并发构建
const _buildLocks = {};

async function _withLock(key, fn) {
  if (_buildLocks[key]) return _buildLocks[key];
  _buildLocks[key] = (async () => {
    try { return await fn(); } finally { delete _buildLocks[key]; }
  })();
  return _buildLocks[key];
}

async function buildHeatmapCached(topN, groupBy, sizeBy, force = false) {
  const td  = currentTradingDate();
  const key = _storageKey(topN, groupBy, sizeBy, td);

  async function _tryCache() {
    if (!force) {
      const m = await _tryMemCache(key, td);
      if (m) return m;
      const s = await _tryStorageCache(key);
      if (s) {
        _memCache[key] = { ts: Date.now() / 1000, td, data: s };
        return s;
      }
    }
    return null;
  }

  // 先试缓存（无锁快速路径）
  const hit1 = await _tryCache();
  if (hit1) return hit1;

  // single-flight：同一 key 只允许一个构建
  return _withLock(key, async () => {
    // 双重检查
    const hit2 = await _tryCache();
    if (hit2) return hit2;

    const data = await HeatmapBuilder.buildHeatmapData(topN, groupBy, sizeBy);
    data.cache_type = "fresh";

    _memCache[key] = { ts: Date.now() / 1000, td, data };
    _writeStorage(key, data).catch(() => {});

    return data;
  });
}

window.HeatmapCache = { buildHeatmapCached };
