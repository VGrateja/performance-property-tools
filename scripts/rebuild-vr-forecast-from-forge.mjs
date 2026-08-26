// =============================================================================
// rebuild-vr-forecast-from-forge.mjs — CI-safe monthly refresh of rdp_vr_forecast.
//
// Recomputes each region's 1-yr VR forecast (VrForecastCalc — the same engine
// build-vr-forecast.mjs verifies against the workbook) using:
//   FRESH from Forge each run:
//     population   ← rdp_raw_series metric='population' (latest year)
//     current VR   ← forge_demand_inputs.regions[slug].vr (SQM, % → fraction)
//     supply       ← OE regions: stored payload.oeByYear[CURRENT year]
//                    (auto-advances 2026→2027→…); approvals regions: Forge
//                    Total Approvals (approvals_h+approvals_u, latest yr) × 0.9
//   REUSED from the stored payload (refreshed only by the local full build /
//   build-vr-demand.mjs):
//     hhSize, oeByYear, and all display extras (rents, OO%, surplus — untouched).
//   DEMAND (nb/im/om/expectedPeople) is taken from payload.demand.v1 whenever
//     that canonical block is present — see the branch in the loop. It no
//     longer auto-advances the workbook's omByYear column, superseded on
//     2026-08-26 by the Centre for Population national forecast plus the
//     per-year share basis (Change 2 of the VR Projection spec).
//   PRE-EXISTING LIMITATION, unchanged: this recomputes the 1-YEAR forecast
//     only. forecastVR2 / twoYrHH / twoYrProps stay as the last full build left
//     them, so after a Forge input moves they lag the 1-yr figure until
//     build-vr-demand.mjs --canonical --write runs again.
//
// This closes the gap where GATHER refreshed SQM VR + population but the VR
// forecast (and therefore Demand Score's Adjusted VR) silently stayed at the
// last local build. Runs in forge-publish.yml; needs NO workbook file.
// Regions missing hhSize/expectedPeople are skipped (kept as-is, reported).
//
//   node scripts/rebuild-vr-forecast-from-forge.mjs           # dry run
//   node scripts/rebuild-vr-forecast-from-forge.mjs --write   # upsert
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import './../shared/vr-forecast-calc.js';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

const CUR_YEAR = new Date().getFullYear();
const pct = v => (v * 100).toFixed(2) + '%';

// ── Current stored forecasts (source of the workbook-side inputs) ──
const { data: rows, error: vrErr } = await sb.from('rdp_vr_forecast').select('region_slug,payload,source_month');
if (vrErr) { console.error('rdp_vr_forecast read failed:', vrErr.message); process.exit(1); }
if (!rows || !rows.length) { console.error('rdp_vr_forecast is empty — run the local build-vr-forecast.mjs first.'); process.exit(1); }

// slug-ify a Cotality region/capital name to match rdp slugs ("Greater Sydney" → sydney)
const cotSlug = s => String(s).replace(/\(.*?\)/g, '').split(',')[0].trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').replace(/^greater-/, '');

// ── Fresh Forge inputs (same queries + period floors as build-vr-forecast.mjs) ──
const forgePop = {}, forgeVR = {}, forgeAppr = {}, forgeRentSqm = {}, forgeRentCot = {};
{
  const { data: pop } = await sb.from('rdp_raw_series').select('region_slug,period,value').eq('metric', 'population').gte('period', '2020-01-01');   // period floor keeps us under the 1000-row cap
  const latest = {};
  for (const row of (pop || [])) { const s = row.region_slug; if (!latest[s] || row.period > latest[s].period) latest[s] = { period: row.period, value: +row.value }; }
  for (const s of Object.keys(latest)) forgePop[s] = latest[s].value;

  const { data: di } = await sb.from('forge_demand_inputs').select('data').eq('id', 'latest').maybeSingle();
  const dreg = (di && di.data && di.data.regions) || {};
  for (const s of Object.keys(dreg)) { const d = dreg[s]; if (!d) continue;
    if (d.vr != null && isFinite(+d.vr)) forgeVR[s] = +d.vr / 100;   // % → fraction
    if (d.rent_h != null || d.rent_u != null) forgeRentSqm[s] = { h: d.rent_h != null ? +d.rent_h : null, u: d.rent_u != null ? +d.rent_u : null };
  }
  const { data: rvRow } = await sb.from('forge_cotality').select('data').eq('id', 'rentvacancy').maybeSingle();
  const rv = rvRow && rvRow.data;
  for (const r of [].concat((rv && rv.capitals) || [], (rv && rv.regions) || [])) { const slug = cotSlug(r.name); if (!slug) continue; forgeRentCot[slug] = { h: r.rentHouse != null ? +r.rentHouse : null, u: r.rentUnit != null ? +r.rentUnit : null }; }

  const { data: appr } = await sb.from('rdp_raw_series').select('region_slug,metric,period,value').in('metric', ['approvals_h', 'approvals_u']).eq('freq', 'A').gte('period', '2018-01-01');
  const byY = {};
  for (const row of (appr || [])) { const y = +String(row.period).slice(0, 4); const s = row.region_slug; (byY[s] ??= {}); (byY[s][y] ??= { h: null, u: null }); byY[s][y][row.metric === 'approvals_h' ? 'h' : 'u'] = +row.value; }
  for (const s of Object.keys(byY)) { const ys = Object.keys(byY[s]).map(Number).sort((a, b) => b - a); for (const y of ys) { const rec = byY[s][y]; if (rec.h != null || rec.u != null) { forgeAppr[s] = { total: (rec.h || 0) + (rec.u || 0), year: y }; break; } } }
}

const stamp = new Date().toISOString();
const updates = []; const skipped = []; const shifts = []; const demandSrcCount = {};

for (const row of rows) {
  const slug = row.region_slug, p = row.payload || {};
  // Workbook-side inputs the CI run can't source — reuse the stored values.
  const hhSize = p.hhSize;
  /* DEMAND — nb / im / om.
     The CANONICAL demand block (payload.demand.v1, written by
     build-vr-demand.mjs --canonical) owns these whenever it is present. It
     carries the Forge-derived NI/IM and the overseas-migration figure from the
     Centre for Population's national forecast apportioned on the per-year
     share basis, plus any manual NIM override, already combined.

     DO NOT go back to auto-advancing payload.omByYear here. That column is the
     VR Projections WORKBOOK's OM tab — superseded on 2026-08-26 (Change 2).
     Reading it would silently undo the new OM method on the top-level fields
     the Buying/Selling slides and the online reports read, one month after it
     shipped, while the VR Projection tool kept showing the new figure from
     payload.demand. That split is the exact failure this branch prevents. */
  let expectedPeople = p.expectedPeople, omUsed = p.om, demandSrc = 'frozen payload';
  const dv1 = p.demand && p.demand.canonical && p.demand.v1;
  if (dv1 && dv1.om1 != null && dv1.people1 != null) {
    omUsed = dv1.om1;
    expectedPeople = dv1.people1;      // ni1 + im1 (override + workforce) + om1
    demandSrc = 'payload.demand.v1 (canonical)';
  } else if (p.omByYear && p.nb != null && p.im != null) {
    // LEGACY path — only for rows that have never had a canonical demand block.
    const yrs = Object.keys(p.omByYear).map(Number).sort((a, b) => b - a);
    const omYear = yrs.includes(CUR_YEAR) ? CUR_YEAR : yrs[0];   // auto-advance; past last year → latest
    const om = p.omByYear[omYear];
    if (om != null) {
      omUsed = om;
      /* NIM override (VR_NIM_OVERRIDES in shared/vr-forecast-calc.js) — without
         this the monthly re-seed would put the computed figure back. */
      const ov = globalThis.VrForecastCalc.applyNimOverride(slug, { im: p.im });
      expectedPeople = p.nb + ov.inp.im + om;
      demandSrc = 'workbook omByYear[' + omYear + '] (legacy)';
    }
  }
  demandSrcCount[demandSrc] = (demandSrcCount[demandSrc] || 0) + 1;
  if (hhSize == null || expectedPeople == null) { skipped.push(slug + ' (no hhSize/expectedPeople in payload — needs a local full build)'); continue; }

  const population = forgePop[slug] != null ? forgePop[slug] : p.population;
  const currentVR = forgeVR[slug] != null ? forgeVR[slug] : p.currentVR;

  // Supply: same per-region decision the local build stamped into the payload.
  let oeInput, oeYear = p.oeYear, oeSource = p.oeSource;
  if (p.oeSource === 'oe' && p.oeByYear) {
    const yrs = Object.keys(p.oeByYear).map(Number).sort((a, b) => b - a);
    oeYear = yrs.includes(CUR_YEAR) ? CUR_YEAR : yrs[0];   // auto-advance; past 2029 → latest OE year
    oeInput = p.oeByYear[oeYear];
  } else if (p.oeSource === 'forge_approvals' && forgeAppr[slug]) {
    oeInput = forgeAppr[slug].total * 0.9;                 // sheet's 10% discount applies to approvals only
    oeYear = forgeAppr[slug].year;
  } else {
    oeInput = p.oeCommencements;                           // workbook-sourced — keep as-is
  }
  if (oeInput == null) { skipped.push(slug + ' (no supply input)'); continue; }

  // expectedPeople is nb+im+om — the calc only ever uses the sum.
  const calc = globalThis.VrForecastCalc.computeVrForecast({ population, hhSize, currentVR, nb: expectedPeople, im: 0, om: 0, oeCommencements: oeInput });
  if (!calc) { skipped.push(slug + ' (calc returned null)'); continue; }

  if (Math.abs((calc.forecastVR ?? 0) - (p.forecastVR ?? 0)) > 0.0005) {
    shifts.push('  ' + slug + ': ' + pct(p.forecastVR || 0) + ' → ' + pct(calc.forecastVR) + '  (VR ' + pct(p.currentVR || 0) + '→' + pct(currentVR) + ', supply ' + Math.round(p.oeCommencements || 0) + '→' + Math.round(oeInput) + ')');
  }
  // Merge: fresh calc + refreshed inputs over the stored payload; every
  // workbook-side extra (forecastVR2, rents, ooPct, surplus, twoYr*, oeByYear,
  // hhSize) survives untouched via the spread base.
  updates.push({
    region_slug: slug,
    payload: { ...p, ...calc, om: omUsed,
      rentHouseSqm: forgeRentSqm[slug] ? forgeRentSqm[slug].h : p.rentHouseSqm, rentUnitSqm: forgeRentSqm[slug] ? forgeRentSqm[slug].u : p.rentUnitSqm,
      rentHouseCot: forgeRentCot[slug] ? forgeRentCot[slug].h : p.rentHouseCot, rentUnitCot: forgeRentCot[slug] ? forgeRentCot[slug].u : p.rentUnitCot,
      oeCommencements: oeInput, oeSource, oeYear, population, popSource: forgePop[slug] != null ? 'forge' : p.popSource, vrSource: forgeVR[slug] != null ? 'forge_sqm' : p.vrSource },
    source_month: row.source_month,
    computed_at: stamp,
  });
}

console.log('Recomputed ' + updates.length + '/' + rows.length + ' regions from Forge inputs (' + CUR_YEAR + ' supply year).');
console.log('demand source: ' + Object.entries(demandSrcCount).map(([k, v]) => v + ' × ' + k).join(' · '));
console.log(shifts.length + ' forecast(s) shifted >0.05pp:'); shifts.forEach(s => console.log(s));
if (skipped.length) { console.log('Skipped (kept previous payload):'); skipped.forEach(s => console.log('  ' + s)); }

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert.'); process.exit(0); }

let n = 0;
for (const u of updates) {
  const { error } = await sb.from('rdp_vr_forecast').upsert(u, { onConflict: 'region_slug' });
  if (error) { console.error('upsert ' + u.region_slug + ': ' + error.message); process.exit(1); }
  n++;
}
await sb.from('rdp_runs').insert({ dataset: 'vr_forecast', source_month: 'forge-rebuild ' + stamp.slice(0, 7), row_count: n, status: 'ok', notes: n + ' regions recomputed from Forge (pop/SQM VR/supply yr ' + CUR_YEAR + '); workbook-side inputs reused; ' + skipped.length + ' skipped' });
console.log('✓ Upserted ' + n + ' regions (computed_at ' + stamp + ').');
