// =============================================================================
// ingest-abs-retail.mjs — Data Forge path: RETAIL TURNOVER (annual, by region).
//
// ABS discontinued the monthly Retail Trade survey (RT dataflow frozen at
// June 2025) and replaced it with the Monthly Household Spending Indicator
// (MHSI). The retail-turnover continuation lives in MHSI **Table 19**
// ("Experimental estimates of retail turnover using bank transactions") — a
// downloadable .xlsx, NOT in any live SDMX dataflow. So this ingest downloads
// Table 19 (auto-discovering the latest release URL) and parses it.
//
// Series (Original, Total (Industry), Current Price, $ millions, monthly):
//   australia A130277416L · st-nsw A130277878F · st-vic A130277548R
//   st-qld A130277812R · st-sa A130277944T · st-wa A130277614A
//   st-tas A130277680X · st-nt A130277746C · st-act A130277482K
//
// RULE (user's): the DB stores ANNUAL values. For each year:
//   value = mean(the year's available monthly values) × FACTOR
//   FACTOR = 1 for national (monthly average) / 12 for states (annual total).
// The current (incomplete) year just has fewer months in the mean — same
// formula. (Prior years differ slightly from the old RT numbers — the
// bank-transactions methodology change; the user confirmed this is expected.)
//
// ISOLATED: rdp_raw_series (source='abs', metric='retail_turnover', freq='A',
// period 'YYYY-01-01') + rdp_runs + forge_data_status (data_key='retail').
// Dry-run by DEFAULT; --write upserts. Optional arg: a Table-19 .xlsx URL/path
// to override auto-discovery.
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const OVERRIDE = process.argv.slice(2).find(a => !a.startsWith('--'));   // optional .xlsx url/path
const UA = { 'User-Agent': 'Mozilla/5.0' };

const SERIES = {
  australia: { id: 'A130277416L', factor: 1 },
  'st-nsw': { id: 'A130277878F', factor: 12 }, 'st-vic': { id: 'A130277548R', factor: 12 },
  'st-qld': { id: 'A130277812R', factor: 12 }, 'st-sa': { id: 'A130277944T', factor: 12 },
  'st-wa': { id: 'A130277614A', factor: 12 }, 'st-tas': { id: 'A130277680X', factor: 12 },
  'st-nt': { id: 'A130277746C', factor: 12 }, 'st-act': { id: 'A130277482K', factor: 12 },
};
const RELEASE = 'https://www.abs.gov.au/statistics/economy/finance/monthly-household-spending-indicator/latest-release';

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const FK = 'retail', FLABEL = 'Retail Turnover', FSOURCE = 'ABS Monthly Household Spending Indicator — Table 19 (5682.0)';
async function recordStatus(status, message, extra = {}) {
  if (!WRITE) return;
  const now = new Date().toISOString();
  const row = { data_key: FK, label: FLABEL, source: FSOURCE, status, message, last_run_at: now, updated_at: now, ...extra };
  if (status === 'ok') row.last_ok_at = now;
  const { error } = await sb.from('forge_data_status').upsert(row, { onConflict: 'data_key' });
  if (error) console.warn('  (forge_data_status not updated — apply migration 053? ' + error.message + ')');
}

// ── 1) locate + download Table 19 ──
let buf, src;
try {
  if (OVERRIDE && existsSync(OVERRIDE)) { buf = readFileSync(OVERRIDE); src = OVERRIDE; }
  else {
    let url = OVERRIDE;
    if (!url) {
      const html = await (await fetch(RELEASE, { headers: UA })).text();
      const m = html.match(/(https?:\/\/[^"'\s]*?\/5682019\.xlsx)/i) || html.match(/(\/[^"'\s]*?\/5682019\.xlsx)/i);
      if (!m) throw new Error('could not find the Table 19 (5682019.xlsx) link on the latest-release page');
      url = m[1].startsWith('http') ? m[1] : 'https://www.abs.gov.au' + m[1];
    }
    src = url;
    buf = Buffer.from(await (await fetch(url, { headers: UA })).arrayBuffer());
  }
} catch (e) { console.error('\n✗ download failed:', e.message); await recordStatus('error', `download failed: ${e.message}`); process.exit(1); }
console.log('Table 19 source:', src);

// ── 2) parse the ABS time-series workbook → monthly per series ──
const monthly = {};  // slug -> { year -> [values] }
try {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets['Data1']; if (!ws) throw new Error('no Data1 sheet');
  const g = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  let hdr = -1; for (let i = 0; i < 12; i++) if ((g[i] || []).some(c => String(c).trim() === 'Series ID')) { hdr = i; break; }
  if (hdr < 0) throw new Error('no "Series ID" header row');
  const col = {}; g[hdr].forEach((v, i) => { const s = String(v).trim(); if (/^A\d+[A-Z]$/.test(s)) col[s] = i; });
  const idToSlug = Object.fromEntries(Object.entries(SERIES).map(([s, o]) => [o.id, s]));
  const yearOf = serial => new Date(Date.UTC(1899, 11, 30) + serial * 86400000).getUTCFullYear();
  for (const slug of Object.keys(SERIES)) monthly[slug] = {};
  for (let r = hdr + 1; r < g.length; r++) {
    const dc = g[r][0]; if (typeof dc !== 'number') continue;
    const yr = yearOf(dc);
    for (const [id, c] of Object.entries(col)) { const slug = idToSlug[id]; if (!slug) continue; const v = g[r][c]; if (typeof v === 'number') (monthly[slug][yr] ||= []).push(v); }
  }
  const missing = Object.values(SERIES).filter(o => !col[o.id]).map(o => o.id);
  if (missing.length) throw new Error('series not found in Table 19: ' + missing.join(', '));
} catch (e) { console.error('\n✗ parse failed:', e.message); await recordStatus('error', `parse failed: ${e.message}`); process.exit(1); }

// ── 3) annual value per region per year = mean(months) × factor ──
const rows = [];
for (const [slug, o] of Object.entries(SERIES)) {
  for (const [yr, vals] of Object.entries(monthly[slug])) {
    if (!vals.length) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    rows.push({ source: 'abs', region_slug: slug, metric: 'retail_turnover', freq: 'A', period: `${yr}-01-01`, value: mean * o.factor, _n: vals.length });
  }
}
const latest = Math.max(...rows.map(r => +r.period.slice(0, 4)));
const slugs = Object.keys(SERIES);

console.log(`\nRetail turnover — ${rows.length} annual rows for ${slugs.length} regions (latest ${latest}):`);
console.log('region       prev-yr (' + (latest - 1) + ')      current (' + latest + ', n mo)');
for (const slug of slugs) {
  const prev = rows.find(r => r.region_slug === slug && +r.period.slice(0, 4) === latest - 1);
  const cur = rows.find(r => r.region_slug === slug && +r.period.slice(0, 4) === latest);
  console.log(slug.padEnd(11), String(prev ? Math.round(prev.value).toLocaleString() : '—').padStart(14), '   ', cur ? Math.round(cur.value).toLocaleString() + ' (' + cur._n + 'mo)' : '—');
}

// completeness guard: every region has the latest year
const missing = slugs.filter(s => !rows.some(r => r.region_slug === s && +r.period.slice(0, 4) === latest));
if (missing.length) console.error(`\n✗ COMPLETENESS FAIL: missing ${latest} for ${missing.join(', ')}`);
else console.log(`\n✓ Completeness: all ${slugs.length} regions have ${latest}.`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into rdp_raw_series.'); process.exit(missing.length ? 1 : 0); }

const out = rows.map(({ _n, ...r }) => r);
let written = 0;
for (let k = 0; k < out.length; k += 500) { const chunk = out.slice(k, k + 500); const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict: 'source,region_slug,metric,freq,period' }); if (error) { console.error('\n', error.message); process.exit(1); } written += chunk.length; }
await sb.from('rdp_runs').insert({ dataset: 'raw', source_month: `ABS retail ${new Date().toISOString().slice(0, 7)}`, row_count: written, status: missing.length ? 'partial' : 'ok', notes: `ABS MHSI Table 19 retail turnover (annual; national=mean, states=mean*12), through ${latest}${missing.length ? '; MISSING: ' + missing.join(', ') : ''}` });
await recordStatus(missing.length ? 'error' : 'ok', missing.length ? `Missing ${latest} for ${missing.join(', ')}` : `Current through ${latest} (MHSI Table 19).`, { row_count: written, region_count: slugs.length, latest_year: latest });
console.log(`\n✓ Upserted ${written} retail-turnover rows into rdp_raw_series.`);
process.exit(missing.length ? 1 : 0);
