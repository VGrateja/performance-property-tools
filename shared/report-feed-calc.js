/* =============================================================================
   report-feed-calc.js — the report_feed mart calculator.

   Reproduces the per-region "report-ready" columns of the cluster sheets
   (e.g. "Adelaide, SA" in Data - Online Reports (Capital Cities).xlsx) from the
   canonical raw series in rdp_raw_series — so the online reports can read the DB
   instead of the hand-maintained cluster Google Sheets.

   Pure JS, no DOM/network/xlsx deps. Dual-use: Node + browser
   (globalThis.ReportFeedCalc). The caller supplies the raw rows; this computes
   the base + derived columns. Column keys mirror the cluster tab's meaning.

   computeReportFeed({ region, state, benchmark, rows, years }) -> [ {year, ...} ]
     region    : city slug (e.g. 'adelaide')
     state     : state slug (e.g. 'st-sa')      — for median_income / state pop / state unemployment
     benchmark : cap-city slug (default 'sydney') — for the Cap City Comparison column
     rows      : [{ region_slug, metric, period('YYYY-01-01'), value }]  (freq 'A')
     years     : [numbers] to emit

   Deferred (left null until their raw is ingested): retail_turnover,
   business_investment, annualised_fhb, fhb_pct, the monthly medians, JCI,
   arrears, pop-pyramid, industry, CIV, long-term CAGR.
   ============================================================================= */
(function (root) {
  'use strict';

  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  // annual P&I on a 30yr loan at annual rate `rate`, principal `pv` (Excel: -PMT(rate/12,360,pv)*12)
  function annualPI(rate, pv) {
    if (!num(rate) || !num(pv) || rate <= 0) return null;
    const r = rate / 12, n = 360;
    return (r * pv / (1 - Math.pow(1 + r, -n))) * 12;
  }
  const div = (a, b) => (num(a) != null && num(b) && b !== 0) ? a / b : null;
  const pct = (cur, prev) => (num(cur) != null && num(prev) && prev !== 0) ? (cur - prev) / prev : null;
  const cagr = (cur, base, n) => (num(cur) != null && num(base) && base > 0) ? Math.pow(cur / base, 1 / n) - 1 : null;

  function computeReportFeed(input) {
    const { region, state, benchmark = 'sydney', rows, years } = input;
    const idx = Object.create(null);                    // "slug|metric" -> { year: value }
    for (const r of rows || []) {
      const k = r.region_slug + '|' + r.metric;
      (idx[k] || (idx[k] = {}))[+String(r.period).slice(0, 4)] = num(r.value);
    }
    const g = (slug, metric, y) => { const m = idx[slug + '|' + metric]; return m && m[y] != null ? m[y] : null; };

    const out = [];
    for (const y of years) {
      const E = g(region, 'mp_h', y), F = g(region, 'mp_u', y);
      const C = g('australia', 'cash_rate', y), B = C, BankC = g('australia', 'bank_rate', y);
      const D = g(state, 'median_income', y);
      const sales_h = g(region, 'sales_h', y), sales_u = g(region, 'sales_u', y);
      const AD = g(region, 'rent_h', y), AE = g(region, 'rent_u', y);
      const AJ = g(region, 'population', y), ALp = g(state, 'population', y), AN = g('australia', 'population', y);
      const AJp = g(region, 'population', y - 1), ALpp = g(state, 'population', y - 1), ANp = g('australia', 'population', y - 1);
      const BW = g(benchmark, 'mp_h', y);
      const Qv = annualPI(BankC, num(E) != null ? E * 0.8 : null);   // repayments use the BANK rate (cluster col C), not cash rate
      const Rv = annualPI(BankC, num(F) != null ? F * 0.8 : null);

      out.push({
        year: y,
        // ── base (from raw) ──
        cash_rate: C, bank_rate: BankC, median_income: D,
        mp_h: E, mp_u: F, sales_h, sales_u,
        adom_h: g(region, 'adom_h', y), adom_u: g(region, 'adom_u', y),
        som_h: g(region, 'som_h', y), som_u: g(region, 'som_u', y),
        vacancy_rate: g(region, 'vacancy_rate', y), rent_h: AD, rent_u: AE,
        pop_metro: AJ, pop_state: ALp, pop_national: AN,
        natural_increase: g(region, 'natural_increase', y) ?? g(state, 'natural_increase', y),   // capitals carry these at state level
        nim: g(region, 'nim', y) ?? g(state, 'nim', y),
        nom: g(region, 'nom', y) ?? g(state, 'nom', y),
        unemp_metro: g(region, 'unemployment', y), unemp_state: g(state, 'unemployment', y), unemp_national: g('australia', 'unemployment', y),
        approvals_h: g(region, 'approvals_h', y), approvals_u: g(region, 'approvals_u', y),
        capcity_benchmark: BW,
        // ── derived ──
        sales_total: (num(sales_h) != null && num(sales_u) != null) ? sales_h + sales_u : null,
        pct_diff_hu: div(F, E),
        house_yoy: pct(E, g(region, 'mp_h', y - 1)),
        unit_yoy: pct(F, g(region, 'mp_u', y - 1)),
        cagr_h_3: cagr(E, g(region, 'mp_h', y - 3), 3),
        cagr_h_10: cagr(E, g(region, 'mp_h', y - 10), 10),
        cagr_u_3: cagr(F, g(region, 'mp_u', y - 3), 3),
        cagr_u_10: cagr(F, g(region, 'mp_u', y - 10), 10),
        pi_house: Qv, pi_unit: Rv,
        ai_pi_house: div(Qv, num(D) != null ? 52 * D : null),
        ai_pi_unit: div(Rv, num(D) != null ? 52 * D : null),
        ai_house_state: (num(E) != null && num(BankC) != null && num(D) && D !== 0) ? (E * 0.8 * BankC) / (52 * D) : null,
        ai_unit_state: (num(F) != null && num(BankC) != null && num(D) && D !== 0) ? (F * 0.8 * BankC) / (52 * D) : null,
        p2i_house: div(E, num(D) != null ? D * 52 : null),
        p2i_unit: div(F, num(D) != null ? D * 52 : null),
        rent2inc_house: div(AD, D), rent2inc_unit: div(AE, D),
        yield_house: div(num(AD) != null ? AD * 52 : null, E),
        yield_unit: div(num(AE) != null ? AE * 52 : null, F),
        pct_change_metro: pct(AJ, AJp), pct_change_state: pct(ALp, ALpp), pct_change_national: pct(AN, ANp),
        approvals_total: (num(g(region, 'approvals_h', y)) != null && num(g(region, 'approvals_u', y)) != null) ? g(region, 'approvals_h', y) + g(region, 'approvals_u', y) : null,
        capcity_pct_diff: div(E, BW),
        new_pop_metro: (num(AJ) != null && num(AJp) != null) ? AJ - AJp : null,
        household: (num(AJ) != null && num(AJp) != null) ? (AJ - AJp) / 2.5 : null,
        // ── deferred (raw not yet ingested) ──
        retail_turnover: null, business_investment: null, annualised_fhb: null, fhb_pct: null,
      });
    }
    return out;
  }

  root.ReportFeedCalc = { computeReportFeed };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
