// =============================================================================
// build-commercial-from-rdp.mjs — refresh the Forge-backed tabs of forge_commercial
// from rdp_raw_series. The Commercial report reads forge_commercial; the tabs
// below are gathered monthly into rdp_raw_series by the ingests, and this wires
// them into the store so they auto-refresh, WITHOUT touching any manual tab.
//
// Wired tabs (column keys verified against assets/Reports/charts/commercial-charts.js):
//   retail-turnover-data            ← abs retail_trade (M, $m)                 → date,data
//   corporate-bond-data             ← rba corporate_bond_yield (M, decimal)    → date,data
//   term-deposits-data              ← rba term_deposit_1y (M)                  → date,5YearAverage1Year
//   govt-bonds-data                 ← rba govt_bond_yield (M, 2013+)           → 10YearGovernmentBondYield,yield
//   building-approvals-data         ← abs building_approvals_total (A)         → date + {nsw,vic,qld,sa,wa}Ba, nationalBa
//   population-growth-data          ← abs population (A, ERP levels)           → date + nsw,vic,qld,wa,sa, national
//   building-price-indices-data     ← abs building_price_index (Q → calendar-year mean) for the 6 ABS
//                                     capitals + rawlinsons (A) for Canberra/Darwin, × 10,000 (see BPI)
//   cash-rateinflation-rate-data    ← rba cash_rate (M) + abs cpi (Q, year-ended) on a monthly axis
//   population-pyramid-data         ← abs pyr_* (A, australia): latest ERP year vs 20 years earlier
//   individuals-who-accessed-gp-dat ← abs gp_share (A, FY) × abs population (A)
//   pop-accessing-health-services   ← abs gp_share_<band> (A, latest release)
//   fed-gov-health-budget-data      ← budget fed_health_expenses (A, $m; each year = its newest Budget estimate)
// (the five above were hand-typed until 2026-09-12 — Van: "do the five"; the budget tab followed the same day)
//
// DEAD tabs: six tabs no chart or tool reads (sheet15, bond-data, offices-2,
// job-creation, return-on-stocks-and-gold, copy-of-building-price-indices) are
// stripped on every run (Van, 2026-09-12), so a Looker re-seed can't bring them
// back. Backup: scratch/commercial-dead-tabs-backup-2026-09-12.json (gitignored).
//
// MERGE semantics: for each column, use the rdp value where present, else keep
// the existing seeded value — so pre-rdp history is preserved and the series
// only ever extends/refreshes. A tab whose Forge source is EMPTY is left exactly
// as it was (a failed GATHER step never blanks a chart). All other tabs pass
// through untouched.
//
// ISOLATED: reads rdp_raw_series, writes forge_commercial. Dry-run by DEFAULT
// (prints a parity diff vs the current store); --write upserts forge_commercial.
//   node scripts/build-commercial-from-rdp.mjs            # dry run + parity diff
//   node scripts/build-commercial-from-rdp.mjs --write    # upsert forge_commercial
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

// Monthly single-series tabs: one date column + one value column, keyed by
// YYYY-MM (seed dates vary: some first-of-month, some end-of-month). Output is
// SOLO — only {dateCol, valCol} are kept, dropping any vestigial columns (e.g.
// term-deposits' stray account-number cols), which the renderers don't read.
// govt-bonds merges automatically: rdp is 2013+, so the seed's 2004–2012 rows
// are preserved (rdp value where present, else seed).
const MONTHLY = [
  { tab: 'retail-turnover-data', metric: 'retail_trade',         region: 'australia', dateCol: 'date',                      valCol: 'data' },
  { tab: 'corporate-bond-data',  metric: 'corporate_bond_yield', region: 'australia', dateCol: 'date',                      valCol: 'data',              tol: 0.05 },
  { tab: 'term-deposits-data',   metric: 'term_deposit_1y',      region: 'australia', dateCol: 'date',                      valCol: '5YearAverage1Year', tol: 0.05 },
  { tab: 'govt-bonds-data',      metric: 'govt_bond_yield',      region: 'australia', dateCol: '10YearGovernmentBondYield', valCol: 'yield',             tol: 0.05 },
];
// Annual multi-region tabs: date column (year string) + one column per region.
const ANNUAL = [
  { tab: 'building-approvals-data', metric: 'building_approvals_total', dateCol: 'date',
    regionCol: { 'st-nsw': 'nswBa', 'st-vic': 'vicBa', 'st-qld': 'qldBa', 'st-sa': 'saBa', 'st-wa': 'waBa', australia: 'nationalBa' } },
  { tab: 'population-growth-data', metric: 'population', dateCol: 'date',
    regionCol: { 'st-nsw': 'nsw', 'st-vic': 'vic', 'st-qld': 'qld', 'st-wa': 'wa', 'st-sa': 'sa', australia: 'national' } },
];

// Building Price Indices — ABS 6427.0 PPI Table 18 "input to the house
// construction industry" index, per capital. The Looker seed took the CALENDAR-
// year mean of the four quarters and multiplied by 10,000 (its header says
// "JUNE 30" but the numbers are calendar years — 2023/24/25 reproduce to the
// cent); the chart's axis prints that as "1.6m", so the scale is kept to leave
// the picture exactly as it was. The ABS table has only the six state capitals;
// Canberra/Darwin come from the Rawlinsons annual index Forge already holds.
const BPI = {
  tab: 'building-price-indices-data', dateCol: 'periodyearJune30', scale: 10000, metric: 'building_price_index',
  quarterly: { source: 'abs', cols: { adelaide: 'adel', brisbane: 'bris', hobart: 'hob', melbourne: 'mel', perth: 'per', sydney: 'syd' } },
  annual:    { source: 'rawlinsons', cols: { canberra: 'can', darwin: 'dwn' } },
};
// Cash rate v inflation — the seed's axis was the RBA decision dates (Feb–Dec,
// no January) that became first-of-month rows from mid-2025. Rebuilt as a plain
// monthly axis: cash rate = the RBA monthly target (decimal), inflation = the
// ABS year-ended CPI rate on its quarter-end month (Mar/Jun/Sep/Dec), 0 in
// between — exactly the seed's own "bar only where a CPI print lands" convention.
const CASH = { tab: 'cash-rateinflation-rate-data', dateCol: 'effectiveDate', cashCol: 'cashRate', inflCol: 'inflationRate',
  cash: { metric: 'cash_rate', source: 'rba', freq: 'M' }, infl: { metric: 'cpi', source: 'abs', freq: 'Q' } };
// Population pyramid — the seed compared 2000 with 2020 (fixed). Forge's national
// ERP-by-age history (pyr_*, ABS ERP_ASGS2021, 2001 onwards — written by
// ingest-abs-pop-pyramid) has no 2000, so the tab now compares the LATEST ERP
// year with the year 20 before it (2026: 2005 v 2025) and rolls forward each
// year; the chart reads whichever two year columns are present.
const PYR = { tab: 'population-pyramid-data', ageCol: 'ageGroupYears', gap: 20, source: 'abs',
  bands: [['pyr_0_04', '0-04'], ['pyr_05_09', '05-09'], ['pyr_10_14', '10-14'], ['pyr_15_19', '15-19'], ['pyr_20_24', '20-24'], ['pyr_25_29', '25-29'], ['pyr_30_34', '30-34'], ['pyr_35_39', '35-39'], ['pyr_40_44', '40-44'], ['pyr_45_49', '45-49'], ['pyr_50_54', '50-54'], ['pyr_55_59', '55-59'], ['pyr_60_64', '60-64'], ['pyr_65_69', '65-69'], ['pyr_70_74', '70-74'], ['pyr_75_79', '75-79'], ['pyr_80_84', '80-84'], ['pyr_85_and_over', '85+']] };
// GP access — ABS Patient Experiences (ingest-abs-patient-experiences): the share
// who saw a GP by financial year (period = FY start) × the ERP for that year =
// the seed's "people who saw a GP"; plus the share by age band (latest release).
const GP  = { tab: 'individuals-who-accessed-gp-dat', source: 'abs', shareMetric: 'gp_share', popMetric: 'population',
  cols: { date: 'date', pop: 'ausPop', share: 'sawAGeneralPractitioner', people: 'peopleWhoSawAGp' } };
const GP_AGE = { tab: 'pop-accessing-health-services', source: 'abs', rangeCol: 'range', valCol: 'sawAGeneralPractitioner',
  bands: [['gp_share_15_24', '15–24'], ['gp_share_25_34', '25–34'], ['gp_share_35_44', '35–44'], ['gp_share_45_54', '45–54'], ['gp_share_55_64', '55–64'], ['gp_share_65_74', '65–74'], ['gp_share_75_84', '75–84'], ['gp_share_85p', '85+']] };
// Federal health budget — Budget Paper No. 1 "Estimates of expenses by function", Health
// row ($m), from the Department of Finance tables on data.gov.au (ingest-budget-
// health-expenses). Each year carries the newest Budget's estimate for it. The tab
// runs to the newest BUDGET YEAR only (2026-27 for the 2026-27 Budget) — the three
// forward-estimate years stay in rdp but off the chart, as the seed always did.
const FED = { tab: 'fed-gov-health-budget-data', source: 'budget', metric: 'fed_health_expenses', statusKey: 'fed_health_budget', cols: { date: 'date', val: 'data' } };
const DEAD_TABS = ['sheet15', 'bond-data', 'offices-2', 'job-creation', 'return-on-stocks-and-gold', 'copy-of-building-price-indices'];

async function fetchSeries(metric, freq, regions, source) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from('rdp_raw_series').select('region_slug,metric,period,value').eq('freq', freq).in('region_slug', regions).order('period').range(from, from + 999);
    q = Array.isArray(metric) ? q.in('metric', metric) : q.eq('metric', metric);
    if (source) q = q.eq('source', source);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}
const relDiff = (a, b) => (a == null || b == null) ? null : (Math.abs(a - b) / (Math.abs(b) || 1));
const ym = d => String(d).slice(0, 7);   // YYYY-MM key (handles first/end-of-month seeds)
const yr = d => String(d).slice(0, 4);
const r4 = v => Math.round(v * 1e4) / 1e4;

async function main() {
  const { data: row, error } = await sb.from('forge_commercial').select('data').eq('id', 'latest').maybeSingle();
  if (error) throw error;
  if (!row || !row.data || !row.data.tabs) { console.error('forge_commercial empty — seed it first (seed-commercial.mjs).'); process.exit(1); }
  const store = row.data;
  const tabs = store.tabs;
  const flags = [];
  const touched = [];
  let worstDiff = 0;   // largest relative divergence seen — >25% hard-fails (corruption guard)
  // parity bookkeeping shared by every tab: compare a rebuilt column with the seed
  // over the keys both hold; flag beyond tol; feed the hard guard.
  // abs:true compares in ABSOLUTE terms (decimal rates): a relative diff on a
  // near-zero base (a 0.25% cash rate, a -0.1% CPI print) reads as 50–100% and
  // would trip the corruption guard for what is a one-step timing difference.
  // In that mode tol is the flag threshold and 0.02 (two percentage points) the
  // hard limit — anything beyond that is a scale slip, not a convention.
  const parity = (label, keys, newMap, oldMap, tol, opts = {}) => {
    let over = 0, maxd = 0, ex = '';
    const diff = opts.abs ? ((a, b) => (a == null || b == null) ? null : Math.abs(a - b)) : relDiff;
    for (const k of keys) { const a = newMap.get(k), b = oldMap.get(k); const rd = diff(a, b); if (rd != null) { over++; if (rd > maxd) { maxd = rd; ex = `${k} old=${b} new=${a}`; } } }
    const warn = maxd > tol;
    const shown = opts.abs ? `maxAbsDiff ${(maxd * 100).toFixed(3).padStart(7)}pp` : `maxRelDiff ${(maxd * 100).toFixed(3).padStart(7)}%`;
    console.log(`${label.padEnd(50)} overlap ${String(over).padStart(4)}, ${shown}  ${warn ? '⚠ ' + ex : ''}`);
    if (warn) { flags.push(`${label}: ${(maxd * 100).toFixed(2)}${opts.abs ? 'pp' : '%'} (${ex})`); worstDiff = Math.max(worstDiff, opts.abs ? (maxd > 0.02 ? 1 : 0) : maxd); }
  };

  // ── DEAD tabs ──
  const dead = DEAD_TABS.filter(t => tabs[t]);
  for (const t of dead) delete tabs[t];
  console.log(dead.length ? `dead tabs removed: ${dead.join(', ')}` : 'dead tabs: none present');

  // ── MONTHLY tabs ──
  for (const cfg of MONTHLY) {
    const tab = tabs[cfg.tab];
    if (!tab) { console.log(`skip ${cfg.tab}: not in store`); continue; }
    const oldDate = tab.columns[cfg.dateCol] || [];
    const oldVal = tab.columns[cfg.valCol] || [];
    const oldMap = new Map(oldDate.map((d, i) => [ym(d), oldVal[i]]));
    const start = oldDate.length ? oldDate.map(ym).reduce((m, k) => k < m ? k : m) : '0000-00';
    const series = await fetchSeries(cfg.metric, 'M', [cfg.region]);
    if (!series.length) { console.log(`skip ${cfg.tab}: rdp has no ${cfg.metric} — tab left as is`); continue; }
    const rdpMap = new Map(series.map(r => [ym(r.period), +r.value]));
    const keys = [...new Set([...oldMap.keys(), ...rdpMap.keys()])].filter(k => k >= start).sort();
    const dateOut = keys.map(k => k + '-01');
    const valOut = keys.map(k => rdpMap.has(k) ? rdpMap.get(k) : (oldMap.has(k) ? oldMap.get(k) : null));
    parity(`${cfg.tab} ${cfg.metric} rows ${oldDate.length}→${dateOut.length}`, keys, rdpMap, oldMap, cfg.tol || 0.02);
    tab.columns = { [cfg.dateCol]: dateOut, [cfg.valCol]: valOut };   // solo — drop vestigial columns the renderers ignore
    tab.headers = Object.keys(tab.columns);
    touched.push(cfg.tab);
  }

  // ── ANNUAL tabs ──
  for (const cfg of ANNUAL) {
    const tab = tabs[cfg.tab];
    if (!tab) { console.log(`skip ${cfg.tab}: not in store`); continue; }
    const regions = Object.keys(cfg.regionCol);
    const oldDate = (tab.columns[cfg.dateCol] || []).map(yr);
    const start = oldDate.length ? oldDate.reduce((m, y) => y < m ? y : m) : '0000';
    const series = await fetchSeries(cfg.metric, 'A', regions);
    if (!series.length) { console.log(`skip ${cfg.tab}: rdp has no ${cfg.metric} — tab left as is`); continue; }
    const rdp = {};   // region -> Map(year->val)
    for (const r of series) (rdp[r.region_slug] || (rdp[r.region_slug] = new Map())).set(yr(r.period), +r.value);
    const oldMaps = {}; // col -> Map(year->val)
    for (const col of Object.values(cfg.regionCol)) { const c = tab.columns[col] || []; oldMaps[col] = new Map(oldDate.map((y, i) => [y, c[i]])); }
    const years = [...new Set([...oldDate, ...series.map(r => yr(r.period))])].filter(y => y >= start).sort();
    tab.columns[cfg.dateCol] = years;
    for (const [region, col] of Object.entries(cfg.regionCol)) {
      const rm = rdp[region] || new Map(), om = oldMaps[col];
      tab.columns[col] = years.map(y => rm.has(y) ? rm.get(y) : (om.has(y) ? om.get(y) : null));
      parity(`${cfg.tab}.${col} (${region}) years ${oldDate.length}→${years.length}`, years, rm, om, 0.03);
    }
    tab.headers = Object.keys(tab.columns);
    touched.push(cfg.tab);
  }

  // ── BUILDING PRICE INDICES (calendar-year mean of the quarterly index × 10,000; Rawlinsons annual for CAN/DWN) ──
  {
    const tab = tabs[BPI.tab];
    if (!tab) console.log(`skip ${BPI.tab}: not in store`);
    else {
      const qSeries = await fetchSeries(BPI.metric, 'Q', Object.keys(BPI.quarterly.cols), BPI.quarterly.source);
      const aSeries = await fetchSeries(BPI.metric, 'A', Object.keys(BPI.annual.cols), BPI.annual.source);
      if (!qSeries.length) console.log(`skip ${BPI.tab}: rdp has no quarterly ${BPI.metric} — tab left as is`);
      else {
        const oldYears = (tab.columns[BPI.dateCol] || []).map(v => String(v).trim());
        const isYear = y => /^(19|20)\d{2}$/.test(y);
        const start = oldYears.filter(isYear).sort()[0] || '0000';
        const byCol = {};   // col -> Map(year -> value)
        const acc = {};     // region -> year -> [values]
        for (const r of qSeries) ((acc[r.region_slug] ||= {})[yr(r.period)] ||= []).push(+r.value);
        for (const [region, col] of Object.entries(BPI.quarterly.cols)) {
          byCol[col] = new Map();
          for (const [y, vals] of Object.entries(acc[region] || {})) byCol[col].set(y, Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * BPI.scale * 100) / 100);
        }
        for (const [region, col] of Object.entries(BPI.annual.cols)) {
          byCol[col] = new Map();
          for (const r of aSeries) if (r.region_slug === region) byCol[col].set(yr(r.period), Math.round(+r.value * BPI.scale * 100) / 100);
        }
        const years = [...new Set([...oldYears.filter(isYear), ...Object.values(byCol).flatMap(m => [...m.keys()])])].filter(y => y >= start).sort();
        const out = { [BPI.dateCol]: years };
        const noteRows = oldYears.filter(y => y && !isYear(y)).length;
        for (const col of [...Object.values(BPI.quarterly.cols), ...Object.values(BPI.annual.cols)].sort()) {
          const oldCol = tab.columns[col] || [];
          const om = new Map(oldYears.map((y, i) => [y, oldCol[i]]).filter(([y, v]) => isYear(y) && v != null && v !== ''));
          const nm = byCol[col];
          out[col] = years.map(y => nm.has(y) ? nm.get(y) : (om.has(y) ? om.get(y) : null));
          // the current calendar year is a partial mean until December's quarter lands —
          // its drift against the seed is expected, so it is reported but never flagged
          const cur = String(new Date().getFullYear());
          parity(`${BPI.tab}.${col} years ${oldYears.filter(isYear).length}→${years.length}`, years.filter(y => y !== cur), nm, om, 0.03);
          const rd = relDiff(nm.get(cur), om.get(cur)); if (rd != null) console.log(`${''.padEnd(50)} (${cur} partial year: old=${om.get(cur)} new=${nm.get(cur)} ${(rd * 100).toFixed(2)}% — not flagged)`);
        }
        tab.columns = out; tab.headers = Object.keys(out);
        if (noteRows) console.log(`${BPI.tab}: ${noteRows} note/source text rows dropped from the year column (the source is documented in Data Forge)`);
        touched.push(BPI.tab);
      }
    }
  }

  // ── CASH RATE v INFLATION (monthly axis) ──
  {
    const tab = tabs[CASH.tab];
    if (!tab) console.log(`skip ${CASH.tab}: not in store`);
    else {
      const cash = await fetchSeries(CASH.cash.metric, CASH.cash.freq, ['australia'], CASH.cash.source);
      const infl = await fetchSeries(CASH.infl.metric, CASH.infl.freq, ['australia'], CASH.infl.source);
      if (!cash.length || !infl.length) console.log(`skip ${CASH.tab}: rdp is missing ${!cash.length ? CASH.cash.metric : CASH.infl.metric} — tab left as is`);
      else {
        const oldDate = tab.columns[CASH.dateCol] || [], oldCash = tab.columns[CASH.cashCol] || [], oldInfl = tab.columns[CASH.inflCol] || [];
        const oldCashMap = new Map(oldDate.map((d, i) => [ym(d), oldCash[i]]));            // last decision in a month wins (Mar-2020)
        const oldInflMap = new Map(); oldDate.forEach((d, i) => { const v = +oldInfl[i]; if (v) oldInflMap.set(ym(d), v); });
        const start = oldDate.length ? oldDate.map(ym).reduce((m, k) => k < m ? k : m) : ym(cash[0].period);
        const cashMap = new Map(cash.map(r => [ym(r.period), +r.value]));
        const inflMap = new Map(infl.map(r => [ym(r.period), +r.value]));                  // quarter-END month labels (03/06/09/12)
        const last = [...cashMap.keys()].sort().pop();
        const months = [];
        for (let y = +start.slice(0, 4), m = +start.slice(5, 7); `${y}-${String(m).padStart(2, '0')}` <= last; m === 12 ? (y++, m = 1) : m++) months.push(`${y}-${String(m).padStart(2, '0')}`);
        const cashOut = months.map(k => cashMap.has(k) ? cashMap.get(k) : (oldCashMap.has(k) ? oldCashMap.get(k) : null));
        const inflOut = months.map(k => inflMap.has(k) ? inflMap.get(k) : 0);
        parity(`${CASH.tab}.${CASH.cashCol} rows ${oldDate.length}→${months.length}`, months, cashMap, oldCashMap, 0.0026, { abs: true });   // one 25bp step = a decision-date v month-end timing difference
        // the seed placed some CPI prints on the following meeting month (no March meeting →
        // April); the rebuilt column puts every print on its quarter-end month, so compare
        // by quarter, not month: each seed print v the nearest quarter-end at or before it.
        const qEnd = k => { const y = +k.slice(0, 4), m = +k.slice(5, 7); const qm = Math.floor((m - 1) / 3) * 3; return qm === 0 ? `${y - 1}-12` : `${y}-${String(qm).padStart(2, '0')}`; };
        const oldByQ = new Map(); for (const [k, v] of oldInflMap) { const q = inflMap.has(k) ? k : qEnd(k); if (!oldByQ.has(q)) oldByQ.set(q, v); }
        parity(`${CASH.tab}.${CASH.inflCol} (CPI prints: ${oldInflMap.size} seed v ${[...inflMap.keys()].filter(k => k >= start).length} rdp)`, [...oldByQ.keys()], inflMap, oldByQ, 0.0011, { abs: true });   // the seed typed 1-dp percentages; rdp derives from the index
        tab.columns = { [CASH.dateCol]: months.map(k => k + '-01'), [CASH.cashCol]: cashOut, [CASH.inflCol]: inflOut };
        tab.headers = Object.keys(tab.columns);
        touched.push(CASH.tab);
      }
    }
  }

  // ── POPULATION PYRAMID (latest ERP year v 20 years earlier, national shares) ──
  {
    const tab = tabs[PYR.tab];
    if (!tab) console.log(`skip ${PYR.tab}: not in store`);
    else {
      const metrics = PYR.bands.map(b => b[0]);
      const series = await fetchSeries(metrics, 'A', ['australia'], PYR.source);
      const byYear = {};   // year -> { metric: value }
      for (const r of series) (byYear[yr(r.period)] ||= {})[r.metric] = +r.value;
      const full = Object.keys(byYear).filter(y => metrics.every(m => byYear[y][m] != null)).sort();
      const latest = full[full.length - 1];
      const target = latest ? String(+latest - PYR.gap) : null;
      const early = full.includes(target) ? target : full[0];
      if (!latest || early === latest) console.log(`skip ${PYR.tab}: rdp pyr_* history has ${full.length} complete national year(s) (${full.join(', ') || 'none'}) — need two — tab left as is (run ingest-abs-pop-pyramid.mjs --write)`);
      else {
        const share = y => { const tot = metrics.reduce((s, m) => s + byYear[y][m], 0); return metrics.map(m => r4(byYear[y][m] / tot)); };
        const out = { [PYR.ageCol]: PYR.bands.map(b => b[1]), [early]: share(early), [latest]: share(latest) };
        const oldYearCols = Object.keys(tab.columns).filter(k => /^\d{4}$/.test(k)).sort();
        // parity where a seed year still exists in the history (the seed's 2020 v ERP 2020: revisions only)
        for (const y of oldYearCols) if (full.includes(y)) {
          const om = new Map(PYR.bands.map((b, i) => [b[1], +tab.columns[y][i]])), nm = new Map(PYR.bands.map((b, i) => [b[1], share(y)[i]]));
          parity(`${PYR.tab} seed ${y} v ERP ${y} (shares)`, PYR.bands.map(b => b[1]), nm, om, 0.05);
        }
        console.log(`${PYR.tab.padEnd(50)} years ${oldYearCols.join('/') || '—'} → ${early}/${latest} (history ${full[0]}–${latest}, ${full.length} years; gap ${PYR.gap}${full.includes(target) ? '' : ' — earliest available used'})`);
        tab.columns = out; tab.headers = Object.keys(out);
        touched.push(PYR.tab);
      }
    }
  }

  // ── GP ACCESS — people who saw a GP, by financial year ──
  {
    const tab = tabs[GP.tab];
    if (!tab) console.log(`skip ${GP.tab}: not in store`);
    else {
      const shares = await fetchSeries(GP.shareMetric, 'A', ['australia'], GP.source);
      const pops = await fetchSeries(GP.popMetric, 'A', ['australia'], GP.source);
      if (!shares.length) console.log(`skip ${GP.tab}: rdp has no ${GP.shareMetric} — tab left as is (run ingest-abs-patient-experiences.mjs --write)`);
      else {
        const popMap = new Map(pops.map(r => [yr(r.period), Math.round(+r.value)]));
        const c = GP.cols, oldDate = (tab.columns[c.date] || []).map(String);
        const om = key => new Map(oldDate.map((d, i) => [d, (tab.columns[key] || [])[i]]));
        const rows = shares.map(r => { const y = yr(r.period), label = `${y}-${String(+y + 1).slice(2)}`, share = +r.value, pop = popMap.get(y) ?? null; return { label, pop, share, people: pop == null ? null : Math.round(pop * share * 100) / 100 }; });
        const labels = rows.map(r => r.label);
        const nm = key => new Map(rows.map(r => [r.label, r[key]]));
        parity(`${GP.tab}.${c.share} FYs ${oldDate.length}→${rows.length}`, labels, nm('share'), om(c.share), 0.02);
        parity(`${GP.tab}.${c.pop} (ERP for the FY's first year)`, labels, nm('pop'), om(c.pop), 0.02);
        parity(`${GP.tab}.${c.people} (= share × ERP)`, labels, nm('people'), om(c.people), 0.02);
        const missingPop = rows.filter(r => r.pop == null).map(r => r.label);
        if (missingPop.length) console.log(`${''.padEnd(50)} (no ERP yet for ${missingPop.join(', ')} — people left blank until ingest-abs-population lands it)`);
        tab.columns = { [c.date]: labels, [c.pop]: rows.map(r => r.pop), [c.share]: rows.map(r => r.share), [c.people]: rows.map(r => r.people) };
        tab.headers = Object.keys(tab.columns);
        touched.push(GP.tab);
      }
    }
  }

  // ── GP ACCESS — share who saw a GP, by age band (latest release) ──
  {
    const tab = tabs[GP_AGE.tab];
    if (!tab) console.log(`skip ${GP_AGE.tab}: not in store`);
    else {
      const metrics = GP_AGE.bands.map(b => b[0]);
      const series = await fetchSeries(metrics, 'A', ['australia'], GP_AGE.source);
      const latest = series.map(r => yr(r.period)).sort().pop();
      const vals = new Map(series.filter(r => yr(r.period) === latest).map(r => [r.metric, +r.value]));
      if (!latest || !metrics.every(m => vals.has(m))) console.log(`skip ${GP_AGE.tab}: rdp has ${vals.size}/${metrics.length} age bands for ${latest || '—'} — tab left as is`);
      else {
        const oldRange = (tab.columns[GP_AGE.rangeCol] || []).map(v => String(v).replace(/[‒–—]/g, '-').trim());
        const om = new Map(oldRange.map((k, i) => [k, (tab.columns[GP_AGE.valCol] || [])[i]]));
        const keyOf = b => b[1].replace(/[‒–—]/g, '-');
        const nm = new Map(GP_AGE.bands.map(b => [keyOf(b), vals.get(b[0])]));
        parity(`${GP_AGE.tab}.${GP_AGE.valCol} (${latest}-${String(+latest + 1).slice(2)}, ${metrics.length} bands)`, GP_AGE.bands.map(keyOf), nm, om, 0.02);
        tab.columns = { [GP_AGE.rangeCol]: GP_AGE.bands.map(b => b[1]), [GP_AGE.valCol]: GP_AGE.bands.map(b => vals.get(b[0])) };
        tab.headers = Object.keys(tab.columns);
        touched.push(GP_AGE.tab);
      }
    }
  }

  // ── FEDERAL HEALTH BUDGET — Health function expenses by FY, to the newest Budget year ──
  {
    const tab = tabs[FED.tab];
    if (!tab) console.log(`skip ${FED.tab}: not in store`);
    else {
      const series = await fetchSeries(FED.metric, 'A', ['australia'], FED.source);
      let budgetYear = null;
      try { const { data } = await sb.from('forge_data_status').select('latest_year').eq('data_key', FED.statusKey).maybeSingle(); budgetYear = data && data.latest_year ? +data.latest_year : null; } catch {}
      if (!series.length) console.log(`skip ${FED.tab}: rdp has no ${FED.metric} — tab left as is (run ingest-budget-health-expenses.mjs --write)`);
      else {
        const c = FED.cols;
        const label = y => `${y}-${String(+y + 1).slice(2)}`;
        const oldDate = (tab.columns[c.date] || []).map(String), oldVal = tab.columns[c.val] || [];
        const om = new Map(oldDate.map((d, i) => [d, oldVal[i]]));
        const cut = budgetYear || Math.max(...series.map(r => +yr(r.period)));   // no status row → show everything stored
        const rdpMap = new Map(series.filter(r => +yr(r.period) <= cut).map(r => [label(yr(r.period)), Math.round(+r.value)]));
        const labels = [...new Set([...oldDate, ...rdpMap.keys()])].sort();
        parity(`${FED.tab}.${c.val} FYs ${oldDate.length}→${labels.length} (to the ${label(cut)} Budget year)`, labels, rdpMap, om, 0.03);
        tab.columns = { [c.date]: labels, [c.val]: labels.map(k => rdpMap.has(k) ? rdpMap.get(k) : (om.has(k) ? om.get(k) : null)) };
        tab.headers = Object.keys(tab.columns);
        touched.push(FED.tab);
      }
    }
  }

  console.log(flags.length ? `\n⚠ ${flags.length} column(s) diverge >tolerance (revisions expected for approvals/pop/ERP; investigate if large):\n  ${flags.join('\n  ')}` : '\n✓ All refreshed columns within parity tolerance of the store.');
  // HARD corruption guard: revisions run single-digit % (2026 approvals hit ~18%);
  // >25% means a scale slip / wrong series — refuse to ship it (warnings alone
  // let a corrupted refresh straight into the live Commercial report).
  if (worstDiff > 0.25) { console.error(`\n✗ Divergence ${(worstDiff * 100).toFixed(1)}% exceeds the 25% hard limit — refusing to ${WRITE ? 'write' : 'pass'}. Investigate the flagged columns above.`); process.exit(1); }
  console.log(`\n${touched.length} tab(s) rebuilt from Forge: ${touched.join(', ')}; ${Object.keys(tabs).length} tabs in the store.`);

  if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert forge_commercial.'); return; }
  const now = new Date().toISOString();
  store._meta = Object.assign({}, store._meta, {
    commercialApiRefresh: now, tabCount: Object.keys(tabs).length,
    colCount: Object.values(tabs).reduce((n, t) => n + Object.keys((t && t.columns) || {}).length, 0),
    ...(dead.length ? { deadTabsRemoved: { on: now.slice(0, 10), tabs: dead } } : {}),
  });
  const { error: werr } = await sb.from('forge_commercial').upsert({ id: 'latest', data: store, updated_at: now, uploaded_by: 'build-commercial-from-rdp' }, { onConflict: 'id' });
  if (werr) { console.error(werr.message); process.exit(1); }
  try { await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `commercial API refresh ${now.slice(0, 7)}`, row_count: touched.length, status: 'ok', notes: `forge_commercial Forge tabs refreshed from rdp_raw_series (${touched.join(', ')})${dead.length ? `; dead tabs removed: ${dead.join(', ')}` : ''}` }); } catch {}
  console.log(`\n✓ forge_commercial refreshed (${touched.length} tabs rebuilt${dead.length ? `, ${dead.length} dead tabs removed` : ''}).`);
}
main().catch(e => { console.error(e); process.exit(1); });
