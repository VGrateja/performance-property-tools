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
 * leveraged() (25 Nov 2026): a growth+yield row can instead be geared like our
 * purchases, through the IRR calculator's engine and pp.assumptions; see below.
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

  /* decimal year (month grid) → 'YYYY-MM-DD', the inverse of decYear to the day */
  function isoOf(t) {
    var y = Math.floor(t + 1e-9), r = (t - y) * 12, m = Math.floor(r + 1e-9);
    if (m > 11) { y += 1; m = 0; r = 0; }
    var dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    var d = Math.max(1, Math.min(dim, Math.round((r - m) * dim)));
    return y + '-' + (m < 9 ? '0' : '') + (m + 1) + '-' + (d < 10 ? '0' : '') + d;
  }

  /* a benchmark's gross yield averaged over [t0, t1], each period weighted by
     the time it has inside the window; null when no yield cell overlaps */
  function avgYield(b, years, ytdEnd, t0, t1) {
    var sum = 0, wt = 0;
    (years || []).forEach(function (k) {
      var per = periodOf(k, ytdEnd), y = b && b.yield ? b.yield[k] : null;
      if (!per || !isNum(y)) return;
      var a = Math.max(t0, per[0]), z = Math.min(t1, per[1]);
      if (z <= a) return;
      sum += y * (z - a); wt += z - a;
    });
    return wt > 0 ? sum / wt : null;
  }

  /* Residential property, leveraged like our purchases (25 Nov 2026, Saskia's
     review: the client's figure is a geared IRR, so the property market it is
     set against should be geared the same way). A typical property at the
     median purchase price, bought at the window start and sold at its end,
     its price growing as the benchmark's index did over the window, rented at
     the benchmark's own average gross yield over the window, and run through
     the IRR calculator's engine (`engine` = tools/irr-breakdown-engine.js)
     with the calculator's own assumptions (pp.assumptions — deposit + costs,
     loan, rate, running and selling costs — saved by "Update returns data").
     Only the growth and the yield differ from our purchases. null — and the
     row stays the unleveraged growth + gross yield it was — when there is no
     engine, no saved assumptions, or the index does not cover the window. */
  function leveraged(b, p, engine) {
    var pp = p.pp || {}, a = pp.assumptions, w = windowOf(p);
    if (!engine || !a || typeof a !== 'object' || !w || !b || b.kind !== 'growth+yield') return null;
    if (!isNum(pp.medianPurchasePrice) || pp.medianPurchasePrice <= 0) return null;
    var g = compound(b, p.years, p.window.ytdEnd, w.start, w.end, true);
    if (g.covered < w.years - 1e-6) return null;
    var y = avgYield(b, p.years, p.window.ytdEnd, w.start, w.end);
    if (y == null) return null;
    var opts = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) opts[k] = a[k];
    opts.rentalYield = y;
    var P = pp.medianPurchasePrice, S = P * g.factor, s;
    try {
      s = engine.computeBreakdown({ purchasePrice: P, purchaseDate: isoOf(w.start), soldPrice: S, soldDate: p.window.endDate }, opts).summary;
    } catch (e) { return null; }
    if (!s || !isNum(s.irr)) return null;
    return { irr: s.irr, cagr: Math.pow(g.factor, 1 / g.covered) - 1, rentYield: y, salePrice: S, netProfit: s.netProfit };
  }

  /* everything the page draws; `engine` (optional) turns on leveraged() */
  function compute(p, engine) {
    var pp = p.pp || {};
    var w = windowOf(p);
    var deposit = (isNum(pp.medianPurchasePrice) && isNum(pp.depositPct)) ? pp.medianPurchasePrice * pp.depositPct : null;
    var ppRes = (w && deposit != null && isNum(pp.medianIrr)) ? ppGrowth(deposit, pp.medianIrr, w.years) : null;
    var rows = (p.benchmarks || []).filter(function (b) { return b.include !== false; }).map(function (b) {
      var lev = (w && deposit != null) ? leveraged(b, p, engine) : null;
      if (lev) {
        /* the client's cash compounds at the leveraged IRR, exactly as the PP row does */
        var g = ppGrowth(deposit, lev.irr, w.years), path = [], t;
        path.push([w.start, 1]);
        for (t = Math.floor(w.start) + 1; t < w.end - 1e-9; t++) path.push([t, Math.pow(1 + lev.irr, t - w.start)]);
        path.push([w.end, g.factor]);
        return { key: b.key, label: b.label, source: b.source, kind: b.kind, leveraged: lev,
          pa: g.pa, total: g.total, end: g.end, covered: w.years, short: false, path: path };
      }
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
    compound: compound, annualise: annualise, ppGrowth: ppGrowth, compute: compute,
    isoOf: isoOf, avgYield: avgYield, leveraged: leveraged };
  root.ADLMath = api;
})(typeof window !== 'undefined' ? window : this);
