// =============================================================================
// ingest-rba-commercial.mjs — Data Forge path: COMMERCIAL report RBA series,
// monthly + annual (year-end), national. Auto-refresh upgrade for series that
// were seeded statically into forge_commercial.
//
// Each series is PINNED against the seeded Looker values before wiring (so the
// API series reproduces the report). Stored as DECIMAL fractions (5.47% →
// 0.0547) to match the seeded columns.
//
//   • corporate_bond_yield → RBA F3 "f3-data.csv", series FNFYA10M
//     (Non-financial corporate A-rated bonds – Yield, 10yr). Pinned vs the
//     "Corporate Bond Data" tab: mean abs diff 0.022% over 256 months.
//   • govt_bond_yield → RBA F2 "f2-data.csv", series FCMYGBAG10D (Australian
//     Government 10 year bond, DAILY → month-end). Pinned vs the "Govt Bonds
//     Data" tab: MAD 0.033% over 157 months. NOTE F2's CSV only goes back to
//     2013 — pre-2013 (2004-2012) stays on the forge_commercial seed.
//   • term_deposit_1y → RBA F4 "f4-data.csv", series FRDIRBTD10K1Y (Banks' term
//     deposit $10k, 1 year). This is the series the report's p11 plots (its
//     "5 year average (1 year)" column is mislabelled — it's the raw 1-yr rate).
//
// ISOLATED: rdp_raw_series (source='rba', region 'australia', freq M & A) +
// rdp_runs + forge_data_status. Upsert-only. Dry-run by DEFAULT; --write upserts.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' };
const Q = String.fromCharCode(34);
const parseCsv = t => t.split(/\r?\n/).map(l => { const o = []; let c = '', q = false; for (const ch of l) { if (ch === Q) q = !q; else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o; });

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

// RBA CSV date → 'YYYY-MM'. Handles both dd/mm/yyyy (monthly tables) and
// dd-Mon-yyyy (F2 daily). For daily, last value in a month = month-end.
const MON3 = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function ymOf(s) { let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); if (m) return `${m[3]}-${m[2]}`; m = s.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/); if (m) return `${m[3]}-${MON3[m[2].toLowerCase()]}`; return null; }

// RBA CSV table → { 'YYYY-MM': percent } for a series id (last value per month = month-end)
async function rbaMonthly(url, sid) {
  const g = parseCsv(await (await fetch(url, { headers: UA })).text());
  const sidRow = g.findIndex(r => r[0] && /Series ID/i.test(r[0]));
  if (sidRow < 0) throw new Error('no Series ID row in ' + url);
  const col = g[sidRow].findIndex(x => x.trim() === sid);
  if (col < 0) throw new Error('series ' + sid + ' not found in ' + url);
  const out = {};
  for (let r = sidRow + 1; r < g.length; r++) { const ym = ymOf(g[r][0] || ''); const v = parseFloat(g[r][col]); if (!ym || isNaN(v)) continue; out[ym] = v; }
  return out;
}

const SERIES = [
  { metric: 'corporate_bond_yield', url: 'https://www.rba.gov.au/statistics/tables/csv/f3-data.csv', sid: 'FNFYA10M', label: 'Corporate Bond Yield', source: 'RBA F3 (non-financial A-rated 10yr)' },
  { metric: 'govt_bond_yield', url: 'https://www.rba.gov.au/statistics/tables/csv/f2-data.csv', sid: 'FCMYGBAG10D', label: 'Govt Bond Yield (10yr)', source: 'RBA F2 (Australian Government 10yr bond, daily→month-end; 2013+)' },
  { metric: 'term_deposit_1y', url: 'https://www.rba.gov.au/statistics/tables/csv/f4-data.csv', sid: 'FRDIRBTD10K1Y', label: 'Term Deposit Rate (1yr)', source: 'RBA F4 (Banks term deposit $10k 1yr)' },
];

async function recordStatus(key, label, source, status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: key, label, source, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated? ' + error.message + ')');
}

const all = [];
for (const s of SERIES) {
  let monthly;
  try { monthly = await rbaMonthly(s.url, s.sid); }
  catch (e) { console.error(`\n✗ ${s.metric} fetch failed:`, e.message); await recordStatus(s.metric, s.label, s.source, 'error', `fetch failed: ${e.message}`); process.exit(1); }
  const months = Object.keys(monthly).sort();
  if (!months.length) { console.error(`\n✗ ${s.metric}: no data`); process.exit(1); }
  const rows = months.map(ym => ({ source: 'rba', region_slug: 'australia', metric: s.metric, freq: 'M', period: ym + '-01', value: +(monthly[ym] / 100).toFixed(5) }));
  const byYear = {}; for (const ym of months) byYear[ym.slice(0, 4)] = ym;   // last month per year
  for (const [y, ym] of Object.entries(byYear)) rows.push({ source: 'rba', region_slug: 'australia', metric: s.metric, freq: 'A', period: y + '-01-01', value: +(monthly[ym] / 100).toFixed(5) });
  const last = months[months.length - 1];
  console.log(`${s.metric}: ${months.length} months ${months[0]}..${last} = ${monthly[last].toFixed(2)}%  (${s.source})`);
  all.push({ s, rows, last, monthly });
}

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(0); }

const rows = all.flatMap(x => x.rows);
let written = 0;
for (let k = 0; k < rows.length; k += 500) { const chunk = rows.slice(k, k + 500); const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' }); if (error) { console.error('\n', error.message); process.exit(1); } written += chunk.length; }
for (const x of all) await recordStatus(x.s.metric, x.s.label, x.s.source, 'ok', `Current through ${x.last} (${x.monthly[x.last].toFixed(2)}%).`, { row_count: x.rows.length, region_count: 1, latest_year: +x.last.slice(0, 4) });
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `RBA commercial ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: 'ok', notes: `RBA commercial series (${SERIES.map(s => s.metric).join(', ')}), monthly + annual` });
console.log(`\n✓ Upserted ${written} rows (${SERIES.map(s => s.metric).join(', ')}).`);
process.exit(0);
