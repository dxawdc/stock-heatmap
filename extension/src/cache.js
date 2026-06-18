// ── 两级缓存：内存 + chrome.storage.local ──────────────────────

const _memCache = {};           // key → { ts, td, data }
const MARKET_OPEN_TTL = 120;    // 盘中 2min

// 统一出口：title 按当前时间动态渲染（CACHE_VERSION/renderTitle 来自 heatmap.js，先于本文件加载）
function _finalize(data, cacheType) {
  return { ...data, title: HeatmapBuilder.renderTitle(data.title_meta), cache_type: cacheType };
}

function _storageKey(topN, groupBy, sizeBy, td) {
  return `heatmap_${CACHE_VERSION}_${td}_${topN}_${groupBy}_${sizeBy}`;
}

async function _tryMemCache(key, td) {
  const entry = _memCache[key];
  if (!entry || entry.td !== td) return null;
  if (!isMarketOpen()) return _finalize(entry.data, "memory");
  if ((Date.now() / 1000 - entry.ts) < MARKET_OPEN_TTL) return _finalize(entry.data, "memory");
  return null;
}

async function _tryStorageCache(key) {
  return new Promise(resolve => {
    chrome.storage.local.get(key, result => {
      if (!result[key]) { resolve(null); return; }
      try {
        const data = JSON.parse(result[key]);
        if (data && data.cache_version === CACHE_VERSION) resolve(_finalize(data, "local"));
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

    _memCache[key] = { ts: Date.now() / 1000, td, data };
    _writeStorage(key, data).catch(() => {});   // 存 title_meta，不存运行时 title

    return _finalize(data, "fresh");
  });
}

window.HeatmapCache = { buildHeatmapCached };
