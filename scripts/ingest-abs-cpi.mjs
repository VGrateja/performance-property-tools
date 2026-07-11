// =============================================================================
// ingest-abs-cpi.mjs — Data Forge path: CPI BY CAPITAL CITY (year-ended %).
//
// Source: ABS Consumer Price Index, Australia (cat 6401.0), Table 1&2
//   ("640101.xlsx") — auto-discovered off the CPI latest-release page and
//   downloaded (same file the national inflation ingest uses). Reads the
//   "Percentage Change from Corresponding Month of Previous Year", All groups
//   CPI series for AUSTRALIA + all 8 CAPITAL CITIES. Monthly since the 2025
//   CPI reform (the file currently spans ~2024-04 →).
//
// Feeds the Traffic Lights "Cash Rate vs Inflation" indicator
//   (Real Cash Rate = cash rate − CPI, per capital). Kept ISOLATED under a new
//   metric='cpi' so the existing national metric='inflation' (and its report /
//   commercial consumers) are untouched. Upsert-only — never deletes.
//
// Stored as a DECIMAL fraction (3.2% → 0.032), source='abs', metric='cpi',
//   freq='M', period 'YYYY-MM-01', region = australia + 8 capital slugs.
//
// ISOLATED: rdp_raw_series + rdp_runs + forge_data_status ('cpi').
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

// SID → region slug. All are "Percentage Change from Corresponding Month of
// Previous Year ; All groups CPI ; <region> ;" in 640101.xlsx (Data1).
const SERIES = {
  A130393721F: 'australia',
  A130397376A: 'sydney',
  A130396087L: 'melbourne',
  A130397383X: 'brisbane',
  A130395002W: 'adelaide',
  A130393714J: 'perth',
  A130392356A: 'hobart',
  A130395009L: 'darwin',
  A130393728W: 'canberra',
};
// timezone-safe month-start from an Excel serial (round absorbs float underflow)
const monthOf = serial => { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`; };

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: 'cpi', label: 'CPI by Capital City', source: 'ABS Consumer Price Index (6401.0)', status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated? ' + error.message + ')');
}

// ── download 640101.xlsx ──
let buf, src;
try {
  if (OVERRIDE && existsSync(OVERRIDE)) { buf = readFileSync(OVERRIDE); src = OVERRIDE; }
  else {
    let url = OVERRIDE;
    if (!url) { const html = await (await fetch(RELEASE, { headers: UA })).text(); const m = html.match(/href="([^"]*640101\.xlsx)"/i); if (!m) throw new Error('could not find 640101.xlsx on the CPI latest-release page'); url = m[1].startsWith('http') ? m[1] : 'https://www.abs.gov.au' + m[1]; }
    src = url; buf = Buffer.from(await (await fetch(url, { headers: UA })).arrayBuffer());
  }
} catch (e) { console.error('\n✗ download failed:', e.message); await recordStatus('error', `download failed: ${e.message}`); process.exit(1); }
console.log('CPI 640101 source:', src.split('/').pop());

// ── read the 9 year-ended % series → monthly rows per region ──
const rows = [];
const latestByRegion = {};   // slug -> { period, pct }
try {
  const wb = XLSX.read(buf, { type: 'buffer' });
  let done = false;
  for (const sn of wb.SheetNames) {
    const g = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' });
    let hr = -1; for (let i = 0; i < 12; i++) if ((g[i] || []).some(c => String(c).trim() === 'Series ID')) { hr = i; break; }
    if (hr < 0) continue;
    // map each wanted SID to its column on this sheet
    const colOf = {};
    for (let c = 1; c < g[hr].length; c++) { const sid = String(g[hr][c] || '').trim(); if (SERIES[sid]) colOf[sid] = c; }
    if (!Object.keys(colOf).length) continue;
    for (let r = hr + 1; r < g.length; r++) {
      const dc = g[r][0]; if (typeof dc !== 'number') continue;
      const period = monthOf(dc);
      for (const [sid, c] of Object.entries(colOf)) {
        const v = g[r][c]; if (typeof v !== 'number') continue;
        const slug = SERIES[sid];
        rows.push({ source: 'abs', region_slug: slug, metric: 'cpi', freq: 'M', period, value: +(v / 100).toFixed(5) });
        latestByRegion[slug] = { period, pct: v };   // last row wins → latest month
      }
    }
    done = true; break;
  }
  if (!done) throw new Error('no sheet with a "Series ID" header row found');
} catch (e) { console.error('\n✗ parse failed:', e.message); await recordStatus('error', `parse failed: ${e.message}`); process.exit(1); }

const found = Object.keys(latestByRegion);
const missing = Object.values(SERIES).filter(s => !latestByRegion[s]);
if (!rows.length || missing.length) { console.error(`\n✗ missing series for: ${missing.join(', ') || '(none, but no rows)'}`); await recordStatus('error', `missing series: ${missing.join(', ')}`); process.exit(1); }

const ORDER = ['australia', 'sydney', 'melbourne', 'brisbane', 'adelaide', 'perth', 'hobart', 'darwin', 'canberra'];
console.log(`\nCPI year-ended % — ${found.length} regions, ${rows.length} monthly rows (latest month):`);
for (const s of ORDER) { const l = latestByRegion[s]; if (l) console.log('  ' + s.padEnd(10), l.pct.toFixed(1) + '%', '(' + l.period.slice(0, 7) + ')'); }

// self-check: our national 'cpi' latest ≈ the existing 'inflation' latest (same ABS series A130393721F)
try {
  const { data: infl } = await sb.from('rdp_raw_series').select('period,value').eq('metric', 'inflation').eq('region_slug', 'australia').order('period', { ascending: false }).limit(1);
  if (infl && infl.length) console.log(`  (cross-check: national inflation metric latest = ${(+infl[0].value * 100).toFixed(1)}% @ ${infl[0].period.slice(0, 7)})`);
} catch {}

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(0); }

let written = 0;
for (let k = 0; k < rows.length; k += 500) { const chunk = rows.slice(k, k + 500); const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' }); if (error) { console.error('\n', error.message); process.exit(1); } written += chunk.length; }
const latestMo = Object.values(latestByRegion).map(l => l.period).sort().pop();
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS cpi ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: 'ok', notes: `ABS CPI year-ended % (640101, monthly), national + 8 capitals, through ${latestMo}` });
await recordStatus('ok', `Current through ${latestMo} — national + 8 capital cities (ABS CPI 640101, year-ended %).`, { row_count: written, region_count: found.length, latest_month: latestMo });
console.log(`\n✓ Upserted ${written} CPI rows (source='abs', metric='cpi').`);
process.exit(0);
