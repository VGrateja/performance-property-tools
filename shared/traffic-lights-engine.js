/* ============================================================================
 * traffic-lights-engine.js — the Traffic Lights scoring model. Value and
 * Supply & Demand are still ported verbatim from Traffic Lights.xlsx (Scoring
 * Model sheet, 2026-08 revision); CONFIDENCE was realigned 2026-09-09 to the
 * DESIGN SPEC written by Shaene Salino, which the 2026-08 workbook did not
 * implement (see the CONF table below). PURE where it can be:
 * scoreRegion()/confInputsFrom()/dampedForecast() have no I/O.
 *
 * NOTE: scripts/verify-traffic-lights.mjs checks this file against the
 * workbook's cached Confidence cells and therefore now FAILS on the Confidence
 * rows by design — the workbook is the thing that is out of date, not this
 * engine. Its Value / S&D checks are still valid.
 *
 * 2026-08 model (replaces the 9-indicator version):
 *  · CONFIDENCE = 6 indicators — Job Ads, Business Finance, Housing Finance,
 *    Business Confidence, Unemployment, Underutilisation. Current
 *    verdict = simple average of 2/1/0 scores vs 1.5/0.7, then CAPPED at
 *    ORANGE if any indicator is red (the spec's any-RED veto, current side
 *    only). Forecast =
 *    per-indicator DAMPED-TREND projection (Gardner–McKenzie, phi=0.8, slope
 *    over the last 6 observations, clamped to the series' historical min/max),
 *    aggregated as Σ(score×weight)/Σweight with weights [1,1.5,2,1,1,0.5].
 *  · VALUE = continuous normalised scores: rank-gap and runway each mapped to
 *    0..1 between their red/green thresholds; verdict =
 *    (4·avg(rankNorms) + avg(runwayNorms))/2.5 vs 1.4/0.7.
 *  · SUPPLY & DEMAND = Demand Score H/U, BOTH thresholds green ≥30 / red ≤5;
 *    verdict = 2·avg(norms) vs 1.4/0.7 (headline is the average of segments,
 *    no longer worse-of).
 *
 * scoreRegion(inp) -> { sd, sd_fcst, value, value_fcst, confidence, conf_fcst,
 *                       conf_score, conf_fcst_score, indicators[], value_inds[], sd_inds[] }
 * Loaded as a classic script (window.PP_TL_ENGINE) AND require()-able in Node.
 * ========================================================================== */
(function (root) {
  'use strict';

  var PHI = 0.8;           // damping factor (workbook B23)
  // Shaene's spec: "Confidence is capped at ORANGE if any indicator is red
  // (current side only)". Turning this back ON restores the 2026-07 behaviour
  // on the designer's instruction — the 2026-08 workbook had set B21="NO".
  // "Capped" is applied as a CAP, not a clamp: a red pulls GREEN down to
  // ORANGE but never lifts a sub-0.7 score UP to ORANGE (see confidence below).
  var ANY_RED_VETO = true;

  var verdict = function (score, g, o) { return score >= g ? 'GREEN' : score >= o ? 'ORANGE' : 'RED'; };
  var sigOf = function (s) { return s === 2 ? 'GREEN' : s === 1 ? 'ORANGE' : 'RED'; };   // 2/1/0 -> signal
  var clamp01 = function (x) { return x < 0 ? 0 : x > 1 ? 1 : x; };
  // MEDIAN(0, (v-red)/(green-red), 1) — the workbook's normalisation. null → 0.5
  // (neutral; the workbook's sample sheets are always populated, we must not crash).
  var normTo = function (v, red, green) { return (v == null || isNaN(v)) ? 0.5 : clamp01((v - red) / (green - red)); };

  // Confidence indicators — Shaene Salino's design spec (realigned 2026-09-09).
  //   basis 'chg'  : current = YoY change vs ±thresholds; forecast = damped level → (V/C−1)
  //   basis 'lvl'  : level vs thresholds, HIGHER is better (no indicator uses this
  //                  today; kept as the generic non-inverted level path)
  //   basis 'lvli' : level vs thresholds, LOWER is better — green ≤ g, red ≥ r
  //   kc = current weight (all 1 → simple average), kf = forecast weight, h = damping
  //   horizon in native periods (jobads 12 months, quarterly finance 4, annual
  //   levels 1; business confidence resolves at shape time from its data cadence).
  //
  // What changed from the 2026-08 workbook port, and why:
  //  · Consumer Confidence REMOVED — not in the spec, and it is a NATIONAL
  //    series, so every market got the identical value (0G·36O·0R live): it
  //    could not discriminate between markets by construction.
  //  · Unemployment ADDED (market-level, state fallback), inverted level.
  //  · Underutilisation lost its trend gate — the spec scores it on LEVEL
  //    alone. The old gate (green also required dC ≤ 0; red fired on a
  //    >0.3pp rise) is what produced 17 reds off an 8-value state series.
  //  · Business Confidence DIRECTION REVERSED — see the warning below.
  //
  // ⚠ BUSINESS CONFIDENCE IS AWAITING SHAENE'S EXPLICIT CONFIRMATION.
  //   The spec reads it CONTRARIAN: green ≤ −10, red ≥ 0 — buy into a market
  //   when businesses are gloomy. The workbook read it CONVENTIONALLY: green
  //   ≥ 0, red ≤ −5. Both are defensible; they are opposite. This file now
  //   implements the SPEC, and that single line flips 34 of 36 markets from
  //   RED to GREEN. Do not ship to production before she confirms the sign.
  var CONF = [
    { key: 'jobads',   name: 'Job Ads',             basis: 'chg',  g: 0.03,  r: -0.03, kc: 1, kf: 1,   h: 12 },
    { key: 'bizfin',   name: 'Business Finance',    basis: 'chg',  g: 0.03,  r: -0.03, kc: 1, kf: 1.5, h: 4 },
    { key: 'housfin',  name: 'Housing Finance',     basis: 'chg',  g: 0.03,  r: -0.03, kc: 1, kf: 2,   h: 4 },
    { key: 'bizconf',  name: 'Business Confidence', basis: 'lvli', g: -10,   r: 0,     kc: 1, kf: 1,   h: 12 },
    // Unemployment / Underutilisation are stored as FRACTIONS in rdp_raw_series
    // (0.052 = 5.2%), never as percentage points — thresholds must match.
    // NOTE: the spec's own expected spread for Unemployment (15G·15O·6R) is
    // reproduced EXACTLY by 0.042 / 0.052, and not by the 0.04 / 0.055 written
    // beside it (which gives 12G·22O·2R). Implementing the stated thresholds;
    // flagged for Shaene — if she confirms 4.2/5.2 it is this line only.
    { key: 'unemp',    name: 'Unemployment',        basis: 'lvli', g: 0.04,  r: 0.055, kc: 1, kf: 1,   h: 1 },
    { key: 'underemp', name: 'Underutilisation',    basis: 'lvli', g: 0.06,  r: 0.075, kc: 1, kf: 0.5, h: 1 }
  ];

  function scoreConf(spec, inp) {
    if (spec.basis === 'lvl' || spec.basis === 'lvli') {
      var L = inp[spec.key + '_level'];
      if (L == null || isNaN(L)) return 1;
      return spec.basis === 'lvli'
        ? (L <= spec.g ? 2 : L >= spec.r ? 0 : 1)   // inverted: LOWER is better
        : (L >= spec.g ? 2 : L <= spec.r ? 0 : 1);
    }
    var E = inp[spec.key];                 // the YoY change for this indicator
    if (E == null || isNaN(E)) return 1;
    return E >= spec.g ? 2 : E <= spec.r ? 0 : 1;
  }

  // Forecast signal (workbook col W): the indicator's own damped-trend projection
  // scored against the SAME thresholds. Missing projection (the IFERROR case)
  // defaults to ORANGE/1.
  function scoreConfFcst(spec, inp) {
    if (spec.basis === 'lvl' || spec.basis === 'lvli') {
      var L = inp['fc_' + spec.key + '_level'];
      if (L == null || isNaN(L)) return 1;
      return spec.basis === 'lvli'
        ? (L <= spec.g ? 2 : L >= spec.r ? 0 : 1)   // inverted: LOWER is better
        : (L >= spec.g ? 2 : L <= spec.r ? 0 : 1);
    }
    var E = inp['fc_' + spec.key];         // projected change (V/C − 1)
    if (E == null || isNaN(E)) return 1;
    return E >= spec.g ? 2 : E <= spec.r ? 0 : 1;
  }

  // FORECAST(x, ys, xs) — linear-regression extrapolation to targetX. ys at x=1..n.
  function linForecast(ys, targetX) {
    var xs = [], vy = [];
    for (var i = 0; i < ys.length; i++) if (ys[i] != null && !isNaN(ys[i])) { xs.push(i + 1); vy.push(+ys[i]); }
    var n = xs.length;
    if (n === 0) return null;
    if (n === 1) return vy[0];
    var mx = 0, my = 0, j;
    for (j = 0; j < n; j++) { mx += xs[j]; my += vy[j]; } mx /= n; my /= n;
    var num = 0, den = 0;
    for (j = 0; j < n; j++) { num += (xs[j] - mx) * (vy[j] - my); den += (xs[j] - mx) * (xs[j] - mx); }
    if (den === 0) return my;
    var b = num / den, a = my - b * mx;
    return a + b * (targetX == null ? n + 1 : targetX);
  }

  // Damped-trend forecast (workbook col V): slope over the LAST SIX observations,
  // each step ahead contributes phi^k of that slope (Σ = phi(1−phi^h)/(1−phi)),
  // clamped to the series' historical min/max — MEDIAN(min, C+slope·mult, max).
  // Fewer than 6 points → null (the workbook's SLOPE would error → IFERROR).
  function dampedForecast(series, h, phi) {
    var a = [];
    for (var i = 0; i < series.length; i++) if (series[i] != null && !isNaN(series[i])) a.push(+series[i]);
    if (a.length < 6) return null;
    var w = a.slice(-6);
    var mx = 0, my = 0, k;
    for (k = 0; k < 6; k++) { mx += k + 1; my += w[k]; } mx /= 6; my /= 6;
    var num = 0, den = 0;
    for (k = 0; k < 6; k++) { num += (k + 1 - mx) * (w[k] - my); den += (k + 1 - mx) * (k + 1 - mx); }
    var slope = den ? num / den : 0;
    var p = phi == null ? PHI : phi, mult = 0;
    for (k = 1; k <= h; k++) mult += Math.pow(p, k);
    var f = a[a.length - 1] + slope * mult;
    var lo = Math.min.apply(null, a), hi = Math.max.apply(null, a);
    return Math.min(hi, Math.max(lo, f));
  }

  function scoreRegion(inp) {
    // ── Confidence (6 indicators) ──
    /* `inverted` = a RISE in this reading is bad news (unemployment, underutilisation,
       and business confidence under the contrarian reading the design specifies).
       The tools colour a change arrow green-for-up by default, which is backwards
       on these three; the flag lets the display flip it rather than guessing by name. */
    var indicators = [], lc = 0, kcSum = 0, lf = 0, kfSum = 0, anyRedCur = false;
    for (var i = 0; i < CONF.length; i++) {
      var s = scoreConf(CONF[i], inp);            // current score (2/1/0)
      var fs = scoreConfFcst(CONF[i], inp);       // forecast score from the damped projection
      if (s === 0) anyRedCur = true;
      lc += s * CONF[i].kc; kcSum += CONF[i].kc;
      lf += fs * CONF[i].kf; kfSum += CONF[i].kf;
      indicators.push({ key: CONF[i].key, name: CONF[i].name, score: s, signal: sigOf(s), fscore: fs, fsignal: sigOf(fs) });
    }
    var confScore = lc / kcSum;                   // current weights are all 1 → simple average
    var confFcstScore = lf / kfSum;               // Σ(score×fcstWeight)/Σweights (Σ = 7)
    // The spec caps Confidence at ORANGE when any indicator is red, CURRENT
    // SIDE ONLY — so the forecast verdict is deliberately left un-vetoed.
    // Applied as a cap (GREEN → ORANGE) rather than an assignment, so a
    // genuinely bad score can still read RED instead of being lifted to ORANGE.
    var capOrange = function (v) { return v === 'GREEN' ? 'ORANGE' : v; };
    var confidence = verdict(confScore, 1.5, 0.7);
    if (ANY_RED_VETO && anyRedCur) confidence = capOrange(confidence);
    var confFcst = verdict(confFcstScore, 1.5, 0.7);

    // ── Value: continuous norms — (4·avg(rank norms) + avg(runway norms)) / 2.5 ──
    var rankScore = function (gap) { return gap == null ? 1 : gap >= 3 ? 2 : gap <= -3 ? 0 : 1; };
    var rankFcstSig = function (proj, avg) { if (proj == null || avg == null) return 'ORANGE'; var d = proj - avg; return d >= 3 ? 'GREEN' : d <= -3 ? 'RED' : 'ORANGE'; };
    var rwScore = function (v, g, r) { return v == null ? 1 : v >= g ? 2 : v <= r ? 0 : 1; };
    var rwFcstSig = function (v, g, r) { return v == null ? 'ORANGE' : v >= g ? 'GREEN' : v <= r ? 'RED' : 'ORANGE'; };

    var rhGap = (inp.rank_h != null && inp.rank_h_avg != null) ? inp.rank_h - inp.rank_h_avg : null;
    var ruGap = (inp.rank_u != null && inp.rank_u_avg != null) ? inp.rank_u - inp.rank_u_avg : null;
    var rhGapF = (inp.rank_h_fcst != null && inp.rank_h_avg != null) ? inp.rank_h_fcst - inp.rank_h_avg : null;
    var ruGapF = (inp.rank_u_fcst != null && inp.rank_u_avg != null) ? inp.rank_u_fcst - inp.rank_u_avg : null;
    var rankNormCur = (normTo(rhGap, -3, 3) + normTo(ruGap, -3, 3)) / 2;
    var rwNormCur = (normTo(inp.runway_h, 0.15, 0.40) + normTo(inp.runway_u, 0.30, 0.60)) / 2;
    var valueCurScore = (4 * rankNormCur + rwNormCur) / 2.5;
    var rankNormF = (normTo(rhGapF, -3, 3) + normTo(ruGapF, -3, 3)) / 2;
    var rwNormF = (normTo(inp.runway_h_fcst, 0.15, 0.40) + normTo(inp.runway_u_fcst, 0.30, 0.60)) / 2;
    var valueFcstScore = (4 * rankNormF + rwNormF) / 2.5;

    var value = verdict(valueCurScore, 1.4, 0.7), value_fcst = verdict(valueFcstScore, 1.4, 0.7);
    var rhFsig = rankFcstSig(inp.rank_h_fcst, inp.rank_h_avg), ruFsig = rankFcstSig(inp.rank_u_fcst, inp.rank_u_avg);
    var rwhFsig = rwFcstSig(inp.runway_h_fcst, 0.40, 0.15), rwuFsig = rwFcstSig(inp.runway_u_fcst, 0.60, 0.30);
    var value_inds = [
      { name: 'Ranking House', gap: rhGap, signal: sigOf(rankScore(rhGap)), fcst: rhFsig, rank: inp.rank_h, avg: inp.rank_h_avg, proj: inp.rank_h_fcst },
      { name: 'Ranking Unit',  gap: ruGap, signal: sigOf(rankScore(ruGap)), fcst: ruFsig, rank: inp.rank_u, avg: inp.rank_u_avg, proj: inp.rank_u_fcst },
      { name: 'Runway House',  signal: sigOf(rwScore(inp.runway_h, 0.40, 0.15)), fcst: rwhFsig, val: inp.runway_h, proj: inp.runway_h_fcst },
      { name: 'Runway Unit',   signal: sigOf(rwScore(inp.runway_u, 0.60, 0.30)), fcst: rwuFsig, val: inp.runway_u, proj: inp.runway_u_fcst }
    ];

    // ── Supply & Demand: DS H/U, both green ≥30 / red ≤5; headline = 2·avg(norms) ──
    var dsScore = function (v) { return v == null ? 1 : v >= 30 ? 2 : v <= 5 ? 0 : 1; };
    var dsFcstSig = function (v) { return v == null ? 'ORANGE' : v >= 30 ? 'GREEN' : v <= 5 ? 'RED' : 'ORANGE'; };
    var sdCurScore = 2 * ((normTo(inp.ds_h, 5, 30) + normTo(inp.ds_u, 5, 30)) / 2);
    var sdFcstScore = 2 * ((normTo(inp.ds_h_fcst, 5, 30) + normTo(inp.ds_u_fcst, 5, 30)) / 2);
    var sd = verdict(sdCurScore, 1.4, 0.7), sd_fcst = verdict(sdFcstScore, 1.4, 0.7);
    var sd_inds = [
      { name: 'Demand Score - House', signal: sigOf(dsScore(inp.ds_h)), fcst: dsFcstSig(inp.ds_h_fcst), val: inp.ds_h, proj: inp.ds_h_fcst },
      { name: 'Demand Score - Unit',  signal: sigOf(dsScore(inp.ds_u)), fcst: dsFcstSig(inp.ds_u_fcst), val: inp.ds_u, proj: inp.ds_u_fcst }
    ];

    return {
      sd: sd, sd_fcst: sd_fcst, value: value, value_fcst: value_fcst,
      confidence: confidence, conf_fcst: confFcst,
      conf_score: Math.round(confScore * 100) / 100, conf_fcst_score: Math.round(confFcstScore * 100) / 100,
      value_score: Math.round(valueCurScore * 100) / 100, value_fcst_score: Math.round(valueFcstScore * 100) / 100,
      sd_score: Math.round(sdCurScore * 100) / 100, sd_fcst_score: Math.round(sdFcstScore * 100) / 100,
      indicators: indicators, value_inds: value_inds, sd_inds: sd_inds
    };
  }

  // ── shared shaping: raw series bundle → the confidence fields of `inp` ──────
  // Used by BOTH the live assembly (Forge) and the verification harness (the
  // workbook's own columns), so the shaping math is tested against the sheet.
  // bundle = { jobads[], bizfinQ[], housfinQ[], bizconf[],
  //            bizconfFreq ('M'|'Q'), unemp[], underemp[] }  — plain numeric
  // arrays in period order (nulls allowed). Missing arrays are tolerated:
  // a null level scores ORANGE/1, which is the workbook's IFERROR behaviour.
  // (cciAnnual[] was dropped 2026-09-09 with the Consumer Confidence indicator.)
  var lastN = function (a) { for (var i = a.length - 1; i >= 0; i--) if (a[i] != null && !isNaN(a[i])) return +a[i]; return null; };
  var priorN = function (a) { var seen = 0; for (var i = a.length - 1; i >= 0; i--) if (a[i] != null && !isNaN(a[i])) { seen++; if (seen === 2) return +a[i]; } return null; };
  // value k rows before the last populated one — the workbook's INDEX(col, MATCH(last)-k).
  var backN = function (a, k) { for (var i = a.length - 1; i >= 0; i--) if (a[i] != null && !isNaN(a[i])) { var j = i - k; return (j >= 0 && a[j] != null && !isNaN(a[j])) ? +a[j] : null; } return null; };
  var chgVs = function (l, p) { return (l == null || p == null || p === 0) ? null : l / p - 1; };
  var fcChg = function (series, h) { var v = dampedForecast(series, h), l = lastN(series); return (v == null || l == null || l === 0) ? null : v / l - 1; };
  var mean = function (a) { var s = 0, n = 0; for (var i = 0; i < a.length; i++) if (a[i] != null && !isNaN(a[i])) { s += +a[i]; n++; } return n ? s / n : null; };

  function confInputsFrom(b) {
    var bizconfBack = (b.bizconfFreq === 'Q') ? 4 : 12;   // workbook AJ1 flag
    var A = function (a) { return a || []; };             // tolerate a missing series
    var ueL = lastN(A(b.underemp)), ueP = priorN(A(b.underemp));
    var unL = lastN(A(b.unemp)), unP = priorN(A(b.unemp));
    return {
      jobads: chgVs(lastN(A(b.jobads)), backN(A(b.jobads), 12)),
      bizfin: chgVs(lastN(A(b.bizfinQ)), backN(A(b.bizfinQ), 4)),
      housfin: chgVs(lastN(A(b.housfinQ)), backN(A(b.housfinQ), 4)),
      bizconf_level: lastN(A(b.bizconf)),
      // levels are FRACTIONS (0.052 = 5.2%); *_change is display-only (pp)
      unemp_level: unL,
      unemp_change: (unL != null && unP != null) ? unL - unP : null,
      underemp_level: ueL,
      underemp_change: (ueL != null && ueP != null) ? ueL - ueP : null,
      fc_jobads: fcChg(A(b.jobads), 12),
      fc_bizfin: fcChg(A(b.bizfinQ), 4),
      fc_housfin: fcChg(A(b.housfinQ), 4),
      fc_bizconf_level: dampedForecast(A(b.bizconf), bizconfBack),
      fc_unemp_level: dampedForecast(A(b.unemp), 1),
      fc_underemp_level: dampedForecast(A(b.underemp), 1)
    };
  }

  // ── data assembly (browser; caller passes window.sb) ───────────────────────
  var CAPS = [
    { slug: 'sydney', state: 'st-nsw', name: 'Sydney' },
    { slug: 'melbourne', state: 'st-vic', name: 'Melbourne' },
    { slug: 'brisbane', state: 'st-qld', name: 'Brisbane' },
    { slug: 'perth', state: 'st-wa', name: 'Perth' },
    { slug: 'adelaide', state: 'st-sa', name: 'Adelaide' },
    { slug: 'canberra', state: 'st-act', name: 'Canberra' },
    { slug: 'darwin', state: 'st-nt', name: 'Darwin' },
    { slug: 'hobart', state: 'st-tas', name: 'Hobart' }
  ];
  var STATE_CAP = { NSW: 'sydney', VIC: 'melbourne', QLD: 'brisbane', WA: 'perth', SA: 'adelaide', ACT: 'canberra', NT: 'darwin', TAS: 'hobart' };

  var cleanNums = function (a) { var o = []; for (var i = 0; i < a.length; i++) if (a[i] != null && !isNaN(a[i])) o.push(+a[i]); return o; };
  // FORECAST over the last `win` observations to `ahead` past their end (S&D/runway/ranking projections)
  var projLast = function (a, win, ahead) { var w = cleanNums(a).slice(-win); return w.length ? linForecast(w, w.length + ahead) : null; };

  async function fetchAll(sb) {
    var rg = await sb.from('rdp_regions').select('slug,name,state');
    var regInfo = {}; (rg.data || []).forEach(function (r) { regInfo[r.slug] = { name: r.name, state: r.state }; });
    var sn = await sb.from('forge_demand_snapshots').select('version,data').order('version');
    var snaps = (sn.data || []).filter(function (s) { return /^\d{4}-\d{2}$/.test(s.version); });
    var latest = snaps.length ? snaps[snaps.length - 1] : null;
    var snapSlugs = latest ? Object.keys((latest.data && latest.data.houses) || {}) : [];
    var capSet = {}; for (var sk in STATE_CAP) capSet[STATE_CAP[sk]] = 1;
    var markets = [];
    for (var si = 0; si < snapSlugs.length; si++) {
      var mslug = snapSlugs[si], info = regInfo[mslug], sc = info && info.state, capSlug = sc && STATE_CAP[sc];
      if (!sc || !capSlug) continue;
      markets.push({ slug: mslug, name: (info && info.name) || mslug, state: 'st-' + sc.toLowerCase(), capitalSlug: capSlug });
    }
    markets.sort(function (a, b) { var ca = capSet[a.slug] ? 0 : 1, cb = capSet[b.slug] ? 0 : 1; return ca !== cb ? ca - cb : a.name.localeCompare(b.name); });

    var METRICS = ['ranking_h', 'ranking_u', 'job_creation_index',
      'owner_occupier', 'investor',
      'bus_fin_sm_construction', 'bus_fin_sm_property', 'bus_fin_med_construction', 'bus_fin_med_property',
      'business_confidence', 'unemployment', 'underemployment'];
    // 'consumer_confidence' dropped 2026-09-09 with the CCI indicator — nothing
    // else in this engine reads it. The Forge / B-S Slides / Data Extractor
    // pages that chart CCI issue their own queries and are unaffected.
    var regSet = { australia: 1 };
    for (var mi = 0; mi < markets.length; mi++) { regSet[markets[mi].slug] = 1; regSet[markets[mi].state] = 1; }
    var REGIONS = Object.keys(regSet);
    var rows = [];
    for (var pg = 0; pg < 80; pg++) {
      // .order('period') ALONE IS NOT A TOTAL ORDER — thousands of rows share a
      // period, and range() paging over a non-unique sort silently returns some
      // rows twice and never returns others. Measured 2026-09-09 against this
      // project: 51 of 15,593 rows lost on the old metric list, 98 of 16,475 on
      // the new one, which is what made a market's Value verdict depend on
      // which metrics happened to be in METRICS. (metric, region_slug, period)
      // is unique across this result set, so these tie-breaks make it total.
      var q = await sb.from('rdp_raw_series').select('metric,region_slug,period,value').in('metric', METRICS).in('region_slug', REGIONS).order('period').order('metric').order('region_slug').range(pg * 1000, pg * 1000 + 999);
      if (q.error) throw q.error;
      rows = rows.concat(q.data || []);
      if (!q.data || q.data.length < 1000) break;
    }
    var series = {};   // metric|region -> [{p:'YYYY-MM', v}] in period order
    for (var r = 0; r < rows.length; r++) {
      var k = rows[r].metric + '|' + rows[r].region_slug;
      (series[k] || (series[k] = [])).push({ p: String(rows[r].period).slice(0, 7), v: +rows[r].value });
    }
    return { series: series, snaps: snaps, markets: markets };
  }

  var valsOf = function (recs) { return (recs || []).map(function (r) { return r.v; }); };
  // sum several {p,v} series period-by-period (business finance: small+medium × construction+property)
  function sumByPeriod(lists) {
    var by = {};
    for (var i = 0; i < lists.length; i++) for (var j = 0; j < (lists[i] || []).length; j++) {
      var r = lists[i][j]; by[r.p] = (by[r.p] || 0) + r.v;
    }
    return Object.keys(by).sort().map(function (p) { return by[p]; });
  }
  // monthly {p,v} → calendar-quarter SUMS, complete quarters only (housing finance)
  function quarterSums(recs) {
    var by = {}, cnt = {};
    for (var i = 0; i < (recs || []).length; i++) {
      var y = recs[i].p.slice(0, 4), m = +recs[i].p.slice(5, 7), qk = y + '-Q' + Math.ceil(m / 3);
      by[qk] = (by[qk] || 0) + recs[i].v; cnt[qk] = (cnt[qk] || 0) + 1;
    }
    return Object.keys(by).sort().filter(function (k) { return cnt[k] === 3; }).map(function (k) { return by[k]; });
  }
  function buildRegion(cap, ctx) {
    var R = function (metric, region) { return ctx.series[metric + '|' + region] || []; };
    var S = function (metric, region) { return valsOf(R(metric, region)); };
    // snapshot ds/rw monthly series (house & unit)
    var dsH = [], dsU = [], rwH = [], rwU = [];
    for (var i = 0; i < ctx.snaps.length; i++) {
      var h = (ctx.snaps[i].data.houses || {})[cap.slug], u = (ctx.snaps[i].data.units || {})[cap.slug];
      if (h) { dsH.push(h.ds); rwH.push(h.rw); } if (u) { dsU.push(u.ds); rwU.push(u.rw); }
    }
    var rkH = S('ranking_h', cap.slug), rkU = S('ranking_u', cap.slug);

    // confidence bundle — state-level for finance/underemployment, market-level
    // job ads and unemployment, state NAB confidence with a national fallback
    // (NAB doesn't publish ACT/NT — the workbook's sample sheets do the same).
    var bizconfRecs = R('business_confidence', cap.state);
    if (!bizconfRecs.length) bizconfRecs = R('business_confidence', 'australia');
    // Unemployment is published per MARKET (35 of the 36 — Canberra has no
    // market series), which is what makes it discriminate; fall back to the
    // state series, then national, exactly like business confidence above.
    var unempRecs = R('unemployment', cap.slug);
    if (!unempRecs.length) unempRecs = R('unemployment', cap.state);
    if (!unempRecs.length) unempRecs = R('unemployment', 'australia');
    var housfinMonthly = [];
    var oo = R('owner_occupier', cap.state), inv = R('investor', cap.state);
    var invBy = {}; inv.forEach(function (r) { invBy[r.p] = r.v; });
    oo.forEach(function (r) { if (invBy[r.p] != null) housfinMonthly.push({ p: r.p, v: r.v + invBy[r.p] }); });
    var bundle = {
      jobads: S('job_creation_index', cap.slug),
      bizfinQ: sumByPeriod([R('bus_fin_sm_construction', cap.state), R('bus_fin_sm_property', cap.state), R('bus_fin_med_construction', cap.state), R('bus_fin_med_property', cap.state)]),
      housfinQ: quarterSums(housfinMonthly),
      bizconf: valsOf(bizconfRecs),
      bizconfFreq: 'M',
      unemp: valsOf(unempRecs),
      underemp: S('underemployment', cap.state)
    };
    var conf = confInputsFrom(bundle);

    var inp = {
      ds_h: lastN(dsH), ds_u: lastN(dsU),
      // FORECAST(9, last-6 monthly, 1..6) — three months ahead (workbook G35/G36)
      ds_h_fcst: dsH.length ? Math.round(projLast(dsH, 6, 3)) : null,
      ds_u_fcst: dsU.length ? Math.round(projLast(dsU, 6, 3)) : null,
      rank_h: lastN(rkH), rank_h_avg: mean(rkH), rank_h_fcst: rkH.length ? Math.round(linForecast(cleanNums(rkH).slice(-5), 6) * 10) / 10 : null,
      rank_u: lastN(rkU), rank_u_avg: mean(rkU), rank_u_fcst: rkU.length ? Math.round(linForecast(cleanNums(rkU).slice(-5), 6) * 10) / 10 : null,
      runway_h: lastN(rwH), runway_u: lastN(rwU),
      // FORECAST(9, last-6 monthly, 1..6), rounded like the workbook (K29/K30)
      runway_h_fcst: rwH.length ? Math.round(projLast(rwH, 6, 3) * 1000) / 1000 : null,
      runway_u_fcst: rwU.length ? Math.round(projLast(rwU, 6, 3) * 1000) / 1000 : null
    };
    for (var kf in conf) inp[kf] = conf[kf];
    var out = scoreRegion(inp);
    return formatForTool(cap, inp, out, {
      jobads: lastN(bundle.jobads), bizfin: lastN(bundle.bizfinQ), housfin: lastN(bundle.housfinQ),
      bizconf: lastN(bundle.bizconf), bizconfPrior: backN(bundle.bizconf, 12)
    });
  }

  // display formatting → the DATA shape traffic-lights.html renders
  var pctS = function (v, dp) { return (v == null || isNaN(v)) ? '--' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp == null ? 1 : dp) + '%'; };
  var ppS = function (v) { return (v == null || isNaN(v)) ? '--' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + 'pp'; };
  var lvlS = function (v) { return (v == null || isNaN(v)) ? '--' : (v * 100).toFixed(2) + '%'; };
  var intS = function (v) { return (v == null || isNaN(v)) ? '--' : Math.round(v).toLocaleString(); };
  var oneS = function (v) { return (v == null || isNaN(v)) ? '--' : (+v).toFixed(1); };
  var d1S = function (v) { return (v == null || isNaN(v)) ? '--' : (v >= 0 ? '+' : '') + (+v).toFixed(1); };
  var trendW = function (a, b) { return (a == null || b == null) ? 'steady' : b > a + 0.5 ? 'rising' : b < a - 0.5 ? 'falling' : 'steady'; };

  function formatForTool(cap, inp, out, raw) {
    var byKey = {}, byF = {}; out.indicators.forEach(function (o) { byKey[o.key] = o.signal; byF[o.key] = o.fsignal; });
    var indicators = [
      { name: 'Job Ads', latest: intS(raw.jobads), change: pctS(inp.jobads), signal: byKey.jobads, fsignal: byF.jobads },
      { name: 'Business Finance ($m)', latest: intS(raw.bizfin), change: pctS(inp.bizfin), signal: byKey.bizfin, fsignal: byF.bizfin },
      { name: 'Housing Finance ($m)', latest: intS(raw.housfin), change: pctS(inp.housfin), signal: byKey.housfin, fsignal: byF.housfin },
      { inverted: true, name: 'Business Confidence', latest: oneS(inp.bizconf_level), change: d1S(raw.bizconf != null && raw.bizconfPrior != null ? raw.bizconf - raw.bizconfPrior : null), signal: byKey.bizconf, fsignal: byF.bizconf },
      { inverted: true, name: 'Unemployment', latest: lvlS(inp.unemp_level), change: ppS(inp.unemp_change), signal: byKey.unemp, fsignal: byF.unemp },
      { inverted: true, name: 'Underutilisation', latest: lvlS(inp.underemp_level), change: ppS(inp.underemp_change), signal: byKey.underemp, fsignal: byF.underemp }
    ];
    var gapS = function (v) { return (v == null || isNaN(v)) ? '--' : (v >= 0 ? '+' : '') + (+v).toFixed(1); };
    var vi = out.value_inds;
    var value_inds = [
      { name: 'Ranking House', meta: 'Rank ' + (inp.rank_h == null ? '—' : inp.rank_h) + ' vs avg ' + oneS(inp.rank_h_avg), sub: 'Projected rank: ' + oneS(inp.rank_h_fcst), right: gapS(vi[0].gap), signal: vi[0].signal },
      { name: 'Ranking Unit', meta: 'Rank ' + (inp.rank_u == null ? '—' : inp.rank_u) + ' vs avg ' + oneS(inp.rank_u_avg), sub: 'Projected rank: ' + oneS(inp.rank_u_fcst), right: gapS(vi[1].gap), signal: vi[1].signal },
      { name: 'Runway House', meta: 'Affordability runway', sub: 'Projected: ' + (inp.runway_h_fcst == null ? '—' : Math.round(inp.runway_h_fcst * 100) + '%'), right: (inp.runway_h == null ? '--' : (inp.runway_h * 100).toFixed(1) + '%'), signal: vi[2].signal },
      { name: 'Runway Unit', meta: 'Affordability runway', sub: 'Projected: ' + (inp.runway_u_fcst == null ? '—' : Math.round(inp.runway_u_fcst * 100) + '%'), right: (inp.runway_u == null ? '--' : (inp.runway_u * 100).toFixed(1) + '%'), signal: vi[3].signal }
    ];
    var sd_inds = [
      { name: 'Demand Score - House', meta: 'Demand score', sub: 'Projected: ' + (inp.ds_h_fcst == null ? '—' : inp.ds_h_fcst), right: (inp.ds_h == null ? '--' : String(Math.round(inp.ds_h))), signal: out.sd_inds[0].signal },
      { name: 'Demand Score - Unit', meta: 'Demand score', sub: 'Projected: ' + (inp.ds_u_fcst == null ? '—' : inp.ds_u_fcst), right: (inp.ds_u == null ? '--' : String(Math.round(inp.ds_u))), signal: out.sd_inds[1].signal }
    ];
    return {
      sd: out.sd, sd_fcst: out.sd_fcst, value: out.value, value_fcst: out.value_fcst,
      confidence: out.confidence, conf_fcst: out.conf_fcst, conf_score: out.conf_score, conf_fcst_score: out.conf_fcst_score,
      indicators: indicators, value_inds: value_inds, sd_inds: sd_inds,
      sd_fcst_expl: 'Projecting the demand-score trend of the last six months forward, house demand is ' + trendW(inp.ds_h, inp.ds_h_fcst) + ' (' + (inp.ds_h == null ? '—' : Math.round(inp.ds_h)) + '→' + (inp.ds_h_fcst == null ? '—' : inp.ds_h_fcst) + ') and unit demand is ' + trendW(inp.ds_u, inp.ds_u_fcst) + ' (' + (inp.ds_u == null ? '—' : Math.round(inp.ds_u)) + '→' + (inp.ds_u_fcst == null ? '—' : inp.ds_u_fcst) + '). The headline averages both segments, giving a forecast Supply & Demand signal of ' + out.sd_fcst + '.',
      value_fcst_expl: 'Projecting the ranking trend and runway forward (ranking carries four times the runway weight in the averaged score), the forecast Value signal is ' + out.value_fcst + '.',
      conf_fcst_expl: 'Each indicator projects its own damped trend (slope of its last six observations, damped at 0.8 per period and held inside its historical range). Weighted toward the forward-looking finance flows, ' + cap.name + '’s forecast score is ' + out.conf_fcst_score + ' versus the current ' + out.conf_score + ', giving a forecast Confidence signal of ' + out.conf_fcst + '.'
    };
  }

  async function assembleTrafficLights(sb) {
    var ctx = await fetchAll(sb);
    var DATA = {};
    var mk = ctx.markets || [];
    for (var i = 0; i < mk.length; i++) { try { DATA[mk[i].name] = buildRegion(mk[i], ctx); } catch (e) { /* skip a region that fails */ } }
    return DATA;
  }

  var api = { scoreRegion: scoreRegion, confInputsFrom: confInputsFrom, dampedForecast: dampedForecast,
    linForecast: linForecast, CONF: CONF, CAPS: CAPS, PHI: PHI, assembleTrafficLights: assembleTrafficLights };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PP_TL_ENGINE = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null));
