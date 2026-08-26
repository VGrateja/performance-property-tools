// =============================================================================
// build-vr-demand.mjs — compute the VR model's DEMAND side from Forge and merge
// it into rdp_vr_forecast.payload.demand as { v1, v2 }.
//
// Replaces the workbook's pasted NB/IM/OM with values derived from Forge's
// financial-year components of population change (metrics natural_increase_fy /
// nim_fy / nom_fy, loaded by ingest-abs-popcomponents-regional.mjs). The RULES
// come from the July 2026 VR Projections workbook; none of its DATA is used.
//
// 2026-08-26 — THREE CHANGES (Van Grateja's "VR Projection: three changes"
// specification), applied to V1 and V2 alike:
//   1. CAPITALS ON GCCSA — already true here; --capitals=gccsa is and stays the
//      default, and the ingest reads ERP_COMP_SA_ASGS2021 at the GCCSA level.
//      No change was needed. (--capitals=state still reproduces the workbook's
//      state substitution, as a switch.)
//   2. OVERSEAS MIGRATION — new national source and a per-year share basis.
//      See NATIONAL_NOM below and the OM block in shared/vr-demand-calc.js.
//   3. MELBOURNE NIM OVERRIDE — +10,173, applied to the component series
//      before any window average. See VR_NIM_OVERRIDES in
//      shared/vr-forecast-calc.js for the value, the date and the rationale.
// AFTER THESE CHANGES NEITHER VERSION REPRODUCES ITS SOURCE WORKBOOK. That is
// intended, and payload.demand.departsFromWorkbook records why — do not
// reconcile the stored figures against those files and report a fault.
//
// WHY THIS IS AN IMPROVEMENT, NOT JUST A RE-SOURCE
// ------------------------------------------------
// The workbook's multi-year averages are built from MIXED ABS VINTAGES — each
// year was captured when it was the current year and never revised afterwards.
// Ballarat's natural increase is averaged over 2023=270 (the 2023 release) and
// 2024=424 (the 2024 release); the current release puts those at 247 and 398.
// Recomputing the windows from one current release makes the averages
// internally consistent, so V2 here will differ from the workbook by roughly
// 1-4% on natural increase. That is the fix, not a regression.
//
// CAPITALS BASIS
// --------------
// --capitals=gccsa (DEFAULT) reads each capital's OWN components. The model's
//   population is already GCCSA, so this keeps numerator and denominator on the
//   same geography and removes the double count the workbook carries (its
//   Brisbane natural increase IS Queensland's, while Gold Coast, Ipswich,
//   Townsville and the rest each add their own on top).
// --capitals=state reproduces the workbook's substitution (notes on NB!J1,
//   IM!L2, OM!M1: "Capital Cities uses the state data"). Kept as a switch
//   because it is a methodology choice, not a bug — but note that the
//   workbook's capital figures reconcile with NEITHER basis on any ABS year,
//   so this option does not reproduce that file either.
//
// HOUSEHOLD SIZE — SOURCED, NOT ASSUMED (2026-08-26, Kia: "update the household
// sizes to be more accurate")
// ----------------------------------------------------------------------------
// The stored hhSize used to be the VR Projections workbook's ROUNDED assumption
// (Melbourne 2.6, Sydney 2.7 …), captioned "ABS Census" in the tool. It is now
// taken from shared/vr-household-size.js, which holds ONE OFFICIAL PROJECTED
// FIGURE PER MARKET for 2026 with its publisher, vintage and URL beside it.
//
// --canonical therefore also RE-DERIVES the two quantities that hang off it:
//     households = population / hhSize
//     properties = households / (1 - currentVR)
// and everything downstream of those (expNewHouseholds, forecastVR, twoYrHH,
// twoYrProps, forecastVR2, changeVR). `hhSize` and a human-readable
// `hhSizeSource` string are written onto the payload so the VR Projection tool
// and the Buying/Selling slides can caption the number honestly instead of
// saying "ABS Census".
//
// Only --canonical touches them. A plain --write still adds payload.demand and
// nothing else, exactly as before.
//
// DEFINITIONAL CAVEAT, CARRIED DELIBERATELY: every official source defines
// average household size as persons in OCCUPIED PRIVATE DWELLINGS / occupied
// private dwellings, while this model divides TOTAL ERP by it. That treats the
// ~1-2% of people living in non-private dwellings (hospitals, prisons, halls of
// residence, hotels) as if they formed households, so `households` runs ~1-2%
// above the source's own household count. That is the model's pre-existing
// convention — see shared/vr-household-size.js for the size of the gap per
// market — and it is unchanged here; only the divisor got more accurate.
//
// IF A LATER `build-vr-forecast.mjs --write` PUTS THE WORKBOOK ASSUMPTION BACK
// (it reads hhSize from the "median hh size" column of the xlsx), the recovery
// is one command: node scripts/build-vr-demand.mjs --canonical --write.
//
// SHARED TABLE — READ THIS BEFORE --write
// ---------------------------------------
// rdp_vr_forecast also feeds the online reports, the Buying/Selling VR slide
// and the Demand Score dashboard.
//   without --canonical  only payload.demand is added; nothing downstream
//                        changes until a consumer reads it explicitly.
//   with --canonical     the fields those consumers already read (nb, im, om,
//                        expectedPeople, expNewHouseholds, forecastVR,
//                        forecastVR2, twoYrHH, twoYrProps) are ALSO overwritten
//                        with the Forge-derived V1, which aligns every consumer
//                        at once without touching a single tool. The superseded
//                        values are preserved under payload.demand.legacy, so
//                        this is reversible.
// Either way the dry run prints the deltas first — run it before writing.
//
// Usage:
//   node scripts/build-vr-demand.mjs                    # dry run
//   node scripts/build-vr-demand.mjs --capitals=state   # dry run, state basis
//   node scripts/build-vr-demand.mjs --write            # merge payload.demand only
//   node scripts/build-vr-demand.mjs --canonical        # dry run, show the impact on every consumer
//   node scripts/build-vr-demand.mjs --canonical --write # ALSO align B/S slide, reports, Demand Score
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import '../shared/vr-demand-calc.js';
import '../shared/vr-workforce.js';
import '../shared/vr-forecast-calc.js';   // VR_NIM_OVERRIDES
import '../shared/vr-household-size.js';  // VR_HOUSEHOLD_SIZE — the sourced hhSize table

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const CANON = process.argv.includes('--canonical');   // also overwrite the fields other consumers read
/* Rebuild ONE region. A whole-fleet rebuild moves whatever else has drifted
   since the last run, which turns a one-region request into a re-forecast. */
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;
const BASIS = (process.argv.find(a => a.startsWith('--capitals=')) || '--capitals=gccsa').split('=')[1];
if (!['gccsa', 'state'].includes(BASIS)) { console.error('--capitals must be gccsa or state'); process.exit(1); }

const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co', KEY, { auth: { persistSession: false } });

/* ── NATIONAL NET OVERSEAS MIGRATION FORECAST ────────────────────────────────
   By financial year ENDING (2026 = FY2025-26). Source is the latest official
   Treasury forecast: the 2026-27 FEDERAL BUDGET (13 May 2026), Budget Paper
   No. 3, Appendix A "Parameters and further information", Table A.5 "Net
   overseas migration, for years ending 30 June" — forecasts prepared by the
   Centre for Population. NOT the VR Projections workbook (which happened to
   carry the same 295,000 / 245,000).

   HISTORY. 2026-08-26 AM ("VR Projection — three changes", Change 2) loaded
   the 2025 Population Statement's 260,000 (FY2025-26) / 227,300 (FY2026-27),
   believing the workbook's 295,000 / 245,000 to be stale Budget figures. Kia
   pointed out the same afternoon that Treasury had REVISED NOM UP in the May
   2026 Budget — 260,000 -> 295,000 for FY2025-26 and 225,000 -> 245,000 for
   FY2026-27 (temporary migrants staying longer, more NZ arrivals) — so the
   Statement (Dec 2025 / Jan 2026) was the older of the two. Corrected here
   2026-08-26 PM: newer official forecast wins. Every region's OM RISES vs the
   morning's figures (+13.5% yr1, +7.8% yr2), tightening every forecast; this
   is a source correction, not a tuning.

   FIGURES (Table A.5, read 2026-08-26 from
   https://budget.gov.au/content/bp3/download/bp3_14_appendix_a.pdf):
     FY2024-25  305,000  (a) ABS estimate, National, state and territory
                         population, September 2025 — actual, not forecast
     FY2025-26  295,000
     FY2026-27  245,000
     FY2027-28  225,000
     FY2028-29  225,000
     FY2029-30  225,000
   Beyond the table, hold 225,000 — do not extrapolate a further decline.

   Revisit at each Budget (May) and MYEFO (Dec); the Population Statement
   (Dec/Jan) restates the same Centre-for-Population numbers a month later. */
const NATIONAL_NOM = { 2026: 295000, 2027: 245000, 2028: 225000, 2029: 225000, 2030: 225000 };
const NOM_FORECAST_SOURCE = {
  publisher: 'Australian Government Treasury — Centre for Population forecasts, as published in the 2026-27 Budget',
  publication: '2026-27 Budget, Budget Paper No. 3, Appendix A: Parameters and further information, Table A.5 (Net overseas migration, for years ending 30 June)',
  budgetDate: '2026-05-13',
  documentUrl: 'https://budget.gov.au/content/bp3/download/bp3_14_appendix_a.pdf',
  readAt: '2026-08-26',
  yr1Cite: 'FY2025-26 = 295,000 — Table A.5. Revised up from 260,000 in the May 2026 Budget.',
  yr2Cite: 'FY2026-27 = 245,000 — Table A.5. Revised up from 225,000 in the May 2026 Budget. FY2027-28 onward 225,000.',
  supersedes: '2025 Population Statement figures (260,000 / 227,300) loaded 2026-08-26 AM — that publication (Dec 2025 / Jan 2026) predates the May 2026 Budget revision. The VR Projections workbook already carried 295,000 / 245,000.',
};

const CAPITAL_STATE = { sydney: 'st-nsw', melbourne: 'st-vic', brisbane: 'st-qld', adelaide: 'st-sa', perth: 'st-wa', hobart: 'st-tas', darwin: 'st-nt', canberra: 'st-act' };

// ── load Forge: FY components + the existing forecast payloads ──────────────
const { data: comp, error: cErr } = await sb.from('rdp_raw_series')
  .select('region_slug,metric,period,value')
  .in('metric', ['natural_increase_fy', 'nim_fy', 'nom_fy'])
  .gte('period', '2015-01-01');
if (cErr) { console.error('components read failed:', cErr.message); process.exit(1); }
if (!comp.length) { console.error('No *_fy components in rdp_raw_series — run ingest-abs-popcomponents-regional.mjs --write first.'); process.exit(1); }

const F = {};
const MKEY = { natural_increase_fy: 'ni', nim_fy: 'im', nom_fy: 'nom' };
for (const r of comp) {
  const y = +r.period.slice(0, 4), k = MKEY[r.metric];
  ((F[r.region_slug] = F[r.region_slug] || {})[k] = F[r.region_slug][k] || {})[y] = +r.value;
}
/* NATIONAL NOM history — the DENOMINATOR of every region's share. This is the
   ABS national series (region_slug 'australia', from ERP_COMP_SA_ASGS2021's
   AUS level), NOT the sum of the modelled regions: the 36 markets exclude
   rest-of-state areas, so summing them would inflate every share. */
const national = { nom: (F['australia'] || {}).nom || {} };
if (!Object.keys(national.nom).length) { console.error('No national (australia) nom_fy in rdp_raw_series — the share denominator is missing. Run ingest-abs-popcomponents-regional.mjs --write first.'); process.exit(1); }
const latestYear = Math.max(...Object.keys(national.nom).map(Number));
/* Fail loudly rather than silently emitting null OM for every region. */
for (const y of [latestYear + 1, latestYear + 2]) {
  if (NATIONAL_NOM[y] == null) { console.error(`No national NOM forecast for FY${y - 1}-${String(y).slice(2)} in NATIONAL_NOM — add it from the latest Budget / MYEFO / Population Statement before rebuilding.`); process.exit(1); }
}

const { data: fc, error: fErr } = await sb.from('rdp_vr_forecast').select('region_slug,payload');
if (fErr) { console.error('forecast read failed:', fErr.message); process.exit(1); }

// Workforce figures come from public.vr_workforce — never from this repo, which
// is public. `fc` is handed over as the fallback source for the window before
// migration 100 is applied.
await globalThis.VrWorkforce.load(sb, fc);
console.log(`workforce: ${globalThis.VrWorkforce.markets().length} markets from ${globalThis.VrWorkforce.source()}`);

const rows = [], skipped = [];
const nimApplied = [];   // regions whose IM was forced (VR_NIM_OVERRIDES)
/* SOURCED HOUSEHOLD SIZE — shared/vr-household-size.js. A market present in the
   table takes its figure; a market absent from it keeps whatever is stored, so
   this can never blank a row out. Only --canonical writes it. */
const HHTAB = globalThis.VrHouseholdSize.VR_HOUSEHOLD_SIZE;
for (const r of fc) {
  const p = r.payload || {}, slug = r.region_slug;
  const hh = HHTAB[slug] || null;                       // sourced entry, or null
  const pop = p.population, hhSize = hh ? hh.value : p.hhSize;
  if (pop == null || hhSize == null) { skipped.push(`${slug} (no population/hhSize)`); continue; }

  // Which component series this region reads. Capitals can be flipped to the
  // workbook's state substitution; regionals and national are always their own.
  const src = (BASIS === 'state' && CAPITAL_STATE[slug]) ? CAPITAL_STATE[slug] : slug;
  const components = F[src];
  if (!components || !components.ni) { skipped.push(`${slug} (no components for ${src})`); continue; }

  if (ONLY && slug !== ONLY) continue;

  /* MANUAL NIM OVERRIDE — VR_NIM_OVERRIDES in shared/vr-forecast-calc.js.
     Currently { melbourne: +10,173 } (Greater Melbourne's 2017 net internal
     migration — a deliberate analyst override; the full rationale lives next
     to the value in that file).

     Applied by REPLACING every year of the COMPONENT SERIES with the override
     value, before computeDemand takes its window averages. That makes
     imAvg2 / imAvg3 / imCur all equal the override, so the override reaches
     BOTH versions and BOTH forecast years through every IM path there is —
     V1's 2-year average, V2's current-year actual, and V2's 0.5/0.5 blend —
     and it lands on the WF-FREE BASE, before the workforce modifier is added.
     Patching the outputs instead would leave V2's year-2 natural increase
     computed from the old year-1 intake, since that is a per-capita rate
     applied to the post-intake population. */
  let componentsUsed = components;
  let nimRaw = null;                    // the computed IM the override displaced (V1's 2-yr average)
  const nimOv = globalThis.VrForecastCalc.VR_NIM_OVERRIDES;
  if (nimOv && slug in nimOv) {
    const forced = {};
    Object.keys(components.im || {}).forEach(y => { forced[y] = nimOv[slug]; });
    nimRaw = globalThis.VrDemandCalc.windowAvg(components.im, 2, latestYear);   // pre-override, for the audit trail
    componentsUsed = Object.assign({}, components, { im: forced });
    nimApplied.push(slug + ' (IM forced to ' + nimOv[slug] + ' across ' + Object.keys(forced).length +
      ' years; computed 2-yr avg was ' + (nimRaw == null ? '—' : Math.round(nimRaw)) + ')');
  }

  const wf = globalThis.VrWorkforce.forRegion(slug);   // loaded from public.vr_workforce above
  const res = globalThis.VrDemandCalc.computeDemand({
    components: componentsUsed, population: pop, national, latestYear,
    nationalNom: { yr1: NATIONAL_NOM[latestYear + 1], yr2: NATIONAL_NOM[latestYear + 2] },
    wf,
  });
  if (!res || !res.v1 || !res.v2) { skipped.push(`${slug} (calc returned null — short window?)`); continue; }

  rows.push({ slug, pop, hhSize, hh, src, res, stored: p, nimRaw, nimTarget: (nimOv && slug in nimOv) ? nimOv[slug] : null });
}

// ── report ─────────────────────────────────────────────────────────────────
const f0 = v => v == null ? '—' : Math.round(v).toLocaleString('en-AU');
console.log(`VR demand from Forge — capitals basis: ${BASIS.toUpperCase()} · components through FY${latestYear - 1}-${String(latestYear).slice(2)}`);
console.log(`National NOM forecast (${NOM_FORECAST_SOURCE.publication}, read ${NOM_FORECAST_SOURCE.readAt}):`);
console.log(`  yr1 FY${latestYear}-${String(latestYear + 1).slice(2)}  ${f0(NATIONAL_NOM[latestYear + 1])}   (share = region latest-FY OM / national latest-FY OM — 1-yr window, Kia 2026-08-26)`);
console.log(`  yr2 FY${latestYear + 1}-${String(latestYear + 2).slice(2)}  ${f0(NATIONAL_NOM[latestYear + 2])}   (same latest-FY share)`);
console.log(`  national 2-yr avg ${f0(globalThis.VrDemandCalc.windowAvg(national.nom, 2, latestYear))} · 3-yr avg ${f0(globalThis.VrDemandCalc.windowAvg(national.nom, 3, latestYear))}  (ABS 'australia', not the sum of regions)`);
console.log(`${rows.length} regions computed${skipped.length ? ` · ${skipped.length} skipped` : ''}\n`);

/* ── OM delta: the whole point of the 2026-08-26 change ─────────────────────
   Old = the single 3-yr share x the workbook's Budget figures. Recomputed
   here from the STORED payload so the comparison is against what is live. */
console.log('OVERSEAS MIGRATION — old (stored) vs new (per-year share x national forecast, 2026-27 Budget)');
console.log('region            share1   share2 |   OM yr1 old      new    delta |   OM yr2 old      new    delta');
let shareSum1 = 0, shareSum2 = 0;
for (const r of rows.sort((a, b) => a.slug.localeCompare(b.slug))) {
  const inp = r.res.inputs, sv1 = r.stored.demand && r.stored.demand.v1, sv2 = r.stored.demand && r.stored.demand.v2;
  const oldOm1 = sv1 ? sv1.om1 : null, oldOm2 = sv2 ? sv2.om2 : (sv1 ? sv1.om2 : null);
  const nOm1 = r.res.v1.om1, nOm2 = r.res.v1.om2;
  if (r.slug !== 'australia') { shareSum1 += inp.nomShare1 || 0; shareSum2 += inp.nomShare2 || 0; }
  const d = (a, b) => (a == null || b == null) ? '—' : ((b - a >= 0 ? '+' : '') + f0(b - a));
  console.log('  ' + r.slug.padEnd(16) + (inp.nomShare1 * 100).toFixed(3).padStart(7) + '%' +
    (inp.nomShare2 * 100).toFixed(3).padStart(8) + '% |' +
    f0(oldOm1).padStart(10) + f0(nOm1).padStart(9) + d(oldOm1, nOm1).padStart(9) + ' |' +
    f0(oldOm2).padStart(10) + f0(nOm2).padStart(9) + d(oldOm2, nOm2).padStart(9));
}
console.log(`  shares of the 36 modelled regions sum to ${(shareSum1 * 100).toFixed(1)}% (yr1) / ${(shareSum2 * 100).toFixed(1)}% (yr2).`);
console.log('  Under 100% is CORRECT — rest-of-state areas are not modelled. Never normalise these to 1.\n');

if (nimApplied.length) console.log('MANUAL NIM OVERRIDES APPLIED (shared/vr-forecast-calc.js):\n  ' + nimApplied.join('\n  ') + '\n');

console.log('region            V1 people   stored     delta  |  V2 yr1     V2 yr2');
let moved = 0;
for (const r of rows.sort((a, b) => a.slug.localeCompare(b.slug))) {
  /* Compare the SAME field before and after: expectedPeople is what
     canonicalise() writes, and it carries the workforce (the workbook's IM
     column G convention). Comparing people1NoWf against it — as this line did
     until 2026-08-26 — understated the eight workforce markets by their whole
     workforce and made Darwin look like it moved 900 people when it moved 88. */
  const v1 = r.res.v1.people1, st = r.stored.expectedPeople;
  const d = (st != null) ? v1 - st : null;
  if (d != null && Math.abs(d) > Math.max(1, Math.abs(st) * 0.02)) moved++;
  console.log('  ' + r.slug.padEnd(16) + f0(v1).padStart(10) + f0(st).padStart(10) +
    (d == null ? '—' : (d >= 0 ? '+' : '') + f0(d)).padStart(10) + '  |' +
    f0(r.res.v2.people1).padStart(9) + f0(r.res.v2.people2).padStart(10));
}
console.log(`\n${moved}/${rows.length} regions move V1 expected-people by more than 2% vs the stored value.`);
if (skipped.length) console.log('skipped: ' + skipped.join(', '));
console.log('\nNOTE: payload.demand is ADDITIVE. The existing nb/im/om/expectedPeople');
console.log('fields are untouched, so reports, B/S slides and Demand Score are unaffected');
console.log('until a consumer reads payload.demand explicitly.');

/* ── --canonical: also overwrite the fields every OTHER consumer reads ──────
   The Buying/Selling VR slide, the online reports and the Demand Score mart
   read nb/im/om/expectedPeople/expNewHouseholds/forecastVR(2)/twoYr*. Writing
   the Forge-derived V1 into those aligns all of them at once, with no
   per-tool code change and no risk of the tools drifting apart.

   V1 is used because it is the tool's default method; the workbook's own
   convention is followed for the workforce (its IM column is G = E + WF), so
   `im` carries the workforce and nb + im + om still sums to expectedPeople.
   The superseded values are kept under demand.legacy so this is reversible. */
function canonicalise(r) {
  const p = r.stored, v1 = r.res.v1;
  const cur = p.currentVR;
  /* HOUSEHOLD SIZE and the two quantities derived from it. Where the sourced
     table has the market (r.hh), households and properties are RE-DERIVED from
     the stored population and current VR rather than carried over — otherwise
     the row would advertise a new hhSize while still holding the household
     count the old one produced, and every downstream figure would be computed
     off a base that no longer matches its own divisor. Markets absent from the
     table keep the stored trio untouched. */
  /* All three move together or none of them do. A sourced hhSize is only
     adopted when the base can be re-derived from it (population and current VR
     both present) — adopting the divisor while keeping the old household count
     would be worse than leaving the row alone. */
  const rederive = !!(r.hh && p.population != null && cur != null);
  const hhSize = rederive ? r.hh.value : p.hhSize;
  const HH = rederive ? p.population / hhSize : p.households;
  const props = rederive ? HH / (1 - cur) : p.properties;
  if (hhSize == null || HH == null || props == null || cur == null) return null;
  const oe1 = p.oeCommencements;
  /* Resolve year-2 supply BEFORE twoYrProps is overwritten, using the same
     per-region routing the tool uses (OE forward column only for OE markets).
     The derived branch MUST read the STORED properties, not the re-derived
     `props`: p.twoYrProps was built on the old property base, so mixing the new
     base into that subtraction would corrupt year-2 supply by exactly the
     household-size shift. Both operands stay on the old basis; the result is
     the same oe2 as before this change. */
  const oeY = p.oeYear || latestYear + 1;
  const oe2 = (p.oeSource === 'oe' && p.oeByYear && p.oeByYear[String(oeY + 1)] != null) ? p.oeByYear[String(oeY + 1)]
    : (p.twoYrProps != null && p.properties != null && oe1 != null) ? (p.twoYrProps - p.properties - oe1)
    : oe1;
  const expectedPeople = v1.people1;
  const expNewHouseholds = expectedPeople / hhSize;
  const props1 = props + (oe1 || 0), HH1 = HH + expNewHouseholds;
  const forecastVR = props1 > 0 ? Math.max(0.001, (props1 - HH1) / props1) : null;
  /* Year 2 takes V1's OWN year-2 demand. Until 2026-08-26 this line reused
     year-1 formation, because V1's year 2 was a straight copy of year 1. It
     is not any more: Change 2 gives OM its own year-2 figure, so the two
     years differ by the OM step. Reusing year 1 here would leave the
     top-level 2-yr forecast (Buying/Selling slides, reports) disagreeing
     with what the VR Projection tool computes from payload.demand.v1 — the
     exact split-brain this canonical block exists to prevent. */
  const newHH2 = v1.people2 / hhSize;
  const props2 = props1 + (oe2 || 0), HH2 = HH1 + newHH2;
  const forecastVR2 = props2 > 0 ? Math.max(0.001, (props2 - HH2) / props2) : null;
  const out = {
    nb: v1.ni1, im: v1.im1, om: v1.om1,        // im carries the workforce, per the workbook's column G
    expectedPeople, expNewHouseholds, forecastVR, forecastVR2,
    // derived from forecastVR, so it has to move with it or it silently goes stale
    changeVR: forecastVR == null ? null : forecastVR - cur,
    twoYrHH: HH2, twoYrProps: props2,
  };
  /* The sourced household size travels WITH the figures it produced, so no
     consumer can pair the new households with the old divisor, and so the tool
     and the slides can caption the number with its actual publisher instead of
     the blanket "ABS Census" they used to hard-code. */
  if (rederive) {
    out.hhSize = hhSize;
    out.hhSizeSource = r.hh.source;
    out.hhSizeMeta = { value: hhSize, source: r.hh.source, publisher: r.hh.publisher, year: r.hh.year,
      geography: r.hh.geography, url: r.hh.url, basis: r.hh.basis, appliedAt: new Date().toISOString() };
    out.households = HH;
    out.properties = props;
  }
  /* Keep the top-level override audit trail in step with the demand block, so
     the Buying/Selling slides and the VR tool tell the same story. Without
     this the row would carry the new IM under the previous run's note. */
  if (r.nimTarget != null) {
    out.imOverride = true;
    out.imRaw = r.nimRaw;                      // the computed 2-yr average the override displaced
    out.imOverrideNote = (globalThis.VrForecastCalc.VR_NIM_OVERRIDE_NOTES || {})[r.slug]
      || ('NIM forced to ' + r.nimTarget + ' — see VR_NIM_OVERRIDES in shared/vr-forecast-calc.js.');
  }
  return out;
}

if (CANON) {
  /* HOUSEHOLD SIZE and the base it rebuilds. Printed before the forecast table
     because it is the CAUSE of every move below it — a reviewer who reads only
     the VR deltas cannot tell a demand change from a divisor change. */
  console.log('\n--canonical: household size and the base re-derived from it');
  console.log('region            hhSize old   new   |    households old        new   |     properties old        new   | source');
  let hhMoved = 0, hhKept = [];
  for (const r of rows.slice().sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (!r.hh) { hhKept.push(r.slug); continue; }
    const p = r.stored, HH = p.population / r.hh.value, props = HH / (1 - p.currentVR);
    if (Math.abs(r.hh.value - (p.hhSize || 0)) > 1e-9) hhMoved++;
    console.log('  ' + r.slug.padEnd(16) +
      (p.hhSize == null ? '—' : p.hhSize.toFixed(3)).padStart(10) + r.hh.value.toFixed(3).padStart(8) + '   |' +
      f0(p.households).padStart(15) + f0(HH).padStart(11) + '   |' +
      f0(p.properties).padStart(15) + f0(props).padStart(11) + '   | ' + r.hh.source);
  }
  console.log(`\n${hhMoved}/${rows.length} markets change household size.` +
    (hhKept.length ? ` Kept as stored (not in the sourced table): ${hhKept.join(', ')}.` : ' Every market is sourced.'));

  console.log('\n--canonical: forecastVR before → after (every consumer of this mart)');
  console.log('region             1yr before   1yr after   |  2yr before   2yr after');
  let bigMoves = 0;
  for (const r of rows.sort((a, b) => a.slug.localeCompare(b.slug))) {
    const c = canonicalise(r); if (!c) continue;
    const pc = v => v == null ? '—' : (v * 100).toFixed(2) + '%';
    const d1 = (c.forecastVR != null && r.stored.forecastVR != null) ? Math.abs(c.forecastVR - r.stored.forecastVR) : 0;
    if (d1 > 0.002) bigMoves++;
    console.log('  ' + r.slug.padEnd(16) + pc(r.stored.forecastVR).padStart(11) + pc(c.forecastVR).padStart(12) + '   |' +
      pc(r.stored.forecastVR2).padStart(12) + pc(c.forecastVR2).padStart(12) + (d1 > 0.002 ? '   <-- moves >0.2pp' : ''));
  }
  console.log(`\n${bigMoves}/${rows.length} regions move their 1-year forecast VR by more than 0.2pp.`);
  console.log('This is what the B/S VR slide, the online reports and Demand Score will show.');
}

if (!WRITE) { console.log(`\nDry run. Re-run with --write to merge payload.demand${CANON ? ' AND overwrite the canonical fields' : ''}.`); process.exit(0); }

const WROTE_AT = new Date().toISOString();
let n = 0;
for (const r of rows) {
  const canon = CANON ? canonicalise(r) : null;
  const legacy = canon ? { nb: r.stored.nb, im: r.stored.im, om: r.stored.om, expectedPeople: r.stored.expectedPeople,
    expNewHouseholds: r.stored.expNewHouseholds, forecastVR: r.stored.forecastVR, forecastVR2: r.stored.forecastVR2,
    twoYrHH: r.stored.twoYrHH, twoYrProps: r.stored.twoYrProps,
    /* the household-size trio too, so a rollback restores the base the old
       forecast was computed on and not just the forecast itself */
    hhSize: r.stored.hhSize, households: r.stored.households, properties: r.stored.properties,
    hhSizeSource: r.stored.hhSizeSource === undefined ? null : r.stored.hhSizeSource,
    supersededAt: new Date().toISOString() } : null;
  const payload = { ...r.stored, ...(canon || {}), demand: {
    basis: BASIS, latestYear,
    nationalNom: { yr1: NATIONAL_NOM[latestYear + 1], yr2: NATIONAL_NOM[latestYear + 2], source: NOM_FORECAST_SOURCE },
    /* Legacy alias kept so anything still reading `treasuryNom` sees the CURRENT
       levels rather than the superseded Budget ones. The name is wrong now —
       these are Centre for Population figures. Read `nationalNom`. */
    treasuryNom: { yr1: NATIONAL_NOM[latestYear + 1], yr2: NATIONAL_NOM[latestYear + 2] },
    /* Stored demand DELIBERATELY departs from the VR Projections workbooks as of
       2026-08-26 — do not reconcile against those files and report a fault. */
    departsFromWorkbook: {
      since: '2026-08-26',
      spec: 'Van Grateja — "VR Projection: three changes, applied to both V1 and V2"',
      reasons: [
        'OM: national forecast is the latest Treasury figure (2026-27 Budget, BP3 Table A.5: 295,000 / 245,000 — the same numbers the workbook carried), but the share is the region\'s LATEST financial-year share of the ABS national series (FY2024-25, 1-yr window, both years — Kia 2026-08-26) rather than the workbook\'s 3-yr average share.',
        'Capitals read Greater Capital City (GCCSA) components, not the workbook\'s state substitution (notes on NB!J1 / IM!L2).',
        'Window averages are recomputed from one current ABS release, where the workbook mixes vintages.',
        'Melbourne carries a manual net-internal-migration override of +10,173.',
      ],
    },
    nimOverride: r.nimTarget == null ? null : {
      value: r.nimTarget, displaced: r.nimRaw, appliedTo: 'base IM component series, before the workforce modifier, both versions and both years',
      note: (globalThis.VrForecastCalc.VR_NIM_OVERRIDE_NOTES || {})[r.slug] || null,
    },
    componentSource: r.src, params: r.res.inputs.params, canonical: !!canon,
    v1: r.res.v1, v2: r.res.v2, inputs: r.res.inputs,
    ...(legacy ? { legacy } : (r.stored.demand && r.stored.demand.legacy ? { legacy: r.stored.demand.legacy } : {})),
  } };
  /* Stamp computed_at — the VR Projection tool shows it as "Forecast computed",
     and leaving it at the previous build's timestamp made a fresh rebuild look
     stale. Only on a write, and only for the rows this run actually touched. */
  const { error } = await sb.from('rdp_vr_forecast').update({ payload, computed_at: WROTE_AT }).eq('region_slug', r.slug);
  if (error) { console.error('\n' + r.slug + ':', error.message); process.exit(1); }
  n++; process.stdout.write(`\r  updated ${n}/${rows.length}`);
}
await sb.from('rdp_runs').insert({ dataset: 'vr_demand', source_month: `Forge demand ${new Date().toISOString().slice(0, 7)}`, row_count: n, status: skipped.length ? 'partial' : 'ok', notes: `V1+V2 demand from Forge FY components (capitals=${BASIS}), through FY${latestYear - 1}-${String(latestYear).slice(2)}${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}` });
console.log(`\n✓ Merged payload.demand into ${n} regions.`);
