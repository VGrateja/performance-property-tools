// =============================================================================
// build-civ.mjs  —  L2 mart builder for rdp_civ (Current Investment Value).
//
// civ = the latest-year snapshot of each region: current median price (H/U),
// current rent (H/U), gross yield (H/U). Derived from rdp_report_feed's most
// recent row with data (so it inherits the verified report_feed values).
// Verified against the Data Dump "CIV" tab (Brisbane / Adelaide / Perth).
//
// Dry-run by DEFAULT; --write upserts + logs rdp_runs.
//   node scripts/build-civ.mjs            # dry run
//   node scripts/build-civ.mjs --write     # upsert
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');

const { data: feeds, error } = await sb.from('rdp_report_feed').select('region_slug,payload');
if (error) { console.error(error.message); process.exit(1); }

const civ = [];
for (const f of feeds) {
  const years = (f.payload && f.payload.years) || [];
  const latest = [...years].reverse().find(r => r.mp_h != null || r.mp_u != null);
  if (!latest) continue;
  civ.push({ region_slug: f.region_slug, payload: {
    year: latest.year,
    mp_h: latest.mp_h, mp_u: latest.mp_u,
    rent_h: latest.rent_h, rent_u: latest.rent_u,
    yield_h: latest.yield_house, yield_u: latest.yield_unit,
  } });
}
console.log('civ regions:', civ.length);

// verify vs Data Dump CIV tab (Brisbane / Adelaide / Perth)
const ddPath = join(homedir(), 'Downloads', 'Data Dump - Online Report.xlsx');
if (existsSync(ddPath)) {
  const g = XLSX.utils.sheet_to_json(XLSX.readFile(ddPath, { cellFormula: false }).Sheets['CIV'], { header: 1, raw: true, defval: '' });
  const exp = {};
  for (let r = 1; r < g.length; r++) { const city = String(g[r][0] || '').trim().toLowerCase(); if (!city) continue; exp[city] = { mp_h: g[r][1], mp_u: g[r][2], rent_h: g[r][3], rent_u: g[r][4], yield_h: g[r][5], yield_u: g[r][6] }; }
  const close = (a, b) => (a == null || b == null) ? false : Math.abs(a - b) <= 0.5 + 0.02 * Math.abs(b);  // CIV tab values are display-rounded
  let checks = 0, pass = 0; const fails = [];
  for (const c of civ) { const e = exp[c.region_slug]; if (!e) continue;
    for (const k of ['mp_h', 'mp_u', 'rent_h', 'rent_u', 'yield_h', 'yield_u']) { if (e[k] === '' || e[k] == null) continue; checks++; if (close(c.payload[k], e[k])) pass++; else fails.push(`${c.region_slug}.${k}: civ=${c.payload[k]} sheet=${e[k]}`); }
  }
  console.log(`VERIFY vs CIV tab: ${pass}/${checks} match` + (fails.length ? '\n  ' + fails.join('\n  ') : ''));
}
const a = civ.find(c => c.region_slug === 'adelaide');
if (a) console.log('adelaide civ:', JSON.stringify(a.payload));

if (!WRITE) { console.log('\nDry run complete. Re-run with --write to upsert into rdp_civ.'); process.exit(0); }
const stamp = new Date().toISOString(); let n = 0;
for (const c of civ) { const { error } = await sb.from('rdp_civ').upsert({ region_slug: c.region_slug, payload: c.payload, source_month: 'Data Dump 2026-06', computed_at: stamp }, { onConflict: 'region_slug' }); if (error) { console.error(c.region_slug, error.message); process.exit(1); } n++; }
await sb.from('rdp_runs').insert({ dataset: 'civ', source_month: 'Data Dump 2026-06', row_count: n, status: 'ok', notes: `${n} regions; latest-year snapshot from report_feed` });
console.log(`✓ Built rdp_civ for ${n} regions.`);
