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
const ci = l => { let n = 0; for (const c of l) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };
const num = v => { if (typeof v === 'number') return isFinite(v) ? v : null; if (v == null || v === '') return null; const n = Number(String(v).replace(/[$,%\s]/g, '')); return isFinite(n) ? n : null; };

// ---- Variables: config + selection + per-LGA thresholds ----
const V = wb.Sheets[sName('variable')];
const vc = a => { const c = V[a]; return c == null ? '' : c.v; };
const clockO = [], clockP = [];
for (let r = 2; r <= 14; r++) { clockO.push(num(vc('O' + r))); clockP.push(num(vc('P' + r))); }
const config = {
  rate: num(vc('L2')), term: num(vc('M2')), lvr: num(vc('N2')),
  bottomYear: num(vc('H2')), floor: num(vc('Q2')), ceiling: num(vc('R2')),
  clockO, clockP,
};
const lgas = [], suburbs = [], lgaThresh = {};
for (let r = 2; ; r++) { const v = vc('D' + r); if (v === '' || v == null) break; const nm = String(v).trim(); lgas.push(nm); lgaThresh[nm.toUpperCase()] = { ti: num(vc('I' + r)) || 0, tj: num(vc('J' + r)) || 0 }; }
for (let r = 2; ; r++) { const v = vc('B' + r); if (v === '' || v == null) break; suburbs.push(String(v).trim()); }

// ---- Price Data: slim {geo, year, median, growth} ----
const pr = grid('price data');
const price = [];
for (let i = 1; i < pr.length; i++) {
  const row = pr[i]; const geo = String(row[ci('A')] || '').trim(); const year = num(row[ci('B')]);
  if (!geo || year == null) continue;
  price.push({ geo, year, median: num(row[ci('D')]), growth: num(row[ci('E')]) });
}

const reference = { region: slug, label: label || slug, config, lgaThresh, selection: { lgas, suburbs }, price };

console.log(`Seeding "${label || slug}" (${slug}): ${lgas.length} LGAs, ${suburbs.length} suburbs, ${price.length} price rows.`);

const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const { error } = await sb.from('region_dashboard_reference')
  .upsert({ region: slug, label: label || slug, reference, updated_at: new Date().toISOString() }, { onConflict: 'region' });
if (error) { console.error('Seed failed:', error.message); process.exit(1); }
console.log('✓ Seeded region_dashboard_reference for', slug);
