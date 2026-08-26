/* =============================================================================
   vr-forecast-calc.js — the vacancy-rate forecast mart calculator.

   Reproduces the "1 yr Vacancy Rate Forecast" of the VR Projections workbook
   (per region) — the source of the Buying/Selling deck's VR slide and a Demand
   Score input. Pure JS, dual-use (Node + globalThis.VrForecastCalc).

   Method (from the workbook's "VR Explained" tab): VR = vacant ÷ total. For next
   year, add expected new households (demand) and new dwellings (supply).

   computeVrForecast({ population, hhSize, currentVR, nb, im, om, oeCommencements })
     population      : current total population
     hhSize          : median household size
     currentVR       : current vacancy rate (fraction)
     nb, im, om      : next-year natural increase / internal migration / overseas migration (people)
     oeCommencements : expected new dwellings next year (Oxford Economics)
   -> { currentVR, households, properties, expectedPeople, expNewHouseholds,
        expProperties, forecastVR, changeVR }

   NOTE: oeCommencements (Oxford Economics) and hhSize (assumption) are not yet
   in rdp_raw_series; population/currentVR/nb/im/om also live in central raw and
   can be sourced there once OE commencements is centralised.
   ============================================================================= */
(function (root) {
  'use strict';
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;

  /* ── MANUAL NIM OVERRIDE — MELBOURNE, +10,173 ──────────────────────────
     NAMED AND DATED: set 2026-08-26 by Van Grateja, as Change 3 of the
     "VR Projection — three changes" specification of the same date.
     It SUPERSEDES the 2026-08-25 instruction (Davie via Saskia) that forced
     Melbourne's NIM to 0. Zero is no longer the override; +10,173 is.

     WHAT THE NUMBER IS
     Greater Melbourne's NET INTERNAL MIGRATION in 2017: +10,173 people.
     It is a DELIBERATE ANALYST OVERRIDE, not a computed value and not a
     current figure. Do NOT derive it from the components series, and do NOT
     "correct" it towards recent data — that is undoing the instruction, not
     fixing a bug.

     WHY IT LOOKS WRONG (it is not)
     Greater Melbourne's net internal migration, by year:
         2017  +10,173      2020   -9,266      2023   -9,466
         2018   +5,675      2021  -33,501      2024  -10,866
         2019   +2,252      2022  -36,282      2025   -8,554
     so the 2-year average is -9,710, the 3-year average is -9,629, and the
     current-year actual (FY2024-25) is -8,554. The override therefore sits
     roughly +19,800 people ABOVE whatever the method would otherwise
     produce, and carries the OPPOSITE SIGN. At Melbourne's household size
     that is about 7,600 additional households of demand — roughly a fifth
     of its current surplus — so Melbourne's forecast is deliberately
     TIGHTER than its own components imply. That is the intent.

     WHERE IT APPLIES
     To the BASE internal-migration figure, BEFORE the infrastructure
     workforce modifier is added, in BOTH demand versions (V1 and V2) and
     BOTH forecast years. Melbourne is not one of the eight workforce
     markets, so the workforce toggle cannot interact with it.

     WHY IT LIVES HERE
     build-vr-forecast.mjs, rebuild-vr-forecast-from-forge.mjs,
     apply-nim-override.mjs and build-vr-demand.mjs all import this module.
     Patching only the stored row would hold until the next monthly re-seed
     silently put the computed figure back.

     Applied to the STORED forecast only — never to the legacy workbook
     parity check in build-vr-forecast.mjs, which must keep comparing like
     with like or that verify stops meaning anything.

     NO OTHER REGION GETS AN OVERRIDE.

     TO REVERT: delete the region's line below. The next seeder run restores
     the computed value on its own; nothing else needs touching. */
  const VR_NIM_OVERRIDES = { melbourne: 10173 };

  /* Provenance for the payload + any UI that wants to explain the number,
     so the rationale travels with the data and not just with this file. */
  const VR_NIM_OVERRIDE_NOTES = {
    melbourne: 'Net internal migration forced to +10,173 — Greater Melbourne\'s 2017 net internal migration. '
      + 'Deliberate analyst override set 2026-08-26 (Van Grateja, "VR Projection — three changes" spec, Change 3); '
      + 'supersedes the 2026-08-25 force-to-0. NOT computed: Melbourne\'s own 2-yr avg is -9,710, 3-yr avg -9,629, '
      + 'current-year actual -8,554, so this is ~+19,800 people above the computed figure and the opposite sign. '
      + 'Applied to the base IM before the workforce modifier, in both versions and both forecast years. '
      + 'Do not "fix" it back — change VR_NIM_OVERRIDES in shared/vr-forecast-calc.js and re-seed instead.',
  };

  /* Returns a copy of the inputs with the override applied, plus what it
     replaced so the caller can record it on the payload for transparency. */
  function applyNimOverride(slug, inp) {
    const key = String(slug || '').toLowerCase();
    if (!inp || !(key in VR_NIM_OVERRIDES)) return { inp: inp, applied: false, raw: null };
    return { inp: Object.assign({}, inp, { im: VR_NIM_OVERRIDES[key] }), applied: true, raw: inp.im };
  }

  function computeVrForecast(inp) {
    const { population, hhSize, currentVR, nb, im, om, oeCommencements } = inp || {};
    if (num(population) == null || num(hhSize) == null || hhSize <= 0 || num(currentVR) == null) return null;
    const households = population / hhSize;
    const properties = households / (1 - currentVR);
    const expectedPeople = (num(nb) || 0) + (num(im) || 0) + (num(om) || 0);
    const expNewHouseholds = expectedPeople / hhSize;
    const expProperties = num(oeCommencements) || 0;            // new dwellings (supply)
    const newTotalProperties = properties + expProperties;
    const newTotalHouseholds = households + expNewHouseholds;
    const forecastVR = Math.max(0.001, (newTotalProperties - newTotalHouseholds) / newTotalProperties);
    return {
      currentVR, households, properties, expectedPeople,
      expNewHouseholds, expProperties, forecastVR, changeVR: forecastVR - currentVR,
    };
  }

  root.VrForecastCalc = { computeVrForecast, VR_NIM_OVERRIDES, VR_NIM_OVERRIDE_NOTES, applyNimOverride };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
