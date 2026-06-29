// =============================================================================
// ingest-abs-mineral-exploration.mjs — Data Forge path: MINERAL EXPLORATION
// expenditure (quarterly, $m) straight from the ABS Data API. No key.
//
// The Perth report's "Mineral Exploration Expenditure" chart (page 25) uses WA
// mineral exploration. The report guide cites ABS "Mineral and Petroleum
// Exploration, Australia" (cat 8412.0), Table 4, series A2266883F. That is the
// ABS dataflow MIN_EXP, key:
//   MEASURE=1 (Expenditure) · DEPOSIT_TYPE=6 (Total deposits) ·
//   MINERAL_TYPE=TOT (Total) · TSEST=10 (Original) · REGION · FREQ=Q
// Verified: WA Original reproduces the Data Dump "Mining"/"Perth - Iron" tab to
// the decimal (2004-Q1=96.5, Q2=138.8, Q3=147.9, Q4=156.7). ABS covers
// 1988-Q3→present (longer than the sheet). This pulls all 7 mining states + AUS
// (the Perth report uses WA; the rest are stored for completeness).
//
// ISOLATED: writes ONLY to rdp_raw_series (source='abs',
// metric='mineral_exploration', freq='Q', period quarter-start 'YYYY-MM-01') +
// logs rdp_runs + records health in forge_data_status
// (data_key='mineral_exploration'). Upsert-only.
//
// Dry-run by DEFAULT. Pass --write to upsert.
//   node scripts/ingest-abs-mineral-exploration.mjs            # dry run
//   node scripts/ingest-abs-mineral-exploration.mjs --write    # upsert
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');

const API = 'https://data.api.abs.gov.au/rest';
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`ABS ${r.status}: ${t.slice(0, 100)}`); } };

// ABS REGION code → slug (mineral exploration has no ACT)
const REGION_SLUG = { '1': 'st-nsw', '2': 'st-vic', '3': 'st-qld', '4': 'st-sa', '5': 'st-wa', '6': 'st-tas', '7': 'st-nt', AUS: 'australia' };
const Q_MONTH = { Q1: '01', Q2: '04', Q3: '07', Q4: '10' };   // quarter → start month

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

const FK = 'mineral_exploration', FLABEL = 'Mineral Exploration', FSOURCE = 'ABS Data API (MIN_EXP — cat 8412.0, Original)';
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: FK, label: FLABEL, source: FSOURCE, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated — ' + error.message + ')');
}

// ── fetch MIN_EXP: Expenditure · Total deposits · Total mineral · Original · all regions · Q ──
const rows = [];
let latestQ = '';
try {
  // key order: MEASURE.DEPOSIT_TYPE.MINERAL_TYPE.TSEST.REGION.FREQ
  const j = await getJson(`${API}/data/MIN_EXP/1.6.TOT.10..Q?startPeriod=1988&dimensionAtObservation=AllDimensions&format=jsondata`);
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const rI = od.findIndex(d => d.id === 'REGION'), tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    const slug = REGION_SLUG[od[rI].values[ix[rI]].id]; if (!slug) continue;
    const t = od[tI].values[ix[tI]].id;                  // 'YYYY-Qn'
    const m = t.match(/^(\d{4})-(Q[1-4])$/); if (!m) continue;
    if (t > latestQ) latestQ = t;
    rows.push({ source: 'abs', region_slug: slug, metric: 'mineral_exploration', freq: 'Q', period: `${m[1]}-${Q_MONTH[m[2]]}-01`, value: v[0] });
  }
} catch (e) {
  console.error('\n✗ ABS fetch failed:', e.message);
  await recordStatus('error', `ABS fetch failed: ${e.message}`);
  process.exit(1);
}

// ── report ──
const slugs = Object.values(REGION_SLUG);
console.log(`ABS mineral exploration (MIN_EXP, Original $m) — ${rows.length} rows, ${slugs.length} regions, latest ${latestQ}\n`);
const latestRows = rows.filter(r => r.period.startsWith(latestQ.slice(0, 4)) && r.period.slice(5, 7) === Q_MONTH[latestQ.slice(5)]);
console.log('region        latest $m');
for (const slug of slugs) { const r = latestRows.find(x => x.region_slug === slug); console.log(slug.padEnd(13), r ? '$' + r.value.toFixed(1) + 'm' : '—'); }
// WA spot-check vs the Data Dump
const wa04 = q => (rows.find(r => r.region_slug === 'st-wa' && r.period === `2004-${Q_MONTH[q]}-01`) || {}).value;
console.log(`\nWA 2004 check vs sheet (96.5 / 138.8 / 147.9 / 156.7): ${['Q1', 'Q2', 'Q3', 'Q4'].map(q => (wa04(q) ?? '—')).join(' / ')}`);

const missing = slugs.filter(s => !latestRows.some(r => r.region_slug === s));
if (missing.length) console.error(`\n✗ COMPLETENESS: missing ${latestQ} for ${missing.join(', ')}`);
else console.log(`\n✓ All ${slugs.length} regions have a ${latestQ} value.`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(0); }

let written = 0;
for (let i = 0; i < rows.length; i += 500) {
  const chunk = rows.slice(i, i + 500);
  const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' });
  if (error) { console.error('\n', error.message); await recordStatus('error', error.message); process.exit(1); }
  written += chunk.length; process.stdout.write(`\r  upserted ${written}/${rows.length}`);
}
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS mineral exploration ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: 'ok', notes: `MIN_EXP Original total expenditure, ${slugs.length} regions, through ${latestQ}` });
await recordStatus('ok', `Quarterly through ${latestQ}; ${slugs.length} regions (Perth report uses WA).`, { row_count: written, region_count: slugs.length, latest_year: +latestQ.slice(0, 4) });
console.log(`\n✓ Upserted ${written} mineral-exploration rows into rdp_raw_series.`);
process.exit(0);
