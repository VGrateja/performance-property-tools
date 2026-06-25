// =============================================================================
// seed-region-dashboard.mjs
//
// Seed a region's Regional-Dashboards reference data into Supabase
// (table: region_dashboard_reference). Reads a region's "Suburb Selection"
// workbook and extracts the parts that DON'T come from the monthly CoreLogic drop:
//   - config      : rates / loan terms / thresholds / floor-ceiling / clock lookup
//   - selection   : the region's LGA list and suburb list (the "directory")
//   - price       : slim historical median+growth series since 1983 (Price Data tab)
//   - lgaThresh   : per-LGA recency thresholds
// plus propertyType ('H' or 'U') so the tool filters the national file correctly.
//
// Exposes extractReference(file) so the bulk runner (seed-all-regions.mjs) reuses it.
//
// CLI:  node scripts/seed-region-dashboard.mjs "<workbook.xlsx>" <region-slug> "<Label>"
// Needs xlsx + @supabase/supabase-js (npm install). Writes ONLY to
// region_dashboard_reference — never touches report tables.
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Load a local, git-ignored .env (repo root) so the service-role key stays out of
// the shell history and the chat. Runs on import; never prints values.
try {
  if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — fall through to process.env */ }

const num = v => { if (typeof v === 'number') return isFinite(v) ? v : null; if (v == null || v === '') return null; const n = Number(String(v).replace(/[$,%\s]/g, '')); return isFinite(n) ? n : null; };

// Extract a region's reference from its workbook. Reads the Variables tab BY HEADER
// NAME (the per-region templates use different column layouts). Throws on a missing
// expected column so the caller can flag the file. Does NOT set propertyType — the
// caller supplies that (from the filename).
export function extractReference(file) {
  const wb = XLSX.readFile(file);
  const sName = f => wb.SheetNames.find(n => n.toLowerCase().includes(f));
  const grid = f => XLSX.utils.sheet_to_json(wb.Sheets[sName(f)], { header: 1, raw: true, defval: '' });

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
  const required = ['suburbs', 'lga', 'rate', 'term', 'lvr', 'bottom', 'floor', 'ceiling', 'clockX', 'clockY'];
  const miss = required.filter(k => C[k] < 0);
  if (miss.length) throw new Error('Variables tab missing columns: ' + miss.join(', ') + ' | headers: ' + vhdr.join(' | '));
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

  const prows = grid('price data');
  const phdr = (prows[0] || []).map(h => String(h).trim().toLowerCase());
  const pGeo = Math.max(0, phdr.indexOf('suburb')), pYear = phdr.indexOf('year'), pMed = phdr.indexOf('median'), pGrow = phdr.indexOf('growth');
  const price = [];
  for (let i = 1; i < prows.length; i++) {
    const row = prows[i]; const geo = String(row[pGeo] || '').trim(); const year = num(row[pYear]);
    if (!geo || year == null) continue;
    price.push({ geo, year, median: num(row[pMed]), growth: num(row[pGrow]) });
  }
  return { config, lgaThresh, selection: { lgas, suburbs }, price };
}

// ---- CLI (only when run directly, not when imported) ----
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [file, slug, label] = process.argv.slice(2);
  const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!file || !slug) { console.error('Usage: node seed-region-dashboard.mjs "<workbook.xlsx>" <region-slug> "<Label>"'); process.exit(1); }
  if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY — put it in a local .env file (repo root) or the environment.'); process.exit(1); }
  const reference = extractReference(file);
  reference.propertyType = /\(unit/i.test(label || '') ? 'U' : 'H';
  console.log(`Seeding "${label || slug}" (${slug}): ${reference.selection.lgas.length} LGAs, ${reference.selection.suburbs.length} suburbs, ${reference.price.length} price rows, type ${reference.propertyType}.`);
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { error } = await sb.from('region_dashboard_reference').upsert({ region: slug, label: label || slug, reference, updated_at: new Date().toISOString() }, { onConflict: 'region' });
  if (error) { console.error('Seed failed:', error.message); process.exit(1); }
  console.log('✓ Seeded region_dashboard_reference for', slug);
}
