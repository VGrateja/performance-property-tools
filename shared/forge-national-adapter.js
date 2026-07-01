/* ════════════════════════════════════════════════════════════════════
   shared/forge-national-adapter.js  —  window.ForgeNationalAdapter

   Assembles the National report's FLAT data object ({ year:[...],
   <columnKey>:[...] }) from Forge, so the (already-built) national-charts.js
   builders + renderAllCharts render it. Used only with ?src=forge.

   Inputs (fetched by the report):
     natOnly  = forge_national_only.data  (workDone, gdpByCountry, federalBudget,
                govtDebtGdp, householdDebtIncome, householdComposition, cashRate)
     rdpNat   = rdp_raw_series rows for region_slug='australia' (national series)

   PoC scope: the fields that map directly (national annual series + forge_national_only).
   TODO (gaps needing aggregation): state median house prices, capCity/regional
   median aggregates, affordability (aiCapCity/aiRegions/priceToIncome*).
   ════════════════════════════════════════════════════════════════════ */
(function (root) {
  function assemble(natOnly, rdpNat, martRows, stateRows) {
    natOnly = natOnly || {};
    rdpNat = rdpNat || [];
    martRows = martRows || [];
    stateRows = stateRows || [];
    // index national annual series by metric → {year: value}
    const A = {};
    for (const r of rdpNat) {
      if (r.freq !== 'A') continue;
      const y = +String(r.period).slice(0, 4);
      (A[r.metric] || (A[r.metric] = {}))[y] = Number(r.value);
    }
    const yearsSet = new Set();
    for (const m in A) for (const y in A[m]) yearsSet.add(+y);
    const years = [...yearsSet].sort((a, b) => a - b);
    const ser = metric => years.map(y => (A[metric] && A[metric][y] != null) ? A[metric][y] : null);

    const data = { year: years.map(String) };

    // ── national annual series (rdp_raw_series australia) ──
    data.cashRate = ser('cash_rate');
    data.inflationRate = ser('inflation');
    data.populationNational = ser('population');
    data.naturalIncrease = ser('natural_increase');
    data.buildingApprovalsHouse = ser('approvals_h');
    data.buildingApprovalUnits = ser('approvals_u');
    data.buildingApprovalsTotal = ser('building_approvals_total');
    data.dwellingCommencedH = ser('commenced_h');
    data.dwellingCommencedOther = ser('commenced_u');
    data.dwellingCommencedTotal = ser('commenced_h').map((h, i) => { const u = data.dwellingCommencedOther[i]; return (h != null && u != null) ? h + u : (h != null ? h : u); });
    data.ownerOccupierAbs = ser('owner_occupier');
    data.investorAbs = ser('investor');
    data.annualizedFhb = ser('fhb');
    data.manufacturingIndustry = ser('bus_inv_manufacturing');
    data.miningIndustry = ser('bus_inv_mining');
    data.totalIncludingEducationAndHealth = ser('bus_investment');
    // retail spending YoY % change (from national annual retail turnover)
    data.retailTurnoverChange = ser('retail_turnover').map((v, i, arr) => { const p = arr[i - 1]; return (v != null && p != null && p !== 0) ? (v - p) / p : null; });
    data.nationalJobVacanciesPrivate = ser('job_vacancies_private');
    data.nationalJobVacanciesPublic = ser('job_vacancies_public');
    data.nationalInternetJobVacancies = ser('internet_vacancies');

    // ── forge_national_only ──
    const gdp = (natOnly.gdpByCountry && natOnly.gdpByCountry.rows) || [];
    data.country = gdp.map(r => r.country != null ? r.country : r.code);
    data.nominalGdpInTrillions = gdp.map(r => r.gdpTn != null ? r.gdpTn : r.nominalGdp);
    data.debtToGdpRatio = gdp.map(r => r.debtPct != null ? r.debtPct : r.debtToGdp);
    if (natOnly.workDone) { data.valueOfWorkDonePublic = natOnly.workDone.public; data.valueOfWorkDonePrivate = natOnly.workDone.private; data.workDonePeriods = natOnly.workDone.periods; }
    if (natOnly.federalBudget) { data.federalBudgetDates = natOnly.federalBudget.fy; data.federalBudgetInMillions = natOnly.federalBudget.values; }
    if (natOnly.govtDebtGdp) { data.govtDebtToGdp = natOnly.govtDebtGdp.values; data.govtDebtToGdpYears = natOnly.govtDebtGdp.years; }
    if (natOnly.householdDebtIncome) { data.householdDebttoincomeRatio = natOnly.householdDebtIncome.values; data.householdDebtPeriods = natOnly.householdDebtIncome.periods; }

    // ── aggregates computed from the regional mart (rdp_report_feed) ──
    if (martRows.length) {
      const idx = {};
      for (const r of martRows) { if (r.region_slug === 'australia') continue; const map = {}; for (const row of (r.payload && r.payload.years) || []) map[+row.year] = row; idx[r.region_slug] = { cluster: r.cluster, map: map }; }
      const caps = Object.keys(idx).filter(s => idx[s].cluster === 'capital');
      const regs = Object.keys(idx).filter(s => idx[s].cluster !== 'capital');
      const median = arr => { const v = arr.filter(x => x != null && !isNaN(x)).sort((a, b) => a - b); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
      const agg = (slugs, field) => years.map(y => median(slugs.map(s => { const row = idx[s].map[y]; return row ? row[field] : null; })));
      const capSeries = cap => years.map(y => { const row = idx[cap] && idx[cap].map[y]; return row ? row.mp_h : null; });
      data.capCityMedianPrice = agg(caps, 'mp_h');
      data.regionalMedianPrice = agg(regs, 'mp_h');
      data.priceToIncomeRatioCapCity = agg(caps, 'p2i_house');
      data.priceToIncomeRatioRegions = agg(regs, 'p2i_house');
      data.aiCapCity = agg(caps, 'ai_house_state');
      data.aiRegions = agg(regs, 'ai_house_state');
      // state median house prices — capital proxy (states carry no city median in rdp)
      data.nswMedianHousePrice = capSeries('sydney'); data.vicMedianHousePrice = capSeries('melbourne');
      data.qldMedianHousePrice = capSeries('brisbane'); data.saMedianHousePrice = capSeries('adelaide');
      data.waMedianHousePrice = capSeries('perth'); data.tasMedianHousePrice = capSeries('hobart');
      data.ntMedianHousePrice = capSeries('darwin'); data.actMedianHousePrice = capSeries('canberra');
      data.geelongMedianHousePrice = capSeries('geelong'); data.sunshineCoastMedianHousePrice = capSeries('sunshine-coast');
      data.goldCoastMedianHousePrice = capSeries('gold-coast'); data.centralCoastMedianHousePrice = capSeries('central-coast');
    }

    // ── by-state net internal / overseas migration (rdp states, annual) ──
    if (stateRows.length) {
      const S = {};
      for (const r of stateRows) { if (r.freq !== 'A') continue; const k = r.region_slug + '|' + r.metric; const y = +String(r.period).slice(0, 4); (S[k] || (S[k] = {}))[y] = Number(r.value); }
      const sser = (slug, metric) => years.map(y => { const m = S[slug + '|' + metric]; return (m && m[y] != null) ? m[y] : null; });
      data.nswNim = sser('st-nsw', 'nim'); data.vicNim = sser('st-vic', 'nim'); data.qldNim = sser('st-qld', 'nim'); data.saNim = sser('st-sa', 'nim'); data.waNim = sser('st-wa', 'nim');
      data.nswNom = sser('st-nsw', 'nom'); data.vicNom = sser('st-vic', 'nom'); data.qldNom = sser('st-qld', 'nom'); data.saNom = sser('st-sa', 'nom'); data.waNom = sser('st-wa', 'nom');
    }

    return { _meta: { source: 'forge_national', generated: (natOnly.meta && natOnly.meta.updatedAt) || null }, data };
  }
  root.ForgeNationalAdapter = { assemble: assemble };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
