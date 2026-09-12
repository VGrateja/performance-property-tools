// =============================================================================
// ingest-abs-patient-experiences.mjs — Data Forge path: GP ACCESS
// (ABS 4839.0 Patient Experiences — the share of Australians 15+ who saw a GP
// in the last 12 months). Annual survey, released around November; the data
// cube "Tables 1 to 3" (DC1_PEX_<fy>_T1_to_3.xlsx) is linked from the release
// page. The filename carries the financial year, so the page is scraped for the
// current link first (a positional file path / URL overrides the discovery).
//
// Metrics → rdp_raw_series (source `abs`, region `australia`, freq `A`;
// period = the FINANCIAL-YEAR START, 1 July — "2024–25" is 2024-07-01, the
// first survey "2009" is 2009-07-01):
//   gp_share          Table 1   — proportion who saw a GP, every survey year (decimal: 83.4% → 0.834)
//   gp_share_<band>   Table 2.3 — the same by age band, the release's own year only
//                     (15_24, 25_34, 35_44, 45_54, 55_64, 65_74, 75_84, 85p)
//
// Feeds the two Commercial-report health tabs (individuals-who-accessed-gp-dat,
// pop-accessing-health-services) through build-commercial-from-rdp.mjs at
// PUBLISH — they were hand-typed from these exact tables until 2026-09-12.
// Status → forge_data_status data_key 'gp_access' (its own Forge card).
//
// Upsert-only (never deletes). Dry-run by DEFAULT; --write upserts.
//   node scripts/ingest-abs-patient-experiences.mjs                 # discover + parse, print
//   node scripts/ingest-abs-patient-experiences.mjs --write         # upsert rdp_raw_series + status
//   node scripts/ingest-abs-patient-experiences.mjs <file|url> --write
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import XLSX from 'xlsx';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const OVERRIDE = process.argv.slice(2).find(a => !a.startsWith('--'));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' };
const RELEASE = 'https://www.abs.gov.au/statistics/health/health-services/patient-experiences/latest-release';
const FILE_RE = /href="([^"]*DC1_PEX_[^"]*T1_to_3\.xlsx)"/i;

const SOURCE = 'abs', REGION = 'australia', FREQ = 'A';
const GP_ROW = /^Saw a general practitioner$/i;
// ABS band label (dashes normalised) → metric suffix. Order = the chart's x-axis.
const BANDS = [['15-24', '15_24'], ['25-34', '25_34'], ['35-44', '35_44'], ['45-54', '45_54'], ['55-64', '55_64'], ['65-74', '65_74'], ['75-84', '75_84'], ['85 and over', '85p']];
const norm = s => String(s ?? '').replace(/[‒–—−]/g, '-').replace(/\s+/g, ' ').trim();
// "2009" | "2010–11" | "2024-25" → the FY start year, else null
const fyStart = cell => { const m = norm(cell).match(/^((?:19|20)\d{2})(?:-\d{2})?$/); return m ? +m[1] : null; };
const fyLabel = y => `${y}-${String(y + 1).slice(2)}`;      // 2024 → "2024-25" (the tab's own label style)
const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };

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
  const row = { data_key: 'gp_access', label: 'GP Access (ABS Patient Experiences)', source: 'ABS 4839.0 Patient Experiences — data cube Tables 1–3 (Table 1 national by year, Table 2.3 by age band)', status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated? ' + error.message + ')');
}
const fail = async (msg) => { console.error('\n✗ ' + msg); await recordStatus('error', msg); process.exit(1); };

// ── 1. find + download the data cube ──
let buf, src;
try {
  if (OVERRIDE && existsSync(OVERRIDE)) { buf = readFileSync(OVERRIDE); src = OVERRIDE; }
  else {
    let url = OVERRIDE;
    if (!url) {
      const r = await fetch(RELEASE, { headers: UA });
      if (!r.ok) throw new Error(`release page HTTP ${r.status}`);
      const m = (await r.text()).match(FILE_RE);
      if (!m) throw new Error('no DC1_PEX_*_T1_to_3.xlsx link on the release page (ABS renamed the cube?)');
      url = m[1].startsWith('http') ? m[1] : 'https://www.abs.gov.au' + m[1];
    }
    src = url;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`cube HTTP ${r.status} for ${url}`);
    buf = Buffer.from(await r.arrayBuffer());
  }
  if (buf.length < 20000) throw new Error(`cube too small (${buf.length} bytes) — not a workbook`);
} catch (e) { await fail('download failed: ' + e.message); }
console.log('ABS Patient Experiences cube:', src.split('/').pop(), `(${(buf.length / 1024).toFixed(0)} KB)`);

// ── 2. parse Table 1 (national, every year) + Table 2.3 (by age, latest year) ──
const grid = (wb, name) => {
  const sn = wb.SheetNames.find(s => norm(s).toLowerCase() === name.toLowerCase());
  if (!sn) throw new Error(`sheet "${name}" not in the cube (${wb.SheetNames.join(', ')})`);
  return XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' });
};
// first row whose col A is the GP label, AFTER row hr — the proportion block comes
// first in both tables (Table 1 repeats the label in the margin-of-error block,
// Table 2.3 in the Males/Females blocks) so the first hit is the one wanted.
const gpRowAfter = (g, hr) => { for (let i = hr + 1; i < g.length; i++) if (GP_ROW.test(norm(g[i][0]))) return g[i]; return null; };

let byYear = [];       // [{ y, label, share }]
let byBand = [];       // [{ band, metric, share }]
let releaseY = null;
try {
  const wb = XLSX.read(buf, { type: 'buffer' });
  // Table 1: header row = the row with ≥5 FY cells; the GP row follows
  const g1 = grid(wb, 'Table 1');
  let hr = -1;
  for (let i = 0; i < Math.min(g1.length, 20); i++) if (g1[i].filter(c => fyStart(c) != null).length >= 5) { hr = i; break; }
  if (hr < 0) throw new Error('Table 1: no header row of survey years');
  const gp1 = gpRowAfter(g1, hr);
  if (!gp1) throw new Error('Table 1: no "Saw a general practitioner" row');
  for (let c = 1; c < g1[hr].length; c++) {
    const y = fyStart(g1[hr][c]); if (y == null) continue;
    const v = num(gp1[c]); if (v == null) continue;                    // "na"
    if (v < 30 || v > 100) throw new Error(`Table 1: implausible GP share ${v} for ${norm(g1[hr][c])}`);
    byYear.push({ y, label: fyLabel(y), share: +(v / 100).toFixed(4) });
  }
  byYear.sort((a, b) => a.y - b.y);
  if (byYear.length < 10) throw new Error(`Table 1: only ${byYear.length} survey years parsed`);
  releaseY = byYear[byYear.length - 1].y;

  // Table 2.3: header row = the row carrying the age bands; the Persons GP row follows
  const g2 = grid(wb, 'Table 2.3');
  let hr2 = -1;
  for (let i = 0; i < Math.min(g2.length, 20); i++) if (g2[i].some(c => norm(c) === '15-24') && g2[i].some(c => /^85 and over$/i.test(norm(c)))) { hr2 = i; break; }
  if (hr2 < 0) throw new Error('Table 2.3: no age-band header row');
  const gp2 = gpRowAfter(g2, hr2);
  if (!gp2) throw new Error('Table 2.3: no "Saw a general practitioner" row');
  for (const [label, suffix] of BANDS) {
    const c = g2[hr2].findIndex(x => norm(x).toLowerCase() === label.toLowerCase());
    if (c < 0) throw new Error(`Table 2.3: band "${label}" missing`);
    const v = num(gp2[c]);
    if (v == null || v < 30 || v > 100) throw new Error(`Table 2.3: implausible GP share ${gp2[c]} for ${label}`);
    byBand.push({ band: label, metric: 'gp_share_' + suffix, share: +(v / 100).toFixed(4) });
  }
  // the age table must belong to the same release as Table 1's last column
  const title = norm(g2.slice(0, 6).map(r => r[0]).join(' '));
  const ty = (title.match(/((?:19|20)\d{2})-\d{2}/g) || []).map(s => +s.slice(0, 4)).pop();
  if (ty && ty !== releaseY) throw new Error(`Table 2.3 is ${ty}-${String(ty + 1).slice(2)} but Table 1 ends ${fyLabel(releaseY)}`);
} catch (e) { await fail('parse failed: ' + e.message); }

// ── 3. report ──
console.log(`\nTable 1 — saw a GP (share of persons 15+), ${byYear.length} survey years ${byYear[0].label} → ${fyLabel(releaseY)}:`);
console.log('  ' + byYear.map(r => `${r.label}=${(r.share * 100).toFixed(1)}%`).join('  '));
console.log(`\nTable 2.3 — by age band, ${fyLabel(releaseY)}:`);
console.log('  ' + byBand.map(r => `${r.band}=${(r.share * 100).toFixed(1)}%`).join('  '));

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert rdp_raw_series + forge_data_status.'); process.exit(0); }

// ── 4. upsert (5-column key; never deletes) ──
const rows = [
  ...byYear.map(r => ({ source: SOURCE, region_slug: REGION, metric: 'gp_share', freq: FREQ, period: `${r.y}-07-01`, value: r.share })),
  ...byBand.map(r => ({ source: SOURCE, region_slug: REGION, metric: r.metric, freq: FREQ, period: `${releaseY}-07-01`, value: r.share })),
];
const { error } = await sb.from('rdp_raw_series').upsert(rows, { onConflict: 'source,region_slug,metric,freq,period' });
if (error) await fail('upsert failed: ' + error.message);
const now = new Date().toISOString();
try { await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS PEX ${fyLabel(releaseY)}`, row_count: rows.length, status: 'ok', notes: `gp_share ${byYear.length} FYs (${byYear[0].label}→${fyLabel(releaseY)}) + ${byBand.length} age bands from ${src.split('/').pop()}` }); } catch {}
await recordStatus('ok', `${byYear.length} survey years ${byYear[0].label} → ${fyLabel(releaseY)} · age bands ${fyLabel(releaseY)}`, { row_count: rows.length, region_count: 1, latest_year: releaseY });
console.log(`\n✓ Upserted ${rows.length} rows (${byYear.length} years + ${byBand.length} bands) → rdp_raw_series; status 'gp_access' ok (${now.slice(0, 10)}).`);
