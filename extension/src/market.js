// 复刻 app.py:103-182 的市场时间判断和代码归一化工具

const MARKET = {
  OPEN_AM:  { h: 9, m: 25 },
  CLOSE_AM: { h: 11, m: 31 },
  OPEN_PM:  { h: 13, m: 0 },
  CLOSE_PM: { h: 15, m: 1 },
};

function nowHM() {
  const d = new Date();
  return { weekday: d.getDay(), h: d.getHours(), m: d.getMinutes(), date: d };
}

function cmpHM(a, b) {
  if (a.h !== b.h) return a.h - b.h;
  return a.m - b.m;
}

/** A股是否正在交易（仅排除周末，节假日不处理） */
function isMarketOpen() {
  const t = nowHM();
  if (t.weekday >= 5) return false;
  const now = { h: t.h, m: t.m };
  return (cmpHM(MARKET.OPEN_AM, now) <= 0 && cmpHM(now, MARKET.CLOSE_AM) <= 0) ||
         (cmpHM(MARKET.OPEN_PM, now) <= 0 && cmpHM(now, MARKET.CLOSE_PM) <= 0);
}

/** 'open' | 'closed' */
function marketStatus() {
  return isMarketOpen() ? "open" : "closed";
}

/**
 * 当前所属 A股交易日 YYYY-MM-DD。
 * 盘后/周末 → 最近的交易日（周五或更早），节假日不处理。
 */
function currentTradingDate() {
  const d = nowHM();
  const today = d.date;
  const wd = today.getDay();

  if (wd === 0) {
    const r = new Date(today); r.setDate(r.getDate() - 2);
    return r.toISOString().slice(0, 10);
  }
  if (wd === 6) {
    const r = new Date(today); r.setDate(r.getDate() - 1);
    return r.toISOString().slice(0, 10);
  }

  if (d.h < 9 || (d.h === 9 && d.m < 30)) {
    const r = new Date(today);
    r.setDate(r.getDate() - 1);
    while (r.getDay() >= 5) r.setDate(r.getDate() - 1);
    return r.toISOString().slice(0, 10);
  }

  return today.toISOString().slice(0, 10);
}

/** sh600519 → 600519 */
function normalizeCode(code) {
  return String(code).replace(/^(sh|sz|bj)/, "");
}

/** 未映射到申万行业时的交易所板块兜底 */
function getBoardFallback(code) {
  const c = normalizeCode(code);
  if (c.startsWith("688")) return "科创板";
  if (c.startsWith("300") || c.startsWith("301")) return "创业板";
  if (c.startsWith("002") || c.startsWith("003")) return "中小板";
  if (c.startsWith("60")) return "沪市主板";
  if (c.startsWith("000") || c.startsWith("001")) return "深市主板";
  if (c.startsWith("4") || c.startsWith("8")) return "北交所";
  return "其他";
}

/** 交易所板块兜底映射（sector_map 未就绪时使用） */
function buildFallbackMap(codes) {
  const map = {};
  for (const full of codes) map[normalizeCode(full)] = getBoardFallback(full);
  return map;
}
