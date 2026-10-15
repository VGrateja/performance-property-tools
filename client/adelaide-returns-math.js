/* ============================================================================
 * client/adelaide-returns-math.js — the maths behind client/adelaide-returns.html
 *
 * Pure functions, no DOM. Loaded by the public page (window.ADLMath) and by the
 * unit test scripts/adelaide-returns-math.test.mjs (run in a vm sandbox).
 *
 * Time is in DECIMAL YEARS on a month grid: a date is
 *   year + (month − 1)/12 + day/(days in that month)/12
 * so a month end lands on a twelfth (2026-09-30 → 2026.75) and a calendar year
 * is exactly 1.0.
 *
 * Window = [end − hold, end], end = payload.window.endDate, hold =
 * payload.pp.medianHoldYears (7.8 → 2018.95 … 2026.75).
 *
 * A benchmark holds one return per period: 'YYYY' = the calendar year,
 * 'YYYYYTD' = 1 Jan YYYY → window.ytdEnd. Over the window each period
 * contributes (1 + r)^(share of the period inside the window); the product is
 * the growth factor. % p.a. = factor^(1 / years covered) − 1.
 * kind 'growth+yield' (residential): r = growth + gross yield × period length
 * (a full year adds the whole year-end yield; the 9-month YTD adds 0.75 of it).
 * Selection uses the growth alone.
 * ========================================================================== */
(function (root) {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function decYear(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return y + (mo - 1) / 12 + Math.min(d, dim) / dim / 12;
  }

  /* 'YYYY' → [Y, Y+1]; 'YYYYYTD' → [Y, ytdEnd]; anything else → null */
  function periodOf(key, ytdEnd) {
    var m = /^(\d{4})(YTD)?$/i.exec(String(key || '').trim());
    if (!m) return null;
    var y = +m[1];
    if (!m[2]) return [y, y + 1];
    var e = decYear(ytdEnd);
    return (e != null && e > y) ? [y, Math.min(e, y + 1)] : null;
  }

  function windowOf(p) {
    var end = decYear(p && p.window && p.window.endDate);
    var hold = p && p.pp && p.pp.medianHoldYears;
    if (end == null || !isNum(hold) || hold <= 0) return null;
    return { start: end - hold, end: end, years: hold };
  }

  /* the return of one period; null when the cell is blank */
  function periodReturn(b, key, len, growthOnly) {
    var g = b && b.annual ? b.annual[key] : null;
    if (!isNum(g)) return null;
    if (growthOnly || b.kind !== 'growth+yield') return g;
    var y = b.yield ? b.yield[key] : null;
    return isNum(y) ? g + y * len : null;
  }

  /* compound one benchmark between t0 and t1.
     → { factor, covered, path: [[t, factor], …] } (path = cumulative at each
     period boundary inside the window, for the year-by-year chart) */
  function compound(b, years, ytdEnd, t0, t1, growthOnly) {
    var list = (years || []).map(function (k) { return { k: k, p: periodOf(k, ytdEnd) }; })
      .filter(function (x) { return x.p; })
      .sort(function (a, c) { return a.p[0] - c.p[0]; });
    var factor = 1, covered = 0, path = [];
    list.forEach(function (x) {
      var a = Math.max(t0, x.p[0]), z = Math.min(t1, x.p[1]);
      if (z <= a) return;
      var len = x.p[1] - x.p[0];
      var r = periodReturn(b, x.k, len, growthOnly);
      if (r == null) return;
      if (!path.length) path.push([a, factor]);
      factor *= Math.pow(1 + r, (z - a) / len);
      covered += z - a;
      path.push([z, factor]);
    });
    return { factor: factor, covered: covered, path: path };
  }

  function summarise(factor, covered, deposit) {
    return {
      factor: factor,
      covered: covered,
      total: factor - 1,
      pa: covered > 0 ? Math.pow(factor, 1 / covered) - 1 : null,
      end: isNum(deposit) ? deposit * factor : null
    };
  }

  /* one benchmark over the payload's window, applied to `deposit` */
  function annualise(b, p, deposit, growthOnly) {
    var w = windowOf(p);
    if (!w) return null;
    var c = compound(b, p.years, p.window.ytdEnd, w.start, w.end, growthOnly);
    var out = summarise(c.factor, c.covered, deposit);
    out.path = c.path;
    out.short = c.covered < w.years - 1e-6;   /* data does not span the whole window */
    return out;
  }

  /* the PP deposit path: deposit × (1 + IRR)^years */
  function ppGrowth(deposit, irr, years) {
    if (!isNum(deposit) || !isNum(irr) || !isNum(years)) return null;
    var factor = Math.pow(1 + irr, years);
    return { factor: factor, covered: years, total: factor - 1, pa: irr, end: deposit * factor };
  }

  function byKey(p, key) {
    return (p.benchmarks || []).filter(function (b) { return b.key === key; })[0] || null;
  }

  /* everything the page draws */
  function compute(p) {
    var pp = p.pp || {};
    var w = windowOf(p);
    var deposit = (isNum(pp.medianPurchasePrice) && isNum(pp.depositPct)) ? pp.medianPurchasePrice * pp.depositPct : null;
    var ppRes = (w && deposit != null && isNum(pp.medianIrr)) ? ppGrowth(deposit, pp.medianIrr, w.years) : null;
    var rows = (p.benchmarks || []).filter(function (b) { return b.include !== false; }).map(function (b) {
      var r = annualise(b, p, deposit) || {};
      return { key: b.key, label: b.label, source: b.source, kind: b.kind,
        pa: r.pa, total: r.total, end: r.end, covered: r.covered, short: r.short, path: r.path || [] };
    });
    var sel = ((p.selection && p.selection.compare) || []).map(function (c) {
      var b = byKey(p, c.key);
      var r = b ? annualise(b, p, null, true) : null;
      return { key: c.key, label: c.label || (b && b.label) || c.key, source: b && b.source, pa: r ? r.pa : null, short: r ? r.short : false };
    });
    return { window: w, deposit: deposit, pp: ppRes, rows: rows, selection: sel };
  }

  var api = { decYear: decYear, periodOf: periodOf, windowOf: windowOf, periodReturn: periodReturn,
    compound: compound, annualise: annualise, ppGrowth: ppGrowth, compute: compute };
  root.ADLMath = api;
})(typeof window !== 'undefined' ? window : this);
