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
  function assemble(natOnly, rdpNat) {
    natOnly = natOnly || {};
    rdpNat = rdpNat || [];
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

    const out = { _meta: { source: 'forge_national', generated: (natOnly.meta && natOnly.meta.updatedAt) || null }, year: years.map(String) };

    // ── national annual series (rdp_raw_series australia) ──
    out.cashRate = ser('cash_rate');
    out.inflationRate = ser('inflation');
    out.populationNational = ser('population');
    out.naturalIncrease = ser('natural_increase');
    out.buildingApprovalsHouse = ser('approvals_h');
    out.buildingApprovalUnits = ser('approvals_u');
    out.buildingApprovalsTotal = ser('building_approvals_total');
    out.dwellingCommencedH = ser('commenced_h');
    out.dwellingCommencedOther = ser('commenced_u');
    out.dwellingCommencedTotal = ser('commenced_h').map((h, i) => { const u = out.dwellingCommencedOther[i]; return (h != null && u != null) ? h + u : (h != null ? h : u); });
    out.ownerOccupierAbs = ser('owner_occupier');
    out.investorAbs = ser('investor');
    out.annualizedFhb = ser('fhb');
    out.manufacturingIndustry = ser('bus_inv_manufacturing');
    out.miningIndustry = ser('bus_inv_mining');
    out.totalIncludingEducationAndHealth = ser('bus_investment');
    out.nationalJobVacanciesPrivate = ser('job_vacancies_private');
    out.nationalJobVacanciesPublic = ser('job_vacancies_public');
    out.nationalInternetJobVacancies = ser('internet_vacancies');

    // ── forge_national_only ──
    const gdp = (natOnly.gdpByCountry && natOnly.gdpByCountry.rows) || [];
    out.country = gdp.map(r => r.country != null ? r.country : r.code);
    out.nominalGdpInTrillions = gdp.map(r => r.gdpTn != null ? r.gdpTn : r.nominalGdp);
    out.debtToGdpRatio = gdp.map(r => r.debtPct != null ? r.debtPct : r.debtToGdp);
    if (natOnly.workDone) { out.valueOfWorkDonePublic = natOnly.workDone.public; out.valueOfWorkDonePrivate = natOnly.workDone.private; out.workDonePeriods = natOnly.workDone.periods; }
    if (natOnly.federalBudget) { out.federalBudgetDates = natOnly.federalBudget.fy; out.federalBudgetInMillions = natOnly.federalBudget.values; }
    if (natOnly.govtDebtGdp) { out.govtDebtToGdp = natOnly.govtDebtGdp.values; out.govtDebtToGdpYears = natOnly.govtDebtGdp.years; }
    if (natOnly.householdDebtIncome) { out.householdDebttoincomeRatio = natOnly.householdDebtIncome.values; out.householdDebtPeriods = natOnly.householdDebtIncome.periods; }

    return out;
  }
  root.ForgeNationalAdapter = { assemble: assemble };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
