/* =============================================================================
   runway-calc.js — the runway (affordability ceiling) mart calculator.

   Reproduces the Runway Workbook's "Houses/Units Runway - IC" math:
     AI       = annual P&I (80% LVR, 30yr, monthly comp, at `rate`) / annual income
     ceiling  = PV(rate, 360, monthly payment affordable at AI_ceiling) / 0.8
     runway%  = (ceiling - median) / median          (room before the affordability ceiling)
     forecast = same, at the forecast rate
   AI_ceiling is the region's sustainable-affordability constant (workbook col F).

   Pure JS, dual-use (globalThis.RunwayCalc). Verified to reproduce the workbook
   (see build-runway.mjs).

   computeRunway({ median, income, aiCeiling, currentRate, forecastRate }) ->
     { median, ai, ceiling, runway_pct, upside, downside, clock,
       forecast_ai, forecast_ceiling, forecast_pct, forecast_upside, forecast_downside, forecast_clock }
   ============================================================================= */
(function (root) {
  'use strict';
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const annualPI = (rate, pv) => (!num(rate) || !num(pv) || rate <= 0) ? null : (rate / 12 * pv / (1 - Math.pow(1 + rate / 12, -360))) * 12;   // -PMT(rate/12,360,pv)*12
  const pvLoan = (rate, monthly) => (!num(rate) || !num(monthly) || rate <= 0) ? null : monthly * (1 - Math.pow(1 + rate / 12, -360)) / (rate / 12);  // -PV(rate/12,360,monthly)
  // Upside probability band from runway % (workbook col K thresholds), as a fraction.
  function upside(j) { if (j == null) return null; return j >= 1 ? 0.95 : j >= 0.75 ? 0.90 : j >= 0.5 ? 0.80 : j >= 0.295 ? 0.70 : j >= 0.15 ? 0.60 : j >= 0 ? 0.50 : j >= -0.05 ? 0.30 : j >= -0.15 ? 0.20 : 0.10; }
  const CLOCK = [[1.25, '5:30'], [1.15, '6:00'], [1.05, '6:30'], [0.95, '7:00'], [0.85, '7:30'], [0.75, '8:00'], [0.65, '8:30'], [0.55, '9:00'], [0.45, '9:30'], [0.35, '10:00'], [0.25, '10:30'], [0.15, '11:00'], [0.05, '11:30'], [0, '12:00'], [-0.05, '12:30']];
  function clock(j) { if (j == null) return null; for (const [t, lab] of CLOCK) if (j >= t) return lab; return 'for evaluation'; }

  const RUNWAY_CAP = 1.3;   // business rule: runway maxes out at 130%; anything above is capped here at the source

  function leg(median, income, aiCeiling, rate) {
    if (num(median) == null || num(income) == null || num(aiCeiling) == null || num(rate) == null) return { ai: null, ceiling: null, runway_pct: null };
    const ai = annualPI(rate, median * 0.8) / (income * 52);
    const ceiling = pvLoan(rate, (income * 52 * aiCeiling) / 12) / 0.8;
    return { ai, ceiling, runway_pct: Math.min(RUNWAY_CAP, (ceiling - median) / median) };
  }

  function computeRunway({ median, income, aiCeiling, currentRate, forecastRate }) {
    const c = leg(median, income, aiCeiling, currentRate);
    const f = leg(median, income, aiCeiling, forecastRate);
    const up = upside(c.runway_pct), fup = upside(f.runway_pct);
    return {
      median, ai: c.ai, ceiling: c.ceiling, runway_pct: c.runway_pct,
      upside: up, downside: up == null ? null : 1 - up, clock: clock(c.runway_pct),
      forecast_ai: f.ai, forecast_ceiling: f.ceiling, forecast_pct: f.runway_pct,
      forecast_upside: fup, forecast_downside: fup == null ? null : 1 - fup, forecast_clock: clock(f.runway_pct),
    };
  }

  root.RunwayCalc = { computeRunway };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
