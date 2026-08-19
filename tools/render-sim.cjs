#!/usr/bin/env node
/**
 * Render simulator for the LPS weekly dashboard.
 *
 * Stubs document / Chart / fetch, then evals the page's REAL <script> block against the
 * REAL published sheet CSV. Proves every chart builds, every axis referenced exists, the
 * toggle arrays still line up with the datasets by index, and the AOV arithmetic is the
 * ratio of sums rather than the average of ratios.
 *
 * This file is committed deliberately. Previous sessions rebuilt a weaker version of it
 * from scratch each time, so the verification was only as good as whoever rewrote it.
 *
 *   node tools/render-sim.cjs                 fetch the live sheet
 *   node tools/render-sim.cjs <local.csv>     use a saved CSV snapshot (offline / pre-column test)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const PAGE = process.env.RENDER_SIM_PAGE
  ? path.resolve(process.env.RENDER_SIM_PAGE)
  : path.resolve(__dirname, '../index.html');
const LOCAL_CSV = process.argv[2] || null;

let failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  PASS  ' + name); }
  else { failures++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

// ---------------------------------------------------------------- DOM + Chart stubs

const created = {};          // canvasId -> chart config
const elements = {};
const toggleCalls = {};      // containerId -> {metrics, colors, chart}
const statCalls = {};        // containerId -> [{label,value}]

function makeEl(id) {
  return elements[id] || (elements[id] = {
    id,
    _cls: new Set(),
    innerHTML: '', textContent: '', value: '',
    style: {},
    classList: {
      add: function (c) { elements[id]._cls.add(c); },
      remove: function (c) { elements[id]._cls.delete(c); },
      toggle: function (c, f) { f ? elements[id]._cls.add(c) : elements[id]._cls.delete(c); },
      contains: function (c) { return elements[id]._cls.has(c); },
    },
    parentElement: { classList: { add() {}, remove() {}, contains() { return false; } } },
    appendChild() {},
    addEventListener() {},
    insertAdjacentHTML(pos, html) { elements[id].innerHTML += html; },
    _isCanvas: false,
  });
}

const document = {
  getElementById: (id) => makeEl(id),
  createElement: () => ({ className: '', innerHTML: '', style: {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } }),
};

class Chart {
  constructor(canvas, config) {
    const id = canvas && canvas.id ? canvas.id : 'unknown';
    this.canvas = canvas;
    this.config = config;
    this.data = config.data;
    this.options = config.options;
    created[id] = this;
  }
  destroy() {}
  update() {}
  resize() {}
  setDatasetVisibility() {}
}

function fetchCSV() {
  if (LOCAL_CSV) return Promise.resolve(fs.readFileSync(LOCAL_CSV, 'utf8'));
  return new Promise((resolve, reject) => {
    const go = (u) => https.get(u, (r) => {
      if (r.statusCode > 300 && r.headers.location) return go(r.headers.location);
      let b = ''; r.on('data', c => b += c); r.on('end', () => resolve(b));
    }).on('error', reject);
    go(CSV_URL_FROM_PAGE);
  });
}

// ---------------------------------------------------------------- extract the page script

const html = fs.readFileSync(PAGE, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
if (!m) { console.error('Could not extract the inline <script> block.'); process.exit(1); }
let src = m[1];

const CSV_URL_FROM_PAGE = (src.match(/const CSV_URL='([^']+)'/) || [])[1];
if (!CSV_URL_FROM_PAGE) { console.error('Could not find CSV_URL.'); process.exit(1); }

// Intercept createToggles / populateStats so the index alignment can be asserted,
// and swap the real fetch for the stub. loadData() is called at the end of the page
// script; that call is what drives the whole simulation.
src = src
  .replace(/function createToggles\(containerId,chart,metrics,colors\)\{/,
    'function createToggles(containerId,chart,metrics,colors){__toggles(containerId,chart,metrics,colors);')
  .replace(/function populateStats\(containerId,items\)\{/,
    'function populateStats(containerId,items){__stats(containerId,items);')
  .replace(/fetch\(CSV_URL\)/, '__fetch()');

const sandbox = {
  document, Chart, console,
  Date, Math, JSON, Object, Array, Number, String, isNaN, parseFloat, parseInt, setTimeout,
  alert: (msg) => { console.log('  (page alert) ' + msg); },
  __toggles: (id, chart, metrics, colors) => { toggleCalls[id] = { chart, metrics, colors }; },
  __stats: (id, items) => { statCalls[id] = items; },
  __fetch: () => fetchCSV().then(text => ({ ok: true, status: 200, text: () => Promise.resolve(text) })),
};

// ---------------------------------------------------------------- run

(async () => {
  const names = Object.keys(sandbox);
  // allData is populated by the async fetch, so it must be read through a getter.
  // Capturing it by value here returns null every time and silently skips the
  // arithmetic assertions, which is the whole point of this file.
  // typeof guards so this sim can also be pointed at an OLDER revision of the page
  // (RENDER_SIM_PAGE=...) to establish a baseline before blaming a failure on the change.
  const fn = new Function(...names, src + '\n;return {get allData(){return allData}, applyFilter, buildDashboard,'
    + ' trailingRatio:(typeof trailingRatio!=="undefined"?trailingRatio:null),'
    + ' sumN:(typeof sumN!=="undefined"?sumN:null), fmtMoney, sum};');
  const api = fn(...names.map(k => sandbox[k]));

  // loadData() runs async; wait for the charts to appear.
  for (let i = 0; i < 200 && Object.keys(created).length < 4; i++) await new Promise(r => setTimeout(r, 50));

  section('1. Charts construct');
  check('all four charts built', Object.keys(created).length === 4, 'built: ' + Object.keys(created).join(', '));

  section('2. Dataset counts');
  /* Expected counts depend on the revision under test, so derive the expectation from
     whether the AOV series are actually present rather than hard-coding 10. This lets the
     same sim verify an earlier revision (RENDER_SIM_PAGE=...) instead of reporting a
     false failure that would train someone to ignore it. */
  const hasAovSeries = (ch, label) => !!(ch && ch.data.datasets.some(x => x.label === label));
  const adsAov = hasAovSeries(created.adsChart, 'AOV');
  const metaAov = hasAovSeries(created.metaChart, 'Meta AOV');
  console.log(`  (revision under test: ads AOV ${adsAov ? 'present' : 'absent'}, meta AOV ${metaAov ? 'present' : 'absent'})`);
  check(`adsChart has ${adsAov ? 10 : 8} datasets`, created.adsChart && created.adsChart.data.datasets.length === (adsAov ? 10 : 8),
    created.adsChart ? 'got ' + created.adsChart.data.datasets.length : 'missing');
  check(`metaChart has ${metaAov ? 10 : 9} datasets`, created.metaChart && created.metaChart.data.datasets.length === (metaAov ? 10 : 9),
    created.metaChart ? 'got ' + created.metaChart.data.datasets.length : 'missing');

  section('3. Every yAxisID exists in that chart\'s scales');
  for (const [id, ch] of Object.entries(created)) {
    const scales = Object.keys(ch.options.scales || {});
    const used = [...new Set(ch.data.datasets.map(ds => ds.yAxisID).filter(Boolean))];
    const missing = used.filter(a => !scales.includes(a));
    check(`${id}: axes ${used.join(',')} all defined`, missing.length === 0, 'missing: ' + missing.join(','));
  }

  section('4. Toggle arrays align with datasets by index');
  const pairs = { 'toggles-ads': 'adsChart', 'toggles-meta': 'metaChart', 'toggles-calls': 'callsChart', 'toggles-revenue': 'revenueChart' };
  for (const [tid, cid] of Object.entries(pairs)) {
    const t = toggleCalls[tid], c = created[cid];
    if (!t || !c) { check(`${tid} present`, false); continue; }
    check(`${tid}: datasets=metrics=colors`, c.data.datasets.length === t.metrics.length && t.metrics.length === t.colors.length,
      `datasets=${c.data.datasets.length} metrics=${t.metrics.length} colors=${t.colors.length}`);
    const bad = t.metrics.map((lbl, i) => (c.data.datasets[i] && c.data.datasets[i].label) === lbl ? null : `[${i}] "${lbl}" vs "${c.data.datasets[i] && c.data.datasets[i].label}"`).filter(Boolean);
    check(`${tid}: metrics[i] === datasets[i].label`, bad.length === 0, bad.join('; '));
  }

  section('5. AOV arithmetic (the assertion this change turns on)');
  const d = api.allData;
  const HAS_AOV = Array.isArray(d.gadsPurchaseCount);
  if (!HAS_AOV) console.log('  SKIP  this revision of the page has no AOV fields (baseline run)');
  if (HAS_AOV) {
  const idx = d.gadsPurchaseCount.map((c, i) => (c && c > 0 && d.gadsPurchaseValueApi[i] > 0) ? i : -1).filter(i => i >= 0);
  const sN = (a) => a.reduce((x, y) => x + (y || 0), 0);
  const correct = api.fmtMoney(sN(idx.map(i => d.gadsPurchaseValueApi[i])) / sN(idx.map(i => d.gadsPurchaseCount[i])));
  const fromJ = api.fmtMoney(sN(idx.map(i => d.googleAdsPurchases[i])) / sN(idx.map(i => d.gadsPurchaseCount[i])));
  const tile = (statCalls['ads-stats'].find(s => s.label === 'Avg Order Value') || {}).value;

  /* The avg-of-ratios comparison must be built from the page's OWN plotted series, which is
     rounded to 2dp by aovOf. Re-deriving it from raw division lets a genuine avg-of-ratios
     bug slip through on a cents-level difference: measured, that gap alone let mutant 3
     survive this assertion while failing the sum/sum one. */
  const plotted = (chartId, label) => created[chartId].data.datasets.find(x => x.label === label).data;
  const avgOfPlotted = (series) => { const v = series.filter(x => x != null); return api.fmtMoney(v.reduce((a, b) => a + b, 0) / v.length); };

  /* No populated AA/AB at all is the graceful-degradation case (page deployed before the
     backfill, or pointed at an older sheet). The correct behaviour there is an em-dash, so
     assert THAT rather than an arithmetic identity over an empty set. */
  const DEGRADED = idx.length === 0;
  if (DEGRADED) {
    console.log('  NOTE  no populated AA/AB in this feed: checking graceful degradation instead');
    check('ads AOV tile degrades to em-dash', tile === '—', `got ${JSON.stringify(tile)}`);
    check('ads Purchases tile degrades to em-dash', (statCalls['ads-stats'].find(s => s.label === 'Purchases') || {}).value === '—');
    check('ads Purchase Value tile degrades to em-dash', (statCalls['ads-stats'].find(s => s.label === 'Purchase Value') || {}).value === '—');
  } else {
  check('ads AOV tile = sum(AB)/sum(AA) to the cent', tile === correct, `tile=${tile} expected=${correct}`);
  check('ads AOV tile is NOT sum(J)/sum(AA)', tile !== fromJ, `both = ${tile}`);
  check('ads AOV tile is NOT avg(weekly AOVs)', tile !== avgOfPlotted(plotted('adsChart', 'AOV')), `both = ${tile}`);
  }

  // Meta AOV does not depend on AA/AB at all, so it is checked in both states.

  const mTile = (statCalls['meta-stats'].find(s => s.label === 'Avg Order Value') || {}).value;
  const mCorrect = api.fmtMoney(api.sum(d.metaValue) / api.sum(d.metaPurchases));
  check('meta AOV tile = sum(value)/sum(purchases)', mTile === mCorrect, `tile=${mTile} expected=${mCorrect}`);
  check('meta AOV tile is NOT avg(weekly AOVs)', mTile !== avgOfPlotted(plotted('metaChart', 'Meta AOV')), `both = ${mTile} (methods differ by design)`);

  section('6. Null and zero handling');
  const aovSeries = created.adsChart.data.datasets.find(x => x.label === 'AOV').data;
  const metaSeries = created.metaChart.data.datasets.find(x => x.label === 'Meta AOV').data;
  const aov28 = created.adsChart.data.datasets.find(x => x.label === 'AOV 28D').data;
  const nonNull = (a) => a.filter(v => v != null);
  check('no AOV point is exactly 0', ![...nonNull(aovSeries), ...nonNull(metaSeries), ...nonNull(aov28)].some(v => v === 0));
  check('no AOV point is NaN or Infinity', [...nonNull(aovSeries), ...nonNull(metaSeries), ...nonNull(aov28)].every(v => Number.isFinite(v)));
  check('every AOV point inside $50-$10000', [...nonNull(aovSeries), ...nonNull(aov28)].every(v => v >= 50 && v <= 10000));
  check('gadsAov null for the 5 pre-trust weeks', aovSeries.slice(0, 5).every(v => v === null), JSON.stringify(aovSeries.slice(0, 5)));
  if (!DEGRADED) check('gadsAov non-null from week 6 on', aovSeries.slice(5).every(v => v != null));
  check('AOV 28D null for its first 3 weeks', aov28.slice(0, 3).every(v => v === null));

  section('7. Numerator discrimination (source grep)');
  const buildFn = html;
  const aovExprs = (buildFn.match(/const gadsAov=[^\n]*/g) || []).concat(buildFn.match(/const gAovWin=[^\n]*/g) || [], buildFn.match(/trailingRatio\([^)]*\)/g) || []);
  check('no AOV expression references googleAdsPurchases', aovExprs.every(e => !e.includes('googleAdsPurchases')), aovExprs.join(' | '));
  } // end HAS_AOV

  section('8. Axis legibility (>= 5% of its axis peak)');
  /* Two squashed series PRE-DATE the AOV change. Verified by running this same sim against
     git HEAD (commit 03b3042) with RENDER_SIM_PAGE: both appear there identically. They are
     baselined as WARN so a genuinely NEW squash still fails the gate. Do not widen this list
     to silence a regression; fix the axis instead.
       adsChart/y3  Avg. CPC (~$2.50) shares the hidden ROAS axis (peaks ~1042%)
       metaChart/y  Meta Purchases (5-46) shares the Volume axis with Meta Imp (millions) */
  const BASELINE_SQUASH = { 'adsChart/y3': ['Avg. CPC'], 'metaChart/y': ['Meta Purchases'] };
  for (const [id, ch] of Object.entries(created)) {
    const byAxis = {};
    for (const ds of ch.data.datasets) {
      const a = ds.yAxisID || 'y';
      const peak = Math.max(...ds.data.map(v => (typeof v === 'number' && Number.isFinite(v)) ? Math.abs(v) : 0), 0);
      (byAxis[a] = byAxis[a] || []).push({ label: ds.label, peak });
    }
    for (const [a, list] of Object.entries(byAxis)) {
      const top = Math.max(...list.map(x => x.peak));
      const squashed = list.filter(x => top > 0 && x.peak / top < 0.05);
      const known = BASELINE_SQUASH[`${id}/${a}`] || [];
      const fresh = squashed.filter(x => !known.includes(x.label));
      for (const x of squashed.filter(x => known.includes(x.label))) {
        console.log(`  WARN  ${id}/${a}: ${x.label} at ${(x.peak / top * 100).toFixed(1)}% (pre-existing, baselined)`);
      }
      check(`${id}/${a}: no NEW series below 5% of axis peak`, fresh.length === 0,
        fresh.map(x => `${x.label} at ${(x.peak / top * 100).toFixed(1)}%`).join(', '));
    }
  }

  section('9. Filter sweep (the crash-class regression test)');
  const n = d.fullDates.length;
  let sweepErr = null, sweeps = 0, missingField = null;
  const origErr = console.error;
  console.error = (msg) => { if (String(msg).startsWith('applyFilter missing field')) missingField = String(msg); };
  for (let a = 0; a < n && !sweepErr; a++) {
    for (let b = a; b < n; b++) {
      makeEl('dateFrom').value = String(a);
      makeEl('dateTo').value = String(b);
      try { api.applyFilter(); sweeps++; } catch (e) { sweepErr = `(${a},${b}) ${e.message}`; break; }
    }
  }
  console.error = origErr;
  check(`all ${n * (n + 1) / 2} filter windows apply without throwing`, !sweepErr && sweeps === n * (n + 1) / 2, sweepErr || `ran ${sweeps}`);
  check('no applyFilter field omissions', missingField === null, missingField || '');

  section('RESULT');
  console.log(`  ${checks - failures}/${checks} checks passed`);
  if (failures) { console.log(`  ${failures} FAILURE(S)`); process.exit(1); }
  console.log('  ALL GREEN');
})().catch(e => { console.error('SIM ERROR:', e.stack || e.message); process.exit(1); });
