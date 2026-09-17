// =============================================================================
// build-sqm-rvd-history.mjs — Runway v Demand's V3 timeline: V1's SOURCES,
// rebuilt month by month under ONE engine and ONE rule set.
//
// WHY THIS EXISTS
// ---------------
// V1 is a historical record, not a recomputable series. Its twenty captures were
// taken on three different days, each under whatever method was in force at the
// time, and none of them is on the `approvals95` supply rule -- that rule landed
// on 2026-08-26 and the newest capture was taken 2026-08-11. V2 is internally
// consistent (one source, one engine, one rule, every month) but it is Cotality.
// V3 is the missing corner: SQM and REA data, held to V2's standard.
//
// WHERE EACH INPUT COMES FROM
// ---------------------------
//   vacancy      SQM's own published monthly series, via forge_demand_inputs
//                id `sqm_vacancy_history` (ingest-sqm-history.mjs). Read at
//                LABEL - 2, which is the live card's own convention: on
//                2026-09-13 the card's month was 2026-09 and its vr_as_of was
//                2026-07, and every one of the 37 regions' stored `vr` equals
//                this history at that month. Then RE-PROJECTED through the
//                current rdp_vr_forecast inputs, so every month is on the
//                approvals95 rule -- the whole point of the series.
//   rent growth  the same store's `sqm_rent_history`, current month against 36
//                months earlier. Rents are current-month on this card (its
//                rent_week_ending was 04 Sep 2026 for a 2026-09 card), so no lag
//                is applied to them.
//   listings     the LABEL month's stored Demand Score snapshot -- the REA
//                series, which is the one input with no source to re-fetch:
//                REA has no API and the bookmarklet entry is the only record it
//                ever existed.
//   days on mkt  forge_cl_suburbs at LABEL - 3, the same Cotality archive and
//                the same vintage V1 and V2 both read.
//   population   the LABEL month's snapshot.
//   runway       the same snapshot. Runway is basis-independent, so all three
//                series share it and only the demand axis can move.
//
// The engine is LIFTED out of tools/demand-score.html at run time, exactly as
// the Cotality builder lifts it, so this cannot pass against a stale copy of
// the formula.
//
// Dry-run by DEFAULT; --write stores it as ONE row in forge_cotality, id
// `rvd_sqm`, matching how the V2 timeline is stored.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const sb = createClient(process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co', process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');
const VR_LAG = 2, DOM_LAG = 3, RENT_BACK = 36;
const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const shift = (m, n) => { const d = new Date(m + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const slugOf = s => String(s == null ? '' : s).trim()
  .replace(/\([^)]*\)/g, ' ').replace(/,\s*(act|nsw|nt|qld|sa|tas|vic|wa)\b/ig, ' ')
  .replace(/\bgreater\b/ig, ' ').replace(/\bregional\b/ig, ' ').replace(/-hastings/ig, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function loadEngine() {
  const html = readFileSync('tools/demand-score.html', 'utf8');
  const start = html.indexOf('const PP_DEMAND_ENGINE = (function () {');
  const marker = html.indexOf('window.PP_DEMAND_ENGINE = PP_DEMAND_ENGINE', start);
  const end = marker < 0 ? -1 : html.lastIndexOf('\n', html.lastIndexOf('try', marker));
  if (start < 0 || marker < 0 || end <= start) throw new Error('PP_DEMAND_ENGINE not found in tools/demand-score.html — the block moved; fix this extractor rather than copying the formula.');
  return new Function(html.slice(start, end) + '\n return PP_DEMAND_ENGINE;')();
}
const ENGINE = loadEngine();

/* ── inputs ──────────────────────────────────────────────────────────────── */
const { data: vh } = await sb.from('forge_demand_inputs').select('data').eq('id', 'sqm_vacancy_history').maybeSingle();
const { data: rh } = await sb.from('forge_demand_inputs').select('data').eq('id', 'sqm_rent_history').maybeSingle();
if (!vh || !rh) { console.error('SQM history missing — run scripts/ingest-sqm-history.mjs --write first.'); process.exit(1); }
const VAC = vh.data.regions, RENT = rh.data.regions;

const { data: snaps } = await sb.from('forge_demand_snapshots').select('version,data').like('version', '20%').order('version');
console.log('V1 snapshots: ' + snaps.length + '  (' + snaps[0].version + ' .. ' + snaps[snaps.length - 1].version + ')');

const { data: fc } = await sb.from('rdp_vr_forecast').select('region_slug,payload');
const FC = {};
for (const r of fc || []) {
  const p = r.payload || {};
  if (num(p.population) == null || !(num(p.hhSize) > 0)) continue;
  FC[r.region_slug] = { population: p.population, hhSize: p.hhSize, expNewHouseholds: num(p.expNewHouseholds) || 0, expProperties: num(p.expProperties) || 0 };
}
console.log('markets with projection inputs: ' + Object.keys(FC).length);

/* the SAME projection the Cotality builder runs, on SQM's reading */
function projectVR(slug, observedPct) {
  const f = FC[slug];
  if (!f || observedPct == null) return null;
  const vr = observedPct / 100;
  if (!(vr < 1)) return null;
  const households = f.population / f.hhSize;
  const properties = households / (1 - vr);
  const totalProps = properties + f.expProperties;
  if (!(totalProps > 0)) return null;
  return Math.max(0.001, (totalProps - households - f.expNewHouseholds) / totalProps) * 100;
}

/* days on market, per data month, capital rows winning over the same-named LGA */
const CL = {};
async function domFor(dm) {
  if (CL[dm]) return CL[dm];
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from('forge_cl_suburbs').select('name,level,ptype,metrics').eq('month', dm).in('level', ['capital', 'lga']).order('name').range(from, from + 999);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const b = {};
  for (const pass of ['capital', 'lga']) for (const r of rows) {
    if (r.level !== pass) continue;
    const slug = slugOf(r.name); if (!slug) continue;
    const t = String(r.ptype).toUpperCase() === 'U' ? 'u' : 'h';
    (b[slug] || (b[slug] = {}));
    if (b[slug][t] !== undefined) continue;
    const d = r.metrics && r.metrics.dom;
    b[slug][t] = (typeof d === 'number' && isFinite(d)) ? d : null;
  }
  return (CL[dm] = b);
}

/* ── build ───────────────────────────────────────────────────────────────── */
const out = [];
/* Spelled out, NOT toLocaleString: en-AU renders September as "Sept", and the
   V1 and V2 timelines both label it "Sep". A month whose label does not match
   character-for-character lands as a separate point on the chart. */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LABEL = m => MON[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4);

for (const snap of snaps) {
  const month = snap.version;
  const vrMonth = shift(month, -VR_LAG), domMonth = shift(month, -DOM_LAG);
  const dom = await domFor(domMonth);
  const groups = {};
  const miss = { vr: [], rent: [], dom: [], snap: [], proj: [] };

  for (const [grp, t] of [['houses', 'h'], ['units', 'u']]) {
    const markets = snap.data[grp] || {};
    const raw = [], keep = [];
    for (const [slug, v] of Object.entries(markets)) {
      if (!v || v.pop == null || v.listings == null || typeof v.rw !== 'number') { miss.snap.push(slug); continue; }
      const obs = (VAC[slug] || {})[vrMonth];
      if (obs == null) { miss.vr.push(slug); continue; }
      const rNow = (RENT[slug] || {})[month], rBack = (RENT[slug] || {})[shift(month, -RENT_BACK)];
      const nowV = rNow && num(t === 'u' ? rNow.u : rNow.h), backV = rBack && num(t === 'u' ? rBack.u : rBack.h);
      if (nowV == null || backV == null || !(backV > 0)) { miss.rent.push(slug); continue; }
      const d = (dom[slug] || {})[t];
      if (d == null) { miss.dom.push(slug); continue; }
      const projected = projectVR(slug, obs);
      if (projected == null) { miss.proj.push(slug); continue; }
      raw.push({ slug, population: v.pop, listings: v.listings, vr: projected, dom: d, rentGrowth: (nowV - backV) / backV, _rw: v.rw, isNational: false });
      keep.push(slug);
    }
    ENGINE.compute(raw);
    groups[grp] = raw.map(r => ({ city: r.slug, rw: Math.round(r._rw * 10000) / 100, ds: Math.round(r.demandScore) }));
  }
  if (!groups.houses.length) { console.log('  ' + month + ': nothing buildable'); continue; }
  out.push({ version: 'rvdsqm-' + month, label: LABEL(month), data: groups, _m: miss, _src: 'vr ' + vrMonth + ', dom ' + domMonth });
}

console.log('');
for (const o of out) {
  const m = o._m;
  const why = [m.vr.length ? m.vr.length + ' no vacancy' : null, m.rent.length ? m.rent.length + ' no rent-36' : null, m.dom.length ? m.dom.length + ' no DOM' : null, m.snap.length ? m.snap.length + ' no snapshot' : null, m.proj.length ? m.proj.length + ' no projection' : null].filter(Boolean).join(', ');
  console.log('  ' + o.label.padEnd(10) + '(' + o._src + ')  houses ' + String(o.data.houses.length).padStart(3) + '   units ' + String(o.data.units.length).padStart(3) + (why ? '   (' + why + ')' : ''));
  delete o._m; delete o._src;
}

/* display names, as the timeline expects */
const { data: regions } = await sb.from('rdp_regions').select('slug,name');
const NAME = {}; for (const r of regions || []) NAME[r.slug] = r.name;
for (const o of out) for (const g of ['houses', 'units']) for (const row of o.data[g]) row.city = NAME[row.city] || row.city;

console.log('\nmonths built: ' + out.length + (out.length ? '   ' + out[0].label + ' .. ' + out[out.length - 1].label : ''));
if (!WRITE) { console.log('\nDry run. Re-run with --write to store this timeline.'); process.exit(0); }

const payload = { built: new Date().toISOString(), months: out.map(o => ({ label: o.label, houses: o.data.houses, units: o.data.units })) };
const { error } = await sb.from('forge_cotality').upsert({ id: 'rvd_sqm', data: payload, updated_at: new Date().toISOString(), uploaded_by: 'build-sqm-rvd-history' }, { onConflict: 'id' });
if (error) { console.error('write failed: ' + error.message); process.exit(1); }
console.log('\nstored ' + out.length + ' months in forge_cotality id=rvd_sqm (' + (JSON.stringify(payload).length / 1024).toFixed(0) + ' kB).');
