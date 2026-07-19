/* ============================================================================
   shared/suburb-scoring-engine.js — the Simple Suburb Scoring model, ported
   1:1 from the Google-Sheets workbook formulas (extracted 2026-07-19 from all
   13 market workbooks — every market uses the IDENTICAL formula set).

   Per row, CONSTANTS (frozen at seeding, from the workbooks):
     rent0, price0  — rent/price at the start of stagnation
     lt             — long-term CAGR of median prices to stagnation start
   LIVE inputs (from forge_cl_suburbs, refreshed monthly by the Cotality drop):
     rent (median asking rent 12m), price (median sales price), dom
   BENCHMARK (the GREATER row): topPrice = the runway-model affordability
   ceiling ( -PV(bankRate/12,360,(predictedWeeklyIncome*52*AI)/12)/0.8 ) —
   kept as a stored constant here; its runway re-derives from the fresh price.

   Sheet formulas reproduced EXACTLY (including quirks — parity first):
     yield      = rent*52/price
     cagrRent   = (rent/rent0)^(1/7) - 1          · 7-year base, all markets
     cagrPrice  = (price/price0)^(1/7) - 1
     quality    = IFS(lt>0.07 AAA, >0.06 BBB, >0.05 CCC, else DDD)
     scoreRent  = 10..0 ladder — NOTE the sheet's `=0.02` EQUALITY branch (a
                  value of 0.021 scores 1, not 2). Ported verbatim.
     scorePrice = 10..0 ladder on cagrPrice (lower growth = higher score)
     scoreValue = scoreRent + scorePrice
     adjValue   = scoreValue - benchmark scoreValue
     adjustment = IFS(adj>=6 +0.30, >=4 +0.20, >=2 +0.10, >=-1 0,
                      >=-3 -0.10, >=-5 -0.20, else -0.30)
     runway     = benchmark runway + adjustment
     topPrice   = price + price*runway
     rec        = IFS(rw<0.2 "Sell or LT Hold", <0.6 "LT Hold - Foundation",
                      >=0.6 "LT Hold - Foundation / MT - Trading")
     demand     = IFS(dom>=40 "Soft", >=30 "Neutral", >0 "Strong")
   ============================================================================ */
(function (root) {
  'use strict';

  var fin = function (v) { return typeof v === 'number' && isFinite(v); };

  function yieldOf(rent, price) { return (fin(rent) && fin(price) && price) ? (rent * 52) / price : null; }
  function cagr7(now, base) { return (fin(now) && fin(base) && base > 0 && now > 0) ? Math.pow(now / base, 1 / 7) - 1 : null; }

  function quality(lt) {
    if (!fin(lt)) return null;
    if (lt > 0.07) return 'AAA';
    if (lt > 0.06) return 'BBB';
    if (lt > 0.05) return 'CCC';
    return 'DDD';
  }

  /* the sheet's IF-chain verbatim — including the `=0.02` equality quirk */
  function scoreRent(c) {
    if (!fin(c)) return null;
    if (c >= 0.06) return 10; if (c >= 0.055) return 9; if (c >= 0.05) return 8;
    if (c >= 0.045) return 7; if (c >= 0.04) return 6; if (c >= 0.035) return 5;
    if (c >= 0.03) return 4; if (c >= 0.025) return 3;
    if (c === 0.02) return 2;                     /* sheet bug kept for parity */
    if (c >= 0.015) return 1;
    return 0;
  }
  function scorePrice(c) {
    if (!fin(c)) return null;
    if (c < -0.03) return 10; if (c < -0.02) return 9; if (c < -0.01) return 8;
    if (c < 0) return 7; if (c < 0.01) return 6; if (c < 0.02) return 5;
    if (c < 0.03) return 4; if (c < 0.04) return 3; if (c < 0.05) return 2;
    if (c < 0.06) return 1;
    return 0;
  }
  function adjustment(adjValue) {
    if (!fin(adjValue)) return null;
    if (adjValue >= 6) return 0.30; if (adjValue >= 4) return 0.20; if (adjValue >= 2) return 0.10;
    if (adjValue >= -1) return 0.00; if (adjValue >= -3) return -0.10; if (adjValue >= -5) return -0.20;
    return -0.30;
  }
  var REC_DEFAULT = ['Sell or LT Hold', 'LT Hold - Foundation', 'LT Hold - Foundation / MT - Trading'];
  /* per-dataset label variants, enumerated from ALL 26 workbook formulas —
     only Adelaide Units words the first band differently (same thresholds) */
  var REC_LABELS = { 'adelaide-u': ['LT Hold or Consider Sell', 'LT Hold - Foundation', 'LT Hold - Foundation / MT - Trading'] };
  function recommendation(rw, labels) {
    var L = labels || REC_DEFAULT;
    if (!fin(rw)) return null;
    if (rw < 0.2) return L[0];
    if (rw < 0.6) return L[1];
    return L[2];
  }
  function demand(dom) {
    if (!fin(dom) || dom <= 0) return null;
    if (dom >= 40) return 'Soft';
    if (dom >= 30) return 'Neutral';
    return 'Strong';
  }

  /* Fixed Suburb Quality is a CONSTANT ("Fixed" — derives from the frozen LT
     Growth): carry the stored value; only derive when it is absent. */
  function qualityOf(r) { return r.quality != null && r.quality !== '' ? r.quality : quality(r.lt); }

  /* benchmark (GREATER row): topPrice is the stored runway-model ceiling.
     benchRunwayMode 'derive' (production) recomputes runway from the fresh
     price; 'stored' keeps the sheet's value (formula-parity verification —
     a few workbooks' Top MP-RW "Current" cell had drifted from the cycle
     sheet's own current price). */
  function computeBenchmark(b, opts) {
    opts = opts || {};
    var out = Object.assign({}, b);
    out.yield = yieldOf(b.rent, b.price);
    out.cagrRent = cagr7(b.rent, b.rent0);
    out.cagrPrice = cagr7(b.price, b.price0);
    out.quality = qualityOf(b);
    out.scoreRent = scoreRent(out.cagrRent);
    out.scorePrice = scorePrice(out.cagrPrice);
    out.scoreValue = (out.scoreRent != null && out.scorePrice != null) ? out.scoreRent + out.scorePrice : null;
    out.adjValue = 0;
    out.runway = (opts.benchRunwayMode === 'stored' && fin(b.runway)) ? b.runway
      : (fin(b.topPrice) && fin(b.price) && b.price) ? (b.topPrice - b.price) / b.price : null;
    out.rec = recommendation(out.runway, opts.recLabels);
    out.demand = demand(b.dom);
    return out;
  }

  /* suburb / LGA row against a computed benchmark */
  function computeRow(r, bench, opts) {
    opts = opts || {};
    var out = Object.assign({}, r);
    out.yield = yieldOf(r.rent, r.price);
    out.cagrRent = cagr7(r.rent, r.rent0);
    out.cagrPrice = cagr7(r.price, r.price0);
    out.quality = qualityOf(r);
    out.scoreRent = scoreRent(out.cagrRent);
    out.scorePrice = scorePrice(out.cagrPrice);
    out.scoreValue = (out.scoreRent != null && out.scorePrice != null) ? out.scoreRent + out.scorePrice : null;
    out.adjValue = (out.scoreValue != null && bench && bench.scoreValue != null) ? out.scoreValue - bench.scoreValue : null;
    var adj = adjustment(out.adjValue);
    out.runway = (adj != null && bench && fin(bench.runway)) ? bench.runway + adj : null;
    out.topPrice = (fin(r.price) && fin(out.runway)) ? r.price + r.price * out.runway : null;
    out.rec = recommendation(out.runway, opts.recLabels);
    out.demand = demand(r.dom);
    return out;
  }

  /* recompute a whole market payload. key = '<market>-<h|u>' (drives the
     rec-label variant); fresh {rent, price, dom} come from a currentOf(row)
     callback (null → keep the stored values). opts.benchRunwayMode as above. */
  function recomputePayload(key, payload, currentOf, opts) {
    opts = Object.assign({ recLabels: REC_LABELS[key] || null }, opts || {});
    var b = Object.assign({}, payload.benchmark);
    var cb = currentOf ? currentOf(payload.benchmark, true) : null;
    if (cb) { if (fin(cb.rent)) b.rent = cb.rent; if (fin(cb.price)) b.price = cb.price; if (fin(cb.dom)) b.dom = cb.dom; else if (cb.dom === null) b.dom = null; }
    var bench = computeBenchmark(b, opts);
    var rows = (payload.rows || []).map(function (r0) {
      var r = Object.assign({}, r0);
      var c = currentOf ? currentOf(r0, false) : null;
      if (c) { if (fin(c.rent)) r.rent = c.rent; if (fin(c.price)) r.price = c.price; if (fin(c.dom)) r.dom = c.dom; else if (c.dom === null) r.dom = null; }
      return computeRow(r, bench, opts);
    });
    return Object.assign({}, payload, { benchmark: bench, rows: rows });
  }

  root.PP_SSCORE_ENGINE = {
    computeBenchmark: computeBenchmark,
    computeRow: computeRow,
    recomputePayload: recomputePayload,
    parts: { yieldOf: yieldOf, cagr7: cagr7, quality: quality, scoreRent: scoreRent, scorePrice: scorePrice, adjustment: adjustment, recommendation: recommendation, demand: demand }
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
