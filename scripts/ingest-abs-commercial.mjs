// =============================================================================
// ingest-abs-commercial.mjs — Data Forge path: COMMERCIAL report ABS series,
// from the ABS Data API. Auto-refresh upgrade for series seeded statically into
// forge_commercial. Each series is PINNED against the seeded Looker values.
//
//   • retail_trade (monthly $m) → dataflow RT, key M1.20.10.AUS.M
//     (Turnover, Total industry, Original, Australia, monthly). This is ABS
//     Retail Trade 8501.0 (series A3348582J) — the Commercial report's p8,
//     DISTINCT from the residential retail_turnover (Household Spending 5682.0).
//     Pinned vs the "Retail Turnover Data" tab: 2025-06 = 36,352 vs 36,351.9.
//
// ISOLATED: rdp_raw_series (source='abs', region 'australia') + rdp_runs +
// forge_data_status. Upsert-only (preserve old history). Dry-run by DEFAULT.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const API = 'https://data.api.abs.gov.au/rest';
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/vnd.sdmx.data+json' } }); const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`ABS ${r.status}: ${t.slice(0, 100)}`); } };

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
async function recordStatus(key, label, source, status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: key, label, source, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated? ' + error.message + ')');
}

// fetch a single-series monthly ABS key → { 'YYYY-MM': value }
async function absMonthly(dataflow, key, from) {
  const j = await getJson(`${API}/data/${dataflow}/${key}?startPeriod=${from}&format=jsondata&dimensionAtObservation=AllDimensions`);
  const od = (j.data.structure || j.data.structures[0]).dimensions.observation;
  const tI = od.findIndex(d => d.id === 'TIME_PERIOD');
  const out = {};
  for (const [k, v] of Object.entries(j.data.dataSets[0].observations)) {
    const ix = k.split(':').map(Number);
    const m = od[tI].values[ix[tI]].id.match(/^(\d{4})-(\d{2})$/); if (!m) continue;
    out[`${m[1]}-${m[2]}`] = v[0];
  }
  return out;
}

const SERIES = [
  { metric: 'retail_trade', dataflow: 'RT', key: 'M1.20.10.AUS.M', from: '1982-01', label: 'Retail Trade (monthly)', source: 'ABS Retail Trade 8501.0 (A3348582J: total, current prices, original)' },
];

const rows = [];
const report = [];
for (const s of SERIES) {
  let monthly;
  try { monthly = await absMonthly(s.dataflow, s.key, s.from); }
  catch (e) { console.error(`\n✗ ${s.metric} fetch failed:`, e.message); await recordStatus(s.metric, s.label, s.source, 'error', `fetch failed: ${e.message}`); process.exit(1); }
  const months = Object.keys(monthly).sort();
  if (!months.length) { console.error(`\n✗ ${s.metric}: no data`); process.exit(1); }
  for (const ym of months) rows.push({ source: 'abs', region_slug: 'australia', metric: s.metric, freq: 'M', period: ym + '-01', value: monthly[ym] });
  const last = months[months.length - 1];
  console.log(`${s.metric}: ${months.length} months ${months[0]}..${last} = ${Math.round(monthly[last]).toLocaleString()}  (${s.source})`);
  report.push({ s, count: months.length, last, lastVal: monthly[last] });
}

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(0); }

let written = 0;
for (let k = 0; k < rows.length; k += 500) { const chunk = rows.slice(k, k + 500); const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' }); if (error) { console.error('\n', error.message); process.exit(1); } written += chunk.length; }
for (const x of report) await recordStatus(x.s.metric, x.s.label, x.s.source, 'ok', `Current through ${x.last} ($${Math.round(x.lastVal).toLocaleString()}m).`, { row_count: x.count, region_count: 1, latest_year: +x.last.slice(0, 4) });
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS commercial ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: 'ok', notes: `ABS commercial series (${SERIES.map(s => s.metric).join(', ')}), monthly` });
console.log(`\n✓ Upserted ${written} rows (${SERIES.map(s => s.metric).join(', ')}).`);
process.exit(0);
