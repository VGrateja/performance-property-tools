// =============================================================================
// ingest-fred-iron-ore.mjs — Data Forge path: IRON ORE PRICE (monthly, USD/t).
//
// The Perth report's iron-ore chart uses the IMF "Global price of Iron Ore"
// series (the report guide cites IndexMundi, which republishes the same IMF
// commodity data). That series is published cleanly by FRED as PIORECRUSDM —
// free CSV, no API key, monthly, U.S. dollars per metric ton, 1992→present.
// Verified vs the Data Dump "Perth - Iron" tab: 1995/2000/2005 reproduce the
// sheet's annual figure exactly; the sheet's later annual values are simply the
// JANUARY reading of each year (e.g. 2020 = 93.94 ≈ Jan-2020), so the monthly
// series here reproduces both the January value and the calendar-year average.
//
// ISOLATED: writes ONLY to rdp_raw_series (source='imf', region_slug='global',
// metric='iron_ore_price', freq='M', period 'YYYY-MM-01') + logs rdp_runs +
// records health in forge_data_status (data_key='iron_ore_price'). Upsert-only
// (never deletes), so any pre-1992 history already in the DB is preserved.
//
// Dry-run by DEFAULT. Pass --write to upsert.
//   node scripts/ingest-fred-iron-ore.mjs            # dry run
//   node scripts/ingest-fred-iron-ore.mjs --write    # upsert
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');

const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=PIORECRUSDM';

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

const FK = 'iron_ore_price', FLABEL = 'Iron Ore Price', FSOURCE = 'FRED PIORECRUSDM (IMF Global price of Iron Ore)';
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: FK, label: FLABEL, source: FSOURCE, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated — ' + error.message + ')');
}

// ── fetch + parse FRED CSV (observation_date,VALUE; "." = missing) ──
const rows = [];
try {
  const r = await fetch(FRED_CSV);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const txt = await r.text();
  const lines = txt.trim().split(/\r?\n/); lines.shift();   // drop header
  for (const ln of lines) {
    const [date, raw] = ln.split(',');
    const v = Number(raw);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(v) || raw === '.' || raw === '') continue;
    rows.push({ source: 'imf', region_slug: 'global', metric: 'iron_ore_price', freq: 'M', period: `${date.slice(0, 7)}-01`, value: v });
  }
} catch (e) {
  console.error('\n✗ FRED fetch failed:', e.message);
  await recordStatus('error', `FRED fetch failed: ${e.message}`);
  process.exit(1);
}

rows.sort((a, b) => a.period < b.period ? -1 : 1);
const first = rows[0], last = rows[rows.length - 1];
console.log(`FRED iron ore (PIORECRUSDM) — ${rows.length} monthly obs, ${first ? first.period.slice(0, 7) : '—'} → ${last ? last.period.slice(0, 7) : '—'} (USD/tonne)\n`);
console.log('latest 6 months:');
for (const r of rows.slice(-6)) console.log('  ' + r.period.slice(0, 7), '  $' + r.value.toFixed(1) + '/t');
// year-on-year sanity for the latest year
const yr = last ? last.period.slice(0, 4) : null;
if (yr) { const ys = rows.filter(r => r.period.slice(0, 4) === yr).map(r => r.value); console.log(`\n${yr}: ${ys.length} months · avg $${(ys.reduce((a, b) => a + b, 0) / ys.length).toFixed(1)} · Jan $${(rows.find(r => r.period === yr + '-01-01') || {}).value ?? '—'}`); }

if (!rows.length) { console.error('✗ No observations parsed.'); await recordStatus('error', 'No observations parsed from FRED CSV.'); process.exit(1); }
if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(0); }

let written = 0;
for (let i = 0; i < rows.length; i += 500) {
  const chunk = rows.slice(i, i + 500);
  const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' });
  if (error) { console.error('\n', error.message); await recordStatus('error', error.message); process.exit(1); }
  written += chunk.length; process.stdout.write(`\r  upserted ${written}/${rows.length}`);
}
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `FRED iron ore ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: 'ok', notes: `FRED PIORECRUSDM (IMF iron ore) monthly USD/t, ${first.period.slice(0, 7)}..${last.period.slice(0, 7)}` });
await recordStatus('ok', `Monthly through ${last.period.slice(0, 7)} (latest $${last.value.toFixed(1)}/t).`, { row_count: written, latest_year: +last.period.slice(0, 4) });
console.log(`\n✓ Upserted ${written} iron-ore rows into rdp_raw_series.`);
process.exit(0);
