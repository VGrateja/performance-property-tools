// =============================================================================
// ingest-abs-cpi.mjs — Data Forge path: CPI BY CAPITAL CITY (year-ended %).
//
// Source: ABS Consumer Price Index, Australia (cat 6401.0), **TABLE 17**
//   ("6401017.xlsx") — "CPI: Quarterly All Groups, Index numbers and Percentage
//   change" — auto-discovered off the CPI latest-release page. This is the table
//   the Traffic Lights author works from, so the CPI feed now matches her source
//   exactly (Van 2026-07-13, switched from the monthly Tables 1&2 / 640101.xlsx).
//
//   Table 17 is QUARTERLY and publishes INDEX NUMBERS + quarter-on-quarter % —
//   it has no ready-made annual column. The Traffic Lights "Cash Rate vs
//   Inflation" indicator needs the ANNUAL (year-ended) rate, so we derive it
//   from the All-groups CPI index: year-ended % = index[q] / index[q-4y] − 1,
//   for AUSTRALIA + all 8 CAPITAL CITIES.
//
// Feeds the Traffic Lights "Cash Rate vs Inflation" indicator
//   (Real Cash Rate = cash rate − CPI, per capital). Kept ISOLATED under
//   metric='cpi' so the national metric='inflation' (and its report /
//   commercial consumers) are untouched.
//
// Stored as a DECIMAL fraction (4.1% → 0.041), source='abs', metric='cpi',
//   freq='Q', period 'YYYY-MM-01' (quarter-end month), region = australia +
//   8 capital slugs.
//
// The Traffic Lights engine reads all metric='cpi' rows with NO freq filter and
//   takes the latest period — so a --write REPLACES the whole 'cpi' series
//   (deletes the old monthly rows first) to avoid mixing monthly + quarterly.
//
// ISOLATED: rdp_raw_series + rdp_runs + forge_data_status ('cpi').
// Dry-run by DEFAULT (no key needed); --write deletes+reinserts. Optional arg:
//   a 6401017.xlsx url or local path.
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const OVERRIDE = process.argv.slice(2).find(a => !a.startsWith('--'));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' };
const RELEASE = 'https://www.abs.gov.au/statistics/economy/price-indexes-and-inflation/consumer-price-index-australia/latest-release';
const T17_FALLBACK = RELEASE + '/6401017.xlsx';

// INDEX-NUMBER series IDs from Table 17 — "Index Numbers ; All groups CPI ;
// <region> ;". (Table 17 also carries a QoQ % block; we ignore it and derive
// the year-ended rate from the index instead.)
const IDX = {
  A2325846C: 'australia',
  A2325806K: 'sydney',
  A2325811C: 'melbourne',
  A2325816R: 'brisbane',
  A2325821J: 'adelaide',
  A2325826V: 'perth',
  A2325831L: 'hobart',
  A2325836X: 'darwin',
  A2325841T: 'canberra',
};
// timezone-safe month-start from an Excel serial (round absorbs float underflow)
const monthOf = serial => { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`; };
// period exactly one year earlier (same quarter-end month)
const yearBefore = p => `${(+p.slice(0, 4)) - 1}${p.slice(4)}`;

// ── Supabase only needed for --write ──
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
let sb = null;
if (WRITE) {
  if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env (needed only for --write)'); process.exit(1); }
  sb = createClient(URL, KEY, { auth: { persistSession: false } });
}
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: 'cpi', label: 'CPI by Capital City', source: 'ABS CPI 6401.0 — Table 17 (quarterly, year-ended from index)', status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated? ' + error.message + ')');
}

// ── download Table 17 (6401017.xlsx) ──
let buf, src;
try {
  if (OVERRIDE && existsSync(OVERRIDE)) { buf = readFileSync(OVERRIDE); src = OVERRIDE; }
  else {
    let url = OVERRIDE;
    if (!url) {
      try {
        const html = await (await fetch(RELEASE, { headers: UA })).text();
        const m = html.match(/href="([^"]*6401017\.xlsx)"/i);
        url = m ? (m[1].startsWith('http') ? m[1] : 'https://www.abs.gov.au' + m[1]) : T17_FALLBACK;
      } catch { url = T17_FALLBACK; }
    }
    src = url; buf = Buffer.from(await (await fetch(url, { headers: UA })).arrayBuffer());
  }
} catch (e) { console.error('\n✗ download failed:', e.message); await recordStatus('error', `download failed: ${e.message}`); process.exit(1); }
console.log('CPI Table 17 source:', src.split('/').pop());

// ── read the 9 All-groups CPI INDEX series → per-region {period:index} ──
const idxByRegion = {};   // slug -> Map(period -> index)
try {
  const wb = XLSX.read(buf, { type: 'buffer' });
  let done = false;
  for (const sn of wb.SheetNames) {
    const g = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' });
    let hr = -1; for (let i = 0; i < 14; i++) if ((g[i] || []).some(c => String(c).trim() === 'Series ID')) { hr = i; break; }
    if (hr < 0) continue;
    const colOf = {};
    for (let c = 1; c < g[hr].length; c++) { const sid = String(g[hr][c] || '').trim(); if (IDX[sid]) colOf[sid] = c; }
    if (!Object.keys(colOf).length) continue;
    for (const sid of Object.keys(colOf)) idxByRegion[IDX[sid]] = new Map();
    for (let r = hr + 1; r < g.length; r++) {
      const dc = g[r][0]; if (typeof dc !== 'number') continue;
      const period = monthOf(dc);
      for (const [sid, c] of Object.entries(colOf)) {
        const v = g[r][c]; if (typeof v !== 'number') continue;
        idxByRegion[IDX[sid]].set(period, v);
      }
    }
    done = true; break;
  }
  if (!done) throw new Error('no sheet with a "Series ID" header row found');
} catch (e) { console.error('\n✗ parse failed:', e.message); await recordStatus('error', `parse failed: ${e.message}`); process.exit(1); }

const missing = Object.values(IDX).filter(s => !idxByRegion[s] || !idxByRegion[s].size);
if (missing.length) { console.error(`\n✗ missing index series for: ${missing.join(', ')}`); await recordStatus('error', `missing series: ${missing.join(', ')}`); process.exit(1); }

// ── derive year-ended % (idx[q] / idx[q-1yr] − 1) → rows ──
const rows = [];
const latestByRegion = {};   // slug -> { period, pct }
for (const [slug, m] of Object.entries(idxByRegion)) {
  for (const [period, idx] of m) {
    const prev = m.get(yearBefore(period));
    if (typeof prev !== 'number' || !prev) continue;
    const pct = (idx / prev - 1) * 100;
    rows.push({ source: 'abs', region_slug: slug, metric: 'cpi', freq: 'Q', period, value: +(pct / 100).toFixed(5) });
    if (!latestByRegion[slug] || period > latestByRegion[slug].period) latestByRegion[slug] = { period, pct };
  }
}
if (!rows.length) { console.error('\n✗ no year-ended points computed'); await recordStatus('error', 'no year-ended points computed'); process.exit(1); }

const ORDER = ['australia', 'sydney', 'melbourne', 'brisbane', 'adelaide', 'perth', 'hobart', 'darwin', 'canberra'];
const latestMo = Object.values(latestByRegion).map(l => l.period).sort().pop();
console.log(`\nCPI year-ended % (from Table 17 index) — ${Object.keys(latestByRegion).length} regions, ${rows.length} quarterly rows. Latest quarter ${latestMo.slice(0, 7)}:`);
for (const s of ORDER) { const l = latestByRegion[s]; if (l) console.log('  ' + s.padEnd(10), l.pct.toFixed(1) + '%'); }

if (!WRITE) { console.log('\nDry run. Re-run with --write to REPLACE the metric=\'cpi\' series (deletes old monthly rows, inserts these quarterly rows).'); process.exit(0); }

// ── --write: replace the whole 'cpi' series (old source was monthly; the TL
//    engine has no freq filter, so mixing monthly + quarterly would mis-pick
//    the latest). Delete then insert. ──
const del = await sb.from('rdp_raw_series').delete().eq('source', 'abs').eq('metric', 'cpi');
if (del.error) { console.error('\n✗ delete of old cpi rows failed:', del.error.message); process.exit(1); }
console.log('\nCleared previous metric=\'cpi\' rows (source=abs).');

let written = 0;
for (let k = 0; k < rows.length; k += 500) { const chunk = rows.slice(k, k + 500); const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' }); if (error) { console.error('\n', error.message); process.exit(1); } written += chunk.length; }
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS cpi ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: 'ok', notes: `ABS CPI Table 17 (6401017, quarterly), year-ended % from index, national + 8 capitals, through ${latestMo}` });
await recordStatus('ok', `Current through ${latestMo.slice(0, 7)} quarter — national + 8 capital cities (ABS CPI Table 17, year-ended % from index).`, { row_count: written, region_count: Object.keys(latestByRegion).length });
console.log(`\n✓ Replaced with ${written} quarterly CPI rows (source='abs', metric='cpi', freq='Q').`);
process.exit(0);
