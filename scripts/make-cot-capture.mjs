// =============================================================================
// make-cot-capture.mjs — write ONE Demand Score Dashboard capture on the
// COTALITY basis, so the dashboard has a baseline to compare the live month
// against after its default basis moved (Van, 2026-09-18).
//
// WHY BY SCRIPT AND NOT BY THE DASHBOARD'S OWN CAPTURE BUTTON
// -----------------------------------------------------------
// That button freezes the LIVE month. The month needed here is August 2026,
// which is not live any more, so there is nothing for it to freeze. Everything
// below is the same calculation the dashboard would have made had it been
// pressed in August on the Cotality basis -- and that claim is CHECKED rather
// than asserted: the resulting demand scores must equal Runway v Demand's V3
// timeline for Aug 2026, market for market, or the script refuses to write.
//
// WHAT IS BASIS-DEPENDENT AND WHAT IS NOT
// ---------------------------------------
//   from Cotality   the projected vacancy (avr), its raw reading (vrr), the
//                   rents at both ends (rent, rent3) and the 36-month growth
//                   (rg) -- and therefore the demand score.
//   from the month's own SQM capture   population, runway, median price and the
//                   REA listing count. None of those depend on which vacancy or
//                   rent series is in play, so taking them from the capture that
//                   already exists keeps the two months honestly comparable.
//   from the Cotality archive   days on market, at LABEL - 3.
//
// Dry-run by DEFAULT; --write upserts version `cot-2026-08`.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const sb = createClient(process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co', process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');
const MONTH = '2026-08', LABEL = 'Aug 2026', DATA_MONTH = '2026-05', BACK_MONTH = '2023-05';
const VER = 'cot-' + MONTH;
const DIR = join(homedir(), 'Downloads');

const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const slugOf = s => String(s == null ? '' : s).trim()
  .replace(/\([^)]*\)/g, ' ').replace(/,\s*(act|nsw|nt|qld|sa|tas|vic|wa)\b/ig, ' ')
  .replace(/\bgreater\b/ig, ' ').replace(/\bregional\b/ig, ' ').replace(/-hastings/ig, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const monthOf = v => {
  if (typeof v === 'number' && isFinite(v)) { const d = new Date(Date.UTC(1899, 11, 30)); d.setUTCDate(d.getUTCDate() + Math.floor(v)); return d.toISOString().slice(0, 7); }
  const m = String(v == null ? '' : v).trim().match(/^(\d{4})-(\d{2})-\d{2}/); return m ? m[1] + '-' + m[2] : null;
};
function loadEngine() {
  const html = readFileSync('tools/demand-score.html', 'utf8');
  const start = html.indexOf('const PP_DEMAND_ENGINE = (function () {');
  const marker = html.indexOf('window.PP_DEMAND_ENGINE = PP_DEMAND_ENGINE', start);
  const end = marker < 0 ? -1 : html.lastIndexOf('\n', html.lastIndexOf('try', marker));
  if (start < 0 || marker < 0 || end <= start) throw new Error('PP_DEMAND_ENGINE not found');
  return new Function(html.slice(start, end) + '\n return PP_DEMAND_ENGINE;')();
}
const ENGINE = loadEngine();

/* Cotality vacancy + rent, from the same exports the V2/V3 builder reads */
const VR = {};
for (const e of readdirSync(DIR, { withFileTypes: true })) {
  if (!(e.isFile() && /VR and Rent\.xlsx$/i.test(e.name))) continue;
  let rows; try { const wb = XLSX.readFile(join(DIR, e.name), { raw: true }); rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false }); } catch { continue; }
  for (const r of rows.slice(1)) {
    const slug = slugOf(r[1]), month = monthOf(r[3]);
    if (!slug || !month) continue;
    const t = String(r[2]).toUpperCase() === 'U' ? 'u' : 'h';
    const vr = num(+r[4]), rent = num(+r[5]);
    if (vr == null) continue;
    const b = (VR[slug] || (VR[slug] = {}))[month] || (VR[slug][month] = {});
    if (b[t]) continue;
    b[t] = { vr: vr <= 1 ? vr * 100 : vr, rent };      /* Cotality ships a fraction */
  }
}
console.log('Cotality markets read: ' + Object.keys(VR).length);

/* days on market at the data month */
const clRows = [];
for (let from = 0; ; from += 1000) {
  const { data } = await sb.from('forge_cl_suburbs').select('name,level,ptype,metrics').eq('month', DATA_MONTH).in('level', ['capital', 'lga']).order('name').range(from, from + 999);
  clRows.push(...(data || [])); if (!data || data.length < 1000) break;
}
const DOM = {};
for (const pass of ['capital', 'lga']) for (const r of clRows) {
  if (r.level !== pass) continue; const slug = slugOf(r.name); if (!slug) continue;
  const t = String(r.ptype).toUpperCase() === 'U' ? 'u' : 'h';
  (DOM[slug] || (DOM[slug] = {})); if (DOM[slug][t] !== undefined) continue;
  DOM[slug][t] = num(+(r.metrics || {}).dom);
}

/* the projection, and the supply rule stamp the capture freezes */
const { data: fcRows } = await sb.from('rdp_vr_forecast').select('region_slug,payload');
const FC = {}; let vrRule = null, vrAt = null;
for (const r of fcRows || []) {
  const p = r.payload || {}, sr = p.supplyRule || {};
  if (num(p.population) == null || !(num(p.hhSize) > 0)) continue;
  FC[r.region_slug] = { population: p.population, hhSize: p.hhSize, expNewHouseholds: num(p.expNewHouseholds) || 0, expProperties: num(p.expProperties) || 0 };
  if (!vrRule && sr.rule) { vrRule = sr.rule; vrAt = sr.appliedAt || null; }
}
const projectVR = (slug, obs) => { const f = FC[slug]; if (!f || obs == null) return null; const vr = obs / 100; if (!(vr < 1)) return null;
  const H = f.population / f.hhSize, total = H / (1 - vr) + f.expProperties; if (!(total > 0)) return null;
  return Math.max(0.001, (total - H - f.expNewHouseholds) / total) * 100; };

/* the month's own SQM capture supplies everything basis-independent */
const { data: snapRow } = await sb.from('forge_demand_snapshots').select('data,label').eq('version', MONTH).maybeSingle();
if (!snapRow) { console.error('no SQM capture for ' + MONTH + ' to take population/runway/median/listings from'); process.exit(1); }

/* V3's own Aug months, as the check */
const { data: v3row } = await sb.from('forge_cotality').select('data').eq('id', 'rvd_v3').maybeSingle();
const v3Aug = (v3row.data.months || []).find(m => m.label === LABEL);
const { data: regions } = await sb.from('rdp_regions').select('slug,name');
const NAME = {}; for (const r of regions || []) NAME[r.slug] = r.name;
const V3 = {}; for (const g of ['houses', 'units']) for (const r of v3Aug[g] || []) V3[g + '|' + r.city] = r.ds;

const out = {}; const missing = [];
for (const [grp, t] of [['houses', 'h'], ['units', 'u']]) {
  const src = snapRow.data[grp] || {};
  const raw = [], keep = [];
  for (const [slug, v] of Object.entries(src)) {
    const c = ((VR[slug] || {})[DATA_MONTH] || {})[t];
    const back = (((VR[slug] || {})[BACK_MONTH] || {})[t] || {}).rent;
    const dom = (DOM[slug] || {})[t];
    if (!c || c.vr == null || back == null || !(back > 0) || dom == null || v.pop == null || v.listings == null) { missing.push(grp + '/' + slug); continue; }
    const avr = projectVR(slug, c.vr);
    if (avr == null) { missing.push(grp + '/' + slug); continue; }
    const rgPct = c.rent != null ? (c.rent - back) / back * 100 : 0;
    raw.push({ population: v.pop, listings: v.listings, vr: avr, dom, rentGrowth: rgPct / 100, isNational: false });
    keep.push({ slug, v, avr, rgPct, vrr: c.vr, rent: c.rent, rent3: back, dom });
  }
  ENGINE.compute(raw);
  const map = {};
  raw.forEach((r, i) => {
    const k = keep[i];
    map[k.slug] = {
      ds: r.demandScore, rw: k.v.rw, pop: k.v.pop, listings: k.v.listings,
      avr: k.avr, rg: k.rgPct, median: k.v.median,
      dom: k.dom, vrr: k.vrr, rent: k.rent, rent3: k.rent3,
      sqm: null, vrRule, vrAt, inc: k.v.inc ?? null, ai: k.v.ai ?? null, rate: k.v.rate ?? null,
      basis: 'cotality',
    };
  });
  out[grp] = map;
}

/* THE CHECK: these scores must equal V3's Aug 2026, market for market. */
let n = 0, ok = 0; const bad = [];
for (const [grp, map] of Object.entries(out)) {
  for (const [slug, m] of Object.entries(map)) {
    const want = V3[grp + '|' + (NAME[slug] || slug)];
    if (want == null) continue;
    n++;
    if (Math.round(m.ds) === want) ok++; else bad.push(grp + '/' + slug + ': capture ' + Math.round(m.ds) + ' vs V3 ' + want);
  }
}
console.log('markets built: houses ' + Object.keys(out.houses).length + ', units ' + Object.keys(out.units).length + (missing.length ? '   (skipped ' + missing.length + ': ' + missing.slice(0, 4).join(', ') + ')' : ''));
console.log('matches V3 Aug 2026: ' + ok + '/' + n);
if (bad.length) { bad.slice(0, 8).forEach(b => console.log('   ' + b)); console.error('\nREFUSING to write — a capture that disagrees with the chart is worse than no capture.'); process.exit(1); }

if (!WRITE) { console.log('\nDry run. Re-run with --write to store ' + VER + '.'); process.exit(0); }
const { error } = await sb.from('forge_demand_snapshots').upsert({
  version: VER, label: LABEL, data: { houses: out.houses, units: out.units, basis: 'cotality' },
  captured_at: new Date().toISOString(), captured_by: 'make-cot-capture.mjs',
}, { onConflict: 'version' });
if (error) { console.error('write failed: ' + error.message); process.exit(1); }
console.log('\nstored ' + VER + ' (' + LABEL + ').');
