/* =============================================================================
   national-report-calc.js — the National (AUSTRALIA) report mart calculator.

   The National report tab is structurally different from the regional ones: its
   price columns are AGGREGATES (cap-city median = median across capitals,
   regional median = median across regional cities) and the rest come from the
   national-level raw series. Pure JS, dual-use (globalThis.NationalReportCalc).

   computeNationalReport({ rows, capitals, regionals, years }) -> [ {year, ...} ]

   Covers the columns derivable from current raw. DEFERRED (await their raw):
   FHB, retail turnover, value-of-work, industry/mining, federal budget,
   govt debt, job vacancies, owner/investor, arrears, household-type, pyramid.
   ============================================================================= */
(function (root) {
  'use strict';
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const median = arr => { const a = arr.filter(x => num(x) != null).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const pct = (c, p) => (num(c) != null && num(p) && p !== 0) ? (c - p) / p : null;
  const STATECAP = { nsw: 'sydney', vic: 'melbourne', qld: 'brisbane', wa: 'perth', sa: 'adelaide', nt: 'darwin', act: 'canberra', tas: 'hobart' };

  function computeNationalReport({ rows, capitals, regionals, years }) {
    const idx = Object.create(null);
    for (const r of rows || []) { const k = r.region_slug + '|' + r.metric; (idx[k] || (idx[k] = {}))[+String(r.period).slice(0, 4)] = num(r.value); }
    const g = (s, m, y) => { const o = idx[s + '|' + m]; return o && o[y] != null ? o[y] : null; };
    const capMed = y => median(capitals.map(s => g(s, 'mp_h', y)));
    const regMed = y => median(regionals.map(s => g(s, 'mp_h', y)));

    const out = [];
    for (const y of years) {
      const C = g('australia', 'bank_rate', y), E = g('australia', 'median_income', y);
      const G = capMed(y), I = regMed(y);
      const O = g('australia', 'population', y), Op = g('australia', 'population', y - 1);
      const ah = g('australia', 'approvals_h', y), au = g('australia', 'approvals_u', y);
      const ch = g('australia', 'commenced_h', y), cu = g('australia', 'commenced_u', y);
      const sm = {}; for (const st in STATECAP) sm[st] = g(STATECAP[st], 'mp_h', y);
      out.push({
        year: y,
        cash_rate: g('australia', 'cash_rate', y), bank_rate: C, inflation: g('australia', 'inflation', y), median_income: E,
        annualized_income: num(E) != null ? E * 52 : null,
        cap_city_median: G, cap_city_pct: pct(G, capMed(y - 1)),
        regional_median: I, regional_pct: pct(I, regMed(y - 1)),
        ai_cap_city: (num(G) != null && num(C) != null && num(E) && E !== 0) ? (G * 0.8 * C) / (52 * E) : null,
        ai_regions: (num(I) != null && num(C) != null && num(E) && E !== 0) ? (I * 0.8 * C) / (52 * E) : null,
        p2i_cap_city: (num(G) != null && num(E) && E !== 0) ? G / (52 * E) : null,
        p2i_regions: (num(I) != null && num(E) && E !== 0) ? I / (52 * E) : null,
        population: O, pop_change: (num(O) != null && num(Op) != null) ? O - Op : null, pop_pct: pct(O, Op),
        natural_increase: g('australia', 'natural_increase', y), nom: g('australia', 'nom', y),
        unemployment: g('australia', 'unemployment', y), underemployment: g('australia', 'underemployment', y),
        commenced_h: ch, commenced_u: cu, commenced_total: (num(ch) != null && num(cu) != null) ? ch + cu : null,
        approvals_h: ah, approvals_u: au, approvals_total: (num(ah) != null && num(au) != null) ? ah + au : null,
        bedroom_commencements: (num(ah) != null && num(au) != null) ? ((ah + au) * 0.8) * 2.5 : null,
        state_median_house: sm,
      });
    }
    return out;
  }

  root.NationalReportCalc = { computeNationalReport };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
