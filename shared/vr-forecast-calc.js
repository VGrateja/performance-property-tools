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

  root.VrForecastCalc = { computeVrForecast };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
