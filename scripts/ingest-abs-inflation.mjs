// =============================================================================
// ingest-abs-inflation.mjs — Data Forge path: INFLATION RATE (annual, national).
//
// Source: ABS Consumer Price Index, Australia (cat 6401.0), Table 1 & 2
//   ("CPI: All Groups, Index Numbers and Percentage Changes") — the .xlsx
//   "640101.xlsx", auto-discovered off the latest-release page + downloaded
//   (no clean API: CPI_Q is seasonally-adjusted only and the CPI dataflow's
//   key filtering is flaky). ingest type = 'file'.
//
//   Series **A130393721F** = "Percentage Change from Corresponding Month of the
//   Previous Year", All groups CPI, Original, weighted average of eight capital
//   cities (national). ⚠️ ABS reformed CPI to MONTHLY (late 2025), so this
//   series is now MONTHLY and only starts ~Apr 2025.
//
// RULE (user's): DB stores ANNUAL, national.
//   • previous (complete prior) years → AVERAGE of that year's months
//   • current/latest year            → the LATEST month's value
//
//   Stored as a DECIMAL fraction (e.g. 4.0% → 0.04) to match the existing
//   `inflation` metric. Only the years the monthly series covers (2025-) are
//   written; older history stays under its existing source (upsert-only —
//   never deletes; the central DB also has source='rba' inflation 1975-).
//
// ISOLATED: rdp_raw_series (source='abs', metric='inflation', freq='A',
// region 'australia') + rdp_runs + forge_data_status ('inflation').
// Dry-run by DEFAULT; --write upserts. Optional arg: a 640101.xlsx url/path.
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const OVERRIDE = process.argv.slice(2).find(a => !a.startsWith('--'));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' };
const RELEASE = 'https://www.abs.gov.au/statistics/economy/price-indexes-and-inflation/consumer-price-index-australia/latest-release';
const SID = 'A130393721F';
// timezone-safe month from an Excel serial (round absorbs any float underflow)
const yearOf = serial => new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000).getUTCFullYear();

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: 'inflation', label: 'Inflation Rate', source: 'ABS Consumer Price Index (6401.0)', status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated? ' + error.message + ')');
}

// ── download Table 1 & 2 ──
let buf, src;
try {
  if (OVERRIDE && existsSync(OVERRIDE)) { buf = readFileSync(OVERRIDE); src = OVERRIDE; }
  else {
    let url = OVERRIDE;
    if (!url) { const html = await (await fetch(RELEASE, { headers: UA })).text(); const m = html.match(/href="([^"]*640101\.xlsx)"/i); if (!m) throw new Error('could not find 640101.xlsx on the CPI latest-release page'); url = m[1].startsWith('http') ? m[1] : 'https://www.abs.gov.au' + m[1]; }
    src = url; buf = Buffer.from(await (await fetch(url, { headers: UA })).arrayBuffer());
  }
} catch (e) { console.error('\n✗ download failed:', e.message); await recordStatus('error', `download failed: ${e.message}`); process.exit(1); }
console.log('CPI Table 1&2 source:', src.split('/').pop());

// ── read series A130393721F (monthly year-ended %) → group by year ──
const byYear = {};   // year -> [{m, v}] in date order
try {
  const wb = XLSX.read(buf, { type: 'buffer' });
  let found = null;
  for (const sn of wb.SheetNames) {
    const g = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' });
    let hr = -1; for (let i = 0; i < 12; i++) if ((g[i] || []).some(c => String(c).trim() === 'Series ID')) { hr = i; break; }
    if (hr < 0) continue;
    const col = g[hr].findIndex(c => String(c).trim() === SID);
    if (col < 0) continue;
    found = { g, hr, col }; break;
  }
  if (!found) throw new Error(`series ${SID} not found in 640101.xlsx`);
  const { g, hr, col } = found;
  for (let r = hr + 1; r < g.length; r++) { const dc = g[r][0], v = g[r][col]; if (typeof dc !== 'number' || typeof v !== 'number') continue; (byYear[yearOf(dc)] ||= []).push(v); }
} catch (e) { console.error('\n✗ parse failed:', e.message); await recordStatus('error', `parse failed: ${e.message}`); process.exit(1); }

// ── annual = avg of months (prior years) / latest month (current year) ──
const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
if (!years.length) { console.error('\n✗ no data parsed'); await recordStatus('error', 'no data parsed'); process.exit(1); }
const latestY = years[years.length - 1];
const rows = years.map(y => {
  const arr = byYear[y];
  // current/latest year = latest month; complete prior years = avg of 12 months;
  // skip incomplete prior years (e.g. the 2025 transition — the monthly series
  // only began Apr 2025, so its 9-month avg would be worse than the existing
  // full-year value).
  if (y !== latestY && arr.length < 12) return null;
  const pct = (y === latestY) ? arr[arr.length - 1] : arr.reduce((a, b) => a + b, 0) / arr.length;
  return { source: 'abs', region_slug: 'australia', metric: 'inflation', freq: 'A', period: `${y}-01-01`, value: +(pct / 100).toFixed(4), _pct: Math.round(pct * 100) / 100, _n: arr.length };
}).filter(Boolean);
const skipped = years.filter(y => y !== latestY && byYear[y].length < 12);

// compare vs the existing DB inflation (any source)
const { data: cur } = await sb.from('rdp_raw_series').select('source,value').eq('metric', 'inflation').eq('freq', 'A').eq('region_slug', 'australia').in('period', rows.map(r => r.period));
console.log(`\nInflation (ABS CPI, ${SID}) — ${rows.length} annual rows (latest year ${latestY} = latest month):`);
console.log('year   ABS rule        DB (existing)');
for (const r of rows) console.log('  ' + r.period.slice(0, 4), (r._pct + '%').padStart(8) + ' (' + r._n + 'mo)' + (r.period.slice(0, 4) == latestY ? ' latest' : ' avg'), '   ', (cur || []).map(c => (+c.value * 100).toFixed(2) + '% [' + c.source + ']').join(', ') || '—');
if (skipped.length) console.log('Skipped incomplete prior year(s): ' + skipped.map(y => y + ' (' + byYear[y].length + 'mo)').join(', ') + ' — kept the existing full-year value instead.');
console.log('Note: A130393721F is monthly & started ~Apr 2025; older years stay under their existing source (upsert-only).');

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(0); }

const out = rows.map(({ _pct, _n, ...r }) => r);
const { error } = await sb.from('rdp_raw_series').upsert(out, { onConflict: 'source,region_slug,metric,freq,period' });
if (error) { console.error('\n', error.message); process.exit(1); }
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS inflation ${new Date().toISOString().slice(0, 7)}`, row_count: out.length, status: 'ok', notes: `ABS CPI All groups year-ended % (${SID}, monthly→annual: avg/latest), national, ${years.join('/')}` });
await recordStatus('ok', `Current through ${latestY} (ABS CPI ${SID}; monthly→annual). Pre-${years[0]} from prior source.`, { row_count: out.length, region_count: 1, latest_year: latestY });
console.log(`\n✓ Upserted ${out.length} inflation rows (source='abs').`);
process.exit(0);
