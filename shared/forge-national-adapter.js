/* ════════════════════════════════════════════════════════════════════
   shared/forge-national-adapter.js  —  window.ForgeNationalAdapter

   Assembles the National report's FLAT data object ({ year:[...],
   <columnKey>:[...] }) from Forge, so the (already-built) national-charts.js
   builders + renderAllCharts render it. Forge is the source, so this runs on
   every load (and in the Save-data assembly). The ?src=live / ?src=legacy
   escape hatch that used to skip it was retired 2026-07-30.

   Inputs (fetched by the report):
     natOnly  = forge_national_only.data  (workDone, gdpByCountry, federalBudget,
                govtDebtGdp, householdDebtIncome, householdComposition, cashRate)
     rdpNat   = rdp_raw_series rows for region_slug='australia' (national series)

   PoC scope: the fields that map directly (national annual series + forge_national_only).
   TODO (gaps needing aggregation): state median house prices, capCity/regional
   median aggregates, affordability (aiCapCity/aiRegions/priceToIncome*).
   ════════════════════════════════════════════════════════════════════ */
(function (root) {
  function assemble(natOnly, rdpNat, martRows, stateRows, arrears, pyramid, vacMonthEnd) {
    natOnly = natOnly || {};
    rdpNat = rdpNat || [];
    martRows = martRows || [];
    stateRows = stateRows || [];
    arrears = arrears || {};
    pyramid = pyramid || {};
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
    // national population change % (YoY of population; identical to the regional
    // mart's pct_change_national). Drives p6's right y-axis + the pop-change line.
    data.changeNational = data.populationNational.map((v, i, arr) => { const p = arr[i - 1]; return (v != null && p != null && p !== 0) ? (v - p) / p : null; });
    data.naturalIncrease = ser('natural_increase');
    data.netOverseasMigrationNom = ser('nom');   // national NOM (p24 bar)
    data.buildingApprovalsHouse = ser('approvals_h');
    data.buildingApprovalUnits = ser('approvals_u');
    // rdp building_approvals_total only starts 2004 → fill earlier years (chart
    // shows from 1990) with house + units so the Total line spans the full range.
    data.buildingApprovalsTotal = ser('building_approvals_total').map((t, i) => { if (t != null) return t; const h = data.buildingApprovalsHouse[i], u = data.buildingApprovalUnits[i]; return (h != null && u != null) ? h + u : null; });
    data.dwellingCommencedH = ser('commenced_h');
    data.dwellingCommencedOther = ser('commenced_u');
    data.dwellingCommencedTotal = ser('commenced_h').map((h, i) => { const u = data.dwellingCommencedOther[i]; return (h != null && u != null) ? h + u : (h != null ? h : u); });
    data.ownerOccupierAbs = ser('owner_occupier');
    data.investorAbs = ser('investor');
    data.annualizedFhb = ser('fhb');
    // FHB as a % of population (p15 line) — FHB count ÷ national population.
    // ERP population lags the FHB count by ~a year, so carry the last known
    // population forward for the newest year(s) — else the latest FHB % drops.
    var _lastNatPop = null;
    data.fhbPopulation = data.annualizedFhb.map((v, i) => { const p = data.populationNational[i]; if (p != null) _lastNatPop = p; const den = p != null ? p : _lastNatPop; return (v != null && den != null && den !== 0) ? v / den : null; });
    data.manufacturingIndustry = ser('bus_inv_manufacturing');
    data.miningIndustry = ser('bus_inv_mining');
    data.totalIncludingEducationAndHealth = ser('bus_investment');
    // retail spending YoY % change (from national annual retail turnover)
    data.retailTurnoverChange = ser('retail_turnover').map((v, i, arr) => { const p = arr[i - 1]; return (v != null && p != null && p !== 0) ? (v - p) / p : null; });
    data.nationalUnemployment = ser('unemployment');
    data.nationalUnderemployment = ser('underemployment');
    data.nationalJobVacanciesPrivate = ser('job_vacancies_private');
    data.nationalJobVacanciesPublic = ser('job_vacancies_public');
    data.nationalInternetJobVacancies = ser('internet_vacancies');

    // ── forge_national_only ──
    const gdp = (natOnly.gdpByCountry && natOnly.gdpByCountry.rows) || [];
    data.country = gdp.map(r => r.country != null ? r.country : r.code);
    data.nominalGdpInTrillions = gdp.map(r => r.gdpTn != null ? r.gdpTn : r.nominalGdp);
    data.debtToGdpRatio = gdp.map(r => r.debtPct != null ? r.debtPct / 100 : r.debtToGdp);   // debtPct is % → fraction (p28 right axis does v*100)
    if (natOnly.workDone) {
      // Store is QUARTERLY in $m; p23 plots against the annual `years` axis in
      // $'000s (like the original feed, whose axis formatter divides by 1e6→"m").
      // The original used each year's Q4 (Oct-Dec) quarter as that year's value —
      // replicate: take period YYYY-10-01 and ×1000 ($m → $'000s). Aligning the
      // raw quarterly array to an annual axis was the "numbering wrong" bug.
      const wd = natOnly.workDone, wper = wd.periods || [];
      const q4 = (arr, y) => { const i = wper.indexOf(y + '-10-01'); return (i >= 0 && arr && arr[i] != null) ? arr[i] * 1000 : null; };
      data.valueOfWorkDonePrivate = years.map(y => q4(wd.private, y));
      data.valueOfWorkDonePublic = years.map(y => q4(wd.public, y));
      data.workDonePeriods = wd.periods;
    }
    if (natOnly.federalBudget) { data.federalBudgetDates = natOnly.federalBudget.fy; data.federalBudgetInMillions = natOnly.federalBudget.values; }
    if (natOnly.govtDebtGdp) {
      // Store is % of GDP on its OWN year list (1989-2026); p27 slices by the annual
      // `years` index and expects FRACTIONS (yAxis + formatter ×100). Re-index onto
      // `years` and ÷100 so the line aligns and is on-scale (was missing: raw % on
      // its own axis → off-scale + misaligned).
      const gd = natOnly.govtDebtGdp, gmap = {};
      (gd.years || []).forEach((y, i) => { if (gd.values[i] != null) gmap[String(y)] = gd.values[i] / 100; });
      data.govtDebtToGdp = years.map(y => gmap[String(y)] != null ? gmap[String(y)] : null);
      data.govtDebtToGdpYears = gd.years;
    }
    if (natOnly.householdDebtIncome) {
      const hd = natOnly.householdDebtIncome;
      data.householdDebttoincomeRatio = hd.values;
      data.householdDebtPeriods = hd.periods;
      data.quarterYear = hd.periods;   // p30's x-axis — was unset, so the whole chart returned null
      // quarterly RBA cash rate aligned to those quarters (from the monthly cash_rate)
      const cm = {};
      for (const r of rdpNat) { if (r.metric === 'cash_rate' && r.freq === 'M' && r.value != null) cm[String(r.period).slice(0, 7)] = Number(r.value); }
      data.quarterlyCashRate = (hd.periods || []).map(p => { const ym = String(p).slice(0, 7); return cm[ym] != null ? cm[ym] : null; });
    }

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

      // ── p5 — National & Capital City Vacancy Rate (latest vs 1 year ago) ──
      // All Cotality basis (regional/capital vacancy_rate is Cotality — the "sqm"
      // source label is legacy). NATIONAL is computed by replicating SQM's method:
      // SQM's national rate is a stock-weighted aggregate (Σ vacancies ÷ Σ rental
      // stock), i.e. a rate weighted by each area's rental stock — approximated
      // here as a POPULATION-weighted mean of every region's rate. Each region's
      // weight = its latest known population (pop_metro), applied to both years.
      const vrPop = {};
      for (const s in idx) { const m = idx[s].map; let p = null; for (const y of years) if (m[y] && m[y].pop_metro != null) p = m[y].pop_metro; vrPop[s] = p; }
      const vrAt = (s, y) => { const row = idx[s] && idx[s].map[y]; return (row && row.vacancy_rate != null) ? row.vacancy_rate : null; };
      const vrYears = years.filter(y => Object.keys(idx).some(s => vrAt(s, y) != null));
      const CURR = vrYears.length ? vrYears[vrYears.length - 1] : null;
      const PRIOR = CURR != null ? CURR - 1 : null;
      if (CURR != null) {
        const wnat = y => { let vs = 0, ws = 0; for (const s in idx) { const v = vrAt(s, y), w = vrPop[s]; if (v == null || w == null) continue; vs += v * w; ws += w; } return ws ? vs / ws : null; };
        const capOrder = [['melbourne', 'Melbourne'], ['sydney', 'Sydney'], ['brisbane', 'Brisbane'], ['adelaide', 'Adelaide'], ['darwin', 'Darwin'], ['canberra', 'Canberra'], ['hobart', 'Hobart'], ['perth', 'Perth']];
        const labels = ['National'], prior = [wnat(PRIOR)], curr = [wnat(CURR)];
        for (const [s, name] of capOrder) { labels.push(name); prior.push(vrAt(s, PRIOR)); curr.push(vrAt(s, CURR)); }
        data.vacancyRate = labels;
        data.vacancyRateNov2023 = prior;   // legacy field names — "prior year" bars
        data.vacancyRateNov2024 = curr;    // legacy field names — "latest" bars
        const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const mm = vacMonthEnd ? /^(\d+)\//.exec(String(vacMonthEnd)) : null;
        const mi = mm ? Math.min(11, Math.max(0, (+mm[1]) - 1)) : null;
        data.vacancyRatePriorLabel = (mi != null ? MON[mi] + ' ' : '') + PRIOR;
        data.vacancyRateCurrLabel = (mi != null ? MON[mi] + ' ' : '') + CURR;
      }
    }

    // ── by-state net internal / overseas migration (rdp states, annual) ──
    if (stateRows.length) {
      const S = {};
      for (const r of stateRows) { if (r.freq !== 'A') continue; const k = r.region_slug + '|' + r.metric; const y = +String(r.period).slice(0, 4); (S[k] || (S[k] = {}))[y] = Number(r.value); }
      const sser = (slug, metric) => years.map(y => { const m = S[slug + '|' + metric]; return (m && m[y] != null) ? m[y] : null; });
      data.nswNim = sser('st-nsw', 'nim'); data.vicNim = sser('st-vic', 'nim'); data.qldNim = sser('st-qld', 'nim'); data.saNim = sser('st-sa', 'nim'); data.waNim = sser('st-wa', 'nim');
      data.nswNom = sser('st-nsw', 'nom'); data.vicNom = sser('st-vic', 'nom'); data.qldNom = sser('st-qld', 'nom'); data.saNom = sser('st-sa', 'nom'); data.waNom = sser('st-wa', 'nom');
    }

    // ── monthly series on one YYYY-MM axis: lending + monthly cash + arrears ──
    const MM = {};
    for (const r of rdpNat) { if (r.freq !== 'M') continue; const ym = String(r.period).slice(0, 7); (MM[r.metric] || (MM[r.metric] = {}))[ym] = Number(r.value); }
    const arrMonths = (arrears.months || []).map(m => String(m).slice(0, 7));
    const mset = new Set();
    for (const met of ['owner_occupier', 'investor', 'cash_rate']) for (const ym in (MM[met] || {})) mset.add(ym);
    arrMonths.forEach(ym => mset.add(ym));
    const months = [...mset].sort();
    if (months.length) {
      const mAlign = metric => months.map(ym => (MM[metric] && MM[metric][ym] != null) ? MM[metric][ym] : null);
      const arrAlign = slug => { const R = arrears.regions && arrears.regions[slug]; if (!R || !R.values) return months.map(() => null); const map = {}; arrMonths.forEach((ym, i) => { if (R.values[i] != null) map[ym] = R.values[i] / 100; }); return months.map(ym => map[ym] != null ? map[ym] : null); };
      data.lendingDate = months;
      data.ownerOccupierAbs = mAlign('owner_occupier');
      data.investorAbs = mAlign('investor');
      data.monthlyCashRate = mAlign('cash_rate');
      data.arrearsNational = arrAlign('australia');
      data.arrearsNsw = arrAlign('st-nsw'); data.arrearsVic = arrAlign('st-vic'); data.arrearsQld = arrAlign('st-qld'); data.arrearsSa = arrAlign('st-sa'); data.arrearsWa = arrAlign('st-wa');
    }

    // ── household composition (forge_national_only, 5-yearly census) ──
    // The store holds RAW COUNTS per type; p10 expects each type as a SHARE and
    // multiplies by householdByTypeTotal (total count) to recover counts. So emit
    // share = count / total, and total = sum of every type.
    const hc = natOnly.householdComposition;
    if (hc && hc.years && hc.data) {
      const hrow = y => hc.data[y] || hc.data[String(y)];
      const htot = y => { const row = hrow(y); return row ? row.reduce((a, b) => a + (b || 0), 0) : null; };
      const hshare = i => hc.years.map(y => { const row = hrow(y); const t = htot(y); return (row && row[i] != null && t) ? row[i] / t : null; });
      data.householdTypeYear = hc.years.map(String);
      data.coupleWithChildren = hshare(0); data.couplesWithoutChildren = hshare(1); data.oneParentFamilies = hshare(2);
      data.otherFamilies = hshare(3); data.groupHousehold = hshare(4); data.lonePerson = hshare(5);
      data.householdByTypeTotal = hc.years.map(htot);
    }
    // ── job vacancies: quarterly ABS (private/public) + monthly internet ──
    const QQ = {};
    for (const r of rdpNat) { if (r.freq !== 'Q') continue; const p = String(r.period).slice(0, 7); (QQ[r.metric] || (QQ[r.metric] = {}))[p] = Number(r.value); }
    const qP = [...new Set([...Object.keys(QQ.job_vacancies_private || {}), ...Object.keys(QQ.job_vacancies_public || {})])].sort();
    if (qP.length) {
      data.dateNationalJobVacancies = qP;
      data.nationalJobVacanciesPrivate = qP.map(p => (QQ.job_vacancies_private && QQ.job_vacancies_private[p] != null) ? QQ.job_vacancies_private[p] : null);
      data.nationalJobVacanciesPublic = qP.map(p => (QQ.job_vacancies_public && QQ.job_vacancies_public[p] != null) ? QQ.job_vacancies_public[p] : null);
    }
    const ivM = Object.keys(MM.internet_vacancies || {}).sort();
    if (ivM.length) { data.dateInternetJobVacancies = ivM; data.nationalInternetJobVacancies = ivM.map(ym => MM.internet_vacancies[ym]); }

    // ── population pyramid: national vs capital cities, population share by age bracket ──
    if (pyramid.australia && Array.isArray(pyramid.australia.total)) {
      const AGE = ['0-4', '5-9', '10-14', '15-19', '20-24', '25-29', '30-34', '35-39', '40-44', '45-49', '50-54', '55-59', '60-64', '65-69', '70-74', '75-79', '80-84', '85+'];
      const nat = pyramid.australia.total;
      const share = arr => { const s = arr.reduce((a, b) => a + (b || 0), 0); return s ? arr.map(v => (v || 0) / s) : arr.map(() => null); };
      const caps = ['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'canberra', 'hobart', 'darwin'];
      const capSum = nat.map((_, i) => caps.reduce((a, c) => { const t = pyramid[c] && pyramid[c].total; return a + ((t && t[i]) || 0); }, 0));
      data.populationPyramidAge = AGE.slice(0, nat.length);
      data.national = share(nat);
      data.capitalCities = share(capSum);
    }

    return { _meta: { source: 'forge_national', generated: (natOnly.meta && natOnly.meta.updatedAt) || null }, data };
  }
  root.ForgeNationalAdapter = { assemble: assemble };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
