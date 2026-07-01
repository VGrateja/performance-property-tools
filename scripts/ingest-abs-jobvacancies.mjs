// =============================================================================
// ingest-abs-jobvacancies.mjs — Data Forge path: NATIONAL JOB VACANCIES (ABS)
// from the ABS Data API. No key.
//
// Source: ABS Job Vacancies (cat 6354.0), dataflow JV. Key
//   M1.<SECTOR>.TOT.10.AUS.Q  = Job Vacancies (M1), All Industries (TOT),
//   Original (TSEST 10), Australia, quarterly.  SECTOR 1=Private, 2=Public,
//   7=Total. Values published in THOUSANDS (UNIT_MULT 3) and kept as-is to
//   match the user's Data Dump (e.g. 2026-Q1 Private 304.2, Public 38.1).
//   Quarterly; period stored as the quarter's first month
//   (Q1→01, Q2→04, Q3→07, Q4→10), freq='Q'.
//
// Metrics (freq='Q', region 'australia'): job_vacancies_total / _private /
// _public. ISOLATED: rdp_raw_series + rdp_runs + forge_data_status
// ('national_vacancies' — shared with the JSA national internet series).
// Upsert-only. Dry-run by DEFAULT; --write upserts; --from=YYYY.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const FROM = +((process.argv.find(a => a.startsWith('--from=')) || '--from=1990').split('=')[1]) || 1990;
const API = 'https://data.api.abs.gov.au/rest';
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`ABS ${r.status}: ${t.slice(0, 80)}`); } };
const SECTOR = { '7': 'job_vacancies_total', '1': 'job_vacancies_private', '2': 'job_vacancies_public' };
const QMON = { '1': '01', '2': '04', '3': '07', '4': '10' };

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: 'national_vacancies', label: 'National Job Vacancies', source: 'ABS Job Vacancies (6354.0) + JSA IVI', status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated? ' + error.message + ')');
}

const rows = [];
try {
  const j = await getJson(`${API}/data/JV/M1.1+2+7.TOT.10.AUS.Q?startPeriod=${FROM}-Q1&format=jsondata&dimensionAtObservation=AllDimensions`);
  const st = j.data.structure || j.data.structures[0]; const od = st.dimensions.observation;
  const sI = od.findIndex(d => d.id === 'SECTOR'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    const metric = SECTOR[od[sI].values[ix[sI]].id]; if (!metric) continue;
    const m = od[tI].values[ix[tI]].id.match(/^(\d{4})-Q([1-4])$/); if (!m) continue;
    rows.push({ source: 'abs', region_slug: 'australia', metric, freq: 'Q', period: `${m[1]}-${QMON[m[2]]}-01`, value: v[0] });   // kept in '000s
  }
} catch (e) { console.error('\n✗ ABS JV fetch failed:', e.message); await recordStatus('error', `ABS JV fetch failed: ${e.message}`); process.exit(1); }

const latest = rows.reduce((a, r) => r.period > a ? r.period : a, '');
const byMetric = {};
for (const r of rows) (byMetric[r.metric] ||= []).push(r);

// The ABS Job Vacancies Survey was SUSPENDED (no collection) between mid-2008 and
// late-2009, so those quarters come back as null observations and would break the
// line. The report + the original Data Dump carry the last pre-suspension value
// forward across the gap. Do the same here (last-observation-carried-forward) so
// the series stays continuous — INTERIOR gaps only, so a genuinely-missing latest
// quarter still fails the completeness check below rather than being masked.
let filled = 0;
for (const m of Object.values(SECTOR)) {
  const s = (byMetric[m] || []).slice().sort((a, b) => a.period < b.period ? -1 : 1);
  let last = null;
  for (let i = 0; i < s.length; i++) {
    if (s[i].value != null) { last = s[i].value; continue; }
    if (last != null && s.slice(i + 1).some(x => x.value != null)) { s[i].value = last; filled++; }
  }
}
if (filled) console.log(`  (carried last value forward across ${filled} suspended/interior null quarter(s))`);
console.log(`ABS Job Vacancies (JV, Original, $'000s) — ${rows.length} rows, latest ${latest}:`);
for (const m of Object.values(SECTOR)) { const r = (byMetric[m] || []).find(x => x.period === latest); console.log('  ' + m.padEnd(22), r ? r.value : '—'); }
const missing = Object.values(SECTOR).filter(m => !(byMetric[m] || []).some(r => r.period === latest));
if (missing.length) console.error(`\n✗ COMPLETENESS FAIL: missing ${latest} for ${missing.join(', ')}`);
else console.log(`\n✓ all 3 sectors have ${latest}.`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(missing.length ? 1 : 0); }

let written = 0;
for (let k = 0; k < rows.length; k += 500) { const chunk = rows.slice(k, k + 500); const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' }); if (error) { console.error('\n', error.message); process.exit(1); } written += chunk.length; }
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS jobvacancies ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: missing.length ? 'partial' : 'ok', notes: `ABS JV national job vacancies (Original, $'000s, total/private/public), through ${latest}` });
await recordStatus(missing.length ? 'error' : 'ok', missing.length ? `Missing ${latest}` : `ABS job vacancies current through ${latest}; JSA internet vacancies via the JSA ingest.`, { row_count: written, region_count: 1, latest_year: +latest.slice(0, 4) });
console.log(`\n✓ Upserted ${written} job-vacancies rows.`);
process.exit(missing.length ? 1 : 0);
