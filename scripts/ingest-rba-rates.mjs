// =============================================================================
// ingest-rba-rates.mjs — Data Forge path: CASH RATE + BANK RATE (RBA),
// each stored MONTHLY and ANNUALLY, national.
//
// Source: RBA statistical tables (CSV downloads — no clean API).
//   • Cash rate  → F1.1 "f1.1-data.csv", series FIRMMCRT (Cash Rate Target,
//     monthly). https://www.rba.gov.au/statistics/cash-rate/
//   • Bank rate  → F6 "f6-data.csv", series FLRHOFVA (Housing lending rate,
//     new owner-occupier variable, monthly) + 0.5 pp (user's rule).
//     https://www.rba.gov.au/statistics/interest-rates/
//
// RULE (user's): both stored MONTHLY and ANNUALLY.
//   • monthly = the series value each month (bank = FLRHOFVA + 0.5).
//   • annual  = the year's LAST month (Dec for complete years; the latest
//     available month for the current year). [matches the existing DB annual,
//     e.g. 2025 cash 3.60 = Dec; 2025 bank 6.00 = Dec FLRHOFVA 5.5 + 0.5.]
//   The monthly CASH RATE is what the Runway Workbook averages over the last
//   216 months (its long-run cash-rate assumption) — hence we need it monthly.
//
//   Stored as DECIMAL fractions (4.31% → 0.0431) to match the existing series.
//   ISOLATED: rdp_raw_series (source='rba', metric cash_rate|bank_rate,
//   freq M & A, region 'australia') + rdp_runs + forge_data_status. Upsert-only
//   (never deletes the long annual history). Dry-run by DEFAULT; --write upserts.
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
async function recordStatus(key, label, source, status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: key, label, source, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated? ' + error.message + ')');
}

// fetch an RBA CSV table → { 'YYYY-MM': value } for a given series id (+optional add)
async function rbaMonthly(url, sid, add = 0) {
  const g = parseCsv(await (await fetch(url, { headers: UA })).text());
  const sidRow = g.findIndex(r => r[0] && /Series ID/i.test(r[0]));
  if (sidRow < 0) throw new Error('no Series ID row in ' + url);
  const col = g[sidRow].findIndex(x => x.trim() === sid);
  if (col < 0) throw new Error('series ' + sid + ' not found in ' + url);
  const out = {};
  for (let r = sidRow + 1; r < g.length; r++) {
    const m = (g[r][0] || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); const v = parseFloat(g[r][col]);
    if (!m || isNaN(v)) continue;
    out[`${m[3]}-${m[2]}`] = v + add;   // YYYY-MM -> value (percent)
  }
  return out;
}

// Cash rate target (round, step series) from the RBA cash-rate page change
// history → the month-end target for each month. (f1.1's FIRMMCRT is the
// monthly AVERAGE — fractional in months the rate changed — not the target.)
async function rbaCashTarget() {
  const MON = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const html = await (await fetch('https://www.rba.gov.au/statistics/cash-rate/', { headers: UA })).text();
  const changes = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => c[1].replace(/<[^>]+>/g, '').trim());
    if (cells.length < 2) continue;
    const dm = cells[0].match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/); if (!dm) continue;
    const mo = MON[dm[2].toLowerCase()]; if (!mo) continue;
    const nums = cells.slice(1).map(c => parseFloat(c.replace(/[^0-9.\-]/g, ''))).filter(x => !isNaN(x));
    const tgt = nums.length ? nums[nums.length - 1] : null; if (tgt == null || tgt < 0 || tgt > 20) continue;
    changes.push({ y: +dm[3], m: mo, tgt });
  }
  if (!changes.length) throw new Error('no cash rate target changes parsed from the cash-rate page');
  changes.sort((a, b) => a.y - b.y || a.m - b.m);
  const now = new Date(), endY = now.getUTCFullYear(), endM = now.getUTCMonth() + 1;
  const out = {}; let ci = 0, cur = null;
  for (let y = changes[0].y; y <= endY; y++) for (let mo = 1; mo <= 12; mo++) {
    if (y === endY && mo > endM) break;
    while (ci < changes.length && (changes[ci].y < y || (changes[ci].y === y && changes[ci].m <= mo))) { cur = changes[ci].tgt; ci++; }
    if (cur != null) out[`${y}-${String(mo).padStart(2, '0')}`] = cur;   // YYYY-MM -> target percent
  }
  return out;
}

// build monthly + annual rows from a YYYY-MM->pct map
function buildRows(monthly, metric) {
  const months = Object.keys(monthly).sort();
  const rows = months.map(ym => ({ source: 'rba', region_slug: 'australia', metric, freq: 'M', period: ym + '-01', value: +(monthly[ym] / 100).toFixed(4) }));
  const byYear = {}; for (const ym of months) byYear[ym.slice(0, 4)] = ym;   // last ym per year (sorted)
  for (const [y, ym] of Object.entries(byYear)) rows.push({ source: 'rba', region_slug: 'australia', metric, freq: 'A', period: y + '-01-01', value: +(monthly[ym] / 100).toFixed(4) });
  return { rows, months };
}

let cash, bank;
try {
  cash = await rbaCashTarget();   // month-end cash rate target (round) from the cash-rate page
  bank = await rbaMonthly('https://www.rba.gov.au/statistics/tables/csv/f6-data.csv', 'FLRHOFVA', 0.5);   // +0.5pp per the user's rule
} catch (e) { console.error('\n✗ RBA fetch failed:', e.message); await recordStatus('cash_rate', 'Cash Rate', 'RBA cash rate target', 'error', `fetch failed: ${e.message}`); process.exit(1); }

const C = buildRows(cash, 'cash_rate'), B = buildRows(bank, 'bank_rate');
// 216-month average of the monthly cash rate (Runway Workbook long-run assumption)
const cashM = C.months.map(m => cash[m]); const last216 = cashM.slice(-216); const avg216 = last216.reduce((a, b) => a + b, 0) / last216.length;

const latestCash = C.months[C.months.length - 1], latestBank = B.months[B.months.length - 1];
console.log(`Cash rate (target, month-end): ${C.months.length} months ${C.months[0]}..${latestCash} = ${cash[latestCash]}%`);
console.log(`  216-month avg = ${avg216.toFixed(2)}%  (${last216.length} months; Runway Workbook long-run cash rate)`);
console.log(`Bank rate (FLRHOFVA+0.5): ${B.months.length} months ${B.months[0]}..${latestBank} = ${bank[latestBank].toFixed(2)}%`);
const dbCmp = async (metric) => { const { data } = await sb.from('rdp_raw_series').select('period,value').eq('source', 'rba').eq('metric', metric).eq('freq', 'A').gte('period', '2023-01-01').order('period'); return (data || []).map(r => r.period.slice(0, 4) + '=' + (+r.value * 100).toFixed(2)).join(', '); };
console.log('\nANNUAL (new = year last month):');
console.log('  cash:', C.rows.filter(r => r.freq === 'A' && r.period >= '2023').map(r => r.period.slice(0, 4) + '=' + (r.value * 100).toFixed(2)).join(', '), ' | DB:', await dbCmp('cash_rate'));
console.log('  bank:', B.rows.filter(r => r.freq === 'A' && r.period >= '2023').map(r => r.period.slice(0, 4) + '=' + (r.value * 100).toFixed(2)).join(', '), ' | DB:', await dbCmp('bank_rate'));

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(0); }

const all = C.rows.concat(B.rows);
let written = 0;
for (let k = 0; k < all.length; k += 500) { const chunk = all.slice(k, k + 500); const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' }); if (error) { console.error('\n', error.message); process.exit(1); } written += chunk.length; }
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `RBA rates ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: 'ok', notes: `RBA cash rate (FIRMMCRT) + bank rate (FLRHOFVA+0.5), monthly + annual, through ${latestCash}/${latestBank}` });
await recordStatus('cash_rate', 'Cash Rate', 'RBA cash rate target', 'ok', `Current through ${latestCash} (${cash[latestCash].toFixed(2)}%). 216-month avg ${avg216.toFixed(2)}% feeds the Runway Workbook.`, { row_count: C.rows.length, region_count: 1, latest_year: +latestCash.slice(0, 4) });
await recordStatus('bank_rate', 'Bank Rate', 'RBA F6 (FLRHOFVA + 0.5pp)', 'ok', `Current through ${latestBank} (${bank[latestBank].toFixed(2)}%). FLRHOFVA + 0.5pp.`, { row_count: B.rows.length, region_count: 1, latest_year: +latestBank.slice(0, 4) });
console.log(`\n✓ Upserted ${written} rows (cash_rate + bank_rate, monthly + annual).`);
process.exit(0);
