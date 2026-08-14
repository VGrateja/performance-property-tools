// =============================================================================
// build-vr-demand.mjs — compute the VR model's DEMAND side from Forge and merge
// it into rdp_vr_forecast.payload.demand as { v1, v2 }.
//
// Replaces the workbook's pasted NB/IM/OM with values derived from Forge's
// financial-year components of population change (metrics natural_increase_fy /
// nim_fy / nom_fy, loaded by ingest-abs-popcomponents-regional.mjs). The RULES
// come from the July 2026 VR Projections workbook; none of its DATA is used.
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

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const CANON = process.argv.includes('--canonical');   // also overwrite the fields other consumers read
const BASIS = (process.argv.find(a => a.startsWith('--capitals=')) || '--capitals=gccsa').split('=')[1];
if (!['gccsa', 'state'].includes(BASIS)) { console.error('--capitals must be gccsa or state'); process.exit(1); }

const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co', KEY, { auth: { persistSession: false } });

/* Treasury NATIONAL net overseas migration forecast, by financial year ending.
   Manual — a Budget/MYEFO figure with no machine-readable feed. Revisit each
   Budget. Matches the July workbook's OM!H3:L3. */
const TREASURY_NOM = { 2026: 295000, 2027: 245000, 2028: 225000, 2029: 225000, 2030: 225000 };

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
const national = { nom: (F['australia'] || {}).nom || {} };
const latestYear = Math.max(...Object.keys(national.nom).map(Number));

const { data: fc, error: fErr } = await sb.from('rdp_vr_forecast').select('region_slug,payload');
if (fErr) { console.error('forecast read failed:', fErr.message); process.exit(1); }

const rows = [], skipped = [];
for (const r of fc) {
  const p = r.payload || {}, slug = r.region_slug;
  const pop = p.population, hhSize = p.hhSize;
  if (pop == null || hhSize == null) { skipped.push(`${slug} (no population/hhSize)`); continue; }

  // Which component series this region reads. Capitals can be flipped to the
  // workbook's state substitution; regionals and national are always their own.
  const src = (BASIS === 'state' && CAPITAL_STATE[slug]) ? CAPITAL_STATE[slug] : slug;
  const components = F[src];
  if (!components || !components.ni) { skipped.push(`${slug} (no components for ${src})`); continue; }

  const wf = globalThis.VrWorkforce.forRegion(slug);
  const res = globalThis.VrDemandCalc.computeDemand({
    components, population: pop, national, latestYear,
    treasuryNom: { yr1: TREASURY_NOM[latestYear + 1], yr2: TREASURY_NOM[latestYear + 2] },
    wf,
  });
  if (!res || !res.v1 || !res.v2) { skipped.push(`${slug} (calc returned null — short window?)`); continue; }

  rows.push({ slug, pop, hhSize, src, res, stored: p });
}

// ── report ─────────────────────────────────────────────────────────────────
const f0 = v => v == null ? '—' : Math.round(v).toLocaleString('en-AU');
console.log(`VR demand from Forge — capitals basis: ${BASIS.toUpperCase()} · components through FY${latestYear - 1}-${String(latestYear).slice(2)}`);
console.log(`Treasury national NOM: yr1 ${f0(TREASURY_NOM[latestYear + 1])} · yr2 ${f0(TREASURY_NOM[latestYear + 2])}`);
console.log(`${rows.length} regions computed${skipped.length ? ` · ${skipped.length} skipped` : ''}\n`);

console.log('region            V1 people   stored     delta  |  V2 yr1     V2 yr2');
let moved = 0;
for (const r of rows.sort((a, b) => a.slug.localeCompare(b.slug))) {
  const v1 = r.res.v1.people1NoWf, st = r.stored.expectedPeople;   // compare like-for-like: stored expectedPeople excludes the workforce
  const d = (st != null) ? v1 - st : null;
  if (d != null && Math.abs(d) > Math.max(1, Math.abs(st) * 0.02)) moved++;
  console.log('  ' + r.slug.padEnd(16) + f0(v1).padStart(10) + f0(st).padStart(10) +
    (d == null ? '—' : (d >= 0 ? '+' : '') + f0(d)).padStart(10) + '  |' +
    f0(r.res.v2.people1).padStart(9) + f0(r.res.v2.people2).padStart(10));
}
console.log(`\n${moved}/${rows.length} regions move V1 expected-people by more than 2% vs the stored workbook value.`);
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
  const hhSize = p.hhSize, HH = p.households, props = p.properties, cur = p.currentVR;
  if (hhSize == null || HH == null || props == null || cur == null) return null;
  const oe1 = p.oeCommencements;
  // resolve year-2 supply BEFORE twoYrProps is overwritten, using the same
  // per-region routing the tool uses (OE forward column only for OE markets)
  const oeY = p.oeYear || latestYear + 1;
  const oe2 = (p.oeSource === 'oe' && p.oeByYear && p.oeByYear[String(oeY + 1)] != null) ? p.oeByYear[String(oeY + 1)]
    : (p.twoYrProps != null && props != null && oe1 != null) ? (p.twoYrProps - props - oe1)
    : oe1;
  const expectedPeople = v1.people1;
  const expNewHouseholds = expectedPeople / hhSize;
  const props1 = props + (oe1 || 0), HH1 = HH + expNewHouseholds;
  const forecastVR = props1 > 0 ? Math.max(0.001, (props1 - HH1) / props1) : null;
  // V1 repeats year-1 formation in year 2
  const props2 = props1 + (oe2 || 0), HH2 = HH1 + expNewHouseholds;
  const forecastVR2 = props2 > 0 ? Math.max(0.001, (props2 - HH2) / props2) : null;
  return {
    nb: v1.ni1, im: v1.im1, om: v1.om1,        // im carries the workforce, per the workbook's column G
    expectedPeople, expNewHouseholds, forecastVR, forecastVR2,
    twoYrHH: HH2, twoYrProps: props2,
  };
}

if (CANON) {
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

let n = 0;
for (const r of rows) {
  const canon = CANON ? canonicalise(r) : null;
  const legacy = canon ? { nb: r.stored.nb, im: r.stored.im, om: r.stored.om, expectedPeople: r.stored.expectedPeople,
    expNewHouseholds: r.stored.expNewHouseholds, forecastVR: r.stored.forecastVR, forecastVR2: r.stored.forecastVR2,
    twoYrHH: r.stored.twoYrHH, twoYrProps: r.stored.twoYrProps, supersededAt: new Date().toISOString() } : null;
  const payload = { ...r.stored, ...(canon || {}), demand: {
    basis: BASIS, latestYear, treasuryNom: { yr1: TREASURY_NOM[latestYear + 1], yr2: TREASURY_NOM[latestYear + 2] },
    componentSource: r.src, params: r.res.inputs.params, canonical: !!canon,
    v1: r.res.v1, v2: r.res.v2, inputs: r.res.inputs,
    ...(legacy ? { legacy } : (r.stored.demand && r.stored.demand.legacy ? { legacy: r.stored.demand.legacy } : {})),
  } };
  const { error } = await sb.from('rdp_vr_forecast').update({ payload }).eq('region_slug', r.slug);
  if (error) { console.error('\n' + r.slug + ':', error.message); process.exit(1); }
  n++; process.stdout.write(`\r  updated ${n}/${rows.length}`);
}
await sb.from('rdp_runs').insert({ dataset: 'vr_demand', source_month: `Forge demand ${new Date().toISOString().slice(0, 7)}`, row_count: n, status: skipped.length ? 'partial' : 'ok', notes: `V1+V2 demand from Forge FY components (capitals=${BASIS}), through FY${latestYear - 1}-${String(latestYear).slice(2)}${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}` });
console.log(`\n✓ Merged payload.demand into ${n} regions.`);
