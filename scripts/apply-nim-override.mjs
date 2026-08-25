// =============================================================================
// apply-nim-override.mjs — push VR_NIM_OVERRIDES onto the STORED rdp_vr_forecast
// rows, changing nothing else.
//
// Why this exists instead of just running rebuild-vr-forecast-from-forge.mjs:
// that script ALSO auto-advances overseas migration to the current year, which
// currently moves 22 regions' forecasts. Bundling a broad forecast refresh into
// a one-region request is how a "make Melbourne's NIM 0" ask quietly becomes a
// company-wide re-forecast. This touches ONLY the regions in VR_NIM_OVERRIDES,
// and only the values that depend on NIM.
//
// What it recomputes, all from the region's own stored inputs:
//   expectedPeople    = nb + im(override) + om
//   forecastVR (1yr)  via VrForecastCalc — the same engine the seeders use
//   expNewHouseholds, households, properties, expProperties, changeVR
//   twoYrHH           = households + 2 x expNewHouseholds   (verified against
//                       the stored value to the digit before any change)
//   forecastVR2 (2yr) = 1 - twoYrHH / twoYrProps            (likewise verified)
//   surplus           shifted by the change in expNewHouseholds — it is a
//                       supply-minus-demand figure from the workbook, and demand
//                       is exactly what moved.
// twoYrProps and every supply-side field are left alone: NIM is demand.
//
// Usage:
//   node scripts/apply-nim-override.mjs            # dry run, prints before/after
//   node scripts/apply-nim-override.mjs --write    # writes
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import './../shared/vr-forecast-calc.js';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); } } catch {}

const WRITE = process.argv.includes('--write');
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY missing (.env)'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

const { VR_NIM_OVERRIDES, computeVrForecast } = globalThis.VrForecastCalc;
const slugs = Object.keys(VR_NIM_OVERRIDES);
if (!slugs.length) { console.log('No overrides declared — nothing to do.'); process.exit(0); }

const pct = v => (v * 100).toFixed(3) + '%';
const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;

const { data: rows, error } = await sb.from('rdp_vr_forecast')
  .select('region_slug,payload,source_month').in('region_slug', slugs);
if (error) { console.error(error.message); process.exit(1); }

const updates = [];
for (const row of rows) {
  const slug = row.region_slug, p = row.payload || {};
  const target = VR_NIM_OVERRIDES[slug];
  const rawIm = p.imOverride ? p.imRaw : p.im;      // re-running must not lose the original

  if (num(rawIm) == null || num(p.nb) == null || num(p.om) == null) { console.error(slug + ': missing nb/im/om'); process.exit(1); }

  /* Prove the derivations reproduce the STORED values before trusting them to
     produce new ones. If the model has moved on, stop rather than guess. */
  const before = computeVrForecast({
    population: p.population, hhSize: p.hhSize, currentVR: p.currentVR,
    nb: p.nb, im: rawIm, om: p.om, oeCommencements: p.oeCommencements,
  });
  if (!before) { console.error(slug + ': cannot recompute the baseline'); process.exit(1); }
  const chk = (label, mine, theirs, tol) => {
    if (num(theirs) == null) return;
    if (Math.abs(mine - theirs) > tol) {
      console.error(slug + ': ' + label + ' does not reproduce the stored value (' +
        mine + ' vs ' + theirs + ') — the model changed; stopping.');
      process.exit(1);
    }
  };
  chk('forecastVR', before.forecastVR, p.forecastVR, 1e-6);
  chk('expNewHouseholds', before.expNewHouseholds, p.expNewHouseholds, 1e-3);
  chk('twoYrHH', before.households + 2 * before.expNewHouseholds, p.twoYrHH, 1e-3);
  if (num(p.twoYrProps) != null && num(p.forecastVR2) != null) {
    chk('forecastVR2', 1 - p.twoYrHH / p.twoYrProps, p.forecastVR2, 1e-6);
  }

  const after = computeVrForecast({
    population: p.population, hhSize: p.hhSize, currentVR: p.currentVR,
    nb: p.nb, im: target, om: p.om, oeCommencements: p.oeCommencements,
  });
  const dHH = after.expNewHouseholds - before.expNewHouseholds;
  const twoYrHH = after.households + 2 * after.expNewHouseholds;
  const forecastVR2 = num(p.twoYrProps) != null ? 1 - twoYrHH / p.twoYrProps : p.forecastVR2;
  const surplus = num(p.surplus) != null ? p.surplus - dHH : p.surplus;

  const payload = {
    ...p, ...after,
    im: target,
    imRaw: rawIm,                 // the figure the override replaced
    imOverride: true,             // so nobody later wonders why this will not reconcile
    imOverrideNote: 'NIM forced to ' + target + ' (Davie via Saskia, 2026-08-25). Revert by removing the region from VR_NIM_OVERRIDES in shared/vr-forecast-calc.js and re-seeding.',
    twoYrHH, forecastVR2, surplus,
  };
  /* UPDATE, not upsert: this touches the payload only, so source_month and
     computed_by (a uuid) keep whatever the last real seeder run put there. */
  updates.push({ region_slug: slug, payload });

  console.log('\n' + slug.toUpperCase() + '  (everything else held constant)');
  console.log('  NIM                 ' + Math.round(rawIm) + '  ->  ' + target);
  console.log('  incoming people     ' + Math.round(before.expectedPeople) + '  ->  ' + Math.round(after.expectedPeople));
  console.log('  incoming households ' + Math.round(before.expNewHouseholds) + '  ->  ' + Math.round(after.expNewHouseholds));
  console.log('  VR now              ' + pct(p.currentVR));
  console.log('  VR 1yr forecast     ' + pct(before.forecastVR) + '  ->  ' + pct(after.forecastVR) + '   (' + ((after.forecastVR - before.forecastVR) * 100).toFixed(3) + 'pp)');
  if (num(p.forecastVR2) != null) console.log('  VR 2yr forecast     ' + pct(p.forecastVR2) + '  ->  ' + pct(forecastVR2) + '   (' + ((forecastVR2 - p.forecastVR2) * 100).toFixed(3) + 'pp)');
  if (num(p.surplus) != null) console.log('  property surplus    ' + Math.round(p.surplus) + '  ->  ' + Math.round(surplus));
}

/* No process.exit() past this point — the repo has hit libuv's
   "handle is closing" abort when exiting straight after a fetch. Fall off the
   end instead and let node close the sockets itself. */
if (!WRITE) {
  console.log('\nDry run. Re-run with --write to apply.');
} else {
  let wrote = 0;
  for (const u of updates) {
    const { error: e } = await sb.from('rdp_vr_forecast').update({ payload: u.payload, computed_at: new Date().toISOString() }).eq('region_slug', u.region_slug);
    if (e) { console.error('upsert ' + u.region_slug + ': ' + e.message); process.exitCode = 1; break; }
    wrote++;
  }
  console.log('\nWrote ' + wrote + '/' + updates.length + ' region(s).');
}
