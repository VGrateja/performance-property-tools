// =============================================================================
// seed-demand-listings-from-sheet.mjs  —  STOPGAP: seed REA listings into the
// Demand Score Dashboard Data card (forge_demand_inputs) from the monthly
// "Demand Score" workbooks, so the demand-score engine can be wired to Forge
// before the live REA listings are hand-entered.
//
// House listings  = House workbook  DATA sheet, "Listings …" column (col E).
// Unit listings   = Units workbook  DATA sheet, "Listings …" column (col E).
// Merges listings_h / listings_u (+ _at, + listings_src='sheet') per region,
// PRESERVING the SQM rents/VR already in the store. These are PLACEHOLDERS —
// overwrite with live REA numbers (card / bookmarklet) at the monthly cycle.
//
// Dry-run by DEFAULT; --write upserts.
//   node scripts/seed-demand-listings-from-sheet.mjs [--house "<file>"] [--units "<file>"] [--write]
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const argVal = (k, def) => { const i = args.indexOf(k); return (i >= 0 && args[i + 1]) ? args[i + 1] : def; };
const HOUSE = argVal('--house', join(homedir(), 'Downloads', 'V1 - House June 2026 - Demand Score (1).xlsx'));
const UNITS = argVal('--units', join(homedir(), 'Downloads', 'V1 - Units June 2026 - Demand Score (1).xlsx'));

// demand-score region name → slug (matches forge_demand_inputs / demand-score set)
function slugify(s) {
  s = String(s || '').trim(); if (/^national$/i.test(s)) return 'australia';
  return s.replace(/\([^)]*\)/g, ' ').replace(/,\s*(act|nsw|nt|qld|sa|tas|vic|wa)\b/ig, ' ')
    .replace(/\bgreater\b/ig, ' ').replace(/\bregional\b/ig, ' ').replace(/-hastings/ig, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function listingsFrom(file) {
  if (!existsSync(file)) { console.error('File not found:', file); process.exit(1); }
  const g = XLSX.utils.sheet_to_json(XLSX.readFile(file).Sheets['DATA'], { header: 1, raw: true, defval: '' });
  const hdr = g[1] || [];
  const lc = hdr.findIndex(h => String(h).toLowerCase().includes('listings'));
  if (lc < 0) { console.error('No "Listings" column in', file); process.exit(1); }
  const out = {};
  for (let r = 3; r < g.length; r++) {
    const name = String(g[r][0] || '').trim(); if (!name || /^benchmark$/i.test(name)) continue;
    const slug = slugify(name); const v = g[r][lc];
    if (slug && typeof v === 'number' && isFinite(v)) out[slug] = Math.round(v);
  }
  return out;
}

const h = listingsFrom(HOUSE), u = listingsFrom(UNITS);
const slugs = [...new Set([...Object.keys(h), ...Object.keys(u)])].sort();
console.log(`House listings: ${Object.keys(h).length} regions · Unit listings: ${Object.keys(u).length} regions`);
console.log('sample: adelaide H=' + h.adelaide + ' U=' + u.adelaide + ' | sydney H=' + h.sydney + ' U=' + u.sydney + ' | australia H=' + h.australia + ' U=' + u.australia);
const missU = slugs.filter(s => u[s] == null), missH = slugs.filter(s => h[s] == null);
if (missH.length) console.log('no HOUSE listings:', missH.join(', '));
if (missU.length) console.log('no UNIT listings:', missU.join(', '));

if (!WRITE) { console.log('\nDry run. Re-run with --write to merge into forge_demand_inputs (listings_h/u).'); }
else {
  if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data: existing } = await sb.from('forge_demand_inputs').select('data').eq('id', 'latest').maybeSingle();
  const store = (existing && existing.data) || { regions: {} }; if (!store.regions) store.regions = {};
  const nowIso = new Date().toISOString(); let n = 0;
  for (const slug of slugs) {
    const rec = store.regions[slug] || (store.regions[slug] = {});
    if (h[slug] != null) { rec.listings_h = h[slug]; rec.listings_h_at = nowIso; }
    if (u[slug] != null) { rec.listings_u = u[slug]; rec.listings_u_at = nowIso; }
    rec.listings_src = 'sheet';   // placeholder from the Demand Score workbook, not live REA
    n++;
  }
  const { error } = await sb.from('forge_demand_inputs').upsert({ id: 'latest', data: store, updated_at: nowIso, uploaded_at: nowIso, uploaded_by: 'seed-listings-from-sheet' }, { onConflict: 'id' });
  if (error) { console.error('Upsert failed:', error.message); process.exit(1); }
  console.log(`\n✓ Merged sheet listings for ${n} regions into forge_demand_inputs (placeholders; replace with live REA at the monthly cycle).`);
}
