// =============================================================================
// ingest-abs-business-investment.mjs — Data Forge path: BUSINESS INVESTMENT
// (annual, by region) from the ABS Data API. No key.
//
// Source: ABS Private New Capital Expenditure (dataflow CAPEX), quarterly.
//   key  M1.CUR.TOT.TOT.10.<state>.Q
//   = value, Current Prices, Total assets, Total industry, Original.
//   REGION AUS→'australia', 1..8 → st-nsw..st-act (all 8 states + national —
//   user confirmed including NT/ACT/national, which ARE in the API even though
//   the old report only carried 6 states).  Series e.g. NSW = A124792415W.
//
// RULE (user's): the DB stores ANNUAL = a 4-QUARTER SUM.
//   • complete prior years  → sum of that calendar year's 4 quarters
//   • latest/current year   → sum of the most recent 4 quarters (rolling)
// (The current calendar year is incomplete, so it's annualised as a rolling
// 4-qtr sum. Prior years differ ~0.1% from the report = routine ABS revisions.)
//
// ISOLATED: rdp_raw_series (source='abs', metric='bus_investment', freq='A',
// period 'YYYY-01-01') + rdp_runs + forge_data_status (data_key='business').
// Dry-run by DEFAULT; --write upserts; --from=YYYY limits the start year.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const FROM = +((process.argv.find(a => a.startsWith('--from=')) || '--from=1995').split('=')[1]) || 1995;
const API = 'https://data.api.abs.gov.au/rest';
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`ABS ${r.status}: ${t.slice(0, 80)}`); } };

const REG = { AUS: 'australia', '1': 'st-nsw', '2': 'st-vic', '3': 'st-qld', '4': 'st-sa', '5': 'st-wa', '6': 'st-tas', '7': 'st-nt', '8': 'st-act' };

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const FK = 'business', FLABEL = 'Business Investment', FSOURCE = 'ABS Private New Capital Expenditure (CAPEX)';
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: FK, label: FLABEL, source: FSOURCE, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated — apply migration 053? ' + error.message + ')');
}

// ── fetch quarterly CAPEX per region ──
const Q = {};   // slug -> Map(qidx -> value), qidx = year*4 + (quarter-1)
try {
  const j = await getJson(`${API}/data/CAPEX/M1.CUR.TOT.TOT.10..Q?startPeriod=${FROM}-Q1&format=jsondata&dimensionAtObservation=AllDimensions`);
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const sI = od.findIndex(d => d.id === 'STATE'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    const slug = REG[od[sI].values[ix[sI]].id]; if (!slug) continue;
    const m = od[tI].values[ix[tI]].id.match(/^(\d{4})-Q([1-4])$/); if (!m) continue;
    (Q[slug] ||= new Map()).set((+m[1]) * 4 + (+m[2] - 1), v[0]);
  }
} catch (e) { console.error('\n✗ ABS fetch failed:', e.message); await recordStatus('error', `ABS fetch failed: ${e.message}`); process.exit(1); }

// ── annual = 4-quarter sum (calendar for complete years; rolling for the latest) ──
const rows = [];
const slugs = Object.values(REG);
const sum4 = (map, lastQ) => { let s = 0; for (let q = lastQ - 3; q <= lastQ; q++) { const v = map.get(q); if (v == null) return null; s += v; } return s; };
let latestYear = 0;
for (const slug of slugs) {
  const map = Q[slug]; if (!map || !map.size) continue;
  const lastQ = Math.max(...map.keys());
  const ly = Math.floor(lastQ / 4); latestYear = Math.max(latestYear, ly);
  // complete prior calendar years
  const years = new Set([...map.keys()].map(q => Math.floor(q / 4)));
  for (const y of years) {
    if (y === ly) continue;                                   // latest handled below
    const s = sum4(map, y * 4 + 3);                            // calendar Q1..Q4
    if (s != null) rows.push({ source: 'abs', region_slug: slug, metric: 'bus_investment', freq: 'A', period: `${y}-01-01`, value: s });
  }
  // latest/current year = rolling sum of the most recent 4 quarters
  const roll = sum4(map, lastQ);
  if (roll != null) rows.push({ source: 'abs', region_slug: slug, metric: 'bus_investment', freq: 'A', period: `${ly}-01-01`, value: roll });
}

// ── national INDUSTRY split (Manufacturing P02, Mining P01) for the National
//    report's "Business Investment by industry" chart (p18). Same CAPEX
//    dataflow, INDUSTRY dim; AUS only; annual 4-qtr sum (rolling latest).
//    TOT (= Total incl. Education & Health) is already metric 'bus_investment'. ──
const IND = { P02: 'bus_inv_manufacturing', P01: 'bus_inv_mining' };
try {
  const j = await getJson(`${API}/data/CAPEX/M1.CUR.TOT..10.AUS.Q?startPeriod=${FROM}-Q1&format=jsondata&dimensionAtObservation=AllDimensions`);
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const iI = od.findIndex(d => d.id === 'INDUSTRY'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  const QI = {};
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    const code = od[iI].values[ix[iI]].id; if (!IND[code]) continue;
    const m = od[tI].values[ix[tI]].id.match(/^(\d{4})-Q([1-4])$/); if (!m) continue;
    (QI[code] ||= new Map()).set((+m[1]) * 4 + (+m[2] - 1), v[0]);
  }
  for (const [code, metric] of Object.entries(IND)) {
    const map = QI[code]; if (!map || !map.size) continue;
    const lastQ = Math.max(...map.keys()), ly = Math.floor(lastQ / 4);
    for (const y of new Set([...map.keys()].map(q => Math.floor(q / 4)))) {
      if (y === ly) continue;
      const s = sum4(map, y * 4 + 3); if (s != null) rows.push({ source: 'abs', region_slug: 'australia', metric, freq: 'A', period: `${y}-01-01`, value: s });
    }
    const roll = sum4(map, lastQ); if (roll != null) rows.push({ source: 'abs', region_slug: 'australia', metric, freq: 'A', period: `${ly}-01-01`, value: roll });
    console.log(`  national ${metric}: latest ${ly} = ${Math.round(roll).toLocaleString()}`);
  }
} catch (e) { console.error('\n  (national industry split fetch failed: ' + e.message + ')'); }

// compare vs current DB (latest year)
const { data: cur } = await sb.from('rdp_raw_series').select('region_slug,value').eq('source', 'abs').eq('metric', 'bus_investment').eq('freq', 'A').eq('period', `${latestYear}-01-01`).in('region_slug', slugs);
const curMap = Object.fromEntries((cur || []).map(r => [r.region_slug, +r.value]));
console.log(`Business investment (CAPEX) — ${rows.length} annual rows for ${slugs.length} regions (latest ${latestYear} = rolling 4 qtrs):`);
console.log('region       ' + latestYear + ' (rolling)   DB');
for (const slug of slugs) {
  const r = rows.find(x => x.region_slug === slug && +x.period.slice(0, 4) === latestYear);
  console.log(slug.padEnd(11), String(r ? Math.round(r.value).toLocaleString() : '—').padStart(13), '  ', curMap[slug] != null ? Math.round(curMap[slug]).toLocaleString() : '—');
}

const missing = slugs.filter(s => !rows.some(r => r.region_slug === s && +r.period.slice(0, 4) === latestYear));
if (missing.length) console.error(`\n✗ COMPLETENESS FAIL: missing ${latestYear} for ${missing.join(', ')}`);
else console.log(`\n✓ Completeness: all ${slugs.length} regions have ${latestYear}.`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(missing.length ? 1 : 0); }

let written = 0;
for (let k = 0; k < rows.length; k += 500) { const chunk = rows.slice(k, k + 500); const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' }); if (error) { console.error('\n', error.message); process.exit(1); } written += chunk.length; }
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS business ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: missing.length ? 'partial' : 'ok', notes: `ABS CAPEX business investment (annual 4-qtr sum; latest=rolling), ${slugs.length} regions through ${latestYear}${missing.length ? '; MISSING: ' + missing.join(', ') : ''}` });
await recordStatus(missing.length ? 'error' : 'ok', missing.length ? `Missing ${latestYear} for ${missing.join(', ')}` : `Current through ${latestYear} (CAPEX, latest = rolling 4 qtrs).`, { row_count: written, region_count: slugs.length, latest_year: latestYear });
console.log(`\n✓ Upserted ${written} business-investment rows into rdp_raw_series.`);
process.exit(missing.length ? 1 : 0);
