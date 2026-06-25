/* =============================================================================
   region-dashboard-calc.js — Regional Advisor Dashboard calculator.

   The in-house replacement for the per-region "Suburb Selection" Google Sheets.
   Pure JS, NO xlsx/DOM/network deps — the caller parses the files and passes
   already-built data. Dual-use: Node (module.exports) + browser
   (window.RegionDashboardCalc). Verified to reproduce the Adelaide workbook's
   Dashboard exactly (see scripts/verify… in scratchpad); two deliberate
   improvements over the sheet, both confirmed with the user:
     • V/W (negative-return counts) are computed correctly (the sheet's formula
       was broken and returned 0 everywhere).
     • LGA Quality/Affordability roll-ups group suburbs by NORMALISED LGA name,
       so all LGAs compute (the sheet only managed the cleanly-labelled few).

   computeRegionDashboard(input) -> { lgaRows, suburbRows }
     input = {
       config:    { rate, term, lvr, bottomYear, floor, ceiling, clockO[], clockP[] },
       lgaThresh: { "<LGA UPPER>": { ti, tj } },          // recency thresholds (blank => 0)
       selection: { lgas:[names], suburbs:[names] },        // the region's directory
       price:     [ { geo, year, median, growth } ],        // slim history (seeded ref)
       lgaCurrent:    Map normLga(name) -> { s12,s6,s3, m12,m6,m3, yld, rentChg, props, stock, days },
       suburbCurrent: Map UPPER(name)   -> { lga, s12,s6,s3, m12,m6,m3, yld, avmYld, rentChg,
                                             props, stock, days, sepHouse, ownFull, ownBuy, income },
       currentYear:   number,
     }
   Each output row carries the Dashboard column letters (K,M,N,O,P,Q,R,S,T,V,W,
   X,AA,AB,AC,AE,AF,AG,I,J,D, E=overall rating=R).
   ============================================================================= */
(function (root) {
  'use strict';

  const U = s => String(s == null ? '' : s).trim().toUpperCase();
  const isNum = v => typeof v === 'number' && isFinite(v);
  // Normalise an LGA name for cross-source matching: drop the parenthetical code
  // "(C)/(A)/(DC)…", connectors (& / and), and the LGA-type words CoreLogic's
  // national file omits (Shire, Council, City…) — so workbook "Greater Hume
  // Shire (A)" and national "Greater Hume" both reduce to "greater hume".
  const normLga = s => String(s == null ? '' : s).toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[-/&]/g, ' ')
    .replace(/\b(and|the|of|shire|council|regional|municipality|borough|rural|city|town|district)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();

  const annualPmt = (pv, rate, term) => pv * rate / (1 - Math.pow(1 + rate, -term)); // positive annual P&I
  function clockPos(x, O, P) { let i = -1; for (let k = 0; k < O.length; k++) { if (isNum(O[k]) && O[k] <= x) i = k; else break; } if (i < 0) i = 0; if (x > O[O.length - 1]) i = O.length - 1; return P[i]; }
  function growthRating(P, Q) { if (isNum(P) && isNum(Q)) { const a = (P + Q) / 2; return a > 0.07 ? 'A' : a > 0.06 ? 'B' : a > 0.05 ? 'C' : 'D'; } if (isNum(P)) return P > 0.07 ? 'A' : P > 0.06 ? 'B' : P > 0.05 ? 'C' : 'D'; return null; }

  function buildPrice(arr) {
    const med = new Map(), grow = new Map();
    for (const p of (arr || [])) { const g = U(p.geo); if (!g || p.year == null) continue;
      if (!med.has(g)) med.set(g, new Map()); med.get(g).set(p.year, p.median);
      if (!grow.has(g)) grow.set(g, new Map()); grow.get(g).set(p.year, p.growth); }
    return { med, grow };
  }
  const medAt = (med, geo, y) => { const m = med.get(U(geo)); return m && m.has(y) ? m.get(y) : null; };
  function negCount(grow, geo, fromY, toY) { const m = grow.get(U(geo)); if (!m) return 0; let c = 0; for (let y = fromY; y <= toY; y++) { const v = m.get(y); if (isNum(v) && v < 0) c++; } return c; }
  function ltNeg(grow, geo) { const m = grow.get(U(geo)); if (!m) return null; let n = 0, p = 0; for (const v of m.values()) { if (!isNum(v)) continue; p++; if (v < 0) n++; } return p ? n / p : null; }

  // recency pick: (s3/s12 > ti) ? m3 : (s6/s12 > tj) ? m6 : m12   (ti/tj blank => 0)
  function recencyPick(d, ti, tj) {
    const L = d.s12; if (!isNum(L) || L <= 0) return undefined; // signal "Low Sales"
    const r3 = d.s3 / L, r6 = d.s6 / L;
    return (isNum(r3) && r3 > (ti || 0)) ? d.m3 : (isNum(r6) && r6 > (tj || 0)) ? d.m6 : d.m12;
  }

  function computeRegionDashboard(input) {
    const { config: cfg, lgaThresh = {}, selection, price, lgaCurrent, suburbCurrent, currentYear: CY } = input;
    const { med, grow } = buildPrice(price);

    // ---------- suburb rows ----------
    const suburbRows = [];
    for (const subName of selection.suburbs) {
      const d = suburbCurrent.get(U(subName));
      // K (current median): recency pick, average fallback, "Low Sales" guard.
      let K;
      if (!d) K = 'Low Sales';
      else { const pick = recencyPick(d, 0, 0);
        if (pick === undefined) K = 'Low Sales';
        else if (!isNum(pick)) { const v = [d.m12, d.m6, d.m3].filter(isNum); K = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 'Low Sales'; }
        else K = pick; }
      const isK = isNum(K);
      const mb = medAt(med, subName, cfg.bottomYear); const M = isNum(mb) ? mb : 'No data';
      const N = (isK && isNum(M)) ? (K - M) / M : 'No data';
      const O = (isK && isNum(M)) ? Math.pow(K / M, 1 / (CY - cfg.bottomYear)) - 1 : 'No data';
      const p20 = isK ? medAt(med, subName, CY - 21) : null; const P = (isK && isNum(p20)) ? Math.pow(K / p20, 1 / 20) - 1 : null;
      const p28 = isK ? medAt(med, subName, CY - 29) : null; const Q = (isK && isNum(p28)) ? Math.pow(K / p28, 1 / 28) - 1 : null;
      const R = growthRating(P, Q);
      const S = d ? ((isNum(d.yld) && d.yld > 0) ? d.yld : d.avmYld) : null;
      const AG = d ? d.income : null;
      const I = (isK && isNum(AG) && AG !== 0) ? annualPmt(K * cfg.lvr, cfg.rate, cfg.term) / (AG * 52) : null;
      const J = isNum(I) ? (I - cfg.floor) / (cfg.ceiling - cfg.floor) : null;
      const D = (isNum(I) && isNum(N)) ? clockPos(J + N, cfg.clockO, cfg.clockP) : null;
      suburbRows.push({ suburb: subName, lga: d ? d.lga : null,
        D, E: R, I, J, K, L: cfg.bottomYear, M, N, O, P, Q, R, S,
        T: d ? d.rentChg : null,
        V: negCount(grow, subName, CY - 20, CY), W: negCount(grow, subName, CY - 10, CY), X: ltNeg(grow, subName),
        AA: d ? d.props : null, AB: d ? d.stock : null, AC: d ? d.days : null,
        AE: d ? d.sepHouse : null, AF: d ? ((d.ownFull || 0) + (d.ownBuy || 0)) : null, AG });
    }

    // ---------- LGA rows ----------
    const byLga = new Map();
    for (const r of suburbRows) { if (r.lga == null) continue; const k = normLga(r.lga); if (!byLga.has(k)) byLga.set(k, []); byLga.get(k).push(r); }
    const avgOf = (arr, f) => { const v = arr.map(x => x[f]).filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

    const lgaRows = [];
    for (const lgaName of selection.lgas) {
      const cur = lgaCurrent.get(normLga(lgaName));
      let K = null, M = null, N = null, O = null, P = null, Q = null, R = null, S = null, T = null, V = 0, W = 0, X = null, AA = null, AB = null, AC = null;
      if (cur) {
        const th = lgaThresh[U(lgaName)] || { ti: 0, tj: 0 };
        const pick = recencyPick(cur, th.ti, th.tj); K = isNum(pick) ? pick : cur.m12;
        const mb = medAt(med, lgaName, cfg.bottomYear); M = isNum(mb) ? mb : null;
        N = (isNum(K) && isNum(M)) ? (K - M) / M : null;
        O = (isNum(K) && isNum(M)) ? Math.pow(K / M, 1 / (CY - cfg.bottomYear)) - 1 : null;
        const p20 = medAt(med, lgaName, CY - 21); P = (isNum(K) && isNum(p20)) ? Math.pow(K / p20, 1 / 20) - 1 : null;
        const p28 = medAt(med, lgaName, CY - 29); Q = (isNum(K) && isNum(p28)) ? Math.pow(K / p28, 1 / 28) - 1 : null;
        R = growthRating(P, Q); S = cur.yld; T = cur.rentChg;
        V = negCount(grow, lgaName, CY - 20, CY); W = negCount(grow, lgaName, CY - 10, CY); X = ltNeg(grow, lgaName);
        AA = cur.props; AB = cur.stock; AC = cur.days;
      }
      const grp = byLga.get(normLga(lgaName)) || [];
      const AE = avgOf(grp, 'AE'), AF = avgOf(grp, 'AF'), AG = avgOf(grp, 'AG');
      const I = (isNum(K) && isNum(AG) && AG !== 0) ? annualPmt(K * cfg.lvr, cfg.rate, cfg.term) / (AG * 52) : null;
      const J = isNum(I) ? (I - cfg.floor) / (cfg.ceiling - cfg.floor) : null;
      const D = (isNum(I) && isNum(N)) ? clockPos(J + N, cfg.clockO, cfg.clockP) : null;
      lgaRows.push({ lga: lgaName, D, E: R, I, J, K, L: cfg.bottomYear, M, N, O, P, Q, R, S, T, V, W, X, AA, AB, AC, AE, AF, AG });
    }

    return { lgaRows, suburbRows };
  }

  root.RegionDashboardCalc = { computeRegionDashboard, normLga };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
