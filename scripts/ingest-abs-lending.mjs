// =============================================================================
// ingest-abs-lending.mjs — Data Forge path: LENDING, monthly. Handles BOTH
// lending series (same ABS dataflow, same logic, different HOUSING_PURPOSE):
//   • Owner Occupier  HOUSING_PURPOSE=DV5167  (DB metric 'owner_occupier', key 'lending')
//   • Investors       HOUSING_PURPOSE=DV5168  (DB metric 'investor',       key 'investor')
//
// ABS publishes these QUARTERLY; the DB stores them MONTHLY via the user's
// quarterly→monthly disaggregation. For each quarter (months M1,M2,M3 — e.g.
// Jan,Feb,Mar, M3 = quarter-END month):
//   M3 (quarter-end) = ABS quarterly value / 3
//   M1 (first month) = average of the 3 months immediately before M1
//   M2 (second)      = average of the 3 months immediately before M2 (incl. M1)
// APPEND-ONLY: a new quarter is built from the EXISTING DB months; prior months
// are never re-revised (ABS revisions to old quarters are ignored, matching DB).
//
// ABS series (verified: NSW Q1-2026 OO 16600.5/3=5533.5, Inv 12848.7/3=4282.9):
//   LEND_HOUSING  FIN_VAL.NEWCOMMITS.DV8368.TOTDWELL.TOT.<HP>.10.<region>.Q
//   = value($m), new commitments, total fixed-term+revolving, total dwellings
//     excl. refinancing, all lenders, <HP>, Original. REGION AUS+1..8.
//
// ISOLATED: rdp_raw_series (source='abs', freq='M') + rdp_runs + forge_data_status.
// Dry-run by DEFAULT (verifies latest DB quarter recomputes + lists new quarters);
// --write appends. --only=lending|investor limits to one series.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;
const API = 'https://data.api.abs.gov.au/rest';
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`ABS ${r.status}: ${t.slice(0, 80)}`); } };

const REG = { AUS: 'australia', '1': 'st-nsw', '2': 'st-vic', '3': 'st-qld', '4': 'st-sa', '5': 'st-wa', '6': 'st-tas', '7': 'st-nt', '8': 'st-act' };
const idxToPeriod = i => `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}-01`;
const periodToIdx = p => { const [y, m] = p.split('-'); return (+y) * 12 + (+m - 1); };
const idxLabel = i => idxToPeriod(i).slice(0, 7);
const avg3 = (map, a, b, c) => { const v = [map.get(a), map.get(b), map.get(c)]; return v.some(x => x == null) ? null : (v[0] + v[1] + v[2]) / 3; };

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const FSOURCE = 'ABS Lending Indicators (LEND_HOUSING)';

const DATASETS = [
  { metric: 'owner_occupier', hp: 'DV5167', fk: 'lending',  label: 'Lending — Owner Occupier' },
  { metric: 'investor',       hp: 'DV5168', fk: 'investor', label: 'Lending — Investors' },
].filter(d => !ONLY || d.fk === ONLY || d.metric === ONLY);

async function recordStatus(fk, label, status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: fk, label, source: FSOURCE, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn(`  (${fk} status not updated — apply migration 053? ${error.message})`);
}

async function processDataset(ds) {
  console.log(`\n=== ${ds.label}  (metric=${ds.metric}, HOUSING_PURPOSE=${ds.hp}) ===`);

  // 1) ABS quarterly value per region
  const Q = {};
  try {
    const j = await getJson(`${API}/data/LEND_HOUSING/FIN_VAL.NEWCOMMITS.DV8368.TOTDWELL.TOT.${ds.hp}.10..Q?startPeriod=2015-Q1&format=jsondata&dimensionAtObservation=AllDimensions`);
    const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
    const rI = od.findIndex(d => d.id === 'REGION'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
    for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
      const ix = k.split(':').map(Number);
      const slug = REG[od[rI].values[ix[rI]].id]; if (!slug) continue;
      const m = od[tI].values[ix[tI]].id.match(/^(\d{4})-Q([1-4])$/); if (!m) continue;
      (Q[slug] ||= {})[(+m[1]) * 12 + (+m[2] * 3 - 1)] = v[0];
    }
  } catch (e) { console.error('  ✗ ABS fetch failed:', e.message); await recordStatus(ds.fk, ds.label, 'error', `ABS fetch failed: ${e.message}`); return false; }

  // 2) existing DB monthly series
  const { data: dbRows, error: dbErr } = await sb.from('rdp_raw_series').select('region_slug,period,value').eq('source', 'abs').eq('metric', ds.metric).gte('period', '2019-01-01').order('period');
  if (dbErr) { console.error(' ', dbErr.message); await recordStatus(ds.fk, ds.label, 'error', `DB read failed: ${dbErr.message}`); return false; }
  const M = {};
  for (const r of dbRows || []) { (M[r.region_slug] ||= new Map()).set(periodToIdx(r.period.slice(0, 10)), +r.value); }

  const slugs = Object.values(REG);

  // 3a) verify — recompute the latest in-DB quarter and compare
  let vOk = 0, vTot = 0;
  for (const slug of slugs) {
    const map = M[slug], q = Q[slug]; if (!map || !q || !map.size) continue;
    const endIdx = Math.max(...[...map.keys()].filter(i => q[i] != null)); if (!isFinite(endIdx)) continue;
    const r1 = avg3(map, endIdx - 5, endIdx - 4, endIdx - 3);
    const tmp = new Map(map); if (r1 != null) tmp.set(endIdx - 2, r1);
    const r2 = avg3(tmp, endIdx - 4, endIdx - 3, endIdx - 2);
    const r3 = q[endIdx] / 3;
    const close = (a, b) => a != null && b != null && Math.abs(a - b) < 0.05;
    for (const [got, want] of [[r1, map.get(endIdx - 2)], [r2, map.get(endIdx - 1)], [r3, map.get(endIdx)]]) { vTot++; if (close(got, want)) vOk++; }
    if (slug === 'st-nsw') console.log(`  verify st-nsw ${idxLabel(endIdx)}: ${idxLabel(endIdx-2)}=${r1?.toFixed(2)} ${idxLabel(endIdx-1)}=${r2?.toFixed(2)} ${idxLabel(endIdx)}=${r3?.toFixed(2)} (DB ${map.get(endIdx-2)} / ${map.get(endIdx-1)} / ${map.get(endIdx)})`);
  }
  console.log(`  verify: ${vOk}/${vTot} recomputed values match the DB.`);

  // 3b) append any ABS quarter newer than the DB's latest month
  const newRows = [], addedByRegion = {}, missingPriors = [];
  for (const slug of slugs) {
    const map = M[slug] || new Map(), q = Q[slug] || {};
    const dbLatest = map.size ? Math.max(...map.keys()) : -1;
    for (const endIdx of Object.keys(q).map(Number).sort((a, b) => a - b)) {
      if (endIdx <= dbLatest) continue;
      const r1 = avg3(map, endIdx - 5, endIdx - 4, endIdx - 3);
      if (r1 == null) { missingPriors.push(`${slug} ${idxLabel(endIdx)}`); continue; }
      map.set(endIdx - 2, r1);
      const r2 = avg3(map, endIdx - 4, endIdx - 3, endIdx - 2); map.set(endIdx - 1, r2);
      const r3 = q[endIdx] / 3; map.set(endIdx, r3);
      for (const [i, val] of [[endIdx - 2, r1], [endIdx - 1, r2], [endIdx, r3]]) newRows.push({ source: 'abs', region_slug: slug, metric: ds.metric, freq: 'M', period: idxToPeriod(i), value: val });
      (addedByRegion[slug] ||= []).push(idxLabel(endIdx));
    }
  }
  const latestQ = Math.max(...slugs.flatMap(s => Object.keys(Q[s] || {}).map(Number)), -1);
  const addedQ = [...new Set(Object.values(addedByRegion).flat())];
  console.log(`  ABS latest quarter end-month: ${idxLabel(latestQ)}. ${addedQ.length ? 'New quarters: ' + addedQ.join(', ') + ` (${newRows.length} months)` : 'DB already current — nothing to append.'}`);
  if (missingPriors.length) console.log(`  ⚠ missing prior months: ${missingPriors.join(', ')}`);

  if (!WRITE) return true;

  let written = 0;
  for (let k = 0; k < newRows.length; k += 500) {
    const chunk = newRows.slice(k, k + 500);
    const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' });
    if (error) { console.error('  ', error.message); await recordStatus(ds.fk, ds.label, 'error', `upsert failed: ${error.message}`); return false; }
    written += chunk.length;
  }
  const bad = missingPriors.length > 0;
  await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS ${ds.fk} ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: bad ? 'partial' : 'ok', notes: `${ds.label} (quarterly→monthly): ${addedQ.length ? 'appended ' + addedQ.join(', ') : 'no new quarters'}; verify ${vOk}/${vTot}${bad ? '; missing priors: ' + missingPriors.join(', ') : ''}` });
  await recordStatus(ds.fk, ds.label, bad ? 'error' : 'ok',
    bad ? `Missing prior months for: ${missingPriors.join(', ')}` : (addedQ.length ? `Appended ${addedQ.join(', ')}. Current through ${idxLabel(latestQ)}.` : `Current through ${idxLabel(latestQ)} — no new quarter to add.`),
    { row_count: written, region_count: slugs.length, latest_year: +idxLabel(latestQ).slice(0, 4) });
  console.log(`  ✓ Appended ${written} ${ds.metric} month-rows.`);
  return !bad;
}

let allOk = true;
for (const ds of DATASETS) { allOk = (await processDataset(ds)) && allOk; }
if (!WRITE) console.log('\nDry run. Re-run with --write to append into rdp_raw_series.');
process.exit(allOk ? 0 : 1);
