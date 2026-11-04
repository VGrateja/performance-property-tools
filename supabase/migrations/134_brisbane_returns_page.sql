-- =============================================================================
-- 134_brisbane_returns_page.sql — seed the Brisbane Returns client page
--
-- Second client page on the client_pages table (migration 127), duplicating
-- Adelaide's structure for Brisbane: tools/brisbane-returns.html (Vault
-- editor/preview) + client/brisbane-returns.html (public page, no sign-in).
--
-- All PP figures (medianIrr, medianCagr, medianHoldYears, medianPurchasePrice,
-- properties, depositPct, lvr, purchasePeriodLabel, asAtLabel) are null on
-- purpose — same as Adelaide's original seed before Shaene supplied real
-- numbers (see docs/pp-os-migration/adelaide-returns.md, "known gaps"). The
-- public page already handles every blank PP figure as "—" and skips the PP
-- bar/line/point rather than drawing a zero. The "Update returns data" button
-- on the IRR Calculator's Overview tab (tools/irr-calculator.html) fills
-- these in once Brisbane properties are in the book — it merges into this
-- row's `pp` block only, never touching the rest of the payload.
--
-- Benchmarks: the five national series (ASX 200, NASDAQ-100 AUD, AusBond
-- Composite, A-REITs, cash, Australian residential) are the SAME sourced
-- figures as Adelaide's row — they are national index series, not specific
-- to any one city, so they are reused rather than re-researched. A
-- `bne_resi` (Brisbane residential) row is included for structural parity
-- with Adelaide's `adl_resi` row, but is a PLACEHOLDER: `include: false` and
-- an empty `annual`/`yield` map, because no Brisbane-specific Cotality dwelling
-- series has been researched yet. Fill it in (and flip `include` on) once
-- research supplies it — do not guess the figures.
--
-- `on conflict (key) do nothing`: if a Brisbane row already exists (e.g.
-- someone seeded one by hand before this migration ran), this migration
-- leaves it alone rather than clobbering it.
-- =============================================================================

insert into public.client_pages (key, payload)
values (
  'brisbane-returns-2026',
  $json$
  {
    "version": 1,
    "years": ["2015", "2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025", "2026YTD"],
    "window": { "endDate": "2026-09-30", "ytdEnd": "2026-09-30" },
    "pp": {
      "label": "Performance Property — Brisbane (research-selected)",
      "properties": null, "medianIrr": null, "medianCagr": null, "medianHoldYears": null,
      "medianPurchasePrice": null, "depositPct": null, "lvr": null,
      "purchasePeriodLabel": null, "asAtLabel": null,
      "source": "Performance Property IRR calculator: medians across the Brisbane properties our clients have sold; net of purchase costs and our fee, before tax. Not yet available — push live figures from the IRR Calculator's Overview tab (Update returns data)."
    },
    "ppYears": {
      "returns": { "2015": null, "2016": null, "2017": null, "2018": null, "2019": null, "2020": null, "2021": null, "2022": null, "2023": null, "2024": null, "2025": null, "2026YTD": null },
      "source": "Performance Property IRR calculator, Brisbane: pooled return on client cash — not yet available."
    },
    "benchmarks": [
      { "key": "asx200", "label": "Australian shares (ASX 200)", "kind": "total", "include": true,
        "annual": { "2015": 0.0256, "2016": 0.118, "2017": 0.118, "2018": -0.0284, "2019": 0.234, "2020": 0.014, "2021": 0.1723, "2022": -0.0108, "2023": 0.1242, "2024": 0.1144, "2025": 0.1032, "2026YTD": 0.0374 },
        "source": "S&P/ASX 200 Accumulation (S&P DJI total-return levels and factsheet; 2015 FIIG/Schroders)" },
      { "key": "us_shares", "label": "US shares (NASDAQ-100, in AUD)", "kind": "total", "include": true,
        "annual": { "2015": 0.2321, "2016": 0.0831, "2017": 0.2338, "2018": 0.1055, "2019": 0.4049, "2020": 0.3542, "2021": 0.3534, "2022": -0.2758, "2023": 0.5366, "2024": 0.385, "2025": 0.1242, "2026YTD": 0.1608 },
        "source": "NASDAQ-100 Total Return (Nasdaq XNDX levels) converted to AUD with RBA F11 month-end AUD/USD" },
      { "key": "au_bonds", "label": "Australian bonds (AusBond Composite)", "kind": "total", "include": true,
        "annual": { "2015": 0.026, "2016": 0.029, "2017": 0.037, "2018": 0.045, "2019": 0.073, "2020": 0.045, "2021": -0.0287, "2022": -0.0971, "2023": 0.0506, "2024": 0.0293, "2025": 0.0317, "2026YTD": 0.0076 },
        "source": "Bloomberg AusBond Composite 0+Yr (BlackRock IAF benchmark 2021-26; Schroders 2015-20)" },
      { "key": "areits", "label": "Listed property (A-REITs)", "kind": "total", "include": true,
        "annual": { "2015": 0.143, "2016": 0.1316, "2017": 0.0572, "2018": 0.0291, "2019": 0.1936, "2020": -0.0461, "2021": 0.2614, "2022": -0.2046, "2023": 0.1759, "2024": 0.185, "2025": 0.0924, "2026YTD": -0.1312 },
        "source": "S&P/ASX 200 A-REIT Accumulation (S&P DJI; 2015 Schroders)" },
      { "key": "cash", "label": "Cash (bank bills)", "kind": "total", "include": true,
        "annual": { "2015": 0.023, "2016": 0.021, "2017": 0.017, "2018": 0.019, "2019": 0.015, "2020": 0.004, "2021": 0, "2022": 0.013, "2023": 0.039, "2024": 0.045, "2025": 0.04, "2026YTD": 0.0313 },
        "source": "Bloomberg AusBond Bank Bill Index (Schroders); 2026 YTD S&P/ASX Bank Bill (BlackRock BILL)" },
      { "key": "aus_resi", "label": "Australian residential property", "kind": "growth+yield", "include": true,
        "annual": { "2015": 0.083, "2016": 0.058, "2017": 0.042, "2018": -0.048, "2019": 0.023, "2020": 0.03, "2021": 0.245, "2022": -0.049, "2023": 0.085, "2024": 0.049, "2025": 0.086, "2026YTD": -0.03 },
        "yield": { "2015": 0.04, "2016": 0.038, "2017": 0.039, "2018": 0.04, "2019": 0.038, "2020": 0.037, "2021": 0.032, "2022": 0.038, "2023": 0.037, "2024": 0.037, "2025": 0.036, "2026YTD": 0.039 },
        "source": "Cotality Home Value Index, national dwellings, calendar-year change (latest stated vintage); Cotality national gross rental yield at year end (2015-16 estimated from combined capitals)" },
      { "key": "bne_resi", "label": "Brisbane residential property", "kind": "growth+yield", "include": false,
        "annual": {}, "yield": {},
        "source": "Pending — Brisbane-specific Cotality dwelling series not yet researched. Placeholder row so this payload's structure matches Adelaide's adl_resi row; fill in and set include=true once research supplies it." }
    ],
    "selection": {
      "ppLabel": "Performance Property Brisbane purchases (median CAGR)",
      "compare": [
        { "key": "bne_resi", "label": "Brisbane dwellings (the market)" },
        { "key": "aus_resi", "label": "Australian dwellings (the market)" }
      ]
    },
    "risk": {
      "ppRisk": 12,
      "ppLabel": "Performance Property — Brisbane (research-selected)",
      "xLabel": "Risk score (higher = riskier)",
      "yLabel": "20-year average return p.a.",
      "source": "Performance Property research: risk v long-term return table (Commercial Market deck). Risk score = the sum of five scores — purchasing power, risk of losing capital, share of return from income, how quickly it converts to cash, and volatility.",
      "rows": [
        { "label": "Cash", "risk": 10, "reward": 0 },
        { "label": "Term Deposits", "risk": 14, "reward": 0.02 },
        { "label": "Metals - Gold, Copper, Silver", "risk": 18, "reward": 0.095 },
        { "label": "Government Bonds", "risk": 5, "reward": 0.0379 },
        { "label": "Corporate Bonds", "risk": 15, "reward": 0.065 },
        { "label": "Corporate Bonds Fund", "risk": 5, "reward": 0.06 },
        { "label": "1st Mortgage Secured Debt", "risk": 5, "reward": 0.08 },
        { "label": "2nd Mortgage Secured Debt", "risk": 12, "reward": 0.12 },
        { "label": "Direct Shares", "risk": 23, "reward": 0.1 },
        { "label": "Indexed ETF", "risk": 13, "reward": 0.09 },
        { "label": "Managed Funds", "risk": 15, "reward": 0.12 },
        { "label": "Direct Residential Property", "risk": 9, "reward": 0.11 },
        { "label": "Leverage Residential Property", "risk": 12, "reward": 0.15 },
        { "label": "Direct Commercial Property", "risk": 10, "reward": 0.11 },
        { "label": "Leverage Commercial Property", "risk": 13, "reward": 0.15 },
        { "label": "REITS", "risk": 13, "reward": 0.09 },
        { "label": "Private Equity", "risk": 21, "reward": 0.175 },
        { "label": "Private Equity Fund", "risk": 12, "reward": 0.12 },
        { "label": "Performance Property Funds", "risk": 14, "reward": 0.15 },
        { "label": "Development Equity", "risk": 30, "reward": 0.2 },
        { "label": "Development Equity Fund", "risk": 20, "reward": 0.175 },
        { "label": "Crypto (Bitcoin)", "risk": 32, "reward": 0.25 }
      ]
    },
    "text": {
      "eyebrow": "Performance Property · Brisbane research",
      "title": "Brisbane: what research-led property did for your deposit",
      "subtitle": "Our Brisbane purchases set against shares, bonds, listed property, cash and the property market over the same years",
      "meta": "Medians across the {properties} Brisbane properties our clients have sold · Performance Property IRR calculator",
      "beforeTax": { "title": "All figures on this page are before tax", "body": "Our Brisbane results and every investment we compare them with are shown before tax, so they compare like for like. The tax you pay depends on your own circumstances." },
      "tiles": { "irr": "Median IRR on your cash", "cagr": "Median capital growth (CAGR)", "hold": "Median hold", "properties": "Brisbane properties sold" },
      "headings": {
        "deposit": "Your deposit, over the same years", "yearByYear": "Year by year",
        "risk": "Risk v return", "legal": "Legal notices", "disclaimer": "Disclaimer", "riskWarning": "Risk warning"
      },
      "depositLine": "At the median Brisbane purchase price of {price}, a client put in {deposit} of their own cash — {depositPct} of the price, covering the deposit and purchase costs. The loan, {loanPct} of the price, is not counted here. This is what that same {deposit} became.",
      "windowLine": "Over {hold} years: {startLabel} to {endLabel}.",
      "takeaways": {
        "deposit": "At the median Brisbane IRR of {ppIrr}, {deposit} grew to {ppEnd} over {hold} years. The chart shows what the same cash became in each alternative over the same dates.",
        "yearByYear": "Shares and listed property rise and fall from year to year. Held through the cycle, our research-selected Brisbane purchases compounded at a median {ppIrr} on the client's cash.",
        "risk": "Each point is an investment type, placed by our research team's risk score against its long-run return. The teal point places our research-selected Brisbane purchases at their median IRR — research is how we aim to earn a leveraged-property return without taking on more risk."
      },
      "notes": {
        "yearByYear": "The Performance Property line applies the median IRR evenly across the period; it is not a year-by-year valuation of the properties. The other lines compound each year's published return.",
        "risk": "The teal point uses the median Brisbane IRR over {hold} years, not a 20-year average, at a risk score set by our research team."
      },
      "footnotes": {
        "leverage": "Important: the Performance Property figure is the return on the client's own cash — the deposit and purchase costs, {depositPct} of the purchase price. A loan covered the other {loanPct} of the price, and borrowing magnifies both gains and losses. Every alternative is shown unleveraged: the same cash invested with no borrowing.",
        "method": "How the comparison works: each alternative compounds its calendar-year total return over the same {hold}-year period ({startLabel} to {endLabel}); a part year counts in proportion to the time inside the period, and 2026 runs to {ytdEndLabel}. Residential property = capital growth plus gross rental yield, before costs. Index returns are before fees and tax. Performance Property figures are medians across the {properties} Brisbane properties our clients have sold, from the IRR calculator, and are after purchase costs and our fee; properties still held have no IRR yet."
      },
      "sourcesLabel": "Sources",
      "footer": "Performance Property · performanceproperty.com.au"
    },
    "legal": {
      "disclaimer": "This page has been prepared by Performance Property for general information only. It does not take into account your objectives, financial situation or needs, and it is not personal financial, tax or legal advice. Before acting on it, consider whether it is appropriate for you and seek independent professional advice.\n\nThe figures are drawn from sources believed to be reliable, including Performance Property's own purchase records and published index data, but they are not guaranteed to be accurate or complete and may change without notice. To the extent permitted by law, Performance Property and its staff accept no liability for any loss arising from reliance on this information.",
      "riskWarning": "Past performance is not a reliable indicator of future performance. Property values and rents can fall as well as rise. Borrowing to invest magnifies both gains and losses, and you can lose more than your deposit.\n\nThe Performance Property figures are medians across past purchases: individual results varied, and your result will depend on the property, the price paid, the loan, interest rates, costs, tax and how long you hold. Index returns for the other investments are before fees and tax, and you cannot invest in an index directly."
    }
  }
  $json$::jsonb
)
on conflict (key) do nothing;
