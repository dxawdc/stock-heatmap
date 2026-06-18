// ── 交易日历：新浪 klc_td_sh.txt → 识别法定节假日 ────────────────
// 网页版用 akshare 交易日历，插件版无后端，改为前端直连新浪同源接口，
// 用 SinaDateDecode（lib/sina-date-decode.js）解码后构建交易日集合。
// 拉取失败时 _tradeDaySet 保持 null，market.js 自动退回「仅排除周末」。

const TRADE_CAL_STORAGE_KEY = "trade_calendar_cache";
const TRADE_CAL_TTL = 86400 * 7;   // 7 天：交易日历稳定，无需频繁刷新
const TRADE_CAL_URL = "https://finance.sina.com.cn/realstock/company/klc_td_sh.txt";

let _tradeDaySet = null;           // Set<"YYYY-MM-DD">；null = 日历未就绪

/** 解码器返回的 Date 为 UTC 零点，必须用 getUTC* 取日期，否则 UTC+8 会偏移一天 */
function _utcDateStr(d) {
  const y  = d.getUTCFullYear();
  const m  = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function _loadCalFromStorage() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(TRADE_CAL_STORAGE_KEY, r => {
        const e = r[TRADE_CAL_STORAGE_KEY];
        if (e && e.ts && (Date.now() / 1000 - e.ts) < TRADE_CAL_TTL &&
            Array.isArray(e.days) && e.days.length) {
          resolve(e.days);
        } else {
          resolve(null);
        }
      });
    } catch (_) { resolve(null); }
  });
}

function _saveCalToStorage(days) {
  try {
    chrome.storage.local.set({ [TRADE_CAL_STORAGE_KEY]: { ts: Date.now() / 1000, days } });
  } catch (_) {}
}

/** 拉取并解码新浪交易日历，返回 ["YYYY-MM-DD", ...]（含当年全部交易日） */
async function fetchTradeCalendar() {
  const resp = await fetch(TRADE_CAL_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  // 形如 var datelist="...."; —— 复刻 akshare: split('=')[1].split(';')[0].replace('"','')
  const datelist = text.split("=")[1].split(";")[0].replace(/"/g, "").trim();
  const dates = window.SinaDateDecode(datelist);   // Date[]
  return dates.map(_utcDateStr);
}

/** 启动时调用：优先读本地缓存，否则拉取新浪。失败则保持 null（退回周末逻辑） */
async function initTradeCalendar() {
  try {
    const cached = await _loadCalFromStorage();
    if (cached) { _tradeDaySet = new Set(cached); return; }

    const days = await fetchTradeCalendar();
    if (days.length) {
      _tradeDaySet = new Set(days);
      _saveCalToStorage(days);
    }
  } catch (_) {
    // 保持 _tradeDaySet = null，market.js 退回「仅排除周末」
  }
}

/**
 * 判断某日是否为交易日。
 * @returns {boolean|null} true=交易日 / false=非交易日（含节假日） / null=日历未就绪
 */
function isTradeDay(dateStr) {
  if (_tradeDaySet) return _tradeDaySet.has(dateStr);
  return null;
}

window.TradeCalendar = { initTradeCalendar, isTradeDay };
