// =============================================================================
// build-cotality-rvd-history.mjs — build Runway v Demand's COTALITY timeline
// (the V2 basis) from Cotality's own monthly exports.
//
// WHY THIS EXISTS
// ---------------
// The V2 switch added 2026-09-15 lets the Demand Score be built on Cotality
// vacancy and rent instead of SQM's, but Runway v Demand can only show months
// somebody has pushed on that basis. This builds them.
//
// WHERE EACH INPUT COMES FROM, AND WHY
// ------------------------------------
//   vacancy + rent   the "VR and Rent" workbooks Van exports from Cotality —
//                    one Historic file covering 1982-01 .. 2026-01 and one file
//                    per month after it, in Capital Cities and LGA pairs.
//                    Columns: State, (Capital City|Council Name), Property
//                    Type, Month end, Vacancy Rate (1 month), Median Asking
//                    Rent (3 months). Eight capitals + 28 regional councils =
//                    the 36 markets.
//   rent 3 years ago the SAME series, 36 months earlier. Worth saying out loud:
//                    an earlier cut took this from the ANNUAL series because no
//                    monthly history was known to exist. It does, and a rent
//                    growth built from one monthly series beats one spliced
//                    across two.
//   days on market   forge_cl_suburbs, a monthly Cotality archive: 96 months,
//                    2018-07 .. 2026-06, capital / lga / suburb, 30 metrics.
//                    Read at the DATA month, which is the same vintage the SQM
//                    line had at that label — its days on market were always
//                    Cotality's too.
//   listings         Cotality's own `listings1` (the "# listings (1mo)" column),
//                    read at the DATA month from forge_cl_suburbs like days on
//                    market beside it. Saskia's call, 2026-09-17.
//
//                    This REPLACES the REA series an earlier cut used, and it
//                    reverses the warning that used to stand here. That warning
//                    said Cotality's listings were "a different measure on a
//                    different scale", citing Brisbane. Measured across eight
//                    capitals and three months before the switch: SEVEN of the
//                    eight agree within 0.78-1.18x (median ~0.95). Brisbane
//                    alone runs 2.7x, every month.
//
//                    And Brisbane is REA's problem, not Cotality's. Listings per
//                    1,000 people, 2026-09: Melbourne 3.58, Perth 3.22, Adelaide
//                    2.79, Sydney 2.64, Hobart 2.32 — and Brisbane 1.17, less
//                    than half of any peer for a city of 2.8 million. On
//                    Cotality's figure Brisbane is 3.19, beside Melbourne's
//                    3.20. REA's Brisbane is a narrower geography (the council,
//                    not Greater Brisbane), so V2's Brisbane demand was
//                    OVERSTATED — fewer listings per head reads as a tighter
//                    market. Expect Brisbane to fall; that is the fix, not a
//                    break. `scratch/listings-compare.mjs` and `per1k.mjs`
//                    recompute both tables.
//
//                    ⚠ V2 now differs from V1 in TWO inputs, not one. It is no
//                    longer a controlled test of the vacancy/rent SOURCE; it is
//                    a Cotality-based demand score. That was the trade Saskia
//                    asked for.
//   population       the LABEL month's snapshot.
//   runway           the same snapshot. Runway is basis-independent — it is
//                    price against borrowing power and has nothing to do with
//                    which vacancy series is in play — so the Cotality series
//                    and the SQM one share it by design, and the only thing
//                    that moves between the two charts is the demand axis.
//
// THE MONTHS ARE LABELLED THE WAY THE SQM TIMELINE LABELS ITS OWN (Van, 2026-09-15)
// ---------------------------------------------------------------------------------
// A month on this chart is the month the reading was AVAILABLE, not the month
// the data covers — because that is what the SQM line already does, and two
// series on one timeline have to mean the same thing by "August". SQM's
// "Aug 2026" was captured on 2026-08-11 and the Cotality-sourced figures inside
// it are May 2026, so the offset is three months.
//
// MEASURED, not assumed. `forge_cl_suburbs.uploaded_at` dates each Cotality
// month's arrival, and the three months that were loaded as they came in are
// exactly three months behind their own data: 2026-04 landed 2026-07-19,
// 2026-05 landed 2026-08-10, 2026-06 landed 2026-09-12. (Everything from
// 2026-03 back shows a longer lag only because it was bulk-loaded in one go on
// 2026-07-22, so those dates say nothing about the cadence.)
//
// So: LABEL = data month + 3. Cotality's June is this chart's September;
// this chart's January 2025 is Cotality's October 2024.
//
// Worth knowing if this is ever revisited: Van's own workbook, "Data Base.xlsx",
// was labelled the OTHER way — by the month the data covers. Checked across four
// capitals and all fourteen of its months, every vacancy figure matched its
// same-named month end exactly, to four decimal places. The workbook is
// superseded by these exports and no longer read.
//
// WHAT LIMITS THE RANGE
// ---------------------
// Not the vacancy data, which runs from 1982. The runway does: stored Demand
// Score snapshots begin 2025-01, which is this chart's floor. At the new end,
// Cotality's newest published month is 2026-06, which under the rule above is
// September 2026 — so October onward does not exist yet.
//
//   node scripts/build-cotality-rvd-history.mjs            # dry run
//   node scripts/build-cotality-rvd-history.mjs --write    # upsert snapshots
//   node scripts/build-cotality-rvd-history.mjs --dir=<folder of the exports>
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

try {
  if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL, KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');
const DIR = (process.argv.find(a => a.startsWith('--dir=')) || '').slice(6) || join(homedir(), 'Downloads');

const MONTH_NAME = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ym = (s) => String(s).slice(0, 7);
const labelOf = (v) => MONTH_NAME[+v.slice(5, 7)] + ' ' + v.slice(0, 4);
/* "Month end" arrives two ways and both are in use: the .xlsx exports carry an
   Excel serial, the .csv straight off the portal carries an ISO date. Anything
   else is refused rather than guessed — a misread month silently files a
   reading under the wrong point on the timeline. */
const monthOf = (v) => {
  if (typeof v === 'number' && isFinite(v)) {
    const d = new Date(Date.UTC(1899, 11, 30));
    d.setUTCDate(d.getUTCDate() + Math.floor(v));
    return d.toISOString().slice(0, 7);
  }
  const s = String(v == null ? '' : v).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-\d{2}/);
  if (iso) return iso[1] + '-' + iso[2];
  return null;
};
/* The tool's own slug rule, so a market lands on the key the stored snapshots
   and the rest of the Forge already use. */
const slugOf = (s) => String(s == null ? '' : s).trim()
  .replace(/\([^)]*\)/g, ' ').replace(/,\s*(act|nsw|nt|qld|sa|tas|vic|wa)\b/ig, ' ')
  .replace(/\bgreater\b/ig, ' ').replace(/\bregional\b/ig, ' ').replace(/-hastings/ig, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;

// ── the live engine, lifted from the tool rather than copied ─────────────────
function loadEngine() {
  const html = readFileSync('tools/demand-score.html', 'utf8');
  const start = html.indexOf('const PP_DEMAND_ENGINE = (function () {');
  const marker = html.indexOf('window.PP_DEMAND_ENGINE = PP_DEMAND_ENGINE', start);
  /* Cut at the `try {` that wraps the publish line — slicing at the assignment
     lands inside the try and the extracted source will not parse. */
  const end = marker < 0 ? -1 : html.lastIndexOf('\n', html.lastIndexOf('try', marker));
  if (start < 0 || marker < 0 || end <= start) {
    throw new Error('PP_DEMAND_ENGINE not found in tools/demand-score.html — the block moved; fix this extractor rather than copying the formula.');
  }
  return new Function(html.slice(start, end) + '\n return PP_DEMAND_ENGINE;')();
}
const ENGINE = loadEngine();

// ── 1. vacancy + rent, from the Cotality exports ─────────────────────────────
/* VR[slug][month] = { h:{vr,rent}, u:{vr,rent} } */
const VR = {};
/* Two shapes land in Downloads and both are the same six columns: the .xlsx
   "VR and Rent" workbooks, and the raw .csv pair straight off the portal
   (`CSTDAT…_CapitalCities_*.csv` / `…_LGA_*.csv`), which arrive zipped and get
   unpacked into a folder of their own. Look one level down for that. */
const candidates = [];
for (const entry of readdirSync(DIR, { withFileTypes: true })) {
  if (entry.name.startsWith('~$')) continue;
  if (entry.isFile() && /VR and Rent\.xlsx$/i.test(entry.name)) candidates.push([DIR, entry.name]);
  else if (entry.isDirectory() && /^CSTDAT/i.test(entry.name)) {
    for (const f of readdirSync(join(DIR, entry.name))) {
      if (/\.csv$/i.test(f)) candidates.push([join(DIR, entry.name), f]);
    }
  }
}
if (!candidates.length) { console.error('No Cotality VR/rent exports found under ' + DIR); process.exit(1); }
console.log('reading ' + candidates.length + ' Cotality export(s) under ' + DIR);
/* A month can arrive twice — the same drop as a zip and as a "(1)" copy. Keep
   the first reading and count the rest, rather than letting a duplicate file
   quietly double-count or overwrite. */
let dupes = 0, pcts = 0;
for (const [dir, f] of candidates) {
  let rows;
  try {
    const wb = XLSX.readFile(join(dir, f), { raw: true });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });
  } catch (e) { console.log('  ' + f + ' — unreadable, skipped (' + e.message + ')'); continue; }
  let n = 0;
  for (const r of rows.slice(1)) {
    const slug = slugOf(r[1]); const month = monthOf(r[3]);
    if (!slug || !month) continue;
    const t = String(r[2]).toUpperCase() === 'U' ? 'u' : 'h';
    const vr = num(+r[4]), rent = num(+r[5]);
    if (vr == null) continue;
    const bucket = (VR[slug] || (VR[slug] = {}))[month] || (VR[slug][month] = {});
    if (bucket[t]) { dupes++; continue; }
    /* ⚠ COTALITY SHIPS VACANCY AS A FRACTION, NOT A PERCENT — the export files
       say 0.0102 where the number a person reads is 1.02%. Everything
       downstream (the engine's benchmark of 3, the projection, the dashboard)
       works in PERCENT, so it is converted here, once, at the door.
       The guard matters because the two Cotality sources disagree: these files
       hold a fraction, while `forge_cotality/rentvacancy` in Forge holds a
       percent already (1.02). A file that ever arrives in the store's shape
       would otherwise be multiplied into a 102% vacancy — a number that would
       sail through every later check. A real vacancy rate never reaches 100%,
       so a value above 1 is already a percentage. */
    bucket[t] = { vr: vr > 1 ? vr : vr * 100, rent };
    if (vr > 1) pcts++;
    n++;
  }
  console.log('  ' + f.padEnd(50) + String(n).padStart(7) + ' readings');
}
if (dupes) console.log('  (' + dupes + ' duplicate readings ignored — the same month downloaded twice)');
if (pcts) console.log('  (' + pcts + ' readings already came as a percentage rather than a fraction — taken as-is)');
const vrMonths = new Set();
for (const s of Object.keys(VR)) for (const m of Object.keys(VR[s])) vrMonths.add(m);
console.log('  -> ' + Object.keys(VR).length + ' markets, ' + vrMonths.size + ' months, '
  + [...vrMonths].sort()[0] + ' .. ' + [...vrMonths].sort().pop());

// ── 2. days on market + listings, from the monthly Cotality archive ──────────
/* forge_cl_suburbs is paged: 36 markets x 2 types x ~100 months is well over
   the 1000-row read cap, so it is pulled month by month. */
const CL = {};
{
  const months = [...vrMonths].sort().filter(m => m >= '2023-01');
  for (const m of months) {
    /* PAGE IT. A month is 1,043 LGA rows plus 16 capitals, and PostgREST caps a
       read at 1,000 — so a single select comes back short with no error at all.
       That is how Canberra silently vanished from the two newest months on the
       first build: the capitals sort last and fell off the end. */
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('forge_cl_suburbs')
        .select('name,level,ptype,metrics').eq('month', m).in('level', ['capital', 'lga'])
        .order('name').range(from, from + 999);
      if (error) { console.error('forge_cl_suburbs ' + m + ': ' + error.message); break; }
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    /* ⚠ CAPITAL ROWS WIN. Every capital city also exists as an LGA of the same
       name — the inner-city council — and it is a completely different market:
       the City of Melbourne carries 95 listings and 42 days on market against
       Greater Melbourne's 17,421 and 30. Reading both levels into one map and
       letting the later row land gave the CBD's days-on-market to five of the
       eight capitals, which is what broke the control test against V1. Take
       the capital row where there is one and only fall back to the council. */
    for (const pass of ['capital', 'lga']) {
      for (const r of rows) {
        if (r.level !== pass) continue;
        const slug = slugOf(r.name); if (!slug) continue;
        const t = String(r.ptype).toUpperCase() === 'U' ? 'u' : 'h';
        const met = r.metrics || {};
        const bucket = (CL[slug] || (CL[slug] = {}))[m] || (CL[slug][m] = {});
        if (bucket[t]) continue;      /* a capital row already claimed it */
        bucket[t] = { dom: num(+met.dom), listings: num(+met.listings1) };
      }
    }
  }
  const got = new Set(); for (const s of Object.keys(CL)) for (const m of Object.keys(CL[s])) got.add(m);
  console.log('archive months with DOM/listings: ' + got.size + ' (' + [...got].sort()[0] + ' .. ' + [...got].sort().pop() + ')');
}

// ── 3. population + runway, from the stored Demand Score snapshots ───────────
const { data: snaps, error: snapErr } = await sb.from('forge_demand_snapshots')
  .select('version,data').not('version', 'like', 'rvd%').order('version');
if (snapErr) { console.error('could not read snapshots: ' + snapErr.message); process.exit(1); }
const SNAP = {};
for (const s of snaps || []) SNAP[s.version] = { h: (s.data && s.data.houses) || {}, u: (s.data && s.data.units) || {} };
console.log('snapshot months carrying runway + population: ' + Object.keys(SNAP).length
  + ' (' + Object.keys(SNAP).sort()[0] + ' .. ' + Object.keys(SNAP).sort().pop() + ')');

// ── 3a. the VR PROJECTION, re-run on Cotality's reading ─────────────────────
/* Van, 2026-09-15: run the projection on the Cotality vacancy rather than feed
   the engine a raw observation, so V2 differs from V1 in exactly one thing —
   the SOURCE — and nothing else.

   The projection (shared/vr-forecast-calc.js) touches the current vacancy in
   one place only:
       households = population / hhSize
       properties = households / (1 - currentVR)
       forecastVR = (properties + supply - households - newHouseholds)
                    / (properties + supply)
   so every other input can be taken from the stored `rdp_vr_forecast` payload
   and only `currentVR` swapped. Those inputs — population, household size,
   expected people, supply — are annual and move slowly, and they are identical
   for both bases, so holding them still is what isolates the source.
   Sanity: the derivative with respect to vacancy is almost exactly 1 (Perth
   0.64→1.02 gives 0.55→0.92), which is why the additive re-base an earlier cut
   used landed so close to the real thing.
   ⚠ This puts V2 back on the `approvals95` supply rule, the same one the
   September jump was partly traced to. That is the intended trade: V2 now
   answers "was it the source?" rather than "was it the method?". */
const { data: vrFc } = await sb.from('rdp_vr_forecast').select('region_slug,payload');
const VRFC = {};
for (const r of vrFc || []) {
  const p = r.payload || {};
  if (num(p.population) == null || !(num(p.hhSize) > 0)) continue;
  VRFC[r.region_slug] = {
    population: p.population, hhSize: p.hhSize,
    expNewHouseholds: num(p.expNewHouseholds) || 0,
    expProperties: num(p.expProperties) || 0,
  };
}
/* Cotality's observed vacancy (fraction) -> the projected vacancy (percent),
   the same number the SQM side feeds the engine. Returns null where the market
   has no projection inputs, so the row is dropped rather than scored on an
   observation while its neighbours carry a forecast. */
function projectVR(slug, observedPct) {
  const f = VRFC[slug];
  if (!f || observedPct == null) return null;
  const vr = observedPct / 100;
  if (!(vr < 1)) return null;
  const households = f.population / f.hhSize;
  const properties = households / (1 - vr);
  const totalProps = properties + f.expProperties;
  if (!(totalProps > 0)) return null;
  const forecast = (totalProps - households - f.expNewHouseholds) / totalProps;
  return Math.max(0.001, forecast) * 100;
}
console.log('markets with projection inputs: ' + Object.keys(VRFC).length);

// ── 3b. the newest label has no stored snapshot yet ──────────────────────────
/* Cotality's June reads as September here, and no September capture exists. A
   capture taken this month would read the LIVE runway and population marts, so
   that is what the newest label uses. */
const { data: rwLive } = await sb.from('rdp_runway').select('region_slug,payload');
const { data: popLive } = await sb.from('rdp_raw_series').select('region_slug,period,value')
  .eq('metric', 'population').gte('period', '2020-01-01');
/* No listings read here any more: every label, the newest included, takes them
   from the Cotality archive at its own data month. */
const LIVE = { h: {}, u: {} };
{
  const pop = {}; const at = {};
  for (const r of popLive || []) if (!at[r.region_slug] || r.period > at[r.region_slug]) { at[r.region_slug] = r.period; pop[r.region_slug] = +r.value; }
  for (const r of rwLive || []) {
    const p = r.payload || {};
    LIVE.h[r.region_slug] = { rw: p.house && (p.house.forecast_wg_pct ?? p.house.runway_pct), pop: pop[r.region_slug] };
    LIVE.u[r.region_slug] = { rw: p.unit && (p.unit.forecast_wg_pct ?? p.unit.runway_pct), pop: pop[r.region_slug] };
  }
}

// ── 4. build ─────────────────────────────────────────────────────────────────
/* LABEL = data month + 3 (see the header). A label is buildable where the data
   month exists AND the label month has a runway — from its own stored snapshot,
   or from the live marts for the newest label, which has none yet. */
const LAG = 3;
const shift = (m, n) => { const d = new Date(m + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
/* A label needs a runway. Almost all of them take it from their OWN stored
   snapshot; exactly one may take it from the live marts — the newest, which has
   no capture yet. Letting any label without a snapshot fall back to live would
   stamp TODAY's runway onto 2023, which is how a first run produced 42 months
   back to 2023-04 that all shared one x-axis position. */
const newestLabel = shift([...vrMonths].sort().pop(), LAG);
const labels = [...new Set([...vrMonths].map(m => shift(m, LAG)))]
  .filter(l => SNAP[l] || l === newestLabel)
  .sort();
const out = [];
const notes = [];
for (const month of labels) {
  const dataMonth = shift(month, -LAG);
  if (!vrMonths.has(dataMonth)) continue;
  const useLive = !SNAP[month];
  const build = (isU) => {
    const t = isU ? 'u' : 'h';
    const raw = [];
    const missing = { rent3: [], dom: [], listings: [], pop: [], proj: [] };
    for (const slug of Object.keys(VR)) {
      /* Every Cotality input is read at the DATA month; runway and population
         at the LABEL month, because those are what a capture taken then knew. */
      const cur = (VR[slug][dataMonth] || {})[t];
      if (!cur || cur.vr == null) continue;
      /* three years back in the SAME series */
      const back = ((VR[slug][shift(dataMonth, -36)] || {})[t] || {}).rent;
      const cl = ((CL[slug] || {})[dataMonth] || {})[t] || {};
      const snap = useLive ? (LIVE[t][slug] || {}) : (SNAP[month][t][slug] || {});
      if (back == null || !(back > 0)) { missing.rent3.push(slug); continue; }
      if (cl.dom == null) { missing.dom.push(slug); continue; }
      /* Cotality's listings, same row and same vintage as the days on market
         above. A market without them is DROPPED rather than quietly served the
         REA figure -- mixing the two sources inside one series is the thing
         this change exists to stop. */
      if (cl.listings == null) { missing.listings.push(slug); continue; }
      if (snap.pop == null || typeof snap.rw !== 'number') { missing.pop.push(slug); continue; }
      const projected = projectVR(slug, cur.vr);
      if (projected == null) { missing.proj.push(slug); continue; }
      raw.push({
        /* listings = Cotality's listings1 at the DATA month; see the header */
        slug, population: snap.pop, listings: cl.listings,
        /* the PROJECTED vacancy, run on Cotality's own reading — the same KIND
           of number the SQM side feeds the engine. See section 3a. */
        vr: projected, dom: cl.dom,
        rentGrowth: (cur.rent != null) ? (cur.rent - back) / back : 0,
        _rw: snap.rw, isNational: false,
      });
    }
    ENGINE.compute(raw);
    return {
      list: raw.map(r => ({ city: r.slug, rw: Math.round(r._rw * 10000) / 100, ds: Math.round(r.demandScore) })),
      missing,
    };
  };
  const h = build(false), u = build(true);
  if (!h.list.length) { notes.push(month + ': nothing buildable'); continue; }
  out.push({ version: 'rvdcot-' + month, label: labelOf(month), data: { houses: h.list, units: u.list }, _miss: h.missing, _data: dataMonth + (useLive ? ', live runway' : '') });
}

/* The payload keys on the DISPLAY name the timeline uses. The slugs above are
   resolved to those names from the region table so a market lands on the same
   point as every other month. */
const { data: regions } = await sb.from('rdp_regions').select('slug,name');
const NAME = {}; for (const r of regions || []) NAME[r.slug] = r.name;
for (const o of out) for (const grp of ['houses', 'units']) {
  for (const row of o.data[grp]) row.city = NAME[row.city] || row.city;
}

console.log('');
for (const o of out) {
  const m = o._miss;
  const why = [m.rent3.length ? m.rent3.length + ' no rent-3yr' : null, m.dom.length ? m.dom.length + ' no DOM' : null, m.listings.length ? m.listings.length + ' no listings' : null, m.pop.length ? m.pop.length + ' no runway' : null, m.proj.length ? m.proj.length + ' no projection' : null].filter(Boolean).join(', ');
  console.log('  ' + o.label.padEnd(10) + '(data ' + o._data + ')  houses ' + String(o.data.houses.length).padStart(3)
    + '   units ' + String(o.data.units.length).padStart(3) + (why ? '   (' + why + ')' : ''));
  delete o._miss; delete o._data;
}

const have = out.map(o => o.version.replace('rvdcot-', ''));
console.log('\nmonths built: ' + out.length + '   ' + (have[0] || '—') + ' .. ' + (have[have.length - 1] || '—'));
{
  const span = [];
  if (have.length) for (let y = +have[0].slice(0, 4); y <= +have[have.length - 1].slice(0, 4); y++) for (let mo = 1; mo <= 12; mo++) {
    const v = y + '-' + String(mo).padStart(2, '0');
    if (v >= have[0] && v <= have[have.length - 1]) span.push(v);
  }
  const gaps = span.filter(v => !have.includes(v));
  console.log(gaps.length ? '  gaps inside that range: ' + gaps.join(', ') : '  no gaps inside that range');
}
for (const n of notes.slice(0, 10)) console.log('  ' + n);

if (!WRITE) { console.log('\nDry run. Re-run with --write to store this timeline.'); process.exit(0); }

/* WHERE THIS GOES, and why it is not forge_demand_snapshots.
 *
 * It used to be written there, one 'rvdcot-YYYY-MM' row per month. The Demand
 * Score Dashboard builds its month list from that table and excludes only
 * 'rvd-%' -- which 'rvdcot-' does not match, the fourth character being a 'c' --
 * so all 21 rows arrived in its compare view carrying THIS payload shape
 * instead of a capture's: market names rendered as array indices and runway
 * read 2614% where the market was on 26.14% (2026-09-16, on production).
 *
 * A deny-list on a table two tools share is the wrong shape. So the timeline is
 * ONE row in forge_cotality, whose eight readers all query `.eq('id', ...)` and
 * therefore cannot see a new id. Rewriting the whole row each run also makes
 * "stale months" impossible: what is not in this build is not in the store.
 */
const payload = {
  builtAt: new Date().toISOString(),
  builtBy: 'build-cotality-rvd-history.mjs',
  note: 'Runway v Demand V2 — the Cotality-based timeline. Deliberately NOT in forge_demand_snapshots; see the comment in this script.',
  months: out.map((o) => ({
    month: o.version.replace('rvdcot-', ''),
    label: o.label,
    houses: o.data.houses,
    units: o.data.units,
  })),
};
const { error: writeErr } = await sb.from('forge_cotality').upsert(
  { id: 'rvd_cotality', data: payload, file_name: 'runway-demand V2 timeline', uploaded_by: 'build-cotality-rvd-history.mjs' },
  { onConflict: 'id' });
if (writeErr) { console.error('\nFAILED to write forge_cotality/rvd_cotality: ' + writeErr.message); process.exit(1); }
console.log('\nstored ' + payload.months.length + ' months in forge_cotality id=rvd_cotality ('
  + Math.round(JSON.stringify(payload).length / 1024) + ' kB).');
