// =============================================================================
// ingest-sqm-vacancy.mjs — SQM Research vacancy rates → Forge.
//
// Companion to ingest-sqm-rents.mjs, same region map (sqm-regions.mjs) but the
// vacancy-rates endpoint. That page renders a Highcharts chart whose series is
// built from an embedded  var data = [{year,month,properties,listings,vr}, …]
// where `vr` is a decimal (0.0068 = 0.68%). We take the LATEST month:
//     vacancy % = parseFloat(last.vr) * 100
//
// NOTE: this is the RAW SQM vacancy rate. The Demand Score engine uses an
// "Adjusted VR", computed from this raw VR in a separate step (another sheet,
// to be ported later). Here it just populates the raw-VR store / card tab.
//
// Merges vr / vr_as_of / vr_fetched_at into forge_demand_inputs (preserving
// listings + rents). Dry-run by DEFAULT; --write upserts + logs rdp_runs.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { SQM_REGIONS, SQM_UA, sqmUrl } from './sqm-regions.mjs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL_SB = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL_SB, KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': SQM_UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }, redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// Extract the latest vacancy rate (%) + its year-month from the embedded
// `var data = [{year,month,…,vr}, …]` chart array.
function parseVacancy(html) {
  const m = html.match(/var data = (\[[\s\S]*?\])\s*;/);
  if (!m) return null;
  let arr; try { arr = JSON.parse(m[1]); } catch { return null; }
  if (!Array.isArray(arr) || !arr.length) return null;
  const last = arr[arr.length - 1];
  const vr = parseFloat(last.vr);
  if (!isFinite(vr)) return null;
  return { vr: Math.round(vr * 100 * 100) / 100, asOf: last.year + '-' + String(last.month).padStart(2, '0') };
}

const results = {}; let asOf = null, ok = 0; const failed = [];
for (const r of SQM_REGIONS) {
  try {
    const v = parseVacancy(await fetchHtml(sqmUrl('vacancy-rates', r.qs)));
    if (!v) { console.log(`  ${r.slug}: no data parsed`); failed.push(r.slug); continue; }
    results[r.slug] = v;
    if (asOf == null) asOf = v.asOf;
    ok++;
    console.log(`  ${r.slug}: VR ${v.vr}% (as of ${v.asOf})`);
  } catch (e) { console.log(`  ${r.slug}: ERROR ${e.message}`); failed.push(r.slug); }
  await sleep(500);
}
console.log(`\nParsed ${ok}/${SQM_REGIONS.length} regions (${failed.length} failed). As of: ${asOf || 'unknown'}`);

// forge_data_status under 'demand_inputs' — a broken SQM run flags the Demand
// Score Dashboard Data card red in the Data Forge UI (not just the Actions log).
async function recordStatus(status, message) {
  try { const now = new Date().toISOString();
    const row = { data_key: 'demand_inputs', label: 'Demand Score Dashboard Data', source: 'SQM rents + vacancy (auto) / REA listings (manual)', status, message, last_run_at: now, updated_at: now };
    if (status === 'ok') row.last_ok_at = now;
    await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  } catch {}
}

if (!WRITE) { console.log('\nDry run — re-run with --write to merge into forge_demand_inputs.'); process.exit(0); }
if (!ok) { console.error('Nothing parsed — refusing to write.'); await recordStatus('error', 'SQM vacancy: nothing parsed'); process.exit(1); }

const { data: existing } = await sb.from('forge_demand_inputs').select('data').eq('id', 'latest').maybeSingle();
const store = (existing && existing.data) || { regions: {} };
if (!store.regions) store.regions = {};
const nowIso = new Date().toISOString();
for (const [slug, v] of Object.entries(results)) {
  const rec = store.regions[slug] || (store.regions[slug] = {});
  rec.vr = v.vr; rec.vr_as_of = v.asOf; rec.vr_fetched_at = nowIso;
}
store.vr_as_of = asOf || null;
const { error } = await sb.from('forge_demand_inputs').upsert({ id: 'latest', data: store, updated_at: nowIso, uploaded_at: nowIso, uploaded_by: 'ingest-sqm-vacancy' }, { onConflict: 'id' });
if (error) { console.error('Upsert failed:', error.message); await recordStatus('error', 'SQM vacancy upsert failed: ' + error.message); process.exit(1); }
try { await sb.from('rdp_runs').insert({ dataset: 'sqm_vacancy', source_month: asOf || nowIso.slice(0, 7), row_count: ok, status: 'ok', notes: `${ok} regions; SQM current vacancy rate %` }); } catch {}
await recordStatus(failed.length > 5 ? 'error' : 'ok', `SQM vacancy: ${ok}/${SQM_REGIONS.length} regions (as of ${asOf || 'unknown'})${failed.length ? ', failed: ' + failed.join(', ') : ''}`);
console.log(`\n✓ Merged SQM vacancy for ${ok} regions into forge_demand_inputs (as of ${asOf || 'unknown'}).`);
