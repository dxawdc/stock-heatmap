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

/**
 * 某日是否为非交易日。
 * 交易日历就绪时按新浪日历判断（含法定节假日）；
 * 未就绪时退回「仅排除周末」。
 */
function isNonTradingDay(date) {
  const trade = window.TradeCalendar ? window.TradeCalendar.isTradeDay(localDateStr(date)) : null;
  if (trade !== null) return !trade;          // 日历就绪：节假日/周末均判为非交易日
  const wd = date.getDay();                   // 日历未就绪：退回仅排除周末
  return wd === 0 || wd === 6;
}

/** A股是否正在交易（交易日历就绪时识别节假日，否则仅排除周末） */
function isMarketOpen() {
  const t = nowHM();
  if (isNonTradingDay(t.date)) return false;
  const now = { h: t.h, m: t.m };
  return (cmpHM(MARKET.OPEN_AM, now) <= 0 && cmpHM(now, MARKET.CLOSE_AM) <= 0) ||
         (cmpHM(MARKET.OPEN_PM, now) <= 0 && cmpHM(now, MARKET.CLOSE_PM) <= 0);
}

/** 'open' | 'closed' */
function marketStatus() {
  return isMarketOpen() ? "open" : "closed";
}

/**
 * 本地时区日期 YYYY-MM-DD。
 * 不能用 toISOString()——它返回 UTC 日期，与本地时间的盘中判断混用，
 * 在 UTC+8 凌晨会算成前一天，导致交易日/缓存键错位。
 */
function localDateStr(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * 当前所属 A股交易日 YYYY-MM-DD（本地时区）。
 * 开盘前（9:30 之前）回退一天，再向前找到最近交易日；
 * 交易日历就绪时会跳过法定节假日，否则仅跳过周末。
 */
function currentTradingDate() {
  const d = nowHM();
  const cur = new Date(d.date);

  // 开盘前视作上一交易日
  if (d.h < 9 || (d.h === 9 && d.m < 30)) cur.setDate(cur.getDate() - 1);

  // 向前找最近交易日（节假日/周末均跳过）
  let guard = 0;
  while (isNonTradingDay(cur) && guard++ < 30) cur.setDate(cur.getDate() - 1);

  return localDateStr(cur);
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
