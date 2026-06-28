// =============================================================================
// ingest-abs-fhb.mjs — Data Forge path: FHB DWELLINGS FINANCED (no.)
// (annual, by STATE) from the ABS Data API. No key.
//
// Source: ABS Lending Indicators (dataflow LEND_HOUSING), quarterly.
//   key  FIN_VAL→FIN_NUM.NEWCOMMITS.DV8368.TOTHOUS.TOT.DV5167_FHB.10.<region>.Q
//   = number of new loan commitments, Owner-occupier FIRST HOME BUYERS,
//     Total housing (excl. refinancing), Original.  REGION 1..8 → st-nsw..st-act.
//   Series e.g. NSW = A130268073C (Lending Indicators Table 24).
//
//   STATES ONLY. National is intentionally EXCLUDED: the national report builds
//   its FHB figure from a different (monthly) method that the plain state rule
//   doesn't reproduce (state 4-qtr sum of the AUS series = 120,510 vs the
//   national report's 171,277.5). All 8 STATES reproduce the report EXACTLY.
//
// RULE (user's): the DB stores ANNUAL = a 4-QUARTER SUM.
//   • complete prior years  → sum of that calendar year's 4 quarters
//   • latest/current year   → sum of the most recent 4 quarters (rolling)
//
// ISOLATED: rdp_raw_series (source='abs', metric='fhb', freq='A',
// period 'YYYY-01-01') + rdp_runs + forge_data_status (data_key='fhb').
// Dry-run by DEFAULT; --write upserts; --from=YYYY limits the start year.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const FROM = +((process.argv.find(a => a.startsWith('--from=')) || '--from=1995').split('=')[1]) || 1995;
const API = 'https://data.api.abs.gov.au/rest';
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`ABS ${r.status}: ${t.slice(0, 80)}`); } };

// states only (no AUS — see header note)
const REG = { '1': 'st-nsw', '2': 'st-vic', '3': 'st-qld', '4': 'st-sa', '5': 'st-wa', '6': 'st-tas', '7': 'st-nt', '8': 'st-act' };

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const FK = 'fhb', FLABEL = 'FHB Dwellings Financed', FSOURCE = 'ABS Lending Indicators (LEND_HOUSING)';
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: FK, label: FLABEL, source: FSOURCE, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated — apply migration 053? ' + error.message + ')');
}

// ── fetch quarterly FHB count per state ──
const Q = {};   // slug -> Map(qidx -> value), qidx = year*4 + (quarter-1)
try {
  const key = 'FIN_NUM.NEWCOMMITS.DV8368.TOTHOUS.TOT.DV5167_FHB.10..Q';   // region left open → pull all, filter client-side
  const j = await getJson(`${API}/data/LEND_HOUSING/${key}?startPeriod=${FROM}-Q1&format=jsondata&dimensionAtObservation=AllDimensions`);
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const rI = od.findIndex(d => d.id === 'REGION'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    const slug = REG[od[rI].values[ix[rI]].id]; if (!slug) continue;
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
  const years = new Set([...map.keys()].map(q => Math.floor(q / 4)));
  for (const y of years) {
    if (y === ly) continue;                                   // latest handled below
    const s = sum4(map, y * 4 + 3);                            // calendar Q1..Q4
    if (s != null) rows.push({ source: 'abs', region_slug: slug, metric: 'fhb', freq: 'A', period: `${y}-01-01`, value: s });
  }
  const roll = sum4(map, lastQ);                               // latest = rolling 4 qtrs
  if (roll != null) rows.push({ source: 'abs', region_slug: slug, metric: 'fhb', freq: 'A', period: `${ly}-01-01`, value: roll });
}

// compare vs current DB (latest year)
const { data: cur } = await sb.from('rdp_raw_series').select('region_slug,value').eq('source', 'abs').eq('metric', 'fhb').eq('freq', 'A').eq('period', `${latestYear}-01-01`).in('region_slug', slugs);
const curMap = Object.fromEntries((cur || []).map(r => [r.region_slug, +r.value]));
console.log(`FHB dwellings financed (LEND_HOUSING) — ${rows.length} annual rows for ${slugs.length} states (latest ${latestYear} = rolling 4 qtrs):`);
console.log('region       ' + latestYear + ' (rolling)   DB');
for (const slug of slugs) {
  const r = rows.find(x => x.region_slug === slug && +x.period.slice(0, 4) === latestYear);
  console.log(slug.padEnd(11), String(r ? Math.round(r.value).toLocaleString() : '—').padStart(13), '  ', curMap[slug] != null ? Math.round(curMap[slug]).toLocaleString() : '—');
}

const missing = slugs.filter(s => !rows.some(r => r.region_slug === s && +r.period.slice(0, 4) === latestYear));
if (missing.length) console.error(`\n✗ COMPLETENESS FAIL: missing ${latestYear} for ${missing.join(', ')}`);
else console.log(`\n✓ Completeness: all ${slugs.length} states have ${latestYear}.`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(missing.length ? 1 : 0); }

let written = 0;
for (let k = 0; k < rows.length; k += 500) { const chunk = rows.slice(k, k + 500); const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' }); if (error) { console.error('\n', error.message); process.exit(1); } written += chunk.length; }
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS fhb ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: missing.length ? 'partial' : 'ok', notes: `ABS LEND_HOUSING FHB dwellings financed (annual 4-qtr sum; latest=rolling), ${slugs.length} states through ${latestYear}${missing.length ? '; MISSING: ' + missing.join(', ') : ''}` });
await recordStatus(missing.length ? 'error' : 'ok', missing.length ? `Missing ${latestYear} for ${missing.join(', ')}` : `Current through ${latestYear} (LEND_HOUSING, latest = rolling 4 qtrs).`, { row_count: written, region_count: slugs.length, latest_year: latestYear });
console.log(`\n✓ Upserted ${written} FHB rows into rdp_raw_series.`);
process.exit(missing.length ? 1 : 0);
