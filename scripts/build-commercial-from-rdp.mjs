// =============================================================================
// build-commercial-from-rdp.mjs — refresh the API-backed tabs of forge_commercial
// from rdp_raw_series (Phase 1). The Commercial report reads forge_commercial;
// most of its tabs are manual/subscription re-seeds (seed-commercial.mjs), but a
// few series ARE gathered monthly into rdp_raw_series by the commercial ingests.
// This wires those into forge_commercial so they auto-refresh, WITHOUT touching
// any manual tab.
//
// Phase 1 tabs (clean date/year + value; column keys verified against
// assets/Reports/charts/commercial-charts.js):
//   retail-turnover-data     ← abs retail_trade (M, $m)                → date,data
//   corporate-bond-data      ← rba corporate_bond_yield (M, decimal)   → date,data
//   building-approvals-data  ← abs building_approvals_total (A)         → date + {nsw,vic,qld,sa,wa}Ba, nationalBa
//   population-growth-data   ← abs population (A, ERP levels)           → date + nsw,vic,qld,wa,sa, national
// (cash-rate/inflation is Phase 2 — its effectiveDate axis is irregular;
//  govt-bonds + term-deposits are Phase 2 — irregular column shapes.)
//
// MERGE semantics: for each column, use the rdp value where present, else keep
// the existing seeded value — so pre-rdp history is preserved and the series
// only ever extends/refreshes. All other tabs are passed through untouched.
//
// ISOLATED: reads rdp_raw_series, writes forge_commercial. Dry-run by DEFAULT
// (prints a parity diff vs the current seed); --write upserts forge_commercial.
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

async function fetchSeries(metric, freq, regions) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('rdp_raw_series')
      .select('region_slug,period,value').eq('metric', metric).eq('freq', freq)
      .in('region_slug', regions).order('period').range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}
const relDiff = (a, b) => (a == null || b == null) ? null : (Math.abs(a - b) / (Math.abs(b) || 1));

async function main() {
  const { data: row, error } = await sb.from('forge_commercial').select('data').eq('id', 'latest').maybeSingle();
  if (error) throw error;
  if (!row || !row.data || !row.data.tabs) { console.error('forge_commercial empty — seed it first (seed-commercial.mjs).'); process.exit(1); }
  const store = row.data;
  const tabs = store.tabs;
  const flags = [];
  let worstDiff = 0;   // largest relative divergence seen — >25% hard-fails (corruption guard)

  // ── MONTHLY tabs ──
  const ym = d => String(d).slice(0, 7);   // YYYY-MM key (handles first/end-of-month seeds)
  for (const cfg of MONTHLY) {
    const tab = tabs[cfg.tab];
    if (!tab) { console.log(`skip ${cfg.tab}: not in store`); continue; }
    const oldDate = tab.columns[cfg.dateCol] || [];
    const oldVal = tab.columns[cfg.valCol] || [];
    const oldMap = new Map(oldDate.map((d, i) => [ym(d), oldVal[i]]));
    const start = oldDate.length ? oldDate.map(ym).reduce((m, k) => k < m ? k : m) : '0000-00';
    const series = await fetchSeries(cfg.metric, 'M', [cfg.region]);
    const rdpMap = new Map(series.map(r => [ym(r.period), +r.value]));
    const keys = [...new Set([...oldMap.keys(), ...rdpMap.keys()])].filter(k => k >= start).sort();
    const dateOut = keys.map(k => k + '-01');
    const valOut = keys.map(k => rdpMap.has(k) ? rdpMap.get(k) : (oldMap.has(k) ? oldMap.get(k) : null));
    // parity over the overlap (months present in both rdp and the seed)
    const tol = cfg.tol || 0.02; let over = 0, maxd = 0, ex = '';
    for (const k of keys) { const a = rdpMap.get(k), b = oldMap.get(k); const rd = relDiff(a, b); if (rd != null) { over++; if (rd > maxd) { maxd = rd; ex = `${k} old=${b} new=${a}`; } } }
    console.log(`${cfg.tab.padEnd(24)} ${cfg.metric.padEnd(22)} rows ${oldDate.length}→${dateOut.length} (rdp ${series.length}), overlap ${over}, maxRelDiff ${(maxd*100).toFixed(3)}%  ${maxd>tol ? '⚠ ' + ex : ''}`);
    if (maxd > tol) { flags.push(`${cfg.tab}: ${(maxd*100).toFixed(2)}% (${ex})`); worstDiff = Math.max(worstDiff, maxd); }
    tab.columns = { [cfg.dateCol]: dateOut, [cfg.valCol]: valOut };   // solo — drop vestigial columns the renderers ignore
    tab.headers = Object.keys(tab.columns);
  }

  // ── ANNUAL tabs ──
  for (const cfg of ANNUAL) {
    const tab = tabs[cfg.tab];
    if (!tab) { console.log(`skip ${cfg.tab}: not in store`); continue; }
    const regions = Object.keys(cfg.regionCol);
    const oldDate = (tab.columns[cfg.dateCol] || []).map(y => String(y).slice(0, 4));
    const start = oldDate.length ? oldDate.reduce((m, y) => y < m ? y : m) : '0000';
    const series = await fetchSeries(cfg.metric, 'A', regions);
    const rdp = {};   // region -> Map(year->val)
    for (const r of series) { const y = r.period.slice(0, 4); (rdp[r.region_slug] || (rdp[r.region_slug] = new Map())).set(y, +r.value); }
    const oldMaps = {}; // col -> Map(year->val)
    for (const col of Object.values(cfg.regionCol)) { const c = tab.columns[col] || []; oldMaps[col] = new Map(oldDate.map((y, i) => [y, c[i]])); }
    const years = [...new Set([...oldDate, ...series.map(r => r.period.slice(0, 4))])].filter(y => y >= start).sort();
    tab.columns[cfg.dateCol] = years;
    for (const [region, col] of Object.entries(cfg.regionCol)) {
      const rm = rdp[region] || new Map(), om = oldMaps[col];
      tab.columns[col] = years.map(y => rm.has(y) ? rm.get(y) : (om.has(y) ? om.get(y) : null));
      let over = 0, maxd = 0, ex = '';
      for (const y of years) { const a = rm.get(y), b = om.get(y); const rd = relDiff(a, b); if (rd != null) { over++; if (rd > maxd) { maxd = rd; ex = `${y} old=${b} new=${a}`; } } }
      console.log(`${cfg.tab.padEnd(24)} ${col.padEnd(12)} (${region}) years ${oldDate.length}→${years.length}, overlap ${over}, maxRelDiff ${(maxd*100).toFixed(3)}%  ${maxd>0.03?'⚠ '+ex:''}`);
      if (maxd > 0.03) { flags.push(`${cfg.tab}.${col}: ${(maxd*100).toFixed(2)}% (${ex})`); worstDiff = Math.max(worstDiff, maxd); }
    }
    tab.headers = Object.keys(tab.columns);
  }

  console.log(flags.length ? `\n⚠ ${flags.length} column(s) diverge >tolerance (revisions expected for approvals/pop; investigate if large):\n  ${flags.join('\n  ')}` : '\n✓ All refreshed columns within parity tolerance of the seed.');
  // HARD corruption guard: revisions run single-digit % (2026 approvals hit ~18%);
  // >25% means a scale slip / wrong series — refuse to ship it (warnings alone
  // let a corrupted refresh straight into the live Commercial report).
  if (worstDiff > 0.25) { console.error(`\n✗ Divergence ${(worstDiff * 100).toFixed(1)}% exceeds the 25% hard limit — refusing to ${WRITE ? 'write' : 'pass'}. Investigate the flagged columns above.`); process.exit(1); }

  if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert forge_commercial.'); return; }
  const now = new Date().toISOString();
  store._meta = Object.assign({}, store._meta, { commercialApiRefresh: now });
  const { error: werr } = await sb.from('forge_commercial').upsert({ id: 'latest', data: store, updated_at: now, uploaded_by: 'build-commercial-from-rdp' }, { onConflict: 'id' });
  if (werr) { console.error(werr.message); process.exit(1); }
  try { await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `commercial API refresh ${now.slice(0, 7)}`, row_count: MONTHLY.length + ANNUAL.length, status: 'ok', notes: 'forge_commercial API tabs refreshed from rdp_raw_series (retail, corp bond, term deposits, govt bonds, approvals, population)' }); } catch {}
  console.log(`\n✓ forge_commercial API tabs refreshed (${MONTHLY.length + ANNUAL.length} tabs).`);
}
main().catch(e => { console.error(e); process.exit(1); });
