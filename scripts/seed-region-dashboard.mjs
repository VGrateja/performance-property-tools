// =============================================================================
// seed-region-dashboard.mjs
//
// One-time (per region) seed of the Regional Dashboards reference data into
// Supabase (table: region_dashboard_reference). Reads a region's "Suburb
// Selection" workbook and extracts the parts that DON'T come from the monthly
// CoreLogic drop:
//   - config      : rates / loan terms / thresholds / floor-ceiling / clock lookup
//   - selection   : the region's LGA list and suburb list (the "directory")
//   - price       : slim historical median+growth series since 1983 (Price Data tab)
//   - lgaThresh   : per-LGA recency thresholds (Variables I/J; blank => 0)
//
// After this runs, the monthly flow only needs the national CoreLogic file: the
// calculator pulls current values from that drop and history from here.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/seed-region-dashboard.mjs "<workbook.xlsx>" <region-slug> "<Label>"
//
// Requires devDeps: xlsx, @supabase/supabase-js   (run `npm install` first).
// Writes ONLY to region_dashboard_reference — never touches report tables.
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

// Load a local, git-ignored .env (repo root) so the service-role key stays out of
// the shell history and the chat. Never prints values.
try {
  if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — fall through to process.env */ }

const [file, slug, label] = process.argv.slice(2);
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co'; // public project URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!file || !slug) { console.error('Usage: node seed-region-dashboard.mjs "<workbook.xlsx>" <region-slug> "<Label>"'); process.exit(1); }
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY — put it in a local .env file (repo root) or the environment.'); process.exit(1); }

const wb = XLSX.readFile(file);
const sName = f => wb.SheetNames.find(n => n.toLowerCase().includes(f));
const grid = f => XLSX.utils.sheet_to_json(wb.Sheets[sName(f)], { header: 1, raw: true, defval: '' });
const num = v => { if (typeof v === 'number') return isFinite(v) ? v : null; if (v == null || v === '') return null; const n = Number(String(v).replace(/[$,%\s]/g, '')); return isFinite(n) ? n : null; };

// ---- Variables: read columns BY HEADER NAME. The per-region workbooks use
// slightly different column layouts (e.g. Adelaide has extra %-columns that shift
// everything right), but the header labels are consistent — so match on those. ----
const vrows = grid('variable');
const vhdr = (vrows[0] || []).map(h => String(h).trim().toLowerCase());
const findCol = pred => vhdr.findIndex(pred);
const colEq = name => findCol(h => h === name);
const colInc = sub => findCol(h => h.includes(sub));
const C = {
  suburbs: colEq('suburbs'), lga: colEq('lga name'),
  thr3: findCol(h => h.includes('3') && h.includes('median') && h.includes('threshold')),
  thr6: findCol(h => h.includes('6') && h.includes('median') && h.includes('threshold')),
  rate: colInc('interest rate'), term: colInc('loan term'), lvr: colEq('lvr'),
  bottom: colInc('bottom of market'), floor: colInc('floor'), ceiling: colInc('ceiling'),
  clockX: colInc('growth since'), clockY: colInc('clock position'),
};
const required = ['suburbs','lga','rate','term','lvr','bottom','floor','ceiling','clockX','clockY'];
const missing = required.filter(k => C[k] < 0);
if (missing.length) { console.error('Variables tab missing expected columns: ' + missing.join(', ') + '\nHeaders found: ' + vhdr.join(' | ')); process.exit(1); }
const cell = (r, c) => (c < 0 || !vrows[r]) ? '' : vrows[r][c];

const config = {
  rate: num(cell(1, C.rate)), term: num(cell(1, C.term)), lvr: num(cell(1, C.lvr)),
  bottomYear: num(cell(1, C.bottom)), floor: num(cell(1, C.floor)), ceiling: num(cell(1, C.ceiling)),
  clockO: [], clockP: [],
};
for (let r = 1; r <= 13; r++) { config.clockO.push(num(cell(r, C.clockX))); config.clockP.push(num(cell(r, C.clockY))); } // rows 2-14

const suburbs = [], lgas = [], lgaThresh = {};
for (let r = 1; r < vrows.length; r++) { const v = cell(r, C.suburbs); if (v === '' || v == null) break; suburbs.push(String(v).trim()); }
for (let r = 1; r < vrows.length; r++) { const v = cell(r, C.lga); if (v === '' || v == null) break; const nm = String(v).trim(); lgas.push(nm); lgaThresh[nm.toUpperCase()] = { ti: num(cell(r, C.thr3)) || 0, tj: num(cell(r, C.thr6)) || 0 }; }

// ---- Price Data: slim {geo, year, median, growth} (columns by header) ----
const prows = grid('price data');
const phdr = (prows[0] || []).map(h => String(h).trim().toLowerCase());
const pGeo = Math.max(0, phdr.indexOf('suburb')), pYear = phdr.indexOf('year'), pMed = phdr.indexOf('median'), pGrow = phdr.indexOf('growth');
const price = [];
for (let i = 1; i < prows.length; i++) {
  const row = prows[i]; const geo = String(row[pGeo] || '').trim(); const year = num(row[pYear]);
  if (!geo || year == null) continue;
  price.push({ geo, year, median: num(row[pMed]), growth: num(row[pGrow]) });
}

const reference = { region: slug, label: label || slug, config, lgaThresh, selection: { lgas, suburbs }, price };

console.log(`Seeding "${label || slug}" (${slug}): ${lgas.length} LGAs, ${suburbs.length} suburbs, ${price.length} price rows.`);

const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const { error } = await sb.from('region_dashboard_reference')
  .upsert({ region: slug, label: label || slug, reference, updated_at: new Date().toISOString() }, { onConflict: 'region' });
if (error) { console.error('Seed failed:', error.message); process.exit(1); }
console.log('✓ Seeded region_dashboard_reference for', slug);
