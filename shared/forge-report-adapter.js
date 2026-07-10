/* ════════════════════════════════════════════════════════════════════
   shared/forge-report-adapter.js  —  window.ForgeReportAdapter
   ────────────────────────────────────────────────────────────────────
   Turns a Forge mart payload (rdp_report_feed: { years[], extras{} }) into
   the EXACT feed shape the Online Reports chart code already consumes
   (regions.<slug> — a flat object of named arrays, see the live Apps
   Script `capital` feed). The chart/axis/decimal/legend code is NOT
   touched: feed it the same-shaped numbers and it renders identically.

   Presentation rules preserved here (see feedback_report_forge_transition_rules):
     • Each series is CLIPPED to its current first data-year (STARTS) so the
       chart's start year never changes — even where Forge has MORE history.
       New years extend forward naturally (axis max = latest mart year).
     • Missing/clipped cells are '' (empty), matching the feed, so the
       renderer treats them as no-data exactly as today.
     • Values are passed through raw/full-precision — decimals are applied
       by the chart renderer, not here.

   PASS 1 (this file): annual series + derived annual + long-term CAGR +
   current JCI. PASS 2 (todo): monthly section (price/lending/jci/arrears),
   commodities, industry/CIV/pyramid label-maps, mineral exploration,
   approvals-commencements-completions, listings.
   ════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  // First data-year per feed field — Forge is clipped to these (rule #2).
  var STARTS = {
    cashRate:1990, bankRate:1980, medianIncome:1980, medianHousePrice:1978, medianUnitPrice:1983,
    salesHouse:1980, salesUnits:1980, salesTotal:1980, pctDifferenceHvU:1980, houseYoY:1980, unitYoY:1984,
    cagrHouse3yr:2010, cagrHouse10yr:2010, cagrUnit3yr:2010, cagrUnit10yr:2010,
    piRepaymentsHouse:1983, piRepaymentsUnits:1983, aiPiLoanHouse:1983, aiPiLoanUnit:1983, aiHouseStateIncome:1983, aiUnitStateIncome:1983,
    priceToIncomeHouse:1983, priceToIncomeUnit:1983, adomHouse:2017, adomUnit:2017, somHouse:2010, somUnit:2010,
    vacancyRate:2005, medianRentHouse:2001, medianRentUnit:2001, rentToIncomeHouse:2010, rentToIncomeUnit:2010,
    grossYieldHouse:2010, grossYieldUnit:2010, populationMetro:2001, changeMetro:2002, populationState:1981,
    changeState:1982, populationNational:1981, changeNational:1982, naturalIncrease:1982, nim:1982, nom:1982,
    unemploymentMetro:1999, unemploymentState:1979, unemploymentNational:1979,
    buildingApprovalsHouse:2002, buildingApprovalsUnits:2002, buildingApprovalsTotal:2002,
    retailTurnover:1983, businessInvestment:1990, annualisedFhb:2003, fhbPctPopulation:2003,
    capCityComparison:1975, capCityPctDifference:1978, sydneyMedianUnit:1980, unitCapCityDifference:1982,
    inflationRate:1975, changeVr:2006, changeRentH:2002, changeMhp:1978, changeIncome:1981,
    newPopMetro:2002, household:2002,
    gold:1980, goldChange:1981, goldIndexed:1981, ironOre:1980, ironOreChange:1981, ironOreIndexed:1981,
    crudeOil:1980, crudeOilChange:1981, crudeOilIndexed:1981, silver:1980, silverChange:1981, silverIndexed:1981,
    copper:1980, copperChange:1981, copperIndexed:1981
  };
  var FLOOR = 1975;  // = min(STARTS); the master year axis starts here, matching the feed.

  // feed annual field -> mart years[] key (direct passthrough)
  var ANNUAL = {
    cashRate:'cash_rate', bankRate:'bank_rate', medianIncome:'median_income', medianHousePrice:'mp_h', medianUnitPrice:'mp_u',
    salesHouse:'sales_h', salesUnits:'sales_u', salesTotal:'sales_total', pctDifferenceHvU:'pct_diff_hu', houseYoY:'house_yoy', unitYoY:'unit_yoy',
    cagrHouse3yr:'cagr_h_3', cagrHouse10yr:'cagr_h_10', cagrUnit3yr:'cagr_u_3', cagrUnit10yr:'cagr_u_10',
    piRepaymentsHouse:'pi_house', piRepaymentsUnits:'pi_unit', aiPiLoanHouse:'ai_pi_house', aiPiLoanUnit:'ai_pi_unit',
    aiHouseStateIncome:'ai_house_state', aiUnitStateIncome:'ai_unit_state', priceToIncomeHouse:'p2i_house', priceToIncomeUnit:'p2i_unit',
    adomHouse:'adom_h', adomUnit:'adom_u', somHouse:'som_h', somUnit:'som_u', vacancyRate:'vacancy_rate', medianRentHouse:'rent_h', medianRentUnit:'rent_u',
    rentToIncomeHouse:'rent2inc_house', rentToIncomeUnit:'rent2inc_unit', grossYieldHouse:'yield_house', grossYieldUnit:'yield_unit',
    populationMetro:'pop_metro', changeMetro:'pct_change_metro', populationState:'pop_state', changeState:'pct_change_state', populationNational:'pop_national', changeNational:'pct_change_national',
    naturalIncrease:'natural_increase', nim:'nim', nom:'nom', unemploymentMetro:'unemp_metro', unemploymentState:'unemp_state', unemploymentNational:'unemp_national',
    buildingApprovalsHouse:'approvals_h', buildingApprovalsUnits:'approvals_u', buildingApprovalsTotal:'approvals_total',
    retailTurnover:'retail_turnover', businessInvestment:'business_investment', annualisedFhb:'annualised_fhb', fhbPctPopulation:'fhb_pct',
    capCityComparison:'capcity_benchmark', capCityPctDifference:'capcity_pct_diff', sydneyMedianUnit:'capcity_benchmark_unit',
    inflationRate:'inflation_rate', newPopMetro:'new_pop_metro', household:'household',
    gold:'gold', goldChange:'gold_chg', goldIndexed:'gold_idx',
    ironOre:'iron_ore', ironOreChange:'iron_ore_chg', ironOreIndexed:'iron_ore_idx',
    crudeOil:'crude_oil', crudeOilChange:'crude_oil_chg', crudeOilIndexed:'crude_oil_idx',
    silver:'silver', silverChange:'silver_chg', silverIndexed:'silver_idx',
    copper:'copper', copperChange:'copper_chg', copperIndexed:'copper_idx'
  };

  // ANZSIC divisions in the report's fixed display order, slug -> full label.
  var INDUSTRY = [
    ['agriculture_forestry_and_fishing', 'Agriculture, Forestry and Fishing'],
    ['mining', 'Mining'],
    ['manufacturing', 'Manufacturing'],
    ['electricity_gas_water_and_waste_services', 'Electricity, Gas, Water and Waste Services'],
    ['construction', 'Construction'],
    ['wholesale_trade', 'Wholesale Trade'],
    ['retail_trade', 'Retail Trade'],
    ['accommodation_and_food_services', 'Accommodation and Food Services'],
    ['transport_postal_and_warehousing', 'Transport, Postal and Warehousing'],
    ['information_media_and_telecommunications', 'Information Media and Telecommunications'],
    ['financial_and_insurance_services', 'Financial and Insurance Services'],
    ['rental_hiring_and_real_estate_services', 'Rental, Hiring and Real Estate Services'],
    ['professional_scientific_and_technical_services', 'Professional, Scientific and Technical Services'],
    ['administrative_and_support_services', 'Administrative and Support Services'],
    ['public_administration_and_safety', 'Public Administration and Safety'],
    ['education_and_training', 'Education and Training'],
    ['health_care_and_social_assistance', 'Health Care and Social Assistance'],
    ['arts_and_recreation_services', 'Arts and Recreation Services'],
    ['other_services', 'Other Services']
  ];
  // Current Investment Value compares the 5 mainland capitals, in this display order.
  var CIV_ORDER = [['brisbane', 'Brisbane'], ['adelaide', 'Adelaide'], ['perth', 'Perth'], ['melbourne', 'Melbourne'], ['sydney', 'Sydney']];

  function has(v) { return v !== '' && v != null && !(typeof v === 'number' && isNaN(v)); }

  function forgeRegionToFeed(payload, region) {
    var years = (payload && payload.years) || [];
    var extras = (payload && payload.extras) || {};
    var byYear = {}; years.forEach(function (o) { byYear[o.year] = o; });
    var maxY = years.length ? years[years.length - 1].year : new Date().getFullYear();   // dynamic fallback — no hardcoded year ceiling
    var yearAxis = []; for (var y = FLOOR; y <= maxY; y++) yearAxis.push(y);

    // Per-region start years (window.ForgeReportStarts, generated from the feeds) so
    // each region keeps its own chart start year; fall back to the Perth STARTS map,
    // then FLOOR. Raw fields vary by region (e.g. Melbourne price from 1975); computed
    // fields are a uniform 2010.
    var rs = (root.ForgeReportStarts && root.ForgeReportStarts[region]) || {};
    var startOf = function (ff) { return rs[ff] != null ? rs[ff] : (STARTS[ff] != null ? STARTS[ff] : FLOOR); };

    var out = { year: yearAxis.slice() };
    var cell = function (yr, key) { var o = byYear[yr]; return o && has(o[key]) ? o[key] : ''; };
    // clipped passthrough: '' before the field's start year, else the mart value
    var series = function (start, fn) { return yearAxis.map(function (yr) { return yr < start ? '' : fn(yr); }); };

    // ── direct annual maps ──
    Object.keys(ANNUAL).forEach(function (ff) {
      out[ff] = series(startOf(ff), function (yr) { return cell(yr, ANNUAL[ff]); });
    });

    // ── derived annual ──
    // (changeState = pct_change_state is a direct map above — the report's
    //  "Change in Population" chart wants the state growth %, not absolute persons.)
    out.unitCapCityDifference = series(startOf('unitCapCityDifference'), function (yr) {
      var o = byYear[yr];
      return (o && has(o.mp_u) && has(o.capcity_benchmark_unit) && o.capcity_benchmark_unit) ? o.mp_u / o.capcity_benchmark_unit : '';
    });
    var deltaPct = function (key, start) { return series(start, function (yr) {
      var a = byYear[yr], b = byYear[yr - 1];
      return (a && b && has(a[key]) && has(b[key]) && b[key]) ? (a[key] - b[key]) / b[key] : '';
    }); };
    out.changeVr = deltaPct('vacancy_rate', startOf('changeVr'));
    out.changeRentH = deltaPct('rent_h', startOf('changeRentH'));
    out.changeIncome = deltaPct('median_income', startOf('changeIncome'));
    out.changeMhp = series(startOf('changeMhp'), function (yr) {
      var a = byYear[yr], b = byYear[yr - 1];
      return (a && b && has(a.mp_h) && has(b.mp_h)) ? a.mp_h - b.mp_h : '';
    });

    // ── regional LGA aliases ── the regional reports remap *Metro ← *Lga (the
    // region's own LGA-level data). A capital's mart row carries its GCCSA data
    // in *Metro; a regional's carries its LGA data in *Metro — so *Lga = *Metro
    // works for both (capitals ignore *Lga, regionals use it).
    out.populationLga = out.populationMetro;
    out.changeLga = out.changeMetro;
    out.unemploymentLga = out.unemploymentMetro;
    out.newPopLga = out.newPopMetro;

    // ── long-term CAGR (extras.lt) — feed shape is [LT, 10yr, 7yr, 5yr, 3yr] ──
    if (extras.lt) {
      var ltH = extras.lt.house || {}, ltU = extras.lt.unit || {};
      out.ltCagrHouse = [ltH.lt, ltH.y10, ltH.y7, ltH.y5, ltH.y3];
      out.ltCagrUnit = [ltU.lt, ltU.y10, ltU.y7, ltU.y5, ltU.y3];
      out.ltTrends = ['LT', '10 Years', ' 7 Years', ' 5 Years', ' 3 Years'];  // category labels for the LT chart
    }
    // ── current JCI (latest index, single value) ──
    if (extras.jci != null) out.currentJobCreation = [extras.jci];

    // ── industry value-added (extras.industry: [{sector(slug), value, pct}]) → canonical order + labels ──
    if (extras.industry) {
      var indBy = {}; extras.industry.forEach(function (r) { indBy[r.sector] = r; });
      out.industrySector = []; out.industryValue = []; out.industryPctGsp = [];
      INDUSTRY.forEach(function (p) {
        var r = indBy[p[0]];
        out.industrySector.push(p[1]);
        out.industryValue.push(r ? r.value : '');
        out.industryPctGsp.push(r ? r.pct : '');
      });
    }

    // ── CIV / cap-city gross yields (extras.capcity_yields) → 5-city order ──
    if (extras.capcity_yields) {
      var civBy = {}; extras.capcity_yields.forEach(function (r) { civBy[r.slug] = r; });
      out.currentInvestmentValue = []; out.capCityYieldHouse = []; out.capCityYieldUnit = [];
      CIV_ORDER.forEach(function (p) {
        var r = civBy[p[0]];
        out.currentInvestmentValue.push(p[1]);
        out.capCityYieldHouse.push(r ? r.yield_h : '');
        out.capCityYieldUnit.push(r ? r.yield_u : '');
      });
    }

    // ── population pyramid (extras.pyramid: [{age(slug), metro_pct, state_pct, national_pct}]) ──
    // PCTs only here; counts (pyramidMetro / pyramidNational) need a mart addition (Pass 2b).
    if (extras.pyramid) {
      // numeric bands "0_04" → "0-04"; text band "85_and_over" → "85 and over"
      out.pyramidAge = extras.pyramid.map(function (r) { var a = String(r.age); return /\d_\d/.test(a) ? a.replace(/_/g, '-') : a.replace(/_/g, ' '); });
      out.pyramidPctMetro = extras.pyramid.map(function (r) { return r.metro_pct; });
      out.pyramidPctNational = extras.pyramid.map(function (r) { return r.national_pct; });
      out.pyramidMetro = extras.pyramid.map(function (r) { return r.metro_count != null ? r.metro_count : ''; });
      out.pyramidNational = extras.pyramid.map(function (r) { return r.national_count != null ? r.national_count : ''; });
      // regional aliases: regionals plot LGA vs STATE (not metro vs national)
      out.pyramidLga = out.pyramidMetro;
      out.pyramidPctLga = out.pyramidPctMetro;
      out.pyramidState = extras.pyramid.map(function (r) { return r.state_count != null ? r.state_count : ''; });
      out.pyramidPctState = extras.pyramid.map(function (r) { return r.state_pct != null ? r.state_pct : ''; });
    }

    // ── monthly section: price / lending / JCI / arrears on one unified date axis ──
    // (each series aligns to the union of all months; '' where a series has no value)
    var mp = extras.monthly_price, lend = extras.lending, jm = extras.jci_monthly,
        am = extras.arrears_monthly, amN = extras.arrears_national_monthly;
    var monthSet = {};
    [mp && mp.months, lend && lend.months, jm && jm.months, am && am.months, amN && amN.months]
      .forEach(function (arr) { (arr || []).forEach(function (d) { monthSet[d] = 1; }); });
    var months = Object.keys(monthSet).sort();
    if (months.length) {
      var alignM = function (srcMonths, vals) {
        if (!srcMonths || !vals) return months.map(function () { return ''; });
        var by = {}; srcMonths.forEach(function (d, i) { by[d] = vals[i]; });
        return months.map(function (d) { return (by[d] != null) ? by[d] : ''; });
      };
      out.monthlyDate = months.slice();
      out.medianHouseMonthly = alignM(mp && mp.months, mp && mp.h);
      out.medianUnitMonthly = alignM(mp && mp.months, mp && mp.u);
      out.ownerOccupier = alignM(lend && lend.months, lend && lend.owner_occupier);
      out.investor = alignM(lend && lend.months, lend && lend.investor);
      out.jobCreationIndex = alignM(jm && jm.months, jm && jm.values);
      out.arrearsState = alignM(am && am.months, am && am.values);
      out.arrearsNational = alignM(amN && amN.months, amN && amN.values);
    }

    // ── mineral exploration (extras.mineral_exploration: {quarters[], values[]}) → clip to the report's 2004 start ──
    if (extras.mineral_exploration) {
      var me = extras.mineral_exploration, mq = [], mv = [];
      (me.quarters || []).forEach(function (q, i) { if (String(q) >= '2004') { mq.push(q); mv.push(me.values[i]); } });
      if (mq.length) { out.meQuarter = mq; out.mineralExploration = mv; }
    }

    return out;
  }

  root.ForgeReportAdapter = { forgeRegionToFeed: forgeRegionToFeed, STARTS: STARTS, ANNUAL: ANNUAL, FLOOR: FLOOR };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
