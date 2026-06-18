// ═══════════════════════════════════════════════════════════════════
// 共享工具
// ═══════════════════════════════════════════════════════════════════
const COLOR_DN  = [26,  152,  80];
const COLOR_MID = [247, 247, 247];
const COLOR_UP  = [215,  48,  39];
const CMAX = 0.055;

function lerpRGB(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
function changeToColor(g) {
  const t = Math.max(0, Math.min(1, ((g || 0) / CMAX + 1) / 2));
  const [from, to, u] = t < 0.5 ? [COLOR_DN, COLOR_MID, t * 2] : [COLOR_MID, COLOR_UP, (t - 0.5) * 2];
  const [r, gv, b] = lerpRGB(from, to, u);
  return `rgb(${r},${gv},${b})`;
}
function fmtPct(g)      { if (g == null) return '—'; const p = g * 100; return (p >= 0 ? '+' : '') + p.toFixed(2) + '%'; }
function fmtVol(v)      { return v >= 10000 ? (v / 10000).toFixed(2) + ' 亿' : v.toFixed(0) + ' 万'; }
function fmtMktcap(v)   { return v >= 10000 ? (v / 10000).toFixed(1) + ' 万亿' : v.toFixed(0) + ' 亿'; }
function fmtSize(v, unit) { return unit === '亿元' ? fmtMktcap(v) : fmtVol(v); }
function chgColor(g)    { return g > 0.001 ? '#ff4d4f' : g < -0.001 ? '#52c41a' : '#aaa'; }
function isMobile()     { return window.innerWidth < 768; }

const SIZE_INFO = {
  vol:       { label: '成交额',   unit: '万元' },
  mktcap:    { label: '总市值',   unit: '亿元' },
  float_cap: { label: '流通市值', unit: '亿元' },
};
const CACHE_LABELS = {
  fresh:  { cls: 'c-fresh',  text: '实时数据' },
  memory: { cls: 'c-memory', text: '内存缓存' },
  local:  { cls: 'c-local',  text: '本地缓存' },
};

// ═══════════════════════════════════════════════════════════════════
// 懒加载：Plotly / ECharts
// ═══════════════════════════════════════════════════════════════════
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
async function ensurePlotly() {
  if (!window.Plotly) await loadScript('lib/plotly-2.35.2.min.js');
}
async function ensureECharts() {
  if (!window.echarts) await loadScript('lib/echarts-5.5.1.min.js');
}

// ═══════════════════════════════════════════════════════════════════
// Plotly 渲染
// ═══════════════════════════════════════════════════════════════════
function buildHoverStr(n, pid, sLabel, sUnit) {
  function extras(n) {
    const lines = [];
    const sVal = n.v;
    if (sVal > 0) lines.push(`${sLabel}: ${fmtSize(sVal, sUnit)}`);
    if (n.vol   > 0) lines.push(`成交额: ${fmtVol(n.vol)} 万`);
    if (n.mktcap > 0) lines.push(`总市值: ${fmtMktcap(n.mktcap)}`);
    if (n.float_cap > 0 && Math.abs(n.float_cap - n.mktcap) > 0.1)
      lines.push(`流通市值: ${fmtMktcap(n.float_cap)}`);
    return lines.map(l => l + '<br>').join('');
  }
  const gc = chgColor(n.g), chgHtml = `<span style="color:${gc};font-weight:bold">${fmtPct(n.g)}</span>`;
  const src = n.src ? `<span style="color:#666;font-size:11px"> ${n.src}</span>` : '';
  if (pid === '')
    return `<b>全市场（A股）</b><br>涨跌幅: ${chgHtml}${src}<br>${extras(n)}全市场股票数: ${n.cnt}`;
  if (n.cnt != null)
    return `<b>${n.n}</b><br>涨跌幅: ${chgHtml}${src}<br>${extras(n)}股票数: ${n.cnt}`;
  return `<b>${n.n}</b>（${n.c}）<br>涨跌幅: ${chgHtml}<br>${extras(n)}`;
}

function toPlotly(apiData) {
  const sLabel = apiData.size_label || '成交额';
  const sUnit  = apiData.size_unit  || '万元';
  const ids = [], labels = [], parents = [], values = [], colors = [], texts = [], hovers = [];

  function walk(n, pid) {
    const myId = pid === '' ? '__root__' : (n.children ? `__s__${n.n}` : n.c);
    ids.push(myId); labels.push(n.n); parents.push(pid);
    values.push(n.v); colors.push(n.g || 0);
    texts.push(`${n.n}<br>${fmtPct(n.g)}`);
    hovers.push(buildHoverStr(n, pid, sLabel, sUnit));
    if (n.children) n.children.forEach(c => walk(c, myId));
  }
  walk(apiData.root, '');

  const trace = {
    type: 'treemap', ids, labels, parents, values,
    branchvalues: 'total',
    marker: {
      colors,
      colorscale: [[0, '#1a9850'], [0.5, '#f7f7f7'], [1, '#d73027']],
      cmid: 0, cmin: -CMAX, cmax: CMAX,
      colorbar: {
        title: { text: '涨跌幅', font: { color: '#e6edf3', size: 12 } },
        tickformat: '+.1%', tickfont: { color: '#e6edf3', size: 11 },
        len: 0.55, thickness: 15,
      },
      pad: { t: 3, l: 3, r: 3, b: 3 },
    },
    text: texts, textinfo: 'text',
    customdata: hovers, hovertemplate: '%{customdata}<extra></extra>',
    textfont: { size: 12, family: 'Microsoft YaHei, SimHei, sans-serif' },
    tiling: { packing: 'squarify', pad: 2 },
  };

  const layout = {
    title: { text: apiData.title, font: { size: 13, color: '#e6edf3' } },
    margin: { t: 52, l: 8, r: 8, b: 8 },
    paper_bgcolor: '#0d1117', plot_bgcolor: '#0d1117',
    font: { color: '#e6edf3', family: 'Microsoft YaHei, SimHei, sans-serif' },
    autosize: true,
  };
  return { trace, layout };
}

const plotlyConfig = {
  responsive: true, displaylogo: false,
  modeBarButtonsToRemove: ['select2d', 'lasso2d'],
  toImageButtonOptions: { format: 'png', scale: 2 },
};

// ═══════════════════════════════════════════════════════════════════
// ECharts 渲染
// ═══════════════════════════════════════════════════════════════════
function buildECNode(n, depth, sLabel, sUnit) {
  const isBranch = n.children && n.children.length > 0;

  const gc = chgColor(n._g);
  const chgHtml = `<span style="color:${gc};font-weight:bold">${fmtPct(n._g)}</span>`;
  const src = n._src ? `<span style="color:#666;font-size:11px"> ${n._src}</span>` : '';
  function extras(n) {
    const lines = [];
    if (n._sizeVal > 0) lines.push(`${sLabel}: ${fmtSize(n._sizeVal, sUnit)}`);
    if (n._vol    > 0) lines.push(`成交额: ${fmtVol(n._vol)} 万`);
    if (n._mktcap > 0) lines.push(`总市值: ${fmtMktcap(n._mktcap)}`);
    if (n._float  > 0 && Math.abs(n._float - n._mktcap) > 0.1)
      lines.push(`流通市值: ${fmtMktcap(n._float)}`);
    return lines.map(l => l + '<br>').join('');
  }
  let hover;
  if (!n._c && n._cnt != null)
    hover = `<b>${depth === 0 ? '全市场（A股）' : n.name}</b><br>涨跌幅: ${chgHtml}${src}<br>${extras(n)}${depth === 0 ? `全市场股票数: ${n._cnt}` : `股票数: ${n._cnt}`}`;
  else if (n._c)
    hover = `<b>${n.name}</b>（${n._c}）<br>涨跌幅: ${chgHtml}<br>${extras(n)}`;

  const nodeColor = depth === 0 ? 'transparent'
                  : (depth === 1 && isBranch) ? '#1a2332'
                  : changeToColor(n._g);

  const node = {
    name: n.name, value: n.value,
    _g: n._g, _c: n._c || null, _cnt: n._cnt, _hover: hover || '',
    itemStyle: {
      color: nodeColor, borderColor: '#0d1117',
      borderWidth: depth === 0 ? 0 : depth === 1 ? 2 : 1,
      gapWidth:    depth === 0 ? 0 : depth === 1 ? 3 : 2,
    },
  };
  if (isBranch) node.children = n.children.map(c => buildECNode(c, depth + 1, sLabel, sUnit));
  return node;
}

function apiToEC(n, depth, sizeByCfg) {
  const { sizeBy } = sizeByCfg;
  const sizeVal = sizeBy === 'mktcap' ? n.mktcap : sizeBy === 'float_cap' ? n.float_cap : n.vol;
  const mapped = {
    name: n.n, value: n.v, _g: n.g || 0, _c: n.c || null,
    _cnt: n.cnt != null ? n.cnt : null, _src: n.src || '',
    _sizeVal: sizeVal || n.v, _vol: n.vol || 0,
    _mktcap: n.mktcap || 0, _float: n.float_cap || 0,
  };
  if (n.children) mapped.children = n.children.map(c => apiToEC(c, depth + 1, sizeByCfg));
  return mapped;
}

function buildECOption(apiData) {
  const sizeBy = apiData.size_by || 'mktcap';
  const sLabel = apiData.size_label || '总市值';
  const sUnit  = apiData.size_unit  || '亿元';

  const rootEC   = apiToEC(apiData.root, 0, { sizeBy });
  const rootNode = buildECNode(rootEC, 0, sLabel, sUnit);

  const raw   = apiData.title || 'A股热力树图';
  const parts = raw.split('    |    ');
  const main  = parts[0].trim();
  const sub   = parts.slice(1, 4).map(s => s.trim()).join('  ·  ');

  return {
    backgroundColor: '#0d1117',
    title: {
      text: main, subtext: sub, left: 8, top: 4,
      textStyle:    { color: '#e6edf3', fontSize: 12, fontWeight: 'normal',
                      fontFamily: 'Microsoft YaHei, SimHei, sans-serif' },
      subtextStyle: { color: '#8b949e', fontSize: 10,
                      fontFamily: 'Microsoft YaHei, SimHei, sans-serif' },
    },
    tooltip: {
      confine: true, backgroundColor: '#1c2128', borderColor: '#30363d', padding: [10, 14],
      textStyle: { color: '#e6edf3', fontSize: 13, fontFamily: 'Microsoft YaHei, SimHei, sans-serif' },
      formatter: p => p.data?._hover || p.data?.name || '',
    },
    visualMap: {
      type: 'continuous', min: -CMAX * 100, max: CMAX * 100,
      inRange: { color: ['#1a9850', '#f7f7f7', '#d73027'] },
      calculable: false, orient: 'vertical', right: 10, top: 'middle',
      itemHeight: 110, itemWidth: 14,
      formatter: v => (v > 0 ? '+' : '') + v.toFixed(1) + '%',
      textStyle: { color: '#8b949e', fontSize: 10 }, borderWidth: 0,
    },
    series: [{
      type: 'treemap', width: '100%', height: '100%', top: 50,
      roam: false, nodeClick: 'zoomToNode',
      squareRatio: 0.5 * (1 + Math.sqrt(5)), visibleMin: 150,
      label: {
        show: true,
        formatter(p) {
          const d = p.data; if (!d) return '';
          const light = Math.abs(d._g || 0) < 0.02;
          return light
            ? `{nm_dk|${d.name}}\n{pc_dk|${fmtPct(d._g)}}`
            : `{nm_lt|${d.name}}\n{pc_lt|${fmtPct(d._g)}}`;
        },
        rich: {
          nm_lt: { fontSize: 12, fontWeight: 'bold', color: '#f0f6fc', lineHeight: 18,
                   fontFamily: 'Microsoft YaHei, SimHei, sans-serif' },
          pc_lt: { fontSize: 11, color: 'rgba(255,255,255,0.82)', lineHeight: 15,
                   fontFamily: 'Microsoft YaHei, SimHei, sans-serif' },
          nm_dk: { fontSize: 12, fontWeight: 'bold', color: '#1a1a1a', lineHeight: 18,
                   fontFamily: 'Microsoft YaHei, SimHei, sans-serif' },
          pc_dk: { fontSize: 11, color: '#333', lineHeight: 15,
                   fontFamily: 'Microsoft YaHei, SimHei, sans-serif' },
        },
        overflow: 'truncate', ellipsis: '…',
      },
      upperLabel: {
        show: true, height: 28,
        formatter(p) {
          const d = p.data;
          const ck = d._g > 0.001 ? 'cup' : d._g < -0.001 ? 'cdn' : 'cfl';
          return `{uname|${d.name}}  {${ck}|${fmtPct(d._g)}}`;
        },
        rich: {
          uname: { fontSize: 12, fontWeight: 'bold', color: '#e6edf3',
                   fontFamily: 'Microsoft YaHei, SimHei, sans-serif' },
          cup:   { fontSize: 11, color: '#ff8080',
                   fontFamily: 'Microsoft YaHei, SimHei, sans-serif' },
          cdn:   { fontSize: 11, color: '#52de7a',
                   fontFamily: 'Microsoft YaHei, SimHei, sans-serif' },
          cfl:   { fontSize: 11, color: '#aaa',
                   fontFamily: 'Microsoft YaHei, SimHei, sans-serif' },
        },
        backgroundColor: 'rgba(0,0,0,0.55)', overflow: 'truncate',
      },
      itemStyle: { borderColor: '#0d1117', borderWidth: 1, gapWidth: 2 },
      emphasis: {
        label: { show: true }, upperLabel: { show: true },
        itemStyle: { borderColor: '#58a6ff', borderWidth: 2 },
      },
      breadcrumb: {
        show: true, bottom: 4, height: 20, emptyItemWidth: 20,
        itemStyle: {
          color: '#21262d', borderColor: '#30363d',
          textStyle: { color: '#8b949e', fontSize: 11 },
        },
      },
      data: [rootNode],
    }],
  };
}

// ═══════════════════════════════════════════════════════════════════
// 渲染状态
// ═══════════════════════════════════════════════════════════════════
let currentRenderer = isMobile() ? 'echarts' : 'plotly';
let echartsInst     = null;
let lastApiData     = null;

async function renderChart(data) {
  lastApiData = data;
  if (currentRenderer === 'plotly') {
    await ensurePlotly();
    if (echartsInst) { echartsInst.dispose(); echartsInst = null; }
    const { trace, layout } = toPlotly(data);
    Plotly.react('chart', [trace], layout, plotlyConfig);
  } else {
    await ensureECharts();
    if (window.Plotly) Plotly.purge('chart');
    const dom = document.getElementById('chart');
    if (!echartsInst || echartsInst.isDisposed()) {
      echartsInst = echarts.init(dom, null, { renderer: 'canvas' });
    }
    echartsInst.setOption(buildECOption(data), { notMerge: true });
  }
}

async function exportChart(format, scale, filename) {
  if (currentRenderer === 'plotly') {
    await Plotly.downloadImage('chart', { format, scale, filename });
  } else {
    const url = echartsInst.getDataURL({
      type: format === 'jpeg' ? 'jpeg' : 'png',
      pixelRatio: scale, backgroundColor: '#0d1117',
      excludeComponents: ['toolbox'],
    });
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
}

// ═══════════════════════════════════════════════════════════════════
// DOM 绑定
// ═══════════════════════════════════════════════════════════════════
const dot            = document.getElementById('dot');
const statusTxt      = document.getElementById('status-txt');
const sBadge         = document.getElementById('s-badge');
const sProg          = document.getElementById('sector-prog');
const empty          = document.getElementById('empty');
const overlay        = document.getElementById('loading-overlay');
const loadingTxt     = document.getElementById('loading-txt');
const btn            = document.getElementById('btn-generate');
const topNSel        = document.getElementById('top-n');
const sizeToggle     = document.getElementById('size-toggle');
const grpToggle      = document.getElementById('grp-toggle');
const rendererToggle = document.getElementById('renderer-toggle');
const btnExport      = document.getElementById('btn-export');
const exportFmt      = document.getElementById('export-fmt');
const btnForce       = document.getElementById('btn-force');
const cacheBar       = document.getElementById('cache-bar');
const cacheBadge     = document.getElementById('cache-badge');
const cacheInfo      = document.getElementById('cache-info');

function setStatus(type, text) { dot.className = 'dot ' + type; statusTxt.textContent = text; }

function showCacheInfo(data) {
  const info = CACHE_LABELS[data.cache_type] || CACHE_LABELS.fresh;
  cacheBadge.className   = `c-badge ${info.cls}`;
  cacheBadge.textContent = info.text;
  const parts = [];
  if (data.generated_at)  parts.push(`数据时间：${data.generated_at}`);
  if (data.trading_date)  parts.push(`交易日：${data.trading_date}`);
  if (data.market_status) parts.push(data.market_status === 'open' ? '📈 盘中' : '🔒 已闭市');
  cacheInfo.textContent = parts.join('  ·  ');
  cacheBar.classList.remove('hidden');
}

// 行业状态回调（替代原轮询）
DataLayer.onSectorProgress(d => {
  sProg.textContent = d.progress || '初始化中...';
  if (d.ready) {
    sBadge.textContent = `申万行业已就绪（${d.count} 只）`;
    sBadge.className = 's-badge s-ready';
  } else {
    sBadge.textContent = '行业加载中';
    sBadge.className = 's-badge s-loading';
  }
});

// 启动后台行业映射构建
DataLayer.buildSectorMap();

// 初始化渲染器
rendererToggle.querySelectorAll('.toggle-btn').forEach(b =>
  b.classList.toggle('active', b.dataset.val === currentRenderer)
);
if (currentRenderer === 'echarts') ensureECharts();
else ensurePlotly();

// 切换参数
let sizeBy  = 'mktcap';
let groupBy = 'sector';

sizeToggle.addEventListener('click', e => {
  const b = e.target.closest('.toggle-btn'); if (!b) return;
  sizeBy = b.dataset.val;
  sizeToggle.querySelectorAll('.toggle-btn').forEach(x => x.classList.toggle('active', x === b));
});
grpToggle.addEventListener('click', e => {
  const b = e.target.closest('.toggle-btn'); if (!b) return;
  groupBy = b.dataset.val;
  grpToggle.querySelectorAll('.toggle-btn').forEach(x => x.classList.toggle('active', x === b));
});

// 切换渲染器
rendererToggle.addEventListener('click', async e => {
  const b = e.target.closest('.toggle-btn'); if (!b) return;
  if (b.dataset.val === currentRenderer) return;
  currentRenderer = b.dataset.val;
  rendererToggle.querySelectorAll('.toggle-btn').forEach(x => x.classList.toggle('active', x === b));
  if (lastApiData) {
    overlay.classList.add('active');
    loadingTxt.textContent = `切换至 ${currentRenderer === 'plotly' ? 'Plotly' : 'ECharts'} 渲染...`;
    try {
      await renderChart(lastApiData);
    } finally {
      overlay.classList.remove('active');
    }
  }
});

// 强制刷新
let pendingForce = false;
btnForce.addEventListener('click', () => { pendingForce = true; btn.click(); });

// 移动端默认数量
if (isMobile()) topNSel.value = '200';

// 生成图表
btn.addEventListener('click', async () => {
  const topN  = parseInt(topNSel.value, 10);
  const si    = SIZE_INFO[sizeBy] || SIZE_INFO.mktcap;
  const scope = topNSel.value === '0' ? '全部' : `${si.label}前 ${topN} 只`;
  const mode  = groupBy === 'sector' ? '按板块' : '平铺';

  btn.disabled = true;
  overlay.classList.add('active');
  loadingTxt.textContent = `正在拉取实时行情（${scope} · ${mode}）...`;
  setStatus('loading', `加载中：${scope} · ${mode}（约 3～10 秒）`);

  const tips = [
    `正在从腾讯财经获取实时数据（${scope}）...`,
    groupBy === 'sector' ? '正在按申万行业分组...' : '正在整理平铺视图...',
    '正在匹配大盘指数和板块涨跌幅...',
    `正在使用 ${currentRenderer === 'plotly' ? 'Plotly' : 'ECharts'} 渲染...`,
  ];
  let ti = 0;
  const tipTimer = setInterval(() => { loadingTxt.textContent = tips[ti++ % tips.length]; }, 4000);

  try {
    const t0 = Date.now();
    const data = await HeatmapCache.buildHeatmapCached(topN, groupBy, sizeBy, pendingForce);
    pendingForce = false;
    clearInterval(tipTimer);

    empty.classList.add('hidden');
    overlay.classList.remove('active');

    await renderChart(data);
    btnExport.disabled = false;
    showCacheInfo(data);

    const si2 = SIZE_INFO[sizeBy] || SIZE_INFO.mktcap;
    document.getElementById('legend-size-tip').textContent =
      `色块大小 = ${si2.label}（${si2.unit}） · 颜色 = 涨跌幅（板块/全市场来自官方指数）`;

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    setStatus('ok', `图表生成成功 ✓（${currentRenderer === 'plotly' ? 'Plotly' : 'ECharts'}）— 耗时 ${elapsed}s | ${new Date().toLocaleString('zh-CN')}`);
  } catch (err) {
    clearInterval(tipTimer); overlay.classList.remove('active');
    setStatus('err', `错误：${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
});

// 导出
btnExport.addEventListener('click', async () => {
  const [format, scaleStr] = exportFmt.value.split('|');
  const scale    = parseInt(scaleStr, 10);
  const date     = new Date().toLocaleDateString('zh-CN').replace(/\//g, '-');
  const si       = SIZE_INFO[sizeBy] || SIZE_INFO.mktcap;
  const mode     = groupBy === 'sector' ? '按板块' : '平铺';
  const topN     = topNSel.value === '0' ? '全部' : `前${topNSel.value}`;
  const renderer = currentRenderer === 'plotly' ? 'Plotly' : 'ECharts';
  const filename = `A股热力树图_${date}_${topN}_${si.label}_${mode}_${renderer}.${format}`;

  const origHTML = btnExport.innerHTML;
  btnExport.disabled = true; btnExport.classList.add('exporting');
  btnExport.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> 生成中...`;
  try {
    await exportChart(format, scale, filename);
    btnExport.classList.remove('exporting'); btnExport.classList.add('done');
    btnExport.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"/></svg> 已导出`;
    setTimeout(() => { btnExport.classList.remove('done'); btnExport.innerHTML = origHTML; btnExport.disabled = false; }, 2500);
  } catch (err) {
    btnExport.classList.remove('exporting'); btnExport.innerHTML = origHTML; btnExport.disabled = false;
    setStatus('err', `导出失败：${err.message}`);
  }
});

// 响应式
new ResizeObserver(() => {
  if (currentRenderer === 'plotly' && window.Plotly) Plotly.relayout('chart', { autosize: true });
  else if (echartsInst && !echartsInst.isDisposed()) echartsInst.resize();
}).observe(document.getElementById('chart-wrap'));

// ── 全屏模式 ────────────────────────────────────────────────────────
function resizeChart() {
  requestAnimationFrame(() => {
    if (currentRenderer === 'plotly' && window.Plotly) Plotly.relayout('chart', { autosize: true });
    else if (echartsInst && !echartsInst.isDisposed()) echartsInst.resize();
  });
}

function enterFs() {
  document.body.classList.add('is-fs');
  resizeChart();
}
function exitFs() {
  document.body.classList.remove('is-fs');
  resizeChart();
}

document.getElementById('btn-fullscreen').addEventListener('click', enterFs);
document.getElementById('btn-exit-fs').addEventListener('click', exitFs);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('is-fs')) exitFs();
});

// 全屏悬浮栏导出
document.getElementById('btn-fs-export').addEventListener('click', async () => {
  const fsBtn = document.getElementById('btn-fs-export');
  const [format, scaleStr] = document.getElementById('fs-export-fmt').value.split('|');
  const scale    = parseInt(scaleStr, 10);
  const date     = new Date().toLocaleDateString('zh-CN').replace(/\//g, '-');
  const si       = SIZE_INFO[sizeBy] || SIZE_INFO.mktcap;
  const mode     = groupBy === 'sector' ? '按板块' : '平铺';
  const topN     = topNSel.value === '0' ? '全部' : `前${topNSel.value}`;
  const renderer = currentRenderer === 'plotly' ? 'Plotly' : 'ECharts';
  const filename = `A股热力树图_${date}_${topN}_${si.label}_${mode}_${renderer}.${format}`;

  const orig = fsBtn.textContent;
  fsBtn.textContent = '生成中...'; fsBtn.disabled = true;
  try {
    await exportChart(format, scale, filename);
    fsBtn.textContent = '✓ 已导出';
    setTimeout(() => { fsBtn.textContent = orig; fsBtn.disabled = false; }, 2000);
  } catch (err) {
    fsBtn.textContent = orig; fsBtn.disabled = false;
    setStatus('err', `导出失败：${err.message}`);
  }
});
