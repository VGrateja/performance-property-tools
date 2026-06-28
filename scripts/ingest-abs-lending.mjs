// =============================================================================
// ingest-abs-lending.mjs — Data Forge path: LENDING — OWNER OCCUPIER (monthly)
//
// ABS publishes this QUARTERLY; the DB stores it MONTHLY via the user's
// quarterly→monthly disaggregation rule. For each quarter (months M1,M2,M3 —
// e.g. Jan,Feb,Mar 2026, where M3 is the quarter-END month):
//   M3 (quarter-end) = ABS quarterly value / 3
//   M1 (first month) = average of the 3 months immediately before M1
//   M2 (second)      = average of the 3 months immediately before M2 (incl. M1)
// APPEND-ONLY: a new quarter is built from the EXISTING DB months (the trailing
// averages); prior months are never re-revised (ABS revisions to old quarters
// are ignored, matching the DB).
//
// ABS series (verified: NSW Q1-2026 16600.5/3 = 5533.5 = DB Mar-2026):
//   dataflow LEND_HOUSING, key
//   FIN_VAL.NEWCOMMITS.DV8368.TOTDWELL.TOT.DV5167.10.<region>.Q
//   = value($m), New commitments, Total fixed-term+revolving, Total dwellings
//     excl. refinancing, all lenders, Owner occupier (DV5167), Original.
//   REGION AUS→'australia', 1..8→st-nsw..st-act.
//
// ISOLATED: rdp_raw_series (source='abs', metric='owner_occupier', freq='M') +
// rdp_runs + forge_data_status (data_key='lending'). Dry-run by DEFAULT (verifies
// the latest DB quarter recomputes + lists any new quarters); --write appends.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const API = 'https://data.api.abs.gov.au/rest';
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`ABS ${r.status}: ${t.slice(0, 80)}`); } };

const SERIES = 'FIN_VAL.NEWCOMMITS.DV8368.TOTDWELL.TOT.DV5167.10';   // …<region>.Q
const REG = { AUS: 'australia', '1': 'st-nsw', '2': 'st-vic', '3': 'st-qld', '4': 'st-sa', '5': 'st-wa', '6': 'st-tas', '7': 'st-nt', '8': 'st-act' };

// month <-> integer index (year*12 + month0), and period string
const idxToPeriod = i => `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}-01`;
const periodToIdx = p => { const [y, m] = p.split('-'); return (+y) * 12 + (+m - 1); };
const idxLabel = i => idxToPeriod(i).slice(0, 7);

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const FK = 'lending', FLABEL = 'Lending — Owner Occupier', FSOURCE = 'ABS Lending Indicators (LEND_HOUSING)';
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: FK, label: FLABEL, source: FSOURCE, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated — apply migration 053? ' + error.message + ')');
}

// ── 1) ABS quarterly owner-occupier value per region ──
const Q = {};   // slug -> { endIdx -> quarterly value }
try {
  const j = await getJson(`${API}/data/LEND_HOUSING/${SERIES}..Q?startPeriod=2015-Q1&format=jsondata&dimensionAtObservation=AllDimensions`);
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const rI = od.findIndex(d => d.id === 'REGION'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    const slug = REG[od[rI].values[ix[rI]].id]; if (!slug) continue;
    const m = od[tI].values[ix[tI]].id.match(/^(\d{4})-Q([1-4])$/); if (!m) continue;
    const endIdx = (+m[1]) * 12 + (+m[2] * 3 - 1);   // quarter-end month index (Q1→Mar=…*12+2)
    (Q[slug] ||= {})[endIdx] = v[0];
  }
} catch (e) {
  console.error('\n✗ ABS fetch failed:', e.message);
  await recordStatus('error', `ABS fetch failed: ${e.message}`);
  process.exit(1);
}

// ── 2) existing DB monthly series ──
const { data: dbRows, error: dbErr } = await sb.from('rdp_raw_series').select('region_slug,period,value').eq('source', 'abs').eq('metric', 'owner_occupier').gte('period', '2019-01-01').order('period');
if (dbErr) { console.error(dbErr.message); process.exit(1); }
const M = {};   // slug -> Map(idx -> value)
for (const r of dbRows || []) { (M[r.region_slug] ||= new Map()).set(periodToIdx(r.period.slice(0, 10)), +r.value); }

const slugs = Object.values(REG);
const avg3 = (map, a, b, c) => { const v = [map.get(a), map.get(b), map.get(c)]; return v.some(x => x == null) ? null : (v[0] + v[1] + v[2]) / 3; };

// ── 3a) VERIFY: recompute the latest quarter already in the DB and compare ──
let vOk = 0, vTot = 0;
console.log('Verify — recompute the latest in-DB quarter from ABS÷3 + trailing averages:');
for (const slug of slugs) {
  const map = M[slug]; const q = Q[slug]; if (!map || !q || !map.size) continue;
  const endIdx = Math.max(...[...map.keys()].filter(i => q[i] != null));   // latest month that's an ABS quarter-end
  if (!isFinite(endIdx)) continue;
  const m1 = endIdx - 2, m2 = endIdx - 1;
  const r1 = avg3(map, endIdx - 5, endIdx - 4, endIdx - 3);
  const tmp = new Map(map); if (r1 != null) tmp.set(m1, r1);
  const r2 = avg3(tmp, endIdx - 4, endIdx - 3, m1);
  const r3 = q[endIdx] / 3;
  const close = (a, b) => a != null && b != null && Math.abs(a - b) < 0.05;
  for (const [name, got, want] of [[idxLabel(m1), r1, map.get(m1)], [idxLabel(m2), r2, map.get(m2)], [idxLabel(endIdx), r3, map.get(endIdx)]]) { vTot++; if (close(got, want)) vOk++; }
  if (slug === 'st-nsw') console.log(`  st-nsw ${idxLabel(endIdx)} quarter: ${idxLabel(m1)}=${r1?.toFixed(2)} ${idxLabel(m2)}=${r2?.toFixed(2)} ${idxLabel(endIdx)}=${r3?.toFixed(2)} (DB ${map.get(m1)} / ${map.get(m2)} / ${map.get(endIdx)})`);
}
console.log(`  → ${vOk}/${vTot} recomputed values match the DB.\n`);

// ── 3b) APPEND: any ABS quarter newer than the DB's latest month ──
const newRows = []; const addedByRegion = {}; let missingPriors = [];
for (const slug of slugs) {
  const map = M[slug] || new Map(); const q = Q[slug] || {};
  const dbLatest = map.size ? Math.max(...map.keys()) : -1;
  for (const endIdx of Object.keys(q).map(Number).sort((a, b) => a - b)) {
    if (endIdx <= dbLatest) continue;                       // already have this quarter (append-only)
    const m1 = endIdx - 2, m2 = endIdx - 1;
    const r1 = avg3(map, endIdx - 5, endIdx - 4, endIdx - 3);
    if (r1 == null) { missingPriors.push(`${slug} ${idxLabel(endIdx)}`); continue; }
    map.set(m1, r1);
    const r2 = avg3(map, endIdx - 4, endIdx - 3, m1); map.set(m2, r2);
    const r3 = q[endIdx] / 3; map.set(endIdx, r3);
    for (const [i, val] of [[m1, r1], [m2, r2], [endIdx, r3]]) newRows.push({ source: 'abs', region_slug: slug, metric: 'owner_occupier', freq: 'M', period: idxToPeriod(i), value: val });
    (addedByRegion[slug] ||= []).push(idxLabel(endIdx));
  }
}

const latestQ = Math.max(...slugs.flatMap(s => Object.keys(Q[s] || {}).map(Number)), -1);
console.log(`ABS latest quarter end-month: ${idxLabel(latestQ)} (${idxLabel(latestQ).slice(0,4)}-Q${Math.floor((latestQ%12)/3)+1}).`);
const addedQ = [...new Set(Object.values(addedByRegion).flat())];
console.log(addedQ.length ? `New quarters to append: ${addedQ.join(', ')} (${newRows.length} months across ${Object.keys(addedByRegion).length} regions).` : 'DB already current — no new quarters to append.');
if (missingPriors.length) console.log(`⚠ Could not compute (missing prior months): ${missingPriors.join(', ')}`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to append into rdp_raw_series.'); process.exit(0); }

let written = 0;
for (let k = 0; k < newRows.length; k += 500) {
  const chunk = newRows.slice(k, k + 500);
  const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' });
  if (error) { console.error('\n', error.message); process.exit(1); }
  written += chunk.length;
}
const bad = missingPriors.length > 0;
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS lending ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: bad ? 'partial' : 'ok', notes: `ABS LEND_HOUSING owner-occupier (quarterly→monthly): ${addedQ.length ? 'appended ' + addedQ.join(', ') : 'no new quarters'}; verify ${vOk}/${vTot}${bad ? '; missing priors: ' + missingPriors.join(', ') : ''}` });
await recordStatus(bad ? 'error' : 'ok',
  bad ? `Missing prior months for: ${missingPriors.join(', ')}` : (addedQ.length ? `Appended ${addedQ.join(', ')}. Current through ${idxLabel(latestQ)}.` : `Current through ${idxLabel(latestQ)} — no new quarter to add.`),
  { row_count: written, region_count: slugs.length, latest_year: +idxLabel(latestQ).slice(0, 4) });
console.log(`\n✓ Appended ${written} lending month-rows into rdp_raw_series.`);
process.exit(bad ? 1 : 0);
