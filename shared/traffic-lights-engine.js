/* ============================================================================
 * traffic-lights-engine.js — the Traffic Lights scoring model, ported verbatim
 * from Traffic Lights.xlsx (Scoring Model sheet). PURE: no I/O, no DOM, no sb.
 *
 * scoreRegion(inp) -> { sd, sd_fcst, value, value_fcst, confidence, conf_fcst,
 *                       conf_score, conf_fcst_score, indicators[], value_inds[], sd_inds[] }
 *
 * The caller assembles `inp` from Forge (YoY/MoM/level/gap already computed; use
 * linForecast() for the projected values). Thresholds/weights are the workbook's.
 * Loaded as a classic script (window.PP_TL_ENGINE) AND require()-able in Node.
 * ========================================================================== */
(function (root) {
  'use strict';

  var verdict = function (score, g, o) { return score >= g ? 'GREEN' : score >= o ? 'ORANGE' : 'RED'; };
  var sigOf = function (s) { return s === 2 ? 'GREEN' : s === 1 ? 'ORANGE' : 'RED'; };   // 2/1/0 -> signal

  // Confidence indicators, in workbook row order (10..18). cmp: how E/level maps to a 2/1/0 score.
  //   'le'  lower-is-better:  E<=g -> 2, E>=r -> 0, else 1      (som/adom/arrears)
  //   'ge'  higher-is-better: E>=g -> 2, E<=r -> 0, else 1      (retail/bizinv/jci/lending)
  //   'lvl' level lower-is-better: C<=g -> 2, C>=r -> 0, else 1 (real cash rate)
  //   'unemp' level+trend: (C<=g && dC<=0) -> 2, (C>=r || dC>0.005) -> 0, else 1
  // kc = current weight, kf = forecast weight. Score aggregate = mean(score*weight) over the 9.
  var CONF = [
    { key: 'som',     name: 'Stock on Market',         cmp: 'le',  g: -0.03, r: 0.03,  kc: 1,   kf: 2 },
    { key: 'adom',    name: 'Average Days on Market',  cmp: 'le',  g: -0.05, r: 0.05,  kc: 1,   kf: 2 },
    { key: 'retail',  name: 'Retail Turnover',         cmp: 'ge',  g: 0.03,  r: 0.0,   kc: 0.5, kf: 0.5 },
    { key: 'bizinv',  name: 'Business Investment',     cmp: 'ge',  g: 0.02,  r: -0.02, kc: 1,   kf: 1.5 },
    { key: 'unemp',   name: 'Unemployment',            cmp: 'unemp', g: 0.045, r: 0.06, kc: 1,  kf: 0.5 },
    { key: 'realcash',name: 'Cash Rate vs. Inflation', cmp: 'lvl', g: 0.0,   r: 0.015, kc: 1,   kf: 1 },
    { key: 'arrears', name: 'Mortgage Arrears',        cmp: 'le',  g: -0.05, r: 0.05,  kc: 0.5, kf: 0.5 },
    { key: 'jci',     name: 'Job Creation Index',      cmp: 'ge',  g: 0.03,  r: -0.03, kc: 1,   kf: 1.5 },
    { key: 'lending', name: 'Lending Flows (OO+INV)',  cmp: 'ge',  g: 0.03,  r: -0.03, kc: 1,   kf: 2 }
  ];

  function scoreConf(spec, inp) {
    if (spec.cmp === 'unemp') {
      var C = inp.unemp_level, dC = inp.unemp_change;
      if (C == null) return 1;
      if (C <= spec.g && dC != null && dC <= 0) return 2;
      if (C >= spec.r || (dC != null && dC > 0.005)) return 0;
      return 1;
    }
    if (spec.cmp === 'lvl') {
      var Cl = inp.real_cash_rate;
      if (Cl == null) return 1;
      return Cl <= spec.g ? 2 : Cl >= spec.r ? 0 : 1;
    }
    var E = inp[spec.key];                 // the change (YoY/MoM) value for this indicator
    if (E == null || isNaN(E)) return 1;
    return spec.cmp === 'le' ? (E <= spec.g ? 2 : E >= spec.r ? 0 : 1)
                             : (E >= spec.g ? 2 : E <= spec.r ? 0 : 1);
  }

  // FORECAST score for a confidence indicator — scores that indicator's OWN projected
  // value (inp.fc_<key> / fc_unemp_* / fc_real_cash_rate) against the SAME green/red
  // thresholds as the current signal. Mirrors scoreConf; a null projection (missing or
  // broken data — the IFERROR case) defaults to neutral (1) rather than crashing.
  function scoreConfFcst(spec, inp) {
    if (spec.cmp === 'unemp') {
      // forecast scores the PROJECTED level only (workbook W14), not the level+trend combo the current uses.
      var C = inp.fc_unemp_level;
      if (C == null) return 1;
      return C <= spec.g ? 2 : C >= spec.r ? 0 : 1;
    }
    if (spec.cmp === 'lvl') {
      var Cl = inp.fc_real_cash_rate;
      if (Cl == null) return 1;
      return Cl <= spec.g ? 2 : Cl >= spec.r ? 0 : 1;
    }
    var E = inp['fc_' + spec.key];
    if (E == null || isNaN(E)) return 1;
    return spec.cmp === 'le' ? (E <= spec.g ? 2 : E >= spec.r ? 0 : 1)
                             : (E >= spec.g ? 2 : E <= spec.r ? 0 : 1);
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

  function scoreRegion(inp) {
    // ── Confidence (9 indicators) ──
    var indicators = [], lc = 0, lf = 0, kfSum = 0, anyRed = false;
    for (var i = 0; i < CONF.length; i++) {
      var s = scoreConf(CONF[i], inp);            // current score (2/1/0)
      var fs = scoreConfFcst(CONF[i], inp);       // forecast score — each indicator's OWN projected trend
      if (s === 0) anyRed = true;
      lc += s * CONF[i].kc; lf += fs * CONF[i].kf; kfSum += CONF[i].kf;
      indicators.push({ key: CONF[i].key, name: CONF[i].name, score: s, signal: sigOf(s), fscore: fs, fsignal: sigOf(fs) });
    }
    var confScore = lc / CONF.length;             // current: weighted sum / 9 (unchanged)
    var confFcstScore = lf / kfSum;               // forecast: weighted AVERAGE over Σ(forecast weights)
    var confidence = (anyRed) ? 'ORANGE' : verdict(confScore, 1.5, 0.7);   // any-RED veto caps current at ORANGE
    var confFcst = verdict(confFcstScore, 1.5, 0.7);                        // forecast: single green line at 1.5, no veto

    // ── Value: Ranking H/U (w2) + Runway H/U (w0.5); verdict = Σweighted/Σweight ──
    var vw = { rank_h: 2, rank_u: 2, runway_h: 0.5, runway_u: 0.5 }, vwSum = 5;
    var rankScore = function (gap) { return gap == null ? 1 : gap >= 3 ? 2 : gap <= -3 ? 0 : 1; };
    var rankFcstSig = function (proj, avg) { if (proj == null || avg == null) return 'ORANGE'; var d = proj - avg; return d >= 3 ? 'GREEN' : d <= -3 ? 'RED' : 'ORANGE'; };
    var rwScore = function (v, g, r) { return v == null ? 1 : v >= g ? 2 : v <= r ? 0 : 1; };
    var rwFcstSig = function (v, g, r) { return v == null ? 'ORANGE' : v >= g ? 'GREEN' : v <= r ? 'RED' : 'ORANGE'; };
    var sigScore = function (sig) { return sig === 'GREEN' ? 2 : sig === 'RED' ? 0 : 1; };

    var rhGap = (inp.rank_h != null && inp.rank_h_avg != null) ? inp.rank_h - inp.rank_h_avg : null;
    var ruGap = (inp.rank_u != null && inp.rank_u_avg != null) ? inp.rank_u - inp.rank_u_avg : null;
    var vCur = { rank_h: rankScore(rhGap), rank_u: rankScore(ruGap), runway_h: rwScore(inp.runway_h, 0.40, 0.15), runway_u: rwScore(inp.runway_u, 0.60, 0.30) };
    var valueCurScore = (vCur.rank_h * 2 + vCur.rank_u * 2 + vCur.runway_h * 0.5 + vCur.runway_u * 0.5) / vwSum;

    var rhFsig = rankFcstSig(inp.rank_h_fcst, inp.rank_h_avg), ruFsig = rankFcstSig(inp.rank_u_fcst, inp.rank_u_avg);
    var rwhFsig = rwFcstSig(inp.runway_h_fcst, 0.40, 0.15), rwuFsig = rwFcstSig(inp.runway_u_fcst, 0.60, 0.30);
    var valueFcstScore = (sigScore(rhFsig) * 2 + sigScore(ruFsig) * 2 + sigScore(rwhFsig) * 0.5 + sigScore(rwuFsig) * 0.5) / vwSum;

    var value = verdict(valueCurScore, 1.4, 0.7), value_fcst = verdict(valueFcstScore, 1.4, 0.7);
    var value_inds = [
      { name: 'Ranking House', gap: rhGap, signal: sigOf(vCur.rank_h), fcst: rhFsig, rank: inp.rank_h, avg: inp.rank_h_avg, proj: inp.rank_h_fcst },
      { name: 'Ranking Unit',  gap: ruGap, signal: sigOf(vCur.rank_u), fcst: ruFsig, rank: inp.rank_u, avg: inp.rank_u_avg, proj: inp.rank_u_fcst },
      { name: 'Runway House',  signal: sigOf(vCur.runway_h), fcst: rwhFsig, val: inp.runway_h, proj: inp.runway_h_fcst },
      { name: 'Runway Unit',   signal: sigOf(vCur.runway_u), fcst: rwuFsig, val: inp.runway_u, proj: inp.runway_u_fcst }
    ];

    // ── Supply & Demand: Demand Score H (≥20/≤5) + U (≥25/≤5); current = worse-of ──
    var dsScore = function (v, g, r) { return v == null ? 1 : v >= g ? 2 : v <= r ? 0 : 1; };
    var dsFcstSig = function (v, g, r) { return v == null ? 'ORANGE' : v >= g ? 'GREEN' : v <= r ? 'RED' : 'ORANGE'; };
    var sdH = dsScore(inp.ds_h, 20, 5), sdU = dsScore(inp.ds_u, 25, 5);
    var sd = sigOf(Math.min(sdH, sdU));
    var sdHf = dsFcstSig(inp.ds_h_fcst, 20, 5), sdUf = dsFcstSig(inp.ds_u_fcst, 25, 5);
    var sd_fcst = (sdHf === 'RED' || sdUf === 'RED') ? 'RED' : (sdHf === 'ORANGE' || sdUf === 'ORANGE') ? 'ORANGE' : 'GREEN';
    var sd_inds = [
      { name: 'Demand Score - House', signal: sigOf(sdH), fcst: sdHf, val: inp.ds_h, proj: inp.ds_h_fcst },
      { name: 'Demand Score - Unit',  signal: sigOf(sdU), fcst: sdUf, val: inp.ds_u, proj: inp.ds_u_fcst }
    ];

    return {
      sd: sd, sd_fcst: sd_fcst, value: value, value_fcst: value_fcst,
      confidence: confidence, conf_fcst: confFcst,
      conf_score: Math.round(confScore * 100) / 100, conf_fcst_score: Math.round(confFcstScore * 100) / 100,
      value_score: Math.round(valueCurScore * 100) / 100, value_fcst_score: Math.round(valueFcstScore * 100) / 100,
      indicators: indicators, value_inds: value_inds, sd_inds: sd_inds
    };
  }

  // ── data assembly (browser; caller passes window.sb) ───────────────────────
  // Reads the live Forge inputs, shapes them for scoreRegion(), and returns a
  // DATA object keyed by capital NAME in the exact shape traffic-lights.html's
  // renderer expects (so the tool's render is unchanged; only the source swaps).
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

  var lastN = function (a) { for (var i = a.length - 1; i >= 0; i--) if (a[i] != null && !isNaN(a[i])) return +a[i]; return null; };
  var priorN = function (a) { var seen = 0; for (var i = a.length - 1; i >= 0; i--) if (a[i] != null && !isNaN(a[i])) { seen++; if (seen === 2) return +a[i]; } return null; };
  // value k rows before the last populated one — the workbook's INDEX(col, MATCH(last)-k).
  // Monthly confidence indicators use k=12 (year-on-year), NOT the previous point.
  var backN = function (a, k) { for (var i = a.length - 1; i >= 0; i--) if (a[i] != null && !isNaN(a[i])) { var j = i - k; return (j >= 0 && a[j] != null && !isNaN(a[j])) ? +a[j] : null; } return null; };
  var yoy = function (a) { var l = lastN(a), p = priorN(a); return (l == null || p == null || p === 0) ? null : l / p - 1; };
  var mean = function (a) { var s = 0, n = 0; for (var i = 0; i < a.length; i++) if (a[i] != null && !isNaN(a[i])) { s += +a[i]; n++; } return n ? s / n : null; };
  var cleanNums = function (a) { var o = []; for (var i = 0; i < a.length; i++) if (a[i] != null && !isNaN(a[i])) o.push(+a[i]); return o; };
  // project an indicator's OWN trend forward: fit the last `window` clean points, read `ahead` steps past the end.
  var projFwd = function (a, window, ahead) { var w = cleanNums(a).slice(-window); return w.length ? linForecast(w, w.length + ahead) : null; };
  // projected CHANGE = projected level vs the latest actual (mirrors the current YoY/ratio the signal scores).
  var projChg = function (a, window, ahead) { var p = projFwd(a, window, ahead), l = lastN(a); return (p == null || l == null || l === 0) ? null : p / l - 1; };

  async function fetchAll(sb) {
    var METRICS = ['som_h', 'adom_h', 'retail_turnover', 'bus_investment', 'unemployment', 'cash_rate', 'cpi', 'job_creation_index', 'owner_occupier', 'investor', 'ranking_h', 'ranking_u'];
    var REGIONS = ['australia']; for (var i = 0; i < CAPS.length; i++) { REGIONS.push(CAPS[i].slug); REGIONS.push(CAPS[i].state); }
    var rows = [];
    for (var pg = 0; pg < 25; pg++) {
      var q = await sb.from('rdp_raw_series').select('metric,region_slug,period,value').in('metric', METRICS).in('region_slug', REGIONS).order('period').range(pg * 1000, pg * 1000 + 999);
      if (q.error) throw q.error;
      rows = rows.concat(q.data || []);
      if (!q.data || q.data.length < 1000) break;
    }
    var series = {};   // metric|region -> [values in period order]
    for (var r = 0; r < rows.length; r++) { var k = rows[r].metric + '|' + rows[r].region_slug; (series[k] || (series[k] = [])).push(+rows[r].value); }
    var ar = await sb.from('forge_arrears').select('data').eq('id', 'latest').maybeSingle();
    var sn = await sb.from('forge_demand_snapshots').select('version,data').order('version');
    var snaps = (sn.data || []).filter(function (s) { return /^\d{4}-\d{2}$/.test(s.version); });
    return { series: series, arrears: (ar.data && ar.data.data && ar.data.data.regions) || {}, snaps: snaps };
  }

  function buildRegion(cap, ctx) {
    var S = function (metric, region) { return ctx.series[metric + '|' + region] || []; };
    // snapshot ds/rw monthly series (house & unit)
    var dsH = [], dsU = [], rwH = [], rwU = [];
    for (var i = 0; i < ctx.snaps.length; i++) {
      var h = (ctx.snaps[i].data.houses || {})[cap.slug], u = (ctx.snaps[i].data.units || {})[cap.slug];
      if (h) { dsH.push(h.ds); rwH.push(h.rw); } if (u) { dsU.push(u.ds); rwU.push(u.rw); }
    }
    var rkH = S('ranking_h', cap.slug), rkU = S('ranking_u', cap.slug);
    var oo = S('owner_occupier', cap.state), inv = S('investor', cap.state);
    var lendLast = (lastN(oo) || 0) + (lastN(inv) || 0), lendPrior = (backN(oo, 12) || 0) + (backN(inv, 12) || 0);   // YoY (12 months back), per workbook
    var unemp = S('unemployment', cap.state);
    var arr = (ctx.arrears[cap.state] && ctx.arrears[cap.state].values) || [];
    var cash = lastN(S('cash_rate', 'australia')), cpi = lastN(S('cpi', cap.slug));
    var cashP = priorN(S('cash_rate', 'australia')), cpiP = priorN(S('cpi', cap.slug));
    var real = (cash != null && cpi != null) ? cash - cpi : null;
    var realP = (cashP != null && cpiP != null) ? cashP - cpiP : null;

    // ── per-indicator confidence FORECASTS (each projects its OWN trend) ──
    // annual indicators (stock/days/retail/biz-inv/unemp): 3-pt trend → 1 ahead;
    // monthly (cash-rate/arrears/job-creation/lending): 6-pt window → 3 ahead.
    var fcUnemp = projFwd(unemp, 3, 1), unLast = lastN(unemp);
    var fcCash = projFwd(S('cash_rate', 'australia'), 6, 3), fcCpi = projFwd(S('cpi', cap.slug), 6, 3);
    var lendSeries = []; for (var li = 0, lm = Math.max(oo.length, inv.length); li < lm; li++) if (oo[li] != null && inv[li] != null) lendSeries.push(oo[li] + inv[li]);

    var inp = {
      ds_h: lastN(dsH), ds_u: lastN(dsU),
      ds_h_fcst: dsH.length ? Math.round(linForecast(dsH, dsH.length + 3)) : null,
      ds_u_fcst: dsU.length ? Math.round(linForecast(dsU, dsU.length + 3)) : null,
      rank_h: lastN(rkH), rank_h_avg: mean(rkH), rank_h_fcst: rkH.length ? Math.round(linForecast(rkH.slice(-5), 6) * 10) / 10 : null,
      rank_u: lastN(rkU), rank_u_avg: mean(rkU), rank_u_fcst: rkU.length ? Math.round(linForecast(rkU.slice(-5), 6) * 10) / 10 : null,
      runway_h: lastN(rwH), runway_u: lastN(rwU),
      runway_h_fcst: rwH.length ? linForecast(rwH, rwH.length + 3) : null,
      runway_u_fcst: rwU.length ? linForecast(rwU, rwU.length + 3) : null,
      som: yoy(S('som_h', cap.slug)), adom: yoy(S('adom_h', cap.slug)),
      retail: yoy(S('retail_turnover', cap.state)), bizinv: yoy(S('bus_investment', cap.state)),
      unemp_level: lastN(unemp), unemp_change: (lastN(unemp) != null && priorN(unemp) != null) ? lastN(unemp) - priorN(unemp) : null,
      real_cash_rate: real,
      arrears: (function () { var l = lastN(arr), p = backN(arr, 12); return (l != null && p != null && p !== 0) ? l / p - 1 : null; })(),   // YoY
      jci: (function () { var j = S('job_creation_index', cap.slug), l = lastN(j), p = backN(j, 12); return (l != null && p != null && p !== 0) ? l / p - 1 : null; })(),   // YoY
      lending: lendPrior ? lendLast / lendPrior - 1 : null,
      // forecasts — scored against the same thresholds as the current signal above
      fc_som: projChg(S('som_h', cap.slug), 3, 1),
      fc_adom: projChg(S('adom_h', cap.slug), 3, 1),
      fc_retail: projChg(S('retail_turnover', cap.state), 3, 3),   // workbook uses FORECAST(6) on the 3-pt trend
      fc_bizinv: projChg(S('bus_investment', cap.state), 3, 1),
      fc_unemp_level: fcUnemp,
      fc_unemp_change: (fcUnemp != null && unLast != null) ? fcUnemp - unLast : null,
      fc_real_cash_rate: (fcCash != null && fcCpi != null) ? fcCash - fcCpi : null,
      fc_arrears: projChg(arr, 6, 3),
      fc_jci: projChg(S('job_creation_index', cap.slug), 6, 3),
      fc_lending: projChg(lendSeries, 6, 3)
    };
    var out = scoreRegion(inp);
    return formatForTool(cap, inp, out, { som: lastN(S('som_h', cap.slug)), adom: lastN(S('adom_h', cap.slug)), retail: lastN(S('retail_turnover', cap.state)), bizinv: lastN(S('bus_investment', cap.state)), arrears: lastN(arr), jci: lastN(S('job_creation_index', cap.slug)), lending: lendLast, realP: realP });
  }
  var yoyMoM = function (a) { return yoy(a); };   // JCI: latest vs prior available month

  // display formatting → the DATA shape traffic-lights.html renders
  var pctS = function (v, dp) { return (v == null || isNaN(v)) ? '--' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp == null ? 1 : dp) + '%'; };
  var ppS = function (v) { return (v == null || isNaN(v)) ? '--' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + 'pp'; };
  var lvlS = function (v) { return (v == null || isNaN(v)) ? '--' : (v * 100).toFixed(2) + '%'; };
  var intS = function (v) { return (v == null || isNaN(v)) ? '--' : Math.round(v).toLocaleString(); };
  var oneS = function (v) { return (v == null || isNaN(v)) ? '--' : (+v).toFixed(1); };
  var trendW = function (a, b) { return (a == null || b == null) ? 'steady' : b > a + 0.5 ? 'rising' : b < a - 0.5 ? 'falling' : 'steady'; };

  function formatForTool(cap, inp, out, raw) {
    var byKey = {}, byF = {}; out.indicators.forEach(function (o) { byKey[o.key] = o.signal; byF[o.key] = o.fsignal; });
    var indicators = [
      { name: 'Stock on Market', latest: intS(raw.som), change: pctS(inp.som), signal: byKey.som, fsignal: byF.som },
      { name: 'Average Days on Market', latest: oneS(raw.adom), change: pctS(inp.adom), signal: byKey.adom, fsignal: byF.adom },
      { name: 'Retail Turnover', latest: intS(raw.retail), change: pctS(inp.retail), signal: byKey.retail, fsignal: byF.retail },
      { name: 'Business Investment', latest: intS(raw.bizinv), change: pctS(inp.bizinv), signal: byKey.bizinv, fsignal: byF.bizinv },
      { name: 'Unemployment', latest: lvlS(inp.unemp_level), change: ppS(inp.unemp_change), signal: byKey.unemp, fsignal: byF.unemp },
      { name: 'Cash Rate vs. Inflation', latest: lvlS(inp.real_cash_rate), change: ppS(inp.real_cash_rate != null && raw.realP != null ? inp.real_cash_rate - raw.realP : null), signal: byKey.realcash, fsignal: byF.realcash },
      { name: 'Mortgage Arrears', latest: (raw.arrears == null ? '--' : (+raw.arrears).toFixed(2) + '%'), change: pctS(inp.arrears), signal: byKey.arrears, fsignal: byF.arrears },
      { name: 'Job Creation Index', latest: oneS(raw.jci), change: pctS(inp.jci), signal: byKey.jci, fsignal: byF.jci },
      { name: 'Lending Flows (OO+INV)', latest: intS(raw.lending), change: pctS(inp.lending), signal: byKey.lending, fsignal: byF.lending }
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
      { name: 'Demand Score - House', meta: 'Demand score', sub: 'Projected: ' + (inp.ds_h_fcst == null ? '—' : inp.ds_h_fcst), right: (inp.ds_h == null ? '--' : Math.round(inp.ds_h)), signal: out.sd_inds[0].signal },
      { name: 'Demand Score - Unit', meta: 'Demand score', sub: 'Projected: ' + (inp.ds_u_fcst == null ? '—' : inp.ds_u_fcst), right: (inp.ds_u == null ? '--' : Math.round(inp.ds_u)), signal: out.sd_inds[1].signal }
    ];
    return {
      sd: out.sd, sd_fcst: out.sd_fcst, value: out.value, value_fcst: out.value_fcst,
      confidence: out.confidence, conf_fcst: out.conf_fcst, conf_score: out.conf_score, conf_fcst_score: out.conf_fcst_score,
      indicators: indicators, value_inds: value_inds, sd_inds: sd_inds,
      sd_fcst_expl: 'Projecting the captured demand-score trend forward, house demand is ' + trendW(inp.ds_h, inp.ds_h_fcst) + ' (' + (inp.ds_h == null ? '—' : Math.round(inp.ds_h)) + '→' + (inp.ds_h_fcst == null ? '—' : inp.ds_h_fcst) + ') and unit demand is ' + trendW(inp.ds_u, inp.ds_u_fcst) + ' (' + (inp.ds_u == null ? '—' : Math.round(inp.ds_u)) + '→' + (inp.ds_u_fcst == null ? '—' : inp.ds_u_fcst) + '). Scored against the same thresholds as now, the forecast Supply & Demand signal is ' + out.sd_fcst + '.',
      value_fcst_expl: 'Projecting the ranking trend and runway forward (ranking carries the main weight), the forecast Value signal is ' + out.value_fcst + '.',
      conf_fcst_expl: 'The forecast re-weights the nine indicators toward the forward-looking ones (stock, days on market, lending, job creation). ' + cap.name + '’s leading-weighted score is ' + out.conf_fcst_score + ' versus the current ' + out.conf_score + ', giving a forecast Confidence signal of ' + out.conf_fcst + '.'
    };
  }

  async function assembleTrafficLights(sb) {
    var ctx = await fetchAll(sb);
    var DATA = {};
    for (var i = 0; i < CAPS.length; i++) { try { DATA[CAPS[i].name] = buildRegion(CAPS[i], ctx); } catch (e) { /* skip a region that fails */ } }
    return DATA;
  }

  var api = { scoreRegion: scoreRegion, linForecast: linForecast, CONF: CONF, CAPS: CAPS, assembleTrafficLights: assembleTrafficLights };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PP_TL_ENGINE = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null));
