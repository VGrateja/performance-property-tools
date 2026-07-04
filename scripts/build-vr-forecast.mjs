// =============================================================================
// build-vr-forecast.mjs  —  L2 mart builder for rdp_vr_forecast.
//
// Reads the VR Projections workbook's "1 yr Vacancy Rate Forecast" tab (the
// authoritative source), runs VrForecastCalc per region, VERIFIES against the
// workbook's own output (Expected VR / households), and upserts a per-region
// jsonb payload into rdp_vr_forecast. Shared dataset (used by reports + the
// Buying/Selling VR slide), so deck_type-agnostic.
//
// Dry-run by DEFAULT (parse + verify); --write upserts + logs rdp_runs.
//   node scripts/build-vr-forecast.mjs ["<vr.xlsx>"]            # dry run
//   node scripts/build-vr-forecast.mjs ["<vr.xlsx>"] --write     # upsert
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import './../shared/vr-forecast-calc.js';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}

// city-slug resolver (same conventions as the ingestion)
const ST = 'act|nsw|nt|qld|sa|tas|vic|wa';
const SLUGS = new Set(['australia','sydney','melbourne','brisbane','perth','adelaide','canberra','hobart','darwin','mackay','bundaberg','ipswich','rockhampton','gladstone','cairns','townsville','sunshine-coast','toowoomba','gold-coast','albury','central-coast','coffs-harbour','newcastle','orange','port-macquarie','tamworth','wagga-wagga','wollongong','dubbo','ballarat','bendigo','geelong','wodonga','mildura','mandurah','rockingham','bunbury','launceston']);
function resolveCity(label) {
  if (label == null) return null; let s = String(label).trim();
  if (s === '' || /^year$/i.test(s)) return null;
  if (/^national$/i.test(s)) return 'australia';
  s = s.replace(/\([^)]*\)/g, ' ').replace(new RegExp(',\\s*(' + ST + ')\\b', 'ig'), ' ').replace(/\b\d{3,4}\b/g, ' ').replace(/\bgreater\b/ig, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return SLUGS.has(s) ? s : null;
}

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const FILE = argv.find(a => !a.startsWith('--')) || join(homedir(), 'Downloads', 'UPDATED Vacancy Rate Projections.xlsx');
if (!existsSync(FILE)) { console.error('File not found:', FILE); process.exit(1); }
const wb = XLSX.readFile(FILE, { cellFormula: false });
const g = XLSX.utils.sheet_to_json(wb.Sheets['1 yr Vacancy Rate Forecast'], { header: 1, raw: true, defval: '' });

// header row (row 3, index 2) -> column index by name
const hdr = (g[2] || []).map(h => String(h).replace(/\s+/g, ' ').trim().toLowerCase());
const col = pred => hdr.findIndex(pred);
const C = {
  region: 0, state: 1,
  population: col(h => h.includes('total population')),
  hhSize: col(h => h.includes('median hh size')),
  currentVR: col(h => h.includes('current vr')),
  oe: col(h => h.includes('oe commencement')),
  nb: col(h => h === 'nb'), im: col(h => h === 'im'), om: col(h => h === 'om'),
  expHH: col(h => h.includes('households expected')),
  expVR: col(h => h.includes('expected vr')),
};
const need = ['population', 'hhSize', 'currentVR', 'oe', 'nb', 'im', 'om', 'expHH', 'expVR'].filter(k => C[k] < 0);
if (need.length) { console.error('Missing columns:', need.join(', '), '| headers:', hdr.join(' | ')); process.exit(1); }

const close = (a, b, rel = 1e-3) => (a == null || b == null) ? false : Math.abs(a - b) <= 1e-6 + rel * Math.abs(b);
const numv = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const results = []; let checks = 0, pass = 0; const fails = []; const unresolved = [];
for (let r = 3; r < g.length; r++) {
  const row = g[r]; const label = String(row[C.region] || '').trim(); if (!label) continue;
  const slug = resolveCity(label); if (!slug) { unresolved.push(label); continue; }
  const calc = globalThis.VrForecastCalc.computeVrForecast({
    population: numv(row[C.population]), hhSize: numv(row[C.hhSize]), currentVR: numv(row[C.currentVR]),
    nb: numv(row[C.nb]), im: numv(row[C.im]), om: numv(row[C.om]), oeCommencements: numv(row[C.oe]),
  });
  if (!calc) { unresolved.push(label + ' (missing inputs)'); continue; }
  // verify vs workbook output
  const expVR = numv(row[C.expVR]), expHH = numv(row[C.expHH]);
  for (const [k, mine, theirs] of [['forecastVR', calc.forecastVR, expVR], ['expNewHouseholds', calc.expNewHouseholds, expHH]]) {
    if (theirs == null) continue; checks++; if (close(mine, theirs)) pass++; else fails.push({ slug, k, mine, theirs });
  }
  results.push({ region_slug: slug, payload: { ...calc, oeCommencements: numv(row[C.oe]), hhSize: numv(row[C.hhSize]), population: numv(row[C.population]) } });
}

// ── PRESENTATION sheet extras: 2yr VR forecast, rents (+1yr forecasts), OO%,
//    property surplus/deficit, 2yr HH & properties. Merged onto each region's
//    payload (the existing 1yr fields are untouched). Columns per the sheet:
//    I(8) surplus · E(4) 2yr HH · H(7) 2yr props · L(11) 2yr VR · M(12) OO% ·
//    N(13) house rent · P(15) 1yr house rent fc · Q(16) unit rent · S(18) unit fc.
{
  const pres = XLSX.utils.sheet_to_json(wb.Sheets['PRESENTATION'] || {}, { header: 1, raw: true, defval: '' });
  const extras = {};
  for (let r = 1; r < pres.length; r++) {
    const row = pres[r]; const label = String(row[0] || '').trim(); if (!label) continue;
    const slug = resolveCity(label); if (!slug) continue;
    extras[slug] = {
      forecastVR2: numv(row[11]), ooPct: numv(row[12]), surplus: numv(row[8]),
      twoYrHH: numv(row[4]), twoYrProps: numv(row[7]),
      rentHouse: numv(row[13]), rentHouseFc: numv(row[15]),
      rentUnit: numv(row[16]), rentUnitFc: numv(row[18]),
    };
  }
  let merged = 0;
  for (const res of results) { const e = extras[res.region_slug]; if (e) { Object.assign(res.payload, e); merged++; } }
  console.log(`PRESENTATION extras merged onto ${merged}/${results.length} regions (2yr VR, rents, OO%, surplus).`);
}

console.log('regions parsed:', results.length, unresolved.length ? '| unresolved: ' + unresolved.join(', ') : '');
console.log(`VERIFY vs workbook: ${pass}/${checks} match`);
if (fails.length) for (const f of fails.slice(0, 15)) console.log(`  ${f.slug} ${f.k}: calc=${f.mine} workbook=${f.theirs}`);
const adel = results.find(r => r.region_slug === 'adelaide');
if (adel) console.log(`adelaide: currentVR=${(adel.payload.currentVR*100).toFixed(2)}%  expNewHouseholds=${Math.round(adel.payload.expNewHouseholds)}  expProperties=${Math.round(adel.payload.expProperties)}  forecastVR=${(adel.payload.forecastVR*100).toFixed(2)}%`);

if (!WRITE) { console.log('\nDry run complete. Re-run with --write to upsert into rdp_vr_forecast.'); process.exit(0); }

const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const stamp = new Date().toISOString();
let n = 0;
for (const r of results) {
  const { error } = await sb.from('rdp_vr_forecast').upsert({ region_slug: r.region_slug, payload: r.payload, source_month: 'VR Projections 2026-06', computed_at: stamp }, { onConflict: 'region_slug' });
  if (error) { console.error('upsert', r.region_slug, error.message); process.exit(1); }
  n++; process.stdout.write(`\r  upserted ${n}/${results.length}`);
}
console.log('');
await sb.from('rdp_runs').insert({ dataset: 'vr_forecast', source_month: 'VR Projections 2026-06', row_count: n, status: 'ok', notes: `${n} regions; VrForecastCalc (verified ${pass}/${checks})` });
console.log(`✓ Built rdp_vr_forecast for ${n} regions.`);
