/* =============================================================================
   academy-math.js — the pure maths and fixed tables the Performance Academy
   teaches, in ONE dual-use module (browser + Node).

   WHY A COPY: the Demand Score engine lives inline in tools/demand-score.html
   (PP_DEMAND_ENGINE) and the Academy must show a learner the exact numbers the
   dashboard shows without touching that tool. The pure functions below are a
   verbatim copy of the engine's maths; scratch/_verify-academy-math.mjs proves
   the two agree for every market, house and unit. If the dashboard's engine
   ever changes, change this file the same way and re-run the harness.

   Also carried here, as canonical copies for teaching (sources in comments):
     HOUR_BANDS      tools/property-clock.html HOUR_OPTS
     MPC_LABELS      shared/market-clock.js LABELS (the twelve rim indicators)
     TL_CLOCK_STEPS  tools/buying-selling-slides.html (hour → traffic lights)
     QUADRANTS       tools/runway-demand.html quadrant fills + thresholds
     RENT_SCALE      tools/runway-demand.html right axis (DS → rent growth)
     ENTRY_BAR       tools/market-compare.html / demand-score.html
     REC_RATE        tools/demand-score.html DS_REC_RATE (PP rate at each capture)
     MARKET_COLOURS  tools/runway-demand.html legend dots

   Exposed as globalThis.AcademyMath.
   ============================================================================= */
(function (root) {
  'use strict';

  /* ── Demand Score engine (verbatim maths) ──────────────────────────────── */
  var E1 = 1000;
  var BENCH = { vr: 3, dom: 45, rentGrowth: 0.1 };
  var A = (function () {
    var a = [], v;
    for (v = 0;   v <= 20;   v += 1)  a.push(v);
    for (v = 25;  v <= 100;  v += 5)  a.push(v);
    for (v = 110; v <= 3740; v += 10) a.push(v);
    return a;
  })();
  function grade(M) {
    if (!(M > A[0])) return 100;
    var lo = 0, hi = A.length - 1, idx = 0;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (A[mid] <= M) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    return 100 - 0.5 * idx;
  }
  function median(arr) {
    var a = arr.filter(function (x) { return typeof x === 'number' && isFinite(x); }).sort(function (x, y) { return x - y; });
    var n = a.length; if (!n) return 0;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }
  /* rows: [{ population, listings, vr, dom, rentGrowth (decimal) }] — pass EVERY
     region incl. National so the benchmark median matches; mutates + returns */
  function compute(rows) {
    rows.forEach(function (r) {
      var pop = Number(r.population) || 0, list = Number(r.listings) || 0;
      r._F = pop > 0 ? (list / pop * E1) : 0;
      r._H = (Number(r.vr) || 0) * r._F;
      r._L = (Number(r.dom) || 0) * (1 - (Number(r.rentGrowth) || 0));
      r._M = r._L * r._H;
    });
    var Fb = median(rows.map(function (r) { return r._F; }));
    var Nb = grade((BENCH.dom * (1 - BENCH.rentGrowth)) * (BENCH.vr * Fb));
    rows.forEach(function (r) {
      var N = grade(r._M);
      r.listingsPer1k  = Math.round(r._F * 100) / 100;
      r.supplyScore    = Math.round(r._H * 100) / 100;
      r.rawDS          = Math.round(r._L * 10) / 10;
      r.scoreInversion = Math.round(N * 10) / 10;
      r.demandScore    = Math.min(80, Math.max(-20, ((N - Nb) / Nb) * 100));
      delete r._F; delete r._H; delete r._L; delete r._M;
    });
    return rows;
  }
  function benchmark(rows) {
    var Fs = rows.map(function (r) { var pop = Number(r.population) || 0, list = Number(r.listings) || 0; return pop > 0 ? list / pop * E1 : 0; });
    var Fb = median(Fs);
    return { Fb: Fb, Nb: grade((BENCH.dom * (1 - BENCH.rentGrowth)) * (BENCH.vr * Fb)) };
  }
  /* one row against a known benchmark grade; also returns the intermediate
     steps so a lesson can show the working */
  function scoreOne(r, Nb) {
    var pop = Number(r.population) || 0, list = Number(r.listings) || 0;
    var F = pop > 0 ? list / pop * E1 : 0;
    var H = (Number(r.vr) || 0) * F;
    var L = (Number(r.dom) || 0) * (1 - (Number(r.rentGrowth) || 0));
    var M = L * H;
    var N = grade(M);
    var ds = Nb ? Math.min(80, Math.max(-20, ((N - Nb) / Nb) * 100)) : null;
    return { F: F, H: H, L: L, M: M, N: N, Nb: Nb, demandScore: ds };
  }

  /* ── Runway helpers ────────────────────────────────────────────────────── */
  /* annuity factor of a 30-year monthly loan at annual rate r — the ratio of
     two of these re-rates a stored runway from the rate of its day to today's */
  function annuityFactor(r) { r = +r; if (!(r > 0)) return null; var m = r / 12; return (1 - Math.pow(1 + m, -360)) / m; }
  function reRateRunway(rw, rateThen, rateNow, cap) {
    var a = annuityFactor(rateThen), b = annuityFactor(rateNow);
    if (a == null || b == null || rw == null || isNaN(rw)) return rw;
    var v = (1 + (+rw)) * b / a - 1;
    return Math.min(cap == null ? 1.3 : cap, v);
  }
  /* the PP variable rate recorded at each dashboard capture (before captures
     stored it themselves) — copied from tools/demand-score.html DS_REC_RATE */
  var REC_RATE = {
    '2025-01': 0.0545, '2025-02': 0.0545, '2025-03': 0.0545, '2025-04': 0.0545, '2025-05': 0.0535, '2025-06': 0.0555,
    '2025-07': 0.0555, '2025-08': 0.0540, '2025-09': 0.0540, '2025-10': 0.0540, '2025-11': 0.0560, '2025-12': 0.0560,
    '2026-01': 0.0560, '2026-02': 0.0603, '2026-03': 0.0494, '2026-04': 0.0494, '2026-05': 0.0494, '2026-06': 0.0494,
    '2026-07': 0.0491, '2026-08': 0.0491
  };
  var RUNWAY_CAP = 1.3;
  var ENTRY_BAR = { smooth: 0.40, workforce: 0.70 };

  /* ── The clock ─────────────────────────────────────────────────────────── */
  /* tools/property-clock.html HOUR_OPTS — the legal positions and band names */
  var HOUR_BANDS = [
    [12, 'Peak'], [10.5, 'Selling Window'], [11, 'Selling Window'], [11.5, 'Selling Window'], [1, 'Selling Window'], [1.5, 'Selling Window'],
    [2, 'Correction'], [2.5, 'Correction'], [3, 'Hold'], [3.5, 'Hold'],
    [4, 'Buy Momentum'], [4.5, 'Buy Momentum'], [5, 'Buy Momentum'], [5.5, 'Buy Momentum'],
    [6, 'Buy Value'], [6.5, 'Buy Value'], [7, 'Buy Value'], [7.5, 'Buy Value'],
    [8, 'Momentum'], [8.5, 'Momentum'], [9, 'Momentum'], [9.5, 'Momentum'], [10, 'Momentum']
  ];
  function bandAtHour(h) {
    h = ((Number(h) % 12) + 12) % 12; if (h === 0) h = 12;
    var best = null, bd = 99;
    HOUR_BANDS.forEach(function (o) { var d = Math.abs(o[0] - h); if (d < bd) { bd = d; best = o; } });
    return best ? best[1] : '';
  }
  /* shared/market-clock.js LABELS — the twelve rim indicators, by hour */
  var MPC_LABELS = [
    { hour: 1,   text: 'Oversupply' },
    { hour: 1.5, text: 'Construction slows' },
    { hour: 2,   text: 'Values stagnate or decline' },
    { hour: 3,   text: 'Development sites unfeasible' },
    { hour: 4,   text: 'Population starts absorbing supply' },
    { hour: 5,   text: 'Low vacancy rate causes rents to begin rising' },
    { hour: 6,   text: 'Negative media sentiment' },
    { hour: 7,   text: 'Rents rise moderately to aggressively' },
    { hour: 8,   text: 'Media sentiment improves, accompanied by moderate price growth' },
    { hour: 9,   text: 'Development sites become feasible' },
    { hour: 10,  text: 'Construction increases as prices run aggressively' },
    { hour: 11,  text: 'FOMO conditions' }
  ];
  /* tools/buying-selling-slides.html TL_CLOCK_STEPS — degrees from 12 o'clock */
  var TL_CLOCK_STEPS = [
    { a1: 300, a2: 330, ph: 'Selling window',        tl: ['GREEN',  'RED',    'GREEN']  },
    { a1: 330, a2: 360, ph: 'Selling window',        tl: ['ORANGE', 'RED',    'GREEN']  },
    { a1: 0,   a2: 30,  ph: 'Selling window',        tl: ['ORANGE', 'RED',    'ORANGE'] },
    { a1: 30,  a2: 60,  ph: 'Correction',            tl: ['RED',    'RED',    'RED']    },
    { a1: 60,  a2: 90,  ph: 'Correction',            tl: ['RED',    'ORANGE', 'RED']    },
    { a1: 90,  a2: 105, ph: 'Before the buy value',  tl: ['ORANGE', 'ORANGE', 'RED']    },
    { a1: 105, a2: 120, ph: 'Before the buy value',  tl: ['GREEN',  'ORANGE', 'RED']    },
    { a1: 120, a2: 135, ph: 'Before the buy value',  tl: ['GREEN',  'GREEN',  'RED']    },
    { a1: 135, a2: 225, ph: 'Buy value',             tl: ['GREEN',  'GREEN',  'ORANGE'] },
    { a1: 225, a2: 300, ph: 'Momentum',              tl: ['GREEN',  'GREEN',  'GREEN']  }
  ];
  function lightsAtHour(hour) {
    var deg = ((((Number(hour) * 30) % 360) + 360) % 360);
    for (var i = 0; i < TL_CLOCK_STEPS.length; i++) { var s = TL_CLOCK_STEPS[i]; if (deg >= s.a1 && deg < s.a2) return s; }
    return null;
  }
  var YEARS_PER_HOUR = 1.5;   // an 18-year lap of a 12-hour dial

  /* ── The Runway v Demand chart ─────────────────────────────────────────── */
  var QUADRANTS = {
    runwayLine: 60, demandLine: 30,
    xDomain: [-15, 135], yDomain: [-25, 82],
    fills: { yellow: 'rgba(255,213,79,.18)', blue: 'rgba(100,181,246,.2)', pink: 'rgba(237,90,117,.18)', green: 'rgba(129,199,132,.2)' },
    names: { green: 'Value, demand not yet there', blue: 'Value and demand', yellow: 'Demand, runway being used up', pink: 'Neither value nor demand' }
  };
  function quadrantOf(runwayPct, ds) {   // runwayPct in percent
    var right = runwayPct >= QUADRANTS.runwayLine, top = ds >= QUADRANTS.demandLine;
    return right ? (top ? 'blue' : 'green') : (top ? 'yellow' : 'pink');
  }
  var RENT_SCALE = [{ ds: 70, t: '10%+' }, { ds: 50, t: '5%+' }, { ds: 30, t: 'CPI+' }, { ds: 10, t: '0%' }, { ds: -8, t: '-5%' }];
  var MARKET_COLOURS = { smooth: '#0C186E', workforce: '#ED5A75' };

  root.AcademyMath = {
    E1: E1, BENCH: BENCH, _A: A, grade: grade, median: median, compute: compute, benchmark: benchmark, scoreOne: scoreOne,
    annuityFactor: annuityFactor, reRateRunway: reRateRunway, REC_RATE: REC_RATE, RUNWAY_CAP: RUNWAY_CAP, ENTRY_BAR: ENTRY_BAR,
    HOUR_BANDS: HOUR_BANDS, bandAtHour: bandAtHour, MPC_LABELS: MPC_LABELS, TL_CLOCK_STEPS: TL_CLOCK_STEPS, lightsAtHour: lightsAtHour, YEARS_PER_HOUR: YEARS_PER_HOUR,
    QUADRANTS: QUADRANTS, quadrantOf: quadrantOf, RENT_SCALE: RENT_SCALE, MARKET_COLOURS: MARKET_COLOURS
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
