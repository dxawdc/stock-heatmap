// ── 热力图构建逻辑：复刻 app.py 的 build_heatmap_data ────────────

const SIZE_LABELS = {
  vol:       ["成交额", "万元"],
  mktcap:    ["总市值", "亿元"],
  float_cap: ["流通市值", "亿元"],
};

const CACHE_VERSION = "v3";

function _buildTitle(sizeLabel, sizeBy, topN, nShown, groupDesc) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  // 显示范围
  const scope = topN === 0
    ? `全部 ${nShown} 只`
    : `${sizeLabel}前 ${topN} 只（实际显示 ${nShown} 只）`;

  // 市场状态
  const mstat = isMarketOpen() ? "盘中" : "闭市";

  return (
    `A股热力树图  ·  ${dateStr} ${timeStr} ${mstat}` +
    `    |    分组：${groupDesc}` +
    `    |    色块大小：${sizeLabel}` +
    `    |    显示范围：${scope}` +
    `    |    颜色：涨跌幅（板块/全市场来自官方指数）`
  );
}

async function buildHeatmapData(topN, groupBy, sizeBy) {
  const [sizeLabel, sizeUnit] = SIZE_LABELS[sizeBy] || ["成交额", "万元"];

  // 3 路并发
  const [stockResult, marketChgIndex, swSectorChg] = await Promise.all([
    DataLayer.fetchStockData(topN, sizeBy),
    DataLayer.fetchMarketIndex(),
    DataLayer.fetchSwSectorChg(),
  ]);

  const { rows: df, totalCount: marketCount } = stockResult;
  const nStocks = df.length;
  const scope = topN === 0 ? "全部" : `${sizeLabel}前 ${topN}`;

  // 根节点：大盘指数（备用等权均值）
  let rootChg = marketChgIndex;
  let rootChgSrc = "A股指数(sh000002)";
  if (rootChg === null) {
    rootChg = df.reduce((sum, r) => sum + r.chg_rate, 0) / df.length;
    rootChgSrc = "等权均值";
  }

  // 各股票 size 值
  for (const row of df) {
    row.sz = Math.round(row[sizeBy] * 10000) / 10000;
  }

  function stockNode(row) {
    return {
      n: row.name,
      c: row.code,
      v: Math.round(row.sz * 100) / 100,
      g: Math.round(row.chg_rate * 100000) / 100000,
      vol: Math.round(row.vol * 100) / 100,
      mktcap: Math.round(row.mktcap * 100) / 100,
      float_cap: Math.round(row.float_cap * 100) / 100,
    };
  }

  let children;
  let groupDesc;

  if (groupBy === "sector") {
    // 获取 sector_map（SW 或 fallback）
    const sectorMap = await DataLayer._getSectorMapWithFallback();
    const sectorStatus = DataLayer.getSectorStatus();

    if (sectorStatus.ready) {
      groupDesc = `申万行业 · ${Object.keys(sectorMap).length} 只映射`;
      for (const row of df) {
        row._sector = sectorMap[row.code_clean] || getBoardFallback(row.code);
      }
    } else {
      groupDesc = "交易所板块";
      for (const row of df) {
        row._sector = getBoardFallback(row.code);
      }
    }

    // 按板块分组
    const sectors = {};
    for (const row of df) {
      if (!sectors[row._sector]) sectors[row._sector] = [];
      sectors[row._sector].push(stockNode(row));
    }

    // 构建板块节点
    children = [];
    for (const [secName, stocks] of Object.entries(sectors)) {
      const sv = stocks.reduce((sum, s) => sum + s.v, 0);
      let sg, sgSrc;

      if (swSectorChg[secName] !== undefined) {
        sg = swSectorChg[secName];
        sgSrc = "申万指数";
      } else {
        // 加权均值
        const weightedSum = stocks.reduce((sum, s) => sum + s.g * s.v, 0);
        sg = sv > 0 ? weightedSum / sv : 0;
        sgSrc = "加权均值";
      }

      const secVol = stocks.reduce((sum, s) => sum + s.vol, 0);
      const secMktcap = stocks.reduce((sum, s) => sum + s.mktcap, 0);

      children.push({
        n: secName,
        v: Math.round(sv * 100) / 100,
        g: Math.round(sg * 100000) / 100000,
        cnt: stocks.length,
        src: sgSrc,
        vol: Math.round(secVol * 100) / 100,
        mktcap: Math.round(secMktcap * 100) / 100,
        children: stocks,
      });
    }

    groupDesc = `申万行业 · ${sectorStatus.ready ? "申万一级行业" : "交易所板块"}`;
  } else {
    // 平铺
    children = df.map(stockNode);
    groupDesc = "平铺（不分组）";
  }

  const title = _buildTitle(sizeLabel, sizeBy, topN, nStocks, groupDesc);

  // 由 children 累加（保证 branchvalues:'total' 自洽）
  const totalV   = children.reduce((sum, c) => sum + c.v, 0);
  const totalVol = children.reduce((sum, c) => sum + c.vol, 0);
  const totalMkt = children.reduce((sum, c) => sum + c.mktcap, 0);

  const td = currentTradingDate();
  const now = new Date();
  const generatedAt = `${now.toISOString().slice(0, 10)} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

  return {
    title,
    size_by: sizeBy,
    size_label: sizeLabel,
    size_unit: sizeUnit,
    root: {
      n: "A股",
      v: Math.round(totalV * 100) / 100,
      g: Math.round(rootChg * 100000) / 100000,
      cnt: marketCount,
      src: rootChgSrc,
      vol: Math.round(totalVol * 100) / 100,
      mktcap: Math.round(totalMkt * 100) / 100,
      children,
    },
    group_by: groupBy,
    trading_date: td,
    generated_at: generatedAt,
    market_status: marketStatus(),
    cache_version: CACHE_VERSION,
  };
}

window.HeatmapBuilder = { buildHeatmapData };
