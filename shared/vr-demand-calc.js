/* =============================================================================
   vr-demand-calc.js — the DEMAND side of the vacancy-rate forecast, computed
   from Forge rather than read out of a workbook.

   Reproduces the July 2026 VR Projections workbook's NB / IM / OM tabs, which
   are the two forecast years' incoming people per region. Pure JS, dual-use
   (Node + globalThis.VrDemandCalc), same shape as vr-forecast-calc.js.

   TWO METHODS, one series
   -----------------------
   V1  natural increase and internal migration are single 2-year averages
       reused in BOTH forecast years, overseas migration is one forecast year
       repeated. Year 2 therefore repeats year-1 household formation and the
       year-2 movement comes from supply alone.

   V2  each year gets its own demand:
         NI  yr1 = the 3-year average exactly. The workbook computes
                   rate = 3yrAvg / population then multiplies back by
                   population, so population cancels — but the RATE is kept
                   because year 2 applies it to a grown population.
             yr2 = (population + yr1 expected people) x rate
         IM  yr1 = the current year's actual + workforce(yr1)
             yr2 = w x current + (1-w) x 3-year average + workforce(yr2),
                   w = imYr2WeightCurrent (workbook IM!K1 = 0.5)
         OM  see below — the same per-year share method as V1.

   OVERSEAS MIGRATION — SHARED BY BOTH VERSIONS (changed 2026-08-26)
   -----------------------------------------------------------------
   A NATIONAL forecast apportioned to the region, per year, on MATCHING
   windows:
       yr1  share = region 2-yr avg OM / NATIONAL 2-yr avg OM,
            OM = share x national forecast for forecast year 1
       yr2  share = region 3-yr avg OM / NATIONAL 3-yr avg OM,
            OM = share x national forecast for forecast year 2
   The denominator is the NATIONAL average over the same window — never the
   sum of the modelled regions. The 36 modelled markets do not cover the
   whole country (rest-of-state areas are not modelled), so their shares
   correctly sum to well under 1.0. DO NOT normalise them to sum to 1.
   The national row divides its own average by itself, so its share is
   exactly 1.0 and it takes the national forecast unapportioned.

   This REPLACED (Van Grateja, "VR Projection — three changes" spec,
   2026-08-26, Change 2) V2's single 3-year-average share used for both
   years and V1's one-forecast-year-repeated approach. V1's NI and IM still
   repeat in year 2; its OM no longer does, so V1's year-2 demand differs
   from year 1 by the OM step alone.

   PARAMETERS, NOT CONSTANTS
   -------------------------
   The 3-year window is defensible only while it excludes the COVID-affected
   years — that was the reasoning when it was set, and it stops being true
   after roughly two more annual updates. The 0.5 blend weight came from a
   backtest on nine years of components. Both are named parameters here and
   must be revisited each cycle rather than quietly inherited.

   WORKFORCE
   ---------
   Passed in separately and ADDED to internal migration, mirroring the
   workbook's IM tab where G = E + WF. Callers must supply the WF-free base
   as `im.current` / `im.avg3` — passing a combined figure double-counts.

   computeDemand({ components, population, national, nationalNom, wf, params })
     components  { ni:{YYYY:n}, im:{YYYY:n}, nom:{YYYY:n} }  financial years,
                 keyed by the June-ENDING year (2025 = FY2024-25)
     population  current total population, same geography as `components`
     national    { nom:{YYYY:n} }  national NOM history, the share DENOMINATOR
     nationalNom { yr1:n, yr2:n }  national NOM forecast levels, per year.
                 (`treasuryNom` is still accepted as a legacy alias, but the
                 figures are no longer Treasury's — see build-vr-demand.mjs.)
     wf          { y1:n, y2:n }    infrastructure workforce people, or null
   -> { v1:{...}, v2:{...}, inputs:{...} } each version carrying
      { ni1, im1, om1, people1, ni2, im2, om2, people2 }
   ============================================================================= */
(function (root) {
  'use strict';
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;

  const DEFAULT_PARAMS = {
    v1WindowYears: 2,          // V1's averaging window for NI and IM
    niWindowYears: 3,          // V2's NI window
    imWindowYears: 3,          // V2's IM blend window
    nomShareWindowYearsYr1: 2, // FORECAST YEAR 1 window for the region's share of national NOM
    nomShareWindowYears: 3,    // FORECAST YEAR 2 window for that share
    imYr2WeightCurrent: 0.5,   // workbook IM!K1 — weight on the current year in year 2
  };

  /* Mean of the most recent `n` years present in a {year: value} map. Returns
     null rather than a partial average when the window can't be filled — a
     short window would silently change the method. */
  function windowAvg(series, n, latestYear) {
    if (!series) return null;
    const end = latestYear != null ? latestYear : Math.max(...Object.keys(series).map(Number).filter(isFinite));
    if (!isFinite(end)) return null;
    let total = 0;
    for (let y = end - n + 1; y <= end; y++) {
      const v = num(series[y]);
      if (v == null) return null;
      total += v;
    }
    return total / n;
  }
  const latestOf = series => {
    const ys = Object.keys(series || {}).map(Number).filter(isFinite);
    return ys.length ? Math.max(...ys) : null;
  };

  function computeDemand(inp) {
    const o = inp || {};
    const P = Object.assign({}, DEFAULT_PARAMS, o.params || {});
    const comp = o.components || {};
    const pop = num(o.population);
    if (pop == null || pop <= 0) return null;

    const latest = o.latestYear != null ? o.latestYear : latestOf(comp.ni);
    if (latest == null) return null;

    const wf1 = (o.wf && num(o.wf.y1)) || 0;
    const wf2 = (o.wf && num(o.wf.y2)) || 0;

    const niAvg2 = windowAvg(comp.ni, P.v1WindowYears, latest);
    const niAvg3 = windowAvg(comp.ni, P.niWindowYears, latest);
    const imAvg2 = windowAvg(comp.im, P.v1WindowYears, latest);
    const imAvg3 = windowAvg(comp.im, P.imWindowYears, latest);
    const imCur = num(comp.im ? comp.im[latest] : null);
    const nomAvg2 = windowAvg(comp.nom, P.nomShareWindowYearsYr1, latest);
    const nomAvg3 = windowAvg(comp.nom, P.nomShareWindowYears, latest);
    const natNomAvg2 = windowAvg(o.national && o.national.nom, P.nomShareWindowYearsYr1, latest);
    const natNomAvg3 = windowAvg(o.national && o.national.nom, P.nomShareWindowYears, latest);

    /* Region's share of NATIONAL overseas migration, each forecast year on its
       OWN window (2-yr for year 1, 3-yr for year 2) with numerator and
       denominator taken over the SAME window. The denominator is the national
       series, NOT the sum of the modelled regions — the 36 markets do not
       cover the country, so these shares sum to well under 1.0 by design and
       must never be normalised. The national row divides its own average by
       itself, so its share is exactly 1.0 and it takes the forecast whole. */
    const nomShare1 = (nomAvg2 != null && natNomAvg2) ? nomAvg2 / natNomAvg2 : null;
    const nomShare2 = (nomAvg3 != null && natNomAvg3) ? nomAvg3 / natNomAvg3 : null;
    const nn = o.nationalNom || o.treasuryNom || {};   // treasuryNom = legacy alias
    const om1 = (nomShare1 != null && num(nn.yr1) != null) ? num(nn.yr1) * nomShare1 : null;
    const om2 = (nomShare2 != null && num(nn.yr2) != null) ? num(nn.yr2) * nomShare2 : null;

    /* Every version reports the WF-FREE internal-migration base alongside the
       combined figure, and people totals both ways. A consumer with a
       workforce toggle must read imBase/peopleNoWf for "excluded" and im/people
       for "included" — never add the workforce to the combined figure, which is
       the double count this whole model keeps tripping over. */
    const pack = (ni1, imBase1, om1v, ni2, imBase2, om2v) => {
      const im1 = imBase1 + wf1, im2 = imBase2 + wf2;
      const people1NoWf = ni1 + imBase1 + om1v, people1 = ni1 + im1 + om1v;
      const people2NoWf = ni2 + imBase2 + om2v, people2 = ni2 + im2 + om2v;
      return { ni1, imBase1, im1, om1: om1v, people1, people1NoWf, wf1,
               ni2, imBase2, im2, om2: om2v, people2, people2NoWf, wf2 };
    };

    /* ── V1 — 2-year averages for NI and IM; OM is year-specific ─────────
       NI and IM repeat in year 2 (single 2-year averages, unchanged), and
       only the YEAR-1 workforce reaches the forecast — the workbook computes
       IM!G (= IM + WF yr 2) but never consumes it, so wf2 is held at wf1.
       OM does NOT repeat any more (spec 2026-08-26, Change 2): year 2 takes
       the 3-yr share of the year-2 national forecast. V1's year-2 demand
       therefore differs from year 1 by the OM step and nothing else. */
    let v1 = null;
    if (niAvg2 != null && imAvg2 != null && om1 != null && om2 != null) {
      v1 = Object.assign(pack(niAvg2, imAvg2, om1, niAvg2, imAvg2, om2), {
        repeatYr2: false,                 // year 2 is no longer a straight copy
        yr2Basis: 'ni+im repeat, om year-specific',
      });
      v1.wf2 = wf1; v1.im2 = v1.im1;                       // year-1 workforce only
      v1.people2 = v1.ni2 + v1.im2 + v1.om2;
      v1.people2NoWf = v1.ni2 + v1.imBase2 + v1.om2;
    }

    /* ── V2 — each year its own demand ───────────────────────────────────── */
    let v2 = null;
    if (niAvg3 != null && imCur != null && imAvg3 != null && om1 != null && om2 != null) {
      const niRate = niAvg3 / pop;         // per-capita, so year 2 can grow it
      const ni1 = pop * niRate;            // == niAvg3 exactly; population cancels
      // year 2 applies the same rate to the population AFTER year-1 intake,
      // and the workbook grows it by the WF-INCLUSIVE intake (col P = NB+IM+OM
      // where IM already carries the workforce)
      const people1 = ni1 + (imCur + wf1) + om1;
      const ni2 = (pop + people1) * niRate;
      const w = P.imYr2WeightCurrent;
      v2 = Object.assign(pack(ni1, imCur, om1, ni2, w * imCur + (1 - w) * imAvg3, om2), { repeatYr2: false });
    }

    return {
      v1, v2,
      inputs: { latestYear: latest, population: pop, niAvg2, niAvg3, imAvg2, imAvg3, imCur,
                nomAvg2, nomAvg3, natNomAvg2, natNomAvg3, nomShare1, nomShare2,
                nomShare: nomShare2,   // legacy alias — the pre-2026-08-26 single share
                wf1, wf2, params: P },
    };
  }

  root.VrDemandCalc = { computeDemand, windowAvg, DEFAULT_PARAMS };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
