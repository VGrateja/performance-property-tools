// =============================================================================
// seed-demand-snapshot-from-sheet.mjs — store a Demand Score version snapshot
// (Runway + Demand Score per region, house & unit) into forge_demand_snapshots,
// read from the "Runway v Demand" tab of the House + Units Demand Score workbooks.
//
// Used to seed the JUNE snapshot as the "prev" baseline for the prev-vs-current
// comparison. "Runway v Demand" tab: col A region, col B RW, col C DS.
//
//   node scripts/seed-demand-snapshot-from-sheet.mjs [--house f] [--units f] \
//        [--version 2026-06] [--label "June 2026"] [--write]
// Dry-run by DEFAULT.
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
const VERSION = argVal('--version', '2026-06');
const LABEL = argVal('--label', 'June 2026');

const numv = v => (typeof v === 'number' && isFinite(v)) ? v : (v != null && v !== '' && !isNaN(+v) ? +v : null);
function slugify(s) {
  s = String(s || '').trim(); if (/^national$/i.test(s)) return 'australia';
  return s.replace(/\([^)]*\)/g, ' ').replace(/,\s*(act|nsw|nt|qld|sa|tas|vic|wa)\b/ig, ' ')
    .replace(/\bgreater\b/ig, ' ').replace(/\bregional\b/ig, ' ').replace(/-hastings/ig, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Per region: ds+rw (Runway v Demand tab) + the input values that drive them, so
// the compare-view hover can show prev→current for each input:
//   Runway v Demand: A=region, B=RW, C=DS
//   DATA:            D=population, E(or "Listings")=listings, G=adjusted VR, J=rental growth (decimal)
//   Median prices:   B=region, E=current median price
function readFile(file) {
  if (!existsSync(file)) { console.error('File not found:', file); process.exit(1); }
  const wb = XLSX.readFile(file);
  const rvd = XLSX.utils.sheet_to_json(wb.Sheets['Runway v Demand'] || {}, { header: 1, raw: true, defval: '' });
  const data = XLSX.utils.sheet_to_json(wb.Sheets['DATA'] || {}, { header: 1, raw: true, defval: '' });
  const mp = XLSX.utils.sheet_to_json(wb.Sheets['Median prices'] || {}, { header: 1, raw: true, defval: '' });
  const out = {};
  for (let r = 1; r < rvd.length; r++) {
    const nm = String(rvd[r][0] || '').trim(); if (!nm || /^region$/i.test(nm)) continue;
    const s = slugify(nm); if (!s) continue;
    (out[s] = out[s] || {}).rw = numv(rvd[r][1]); out[s].ds = numv(rvd[r][2]);
  }
  { const hdr = data[1] || []; const lc = hdr.findIndex(h => String(h).toLowerCase().includes('listings'));
    for (let r = 3; r < data.length; r++) {
      const nm = String(data[r][0] || '').trim(); if (!nm || /^benchmark$/i.test(nm)) continue;
      const s = slugify(nm); if (!s) continue; out[s] = out[s] || {};
      out[s].pop = numv(data[r][3]); out[s].listings = numv(data[r][lc >= 0 ? lc : 4]);
      out[s].avr = numv(data[r][6]); const rg = numv(data[r][9]); out[s].rg = rg == null ? null : Math.round(rg * 1000) / 10;
    } }
  for (let r = 2; r < mp.length; r++) {
    const nm = String(mp[r][1] || '').trim(); if (!nm || /^region$/i.test(nm)) continue;
    const s = slugify(nm); if (!s) continue; const med = numv(mp[r][4]);
    if (med != null) { out[s] = out[s] || {}; out[s].median = Math.round(med); }
  }
  return out;
}

const houses = readFile(HOUSE), units = readFile(UNITS);
const data = { houses, units };
console.log(`version ${VERSION} (${LABEL}): houses ${Object.keys(houses).length} · units ${Object.keys(units).length}`);
console.log('sample adelaide:', 'house', houses.adelaide, '| unit', units.adelaide);

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert into forge_demand_snapshots.'); }
else {
  if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { error } = await sb.from('forge_demand_snapshots').upsert(
    { version: VERSION, label: LABEL, data, captured_at: new Date().toISOString(), captured_by: 'seed-from-sheet' }, { onConflict: 'version' });
  if (error) { console.error('Upsert failed:', error.message); process.exit(1); }
  console.log(`\n✓ Stored snapshot '${VERSION}' (${LABEL}) — ${Object.keys(houses).length} house + ${Object.keys(units).length} unit regions.`);
}
