/* ─────────────────────────────────────────────────────────────────────
   PPA Online Reports — Sydney region data
   ---------------------------------------------------------------------
   Single editable source for every chart on the Sydney report page.
   To update a number: find the metric below and edit its array. The
   chart will pick up the change on the next page load.

   To add a new region (e.g. Brisbane):
     1) Copy this file to /data/brisbane.js
     2) Replace 'sydney' with 'brisbane' in the assignment line
     3) Replace the values
     4) Add <script src="../assets/reports/data/brisbane.js"></script>
        to online-reports.html
     5) Open /tools/online-reports.html?region=brisbane

   Schema (top-level keys):
     atGlance       — header stat tiles (top of At-a-Glance page)
     houses, units  — per-tab At-a-Glance stat tiles + sparklines
     crises         — recession marker years (used by long-history charts)
     bands          — growth/correction period fills
     medianPrice    — annual house & unit median price ($)
     stockVsDom     — stock on market & avg days on market
     industry       — Industry Value Added (donut data)
     longTermTrends — annualised growth at 3y/5y/7y/10y/LT horizons
     populationPyramid — age × sex × region distribution
   ───────────────────────────────────────────────────────────────────── */
window.PPA_REGION_DATA = window.PPA_REGION_DATA || {};

window.PPA_REGION_DATA.sydney = {
  /* Identity — also consumed by the in-page region selector dropdown
     (Object.values(REGIONS) -> {slug, name, state}). */
  slug:      'sydney',
  name:      'Sydney',
  state:     'NSW',
  fullTitle: 'Sydney Capital City Research Report',
  meta: {
    sources: {
      price:      'CoreLogic & PriceFinder',
      stock:      'SQM Research, CoreLogic & PriceFinder',
      industry:   'Economy.id & REMPLAN',
      population: 'Australian Bureau of Statistics',
    },
  },

  /* ─── At-a-Glance: top stat tiles ─── */
  atGlance: {
    population:       { value: '5,143,256', spark: [4.3,4.4,4.5,4.6,4.7,4.8,4.9,4.95,5.0,5.05,5.1,5.14] },
    populationGrowth: { value: '2.04%',     spark: [1.8,1.9,1.4,0.7,-0.7,1.8,2.9,2.04] },
    vacancyRate:      { value: '1.30%',     spark: [2.5,3.5,3.8,3.9,3.5,2.2,1.8,1.6,1.4,1.3] },
    unemployment:     { value: '4.00%',     spark: [5.2,4.9,4.6,4.3,4.4,4.6,4.1,4.0] },
    jobCreation:      { value: '74.2',      spark: [62, 68, 75, 80, 78, 71, 66, 70, 78, 82, 76, 74.2] },
    stockOnMarket:    { value: '19,113',    spark: [12000,14000,18000,12500,13500,16000,13000,15000,17000,19113] },
  },

  /* ─── At-a-Glance: Houses tab ─── */
  houses: {
    medianPrice:     { value: '$1,550,000', spark: [600,650,700,780,820,900,1000,1100,1200,1350,1450,1550].map(v=>v*1000) },
    avgDaysOnMarket: { value: '30',         spark: [45,50,42,30,35,28,32,36,30] },
    cagr3yr:         { value: '5.45%',      spark: [8,7.5,7,6,5.8,5.5,5.45] },
    cagr10yr:        { value: '6.77%',      spark: [6.2,6.4,6.5,6.6,6.7,6.77] },
    medianRent:      { value: '$1,153',     spark: [800,850,900,950,1000,1050,1100,1120,1153] },
    grossYield:      { value: '3.74%',      spark: [3.5,3.4,3.3,3.4,3.5,3.6,3.7,3.74] },
  },

  /* ─── At-a-Glance: Units tab ─── */
  units: {
    medianPrice:     { value: '$845,000',   spark: [400,450,500,550,600,650,700,720,750,780,820,845].map(v=>v*1000) },
    avgDaysOnMarket: { value: '32',         spark: [40,45,38,32,35,30,34,32] },
    cagr3yr:         { value: '4.01%',      spark: [3,3.2,3.5,3.7,3.9,4.0,4.01] },
    cagr10yr:        { value: '2.60%',      spark: [3.5,3.2,2.9,2.7,2.65,2.6] },
    medianRent:      { value: '$744',       spark: [520,550,580,620,650,680,710,730,744] },
    grossYield:      { value: '4.50%',      spark: [4.2,4.1,4.0,4.3,4.4,4.5,4.5,4.50] },
  },

  /* ─── Recession / crisis markers (shared across long-history charts) ─── */
  crises: [
    { year: 1982, label: 'Severe Recession', cashRate: '16.3%', inflation: '12.4%', unemployment: '11.3%' },
    { year: 1991, label: 'Major Recession',  cashRate: '8.5%',  inflation: '4.8%',  unemployment: '11.3%' },
    { year: 2001, label: 'Dot Com Crash',    cashRate: '4.5%',  inflation: '6.1%',  unemployment: '6.9%'  },
    { year: 2008, label: 'GFC',              cashRate: '5.3%',  inflation: '5%',    unemployment: '6.2%'  },
    { year: 2020, label: 'Covid-19',         cashRate: '0.25%', inflation: '1.8%',  unemployment: '7.9%'  },
  ],

  /* ─── Growth / Correction period band fills ─── */
  bands: [
    { from: 1982, to: 1985, type: 'correct' },
    { from: 1985, to: 1991, type: 'growth'  },
    { from: 1991, to: 1996, type: 'correct' },
    { from: 1996, to: 2004, type: 'growth'  },
    { from: 2004, to: 2009, type: 'correct' },
    { from: 2009, to: 2020, type: 'growth'  },
    { from: 2020, to: 2022, type: 'correct' },
    { from: 2022, to: 2026, type: 'growth'  },
  ],

  /* ─── Median Price 1980–2026 (raw $) ─── */
  medianPrice: (function () {
    const years = [];
    for (let y = 1980; y <= 2026; y++) years.push(y);
    const house = [
      58,68,72,74,77,85,95,110,135,160,158,160,165,172,182,195,210,
      220,240,265,295,320,500,490,485,500,540,560,475,590,700,760,790,820,860,920,1000,
      1050,1100,1160,920,970,1270,1330,1360,1430,1550
    ].map(v => v * 1000);
    const unit = [
      54,62,66,68,70,78,86,100,120,142,140,142,148,154,168,178,188,200,215,240,270,295,360,
      370,385,395,410,420,390,440,500,530,550,570,590,620,670,
      700,730,750,680,700,780,780,760,790,845
    ].map(v => v * 1000);
    return { years, house, unit };
  })(),

  /* ─── Stock on Market vs Days on Market 2010–2026 ─── */
  stockVsDom: {
    years: [2010,2011,2012,2013,2014,2015,2016,2017,2018,2019,2020,2021,2022,2023,2024,2025,2026],
    house: [16500,19700,16600,13100,13000,15700,13900,17100,19800,13200,14100,13100,13700,14400,15600,15500,19113],
    unit:  [ 9700,12000, 9100, 7400, 7400, 8100, 9300,10900,12900, 9700,11900,12200,11900,12200,12300,11600,14000],
    dom:   [   40,   55,   45,   30,   31,   28,   41,   34,   40,   44,   36,   19,   30,   28,   32,   30,   30],
  },

  /* ─── Industry Value Added (Sydney) ─── */
  industry: [
    { v: 33.3, n: 'Financial and Insurance Services'           },
    { v: 20.8, n: 'Professional, Scientific and Tech Services' },
    { v:  7.3, n: 'Information Media and Telecommunications'   },
    { v:  6.4, n: 'Administrative and Support Services'        },
    { v:  5.2, n: 'Public Administration and Safety'           },
    { v:  4.8, n: 'Rental, Hiring and Real Estate Services'    },
    { v:  3.2, n: 'Education and Training'                     },
    { v:  2.8, n: 'Transport, Postal and Warehousing'          },
    { v:  2.6, n: 'Construction'                               },
    { v:  2.4, n: 'Health Care and Social Assistance'          },
    { v:  2.0, n: 'Retail Trade'                               },
    { v:  1.8, n: 'Accommodation and Food Services'            },
    { v:  1.7, n: 'Wholesale Trade'                            },
    { v:  1.5, n: 'Manufacturing'                              },
    { v:  1.3, n: 'Electricity, Gas, Water and Waste Services' },
    { v:  1.1, n: 'Arts and Recreation Services'               },
    { v:  0.9, n: 'Mining'                                     },
    { v:  0.5, n: 'Other Services'                             },
    { v:  0.4, n: 'Others'                                     },
  ],

  /* ─── Long-Term Trends: annualised growth at multiple horizons (%) ─── */
  longTermTrends: {
    horizons: ['LT', '10 Years', '7 Years', '5 Years', '3 Years'],
    house:    [7.20, 6.77, 6.20, 5.80, 5.45],
    unit:     [5.10, 2.60, 3.10, 3.50, 4.01],
  },

  /* ─── Job Creation Index — monthly Sydney internet vacancy index ─── */
  jobCreation: (function () {
    /* Monthly from Jan 2012 → Dec 2025. Mock shape mirrors the PDF
       silhouette: rising into 2018, Covid trough mid-2020, recovery
       peak late 2022, gradual decline into 2025. */
    const months = [];
    const sydney = [];
    /* Deterministic monthly noise so the index reads as month-to-month
       data with real wobble, not a smooth analytic curve. */
    const noise = (t) => (
      Math.sin(t * 5.7) * 4 +
      Math.cos(t * 9.1) * 3 +
      Math.sin(t * 17.3) * 2
    );
    for (let y = 2012; y <= 2025; y++) {
      for (let m = 0; m < 12; m++) {
        const mm = m + 1;
        months.push(y + '-' + (mm < 10 ? '0' + mm : mm));
        const t = (y - 2012) * 12 + m;
        let v = 80 + Math.sin(t / 6) * 12 + Math.cos(t / 14) * 9;
        if (y >= 2014 && y <= 2018) v += (y - 2013) * 4;
        if (y === 2020 && m >= 3 && m <= 8) v -= 45 + Math.sin((m - 3) * 0.8) * 8;
        if (y >= 2021 && y <= 2022) v += 22 + Math.sin(t / 4) * 6;
        if (y >= 2024) v -= (y - 2023) * 8;
        v += noise(t);
        sydney.push(+v.toFixed(1));
      }
    }
    return { months, sydney };
  })(),

  /* ─── Change in Population (yearly %) — Sydney / NSW / National ───
        NSW + National ABS series go back to the early 1980s; the
        Sydney series only starts in 2002 (the SA4 release prior to
        that wasn't broken out for greater capital cities). The Sydney
        array uses `null` for years before its data exists so the
        chart line begins at 2002 without filling-in fake values. */
  changeInPopulation: (function () {
    const years = [];
    for (let y = 1982; y <= 2024; y++) years.push(y);
    /* Mock yearly population growth rates approximating ABS data. */
    const nsw = [
      /* 1982-1990 */ 1.4, 1.2, 1.1, 1.0, 1.1, 1.3, 1.4, 1.5, 1.5,
      /* 1991-1999 */ 1.0, 0.8, 0.7, 0.7, 0.8, 0.9, 1.0, 1.0, 1.0,
      /* 2000-2009 */ 0.8, 0.7, 0.8, 0.9, 0.9, 1.1, 1.4, 1.6, 1.6, 1.4,
      /* 2010-2019 */ 1.1, 1.1, 1.3, 1.4, 1.4, 1.5, 1.6, 1.5, 1.4, 1.1,
      /* 2020-2024 */ 0.1, 0.1, 1.8, 2.2, 1.4,
    ];
    const national = [
      /* 1982-1990 */ 1.5, 1.4, 1.3, 1.2, 1.4, 1.5, 1.6, 1.7, 1.7,
      /* 1991-1999 */ 1.4, 1.2, 1.0, 1.1, 1.2, 1.2, 1.3, 1.2, 1.1,
      /* 2000-2009 */ 1.0, 1.0, 1.2, 1.3, 1.4, 1.5, 1.7, 1.8, 1.9, 1.7,
      /* 2010-2019 */ 1.4, 1.4, 1.8, 1.6, 1.5, 1.5, 1.6, 1.6, 1.6, 1.5,
      /* 2020-2024 */ 0.5, 0.6, 2.1, 2.4, 1.6,
    ];
    /* Sydney: null for 1982-2001; mock + real shape from 2002 onwards. */
    const sydneyPre2010 = [1.0, 1.1, 1.0, 1.2, 1.4, 1.5, 1.4, 1.3]; /* 2002-2009 */
    const sydney2010Plus = [1.4, 1.2, 1.5, 1.8, 1.8, 1.8, 2.0, 2.0, 1.4, 1.3, 0.7, -0.7, 0.8, 2.9, 2.0];
    const sydney = years.map((y) => {
      if (y < 2002) return null;
      if (y < 2010) return sydneyPre2010[y - 2002];
      return sydney2010Plus[y - 2010];
    });
    return { years, sydney, nsw, national };
  })(),

  /* ─── Population Movement (yearly counts) — natural increase + NIM + NOM
        + NSW total population overlaid on a secondary axis. ─── */
  populationMovement: (function () {
    const years = [];
    for (let y = 1990; y <= 2025; y++) years.push(y);
    /* Mock series approximating PDF shape:
       - Natural Increase: stable ~40-50k
       - NIM (interstate, mostly negative for Sydney)
       - NOM (overseas, big jumps post-2006, Covid trough, big bounce 2022-23) */
    const naturalIncrease = years.map((y, i) =>
      45 + Math.sin(i / 6) * 4 + (y >= 2020 ? -10 : 0) + (y >= 2022 ? -3 : 0));
    const nim = years.map(y =>
      y < 2002 ? -12 + Math.sin(y / 3) * 4
                : -28 + Math.sin(y / 5) * 8 - (y >= 2020 ? 10 : 0));
    const nom = years.map(y =>
      y < 2005 ? 30 + Math.sin(y / 4) * 8
              : y < 2020 ? 60 + (y - 2005) * 1.5 + Math.sin(y / 3) * 12
              : y === 2020 ? 6
              : y === 2021 ? 12
              : y === 2022 ? 145
              : y === 2023 ? 175
              : y === 2024 ? 102
              : 92);
    const round = a => a.map(v => Math.round(v));
    /* NSW total population (millions). Smooth upward trend from
       ~5.84M in 1990 to ~8.50M in 2025, with a flatter Covid-era
       slope as overseas migration dropped. */
    const nswPopulation = years.map((y) => {
      let p;
      if (y < 2005)         p = 5.84 + (y - 1990) * 0.045;
      else if (y < 2020)    p = 6.51 + (y - 2005) * 0.085;
      else if (y < 2022)    p = 7.79 + (y - 2020) * 0.04;   /* Covid plateau */
      else                  p = 7.87 + (y - 2022) * 0.20;   /* migration bounce */
      return +p.toFixed(2);
    });
    return {
      years,
      naturalIncrease: round(naturalIncrease),
      nim: round(nim),
      nom: round(nom),
      nswPopulation,
    };
  })(),

  /* ─── Vacancy Rate vs Rent — Rent House/Unit bars + Vacancy line ─── */
  vacancyVsRent: (function () {
    const years = [];
    for (let y = 2000; y <= 2026; y++) years.push(y);
    /* Rent in $/week, vacancy in %. Rents climb steeply post-2020;
       vacancy spikes 2002-2004 then settles, climbs 2018-2021, drops since. */
    const rentHouse = [400,420,450,460,440,430,460,500,520,560,650,680,690,720,760,780,820,860,830,800,920,1090,1100,1140,1153];
    const rentUnit  = [320,340,355,370,360,340,360,380,395,410,440,460,470,490,500,520,560,580,570,560,650,720,710,730,744];
    const vacancy   = [1.7,1.7,4.6,4.4,3.5,1.5,1.5,1.2,1.6,1.7,1.9,1.8,2.0,2.7,2.6,2.9,3.1,3.0,2.9,3.0,3.7,2.6,2.0,1.8,1.5,1.4,1.3];
    /* Pad rent arrays out to 27 years to match years[] (2000-2026 = 27). */
    while (rentHouse.length < years.length) rentHouse.push(rentHouse[rentHouse.length - 1] + 30);
    while (rentUnit.length  < years.length) rentUnit.push (rentUnit [rentUnit.length  - 1] + 18);
    return { years, rentHouse, rentUnit, vacancy };
  })(),

  /* ─── Mortgage Arrears (monthly %) — NSW vs National ─── */
  mortgageArrears: (function () {
    /* Jan 2010 → Oct 2025, monthly. Mock follows PDF shape: spikes
       2011-2012, dip mid-2010s, climb late 2010s, post-Covid drop,
       moderate climb through 2024-25. */
    const months = [];
    const nsw = [];
    const national = [];
    /* Jan 2010 → Oct 2025; build strings directly to dodge the
       toISOString-vs-local-time off-by-one. Per-month noise (sum of
       high-freq sines) gives the lines the same monthly wobble that
       real S&P arrears data has, deterministically. */
    const noise = (t, amp, salt) => amp * (
      Math.sin(t * 5.7 + salt) * 0.45 +
      Math.cos(t * 9.1 + salt * 1.3) * 0.30 +
      Math.sin(t * 14.3) * 0.25
    );
    for (let y = 2010; y <= 2025; y++) {
      const lastM = y === 2025 ? 10 : 12;
      for (let m = 1; m <= lastM; m++) {
        months.push(y + '-' + (m < 10 ? '0' + m : m));
        const t = (y - 2010) * 12 + (m - 1);
        const wave = Math.sin(t / 6) * 0.18 + Math.cos(t / 14) * 0.08;
        let n  = 1.55 + wave;
        let na = 1.30 + wave * 0.7;
        if (t < 36) { n += 0.5 - t * 0.005; na += 0.35 - t * 0.005; }
        if (t > 60 && t < 110) { n -= 0.4; na -= 0.4; }
        if (t > 130 && t < 160) { n += 0.05; na += 0.0; }
        if (t > 145 && t < 165) { n -= 0.55; na -= 0.55; }
        if (t > 165) { n += (t - 165) * 0.012; na += (t - 165) * 0.005; }
        n  += noise(t, 0.10, 0);
        na += noise(t, 0.08, 17);
        nsw.push(+Math.max(0.3, n).toFixed(2));
        national.push(+Math.max(0.3, na).toFixed(2));
      }
    }
    return { months, nsw, national };
  })(),

  /* ─── Price to Income Ratio (yearly) — house/unit + crisis markers ─── */
  priceToIncome: (function () {
    const years = [];
    for (let y = 1983; y <= 2026; y++) years.push(y);
    /* Mock shape from PDF: mid-4s in the 80s, climbing through 2000s,
       House peak ~14-15 by 2024-2025 (post-Covid), Unit peak ~9. */
    const house = years.map((y, i) => {
      if (y < 1991) return 4 + (y - 1983) * 0.06 + Math.sin(i / 3) * 0.3;
      if (y < 2002) return 4.5 + (y - 1991) * 0.15;
      if (y < 2005) return 6.5 + (y - 2002) * 1.0;
      if (y < 2008) return 9.5 - (y - 2005) * 0.5;
      if (y < 2012) return 8.0 + Math.sin(y) * 0.5;
      if (y < 2017) return 8.5 + (y - 2012) * 0.6;
      if (y < 2020) return 11.5 - (y - 2017) * 0.3;
      if (y < 2022) return 10.5 + (y - 2020) * 1.5;
      return 13.5 + (y - 2022) * 0.25;
    }).map(v => +v.toFixed(2));
    const unit = years.map((y) => {
      if (y < 1991) return 3.6 + (y - 1983) * 0.05;
      if (y < 2002) return 4.0 + (y - 1991) * 0.12;
      if (y < 2008) return 5.5 + Math.sin(y) * 0.3;
      if (y < 2017) return 6.5 + (y - 2008) * 0.25;
      if (y < 2020) return 8.5 - (y - 2017) * 0.2;
      if (y < 2022) return 8.0 + (y - 2020) * 0.5;
      return 9.0 - (y - 2022) * 0.25;
    }).map(v => +v.toFixed(2));
    return { years, house, unit };
  })(),

  /* ─── House v Unit Price Comparison — bars + Pct line + LT avg ─── */
  housePriceComparison: (function () {
    const years = [];
    for (let y = 1983; y <= 2026; y++) years.push(y);
    const house = years.map((y, i) => {
      if (y < 1989) return 65 + (y - 1983) * 5 + Math.sin(i) * 4;
      if (y < 1995) return 100 + (y - 1989) * 12;
      if (y < 2003) return 175 + (y - 1995) * 30;
      if (y < 2008) return 480 + Math.sin(y) * 20;
      if (y < 2012) return 530 + (y - 2008) * 18;
      if (y < 2017) return 650 + (y - 2012) * 90;
      if (y < 2020) return 1000 + (y - 2017) * -20;
      if (y < 2022) return 970 + (y - 2020) * 180;
      return 1330 + (y - 2022) * 60;
    }).map(v => Math.round(v) * 1000);
    const unit = years.map((y, i) => {
      if (y < 1989) return 60 + (y - 1983) * 4;
      if (y < 1995) return 90 + (y - 1989) * 11;
      if (y < 2003) return 160 + (y - 1995) * 28;
      if (y < 2008) return 380 + Math.sin(y) * 15;
      if (y < 2012) return 410 + (y - 2008) * 14;
      if (y < 2017) return 470 + (y - 2012) * 48;
      if (y < 2020) return 720 + (y - 2017) * -10;
      if (y < 2022) return 690 + (y - 2020) * 30;
      return 760 + (y - 2022) * 25;
    }).map(v => Math.round(v) * 1000);
    /* Unit price as % of House price; LT average pre-computed. */
    const pct = house.map((h, i) => +(unit[i] / h * 100).toFixed(1));
    const longTermAvg = +(pct.reduce((s, v) => s + v, 0) / pct.length).toFixed(1);
    return { years, house, unit, pct, longTermAvg };
  })(),

  /* ─── Affordability Index v YoY Price Movement (HOUSE) ─── */
  affordabilityHouse: (function () {
    const years = [];
    for (let y = 1983; y <= 2026; y++) years.push(y);
    /* AI = bars (% of income for P&I); priceMovement = line (YoY %) */
    const ai = years.map((y, i) => {
      if (y < 1989) return 35 + (y - 1983) * 1.8;
      if (y === 1989) return 60;
      if (y === 1990) return 68;
      if (y < 2003) return 40 + Math.sin(i) * 5 + (y - 1991) * 0.5;
      if (y < 2008) return 60 + (y - 2003) * 3;
      if (y < 2012) return 70 - (y - 2008) * 3;
      if (y < 2017) return 60 + (y - 2012) * 2;
      if (y < 2020) return 70 + (y - 2017) * -2;
      if (y < 2022) return 64 + (y - 2020) * 7;
      return 78 + (y - 2022);
    }).map(v => +v.toFixed(1));
    /* Derived from medianPrice yoy as a placeholder; once real data
       arrives this will come from the same Sheet column. */
    const priceMovement = years.map((y, i) => {
      if (i === 0) return 0;
      if (y === 1988) return 35;
      if (y === 1989) return 22;
      if (y === 2002) return 56;
      if (y === 2009) return -2;
      if (y === 2020) return -3;
      if (y === 2021) return 28;
      return Math.sin(i / 2) * 8 + 5;
    }).map(v => +v.toFixed(1));
    return { years, ai, priceMovement };
  })(),

  /* ─── Affordability Index v YoY Price Movement (UNIT) ─── */
  affordabilityUnit: (function () {
    const years = [];
    for (let y = 1983; y <= 2026; y++) years.push(y);
    const ai = years.map((y, i) => {
      if (y < 1989) return 36 + (y - 1983) * 1;
      if (y === 1989) return 51;
      if (y === 1990) return 68;
      if (y < 2003) return 40 + Math.sin(i) * 5;
      if (y < 2008) return 45 + (y - 2003) * 0.5;
      if (y < 2012) return 47 - (y - 2008) * 1;
      if (y < 2017) return 45 + (y - 2012) * 1;
      if (y < 2020) return 48 + (y - 2017) * -2;
      if (y < 2022) return 44 + (y - 2020) * 3;
      return 50 + (y - 2022) * -1;
    }).map(v => +v.toFixed(1));
    const priceMovement = years.map((y, i) => {
      if (i === 0) return 0;
      if (y === 1988) return 50;
      if (y === 1989) return 8;
      if (y === 2002) return 22;
      if (y === 2009) return -7;
      if (y === 2020) return -3;
      if (y === 2021) return 14;
      return Math.sin(i / 2) * 5 + 4;
    }).map(v => +v.toFixed(1));
    return { years, ai, priceMovement };
  })(),

  /* ─── NSW Lending vs Median Price (4 lines, dual axis, monthly) ─── */
  lendingVsPrice: (function () {
    /* Monthly span Jan 2004 → Jan 2026 (265 months) so the chart shows
       the full GFC dip, investor-credit boom, APRA-cap correction,
       Covid trough, and post-Covid surge. Strings are built directly
       (avoiding Date.toISOString, which would shift Jan 1 local-time
       back to Dec 31 of the previous year in any UTC+ timezone). */
    const months = [];
    for (let y = 2004; y <= 2026; y++) {
      const lastM = y === 2026 ? 1 : 12;
      for (let m = 1; m <= lastM; m++) {
        months.push(y + '-' + (m < 10 ? '0' + m : m));
      }
    }

    /* Investor and Owner-Occupier lending in $ billions (rough mock).
       Values modelled per absolute month-index so the curves capture
       the real silhouette of NSW lending: rising into 2007, GFC dip,
       2014-2017 investor peak, APRA correction, Covid trough,
       2021-2022 surge, recent moderation.

       Per-month "noise" is layered on as a sum of high-frequency
       sines with prime-ish offsets — gives the line the same wavy
       texture real lending data has, but stays deterministic so the
       chart looks identical on every page reload. */
    const noise = (i, amp, salt) => {
      const s = salt || 0;
      return amp * (
        Math.sin(i * 7.3 + s) * 0.45 +
        Math.sin(i * 13.1 + 1.5 + s) * 0.30 +
        Math.cos(i * 19.7 + s * 1.7) * 0.20 +
        Math.sin(i * 31.3 + s) * 0.15
      );
    };
    const investor = [];
    const ownerOcc = [];
    for (let i = 0; i < months.length; i++) {
      const yr = 2004 + i / 12;          /* fractional year */
      const wave = Math.sin(i / 5) * 0.18 + Math.cos(i / 11) * 0.12;
      let inv = 2.0 + wave;
      let oo  = 2.7 + wave * 0.7;
      if (yr < 2008)               { inv += (yr - 2004) * 0.25; oo += (yr - 2004) * 0.30; }
      else if (yr < 2009)          { inv -= (yr - 2008) * 1.6;  oo -= (yr - 2008) * 1.4; } /* GFC */
      else if (yr < 2014)          { inv += (yr - 2009) * 0.10; oo += (yr - 2009) * 0.20; }
      else if (yr < 2017)          { inv += 0.5 + (yr - 2014) * 0.7; oo += 1.0 + (yr - 2014) * 0.5; } /* boom */
      else if (yr < 2019)          { inv -= (yr - 2017) * 0.7; oo -= (yr - 2017) * 0.3; } /* APRA caps */
      else if (yr < 2020.3)        { inv += (yr - 2019) * 0.5;  oo += (yr - 2019) * 0.6; }
      else if (yr < 2020.7)        { inv -= 1.0;  oo -= 0.7; } /* Covid trough */
      else if (yr < 2022.5)        { inv += (yr - 2020.7) * 1.6; oo += (yr - 2020.7) * 1.7; } /* surge */
      else if (yr < 2023.5)        { inv -= (yr - 2022.5) * 1.0; oo -= (yr - 2022.5) * 1.0; }
      else                          { inv += (yr - 2023.5) * 0.4; oo += (yr - 2023.5) * 0.3; }
      /* Noise scales with the local trend value so the wobble
         stays visually proportional whether the line is at $1b or $5b. */
      inv += noise(i, Math.max(0.4, inv * 0.10), 0);
      oo  += noise(i, Math.max(0.4, oo  * 0.10), 100);
      investor.push(+Math.max(0.5, inv).toFixed(2));
      ownerOcc.push(+Math.max(0.8, oo).toFixed(2));
    }

    /* Median House and Unit Price ramp through the same span — coarse
       yearly steps (the right axis only needs to read trend, not
       monthly volatility). 2004…2026 = 23 years. */
    const housePerYear = [540,560,475,590,700,760,790,820,860,920,1000,1050,1100,1160,920,970,1270,1330,1360,1430,1500,1530,1550];
    const unitPerYear  = [385,395,410,420,390,440,500,530,550,570,590,620,670, 700, 730,750,680,700,780,780,760,790,845];
    const medianHouse = months.map(m => {
      const y = parseInt(m.slice(0, 4), 10) - 2004;
      return (housePerYear[Math.min(y, housePerYear.length - 1)] || 1550) * 1000;
    });
    const medianUnit = months.map(m => {
      const y = parseInt(m.slice(0, 4), 10) - 2004;
      return (unitPerYear[Math.min(y, unitPerYear.length - 1)] || 845) * 1000;
    });
    return { months, investor, ownerOcc, medianHouse, medianUnit };
  })(),

  /* ─── Dwelling Sales (House+Unit sales lines + Median House+Unit price lines) ─── */
  dwellingSales: (function () {
    const years = [];
    for (let y = 2000; y <= 2026; y++) years.push(y);
    const house = years.map((y, i) =>
      Math.round(60 + Math.sin(i / 2) * 8 + (y < 2003 ? -i * 0.5 : 0) +
        (y > 2019 ? -10 : 0) + (y > 2022 ? 8 : 0)));
    const units = years.map((y, i) =>
      Math.round(35 + Math.sin(i / 3) * 6 + (y > 2010 && y < 2017 ? 5 : 0) +
        (y === 2018 ? -10 : 0) + (y > 2021 ? 6 : 0)));
    /* Reuse housePriceComparison series scaled to 1000s. */
    const housePerYear = [320,360,500,490,485,500,540,560,475,590,700,760,790,820,860,920,1000,1050,1100,1160,920,970,1270,1330,1360,1430,1550];
    const unitPerYear  = [270,295,360,370,385,395,410,420,390,440,500,530,550,570,590,620,670,700,730,750,680,700,780,780,760,790,845];
    const medianHouse = years.map((_, i) => (housePerYear[i] || 1550) * 1000);
    const medianUnit  = years.map((_, i) => (unitPerYear[i]  || 845)  * 1000);
    /* sales come in thousands; convert to absolute count for display. */
    return {
      years,
      house: house.map(v => v * 1000),
      units: units.map(v => v * 1000),
      medianHouse, medianUnit,
    };
  })(),

  /* ─── Dwelling Approvals (3 grouped bars + Population Change line) ─── */
  dwellingApprovals: (function () {
    const years = [];
    for (let y = 2010; y <= 2026; y++) years.push(y);
    const house = years.map((y, i) =>
      Math.round(8 + i * 0.6 + (y > 2018 ? -1.5 : 0) + (y > 2022 ? -0.5 : 0)));
    const units = years.map((y, i) =>
      Math.round(15 + Math.sin(i) * 3 + (y > 2014 && y < 2018 ? 18 : 0) +
        (y > 2017 ? -5 : 0)));
    const total = years.map((_, i) => house[i] + units[i] + Math.round(Math.sin(i) * 2));
    /* Population change in % on right axis. */
    const popChange = [1.4,1.2,1.5,1.8,1.8,1.8,2.0,2.0,1.4,1.3,0.7,-0.7,0.8,2.9,2.0,1.4,1.2];
    return {
      years,
      house: house.map(v => v * 1000),
      units: units.map(v => v * 1000),
      total: total.map(v => v * 1000),
      popChange,
    };
  })(),

  /* ─── New Households v Housing (NewH + BuildingApprovals bars + VacancyRate line) ─── */
  newHouseholdsVHousing: (function () {
    const years = [];
    for (let y = 2010; y <= 2026; y++) years.push(y);
    const newHouseholds = [22,19,24,28,29,31,33,32,25,23,13,-13,15,52,38,22,20];
    const buildingApprovals = [23,23,28,36,41,55,58,55,47,36,36,43,36,30,28,36,28];
    /* Vacancy rate placed onto right axis. */
    const vacancy = [1.9,1.8,2.0,2.7,2.6,2.9,3.1,3.0,3.7,3.9,3.8,3.2,1.7,1.7,2.1,1.7,1.3];
    return {
      years,
      newHouseholds: newHouseholds.map(v => v * 1000),
      buildingApprovals: buildingApprovals.map(v => v * 1000),
      vacancy,
    };
  })(),

  /* ─── FHB as a % of Population (Annualised FHB bars + FHB % line) ─── */
  fhbPopulation: (function () {
    const years = [];
    for (let y = 2003; y <= 2025; y++) years.push(y);
    const annualised = [22.5,20.5,25.5,31,33,30.5,49.5,23,25.5,19.5,15.5,16,15,13.5,18.5,24,24.5,33,38,26.5,27,28];
    const pct        = [0.33,0.31,0.40,0.45,0.46,0.43,0.71,0.36,0.39,0.30,0.20,0.21,0.23,0.18,0.30,0.31,0.31,0.42,0.46,0.34,0.32,0.33];
    /* Pad to 23 years (matches years.length). */
    while (annualised.length < years.length) annualised.push(annualised[annualised.length - 1]);
    while (pct.length < years.length)        pct.push(pct[pct.length - 1]);
    return {
      years,
      annualised: annualised.map(v => Math.round(v * 1000)),
      pct,
    };
  })(),

  /* ─── Income to Rent vs Affordability Index (4 lines) ─── */
  incomeToRentAi: (function () {
    const years = [];
    for (let y = 2010; y <= 2025; y++) years.push(y);
    /* Mock from PDF p18 silhouette */
    const house   = [48,49,47,46,47,46,48,47,46,42,36,42,49,55,54,53];
    const unit    = [33,33,33,33,33,32,33,33,33,32,28,27,32,37,36,35];
    const aiHouse = [52,49,47,45,46,46,48,49,46,40,25,34,62,76,76,68];
    const aiUnit  = [42,42,40,38,38,38,38,38,36,32,18,21,35,43,42,37];
    return { years, house, unit, aiHouse, aiUnit };
  })(),

  /* ─── Retail Turnover Growth (2 lines + crisis markers) ─── */
  retailTurnover: (function () {
    const years = [];
    for (let y = 1990; y <= 2026; y++) years.push(y);
    const turnover = years.map((y, i) => Math.round(30 + i * 3 + (y > 2014 ? (y - 2014) * 1 : 0))).map(v => v * 1000);
    /* Reuse house price progression. */
    const housePrice = years.map((y, i) => {
      if (y < 2002) return 150 + i * 10;
      if (y < 2008) return 480 + Math.sin(y) * 20;
      if (y < 2012) return 530 + (y - 2008) * 18;
      if (y < 2017) return 650 + (y - 2012) * 90;
      if (y < 2020) return 1000 + (y - 2017) * -20;
      if (y < 2022) return 970 + (y - 2020) * 180;
      return 1330 + (y - 2022) * 60;
    }).map(v => Math.round(v) * 1000);
    return { years, turnover, housePrice };
  })(),

  /* ─── Unemployment Rate (2 lines + 1 bar series) ─── */
  unemploymentRate: (function () {
    const years = [];
    for (let y = 1980; y <= 2026; y++) years.push(y);
    /* Sydney/NSW unemployment %. */
    const sydney = years.map((y, i) => {
      if (y < 1983) return 5.5 - (y - 1980) * 0.2;
      if (y < 1992) return 9 + Math.sin(i / 2) * 0.8;
      if (y < 2008) return 8 - (y - 1992) * 0.3;
      if (y < 2020) return 5 + Math.sin(y) * 0.4;
      if (y === 2020) return 6.5;
      return 4 + Math.sin(y) * 0.4;
    }).map(v => +v.toFixed(2));
    const nsw = years.map((_, i) => +(sydney[i] + Math.sin(i) * 0.4 + 0.5).toFixed(2));
    /* House YoY % from medianPrice for the bar overlay. */
    const houseYoy = years.map((y, i) => {
      if (i === 0) return 0;
      if (y === 1988) return 35;
      if (y === 1989) return 22;
      if (y === 2002) return 56;
      if (y === 2009) return -2;
      if (y === 2020) return -3;
      if (y === 2021) return 28;
      return Math.sin(i / 2) * 8 + 5;
    }).map(v => +v.toFixed(1));
    return { years, sydney, nsw, houseYoy };
  })(),

  /* ─── Business Investment (2 lines + crisis markers) ─── */
  businessInvestment: (function () {
    const years = [];
    for (let y = 1990; y <= 2026; y++) years.push(y);
    const investment = years.map((y, i) => {
      if (y < 1992) return 14 + Math.sin(i) * 1;
      if (y < 1995) return 11 + (y - 1992) * 1;
      if (y < 2000) return 14 + Math.sin(i) * 1;
      if (y < 2004) return 17 + (y - 2000) * 0.5;
      if (y < 2008) return 22 + Math.sin(y) * 2;
      if (y < 2014) return 28 + Math.sin(y) * 2;
      if (y < 2020) return 33 + (y - 2014) * 1.2;
      if (y === 2020) return 35;
      return 38 + (y - 2020) * 4;
    }).map(v => Math.round(v) * 1000);
    /* House price reused. */
    const housePrice = years.map((y, i) => {
      if (y < 2002) return 150 + i * 10;
      if (y < 2008) return 480 + Math.sin(y) * 20;
      if (y < 2012) return 530 + (y - 2008) * 18;
      if (y < 2017) return 650 + (y - 2012) * 90;
      if (y < 2020) return 1000 + (y - 2017) * -20;
      if (y < 2022) return 970 + (y - 2020) * 180;
      return 1330 + (y - 2022) * 60;
    }).map(v => Math.round(v) * 1000);
    return { years, investment, housePrice };
  })(),

  /* ─── Current Investment Value (yield by city) ─── */
  currentInvestmentValue: {
    cities:     ['Sydney', 'Perth', 'Melbourne', 'Brisbane', 'Adelaide'],
    houseYield: [3.74,    4.75,    4.45,        3.72,       3.82],
    unitYield:  [4.50,    4.95,    4.60,        4.10,       4.05],
  },

  /* ─── Yield vs Cash Rate (HOUSE) — 4 lines + crisis markers ─── */
  yieldVsCashHouse: (function () {
    const years = [];
    for (let y = 1985; y <= 2026; y++) years.push(y);
    /* Real-data availability: yield series only goes back to 2010,
       cash rate only to 1990. Earlier years are `null` so ECharts'
       default `connectNulls: false` draws each line as a partial
       segment that begins at its actual start year — no fake fill.
       Variable rate is computed from the FULL cash-rate base BEFORE
       nulling, so it stays full-range (matches the Sydney PDF where
       the variable rate line spans 1985→2026). */
    const cashRateBase = years.map((y, i) =>
      +Math.max(0.1, 12 - (y - 1985) * 0.3 + Math.cos(i) * 0.5).toFixed(2));
    const variableRate = years.map((y, i) =>
      +(cashRateBase[i] + 1.8 + Math.sin(i) * 0.3).toFixed(2));
    const cashRate = cashRateBase.map((v, i) => years[i] < 1990 ? null : v);
    const yieldRate = years.map((y, i) =>
      y < 2010 ? null : +(8 - (y - 1985) * 0.13 + Math.sin(i) * 0.3).toFixed(2));
    /* House price reused — full range. */
    const housePrice = years.map((y, i) => {
      if (y < 2002) return 150 + i * 10;
      if (y < 2008) return 480 + Math.sin(y) * 20;
      if (y < 2012) return 530 + (y - 2008) * 18;
      if (y < 2017) return 650 + (y - 2012) * 90;
      if (y < 2020) return 1000 + (y - 2017) * -20;
      if (y < 2022) return 970 + (y - 2020) * 180;
      return 1330 + (y - 2022) * 60;
    }).map(v => Math.round(v) * 1000);
    return { years, yieldRate, cashRate, variableRate, housePrice };
  })(),

  /* ─── Yield vs Cash Rate (UNIT) — 4 lines + crisis markers ─── */
  yieldVsCashUnit: (function () {
    const years = [];
    for (let y = 1985; y <= 2026; y++) years.push(y);
    /* See yieldVsCashHouse above for the null-fill rationale.
       Cash rate from 1990, yield from 2010, variable rate full-range
       from the un-nulled cash-rate base. */
    const cashRateBase = years.map((y, i) =>
      +Math.max(0.1, 12 - (y - 1985) * 0.3 + Math.cos(i) * 0.5).toFixed(2));
    const variableRate = years.map((y, i) =>
      +(cashRateBase[i] + 1.8 + Math.sin(i) * 0.3).toFixed(2));
    const cashRate = cashRateBase.map((v, i) => years[i] < 1990 ? null : v);
    const yieldRate = years.map((y, i) =>
      y < 2010 ? null : +(9 - (y - 1985) * 0.12 + Math.sin(i) * 0.3).toFixed(2));
    /* Unit price progression — full range. */
    const unitPrice = years.map((y, i) => {
      if (y < 2002) return 100 + i * 8;
      if (y < 2008) return 380 + Math.sin(y) * 15;
      if (y < 2012) return 410 + (y - 2008) * 14;
      if (y < 2017) return 470 + (y - 2012) * 48;
      if (y < 2020) return 720 + (y - 2017) * -10;
      if (y < 2022) return 690 + (y - 2020) * 30;
      return 760 + (y - 2022) * 25;
    }).map(v => Math.round(v) * 1000);
    return { years, yieldRate, cashRate, variableRate, unitPrice };
  })(),

  /* ─── Sydney vs Melbourne House Median Price (2 bars + line + LT avg) ─── */
  sydneyVsMelbourne: (function () {
    const years = [];
    for (let y = 1990; y <= 2026; y++) years.push(y);
    const sydneyHouse    = years.map((y, i) => Math.round(150 + i * 35 + Math.sin(y) * 30) * 1000);
    const melbourneHouse = years.map((y, i) => Math.round(140 + i * 23 + Math.sin(y) * 20) * 1000);
    /* Difference line gets deterministic multi-frequency noise so the
       trace reads as real cyclical market data (medium 3–5y cycles +
       year-on-year jitter), matching the Sydney PDF where the line
       wobbles meaningfully across the chart. The underlying sydney /
       melbourne medians stay smooth — the noise is added to the ratio
       AFTER computing it, then long-term average is recomputed from
       the noised difference so the dashed reference line still sits
       at the visible mean. */
    const diffNoise = (i) => (
      Math.sin(i * 0.7) * 2.6 +
      Math.cos(i * 1.3) * 1.9 +
      Math.sin(i * 2.7) * 1.1 +
      Math.cos(i * 4.1) * 0.6
    );
    const difference = sydneyHouse.map((s, i) =>
      +((s / melbourneHouse[i]) * 100 + diffNoise(i)).toFixed(1));
    const longTermAvg = +(difference.reduce((s, v) => s + v, 0) / difference.length).toFixed(1);
    return { years, sydneyHouse, melbourneHouse, difference, longTermAvg };
  })(),

  /* ─── Population Pyramid: % of population by age group ───
        Two side-by-side mirrored bars (male/female) and an outline showing
        the National distribution for comparison. */
  populationPyramid: {
    ageGroups: ['0-04','05-09','10-14','15-19','20-24','25-29','30-34','35-39','40-44','45-49','50-54','55-59','60-64','65-69','70-74','75-79','80-84','85 and over'],
    sydney: {
      male:   [3.0,3.0,3.0,3.0,3.4,4.1,4.4,4.0,3.6,3.2,3.0,2.8,2.5,2.2,1.7,1.2,0.8,0.6],
      female: [2.9,2.9,2.9,2.9,3.4,4.2,4.4,4.1,3.7,3.4,3.2,3.0,2.7,2.4,1.9,1.4,1.0,0.9],
    },
    national: {
      male:   [3.1,3.1,3.0,3.0,3.2,3.6,3.8,3.6,3.3,3.2,3.0,3.0,2.8,2.6,2.1,1.5,1.0,0.7],
      female: [2.9,3.0,2.9,2.9,3.1,3.6,3.8,3.6,3.4,3.3,3.2,3.1,2.9,2.7,2.3,1.7,1.3,1.0],
    },
  },

  /* ─── Iron Ore Price (Perth-only chart, page 32) ───
        Sample series approximating the Perth PDF page 14 curve. House
        prices are Perth (not Sydney) — kept here so non-Sydney regions
        falling back to sydney's data still render the chart correctly
        when viewing ?region=perth. Replace with live Sheets data once
        the WA dataset is wired. */
  ironOrePrice: (function () {
    const years = [];
    for (let y = 1990; y <= 2025; y++) years.push(y);
    /* Perth median house price ($) — gentle rise to ~470k by 2008 GFC,
       flat through the 2010s, sharp climb post-2020 to ~900k by 2025. */
    const medianHouse = [
       70,  78,  85,  92, 100, 108, 115, 122, 132, 142,
      153, 165, 180, 200, 240, 290, 350, 410, 470, 460,
      480, 480, 470, 470, 470, 510, 510, 500, 510, 480,
      480, 510, 590, 700, 820, 900,
    ].map(v => v * 1000);
    /* Iron ore (USD / tonne) — flat ~12-15 through 1990s, mining-boom
       spike 2008-2014 to ~170, drop to ~50 in 2015, recovery to peak
       ~155 in 2021, oscillating ~100-130 since. */
    const ironOre = [
       30,  28,  25,  22,  19,  16,  14,  13,  12,  11,
       12,  13,  13,  17,  23,  35,  60,  75, 145,  80,
      145, 168, 130, 135,  95,  56,  60,  70,  70,  90,
      105, 155, 130, 120, 115, 105,
    ];
    return { years, medianHouse, ironOre };
  })(),

  /* ─── Mineral Exploration Expenditure (Perth-only chart, page 33) ───
        Quarterly series Q3 2006 → Q3 2025 (77 quarters). Values are
        approximate $m matching the PDF curve: rise into 2008 boom,
        plateau 2009-2012, trough 2013-2016, gentle recovery 2017-2020,
        sharp post-Covid rise to ~750m by 2024-25. */
  mineralExploration: (function () {
    const quarters = [];
    for (let y = 2006; y <= 2025; y++) {
      const startQ = (y === 2006) ? 3 : 1;
      const endQ   = (y === 2025) ? 3 : 4;
      for (let q = startQ; q <= endQ; q++) quarters.push('Q' + q + ' ' + y);
    }
    /* 77 values approximating the PDF curve. Slight noise on top of the
       broad-stroke shape so the line reads quarterly-realistic rather
       than perfectly smooth. */
    const values = [];
    for (let i = 0; i < quarters.length; i++) {
      let v;
      if (i < 10)        v = 150 + i * 32;                              /* Q3 2006 → boom buildup */
      else if (i < 20)   v = 470 + Math.sin(i * 0.55) * 80 + (i - 10) * 8;
      else if (i < 28)   v = 600 - (i - 20) * 35 + Math.cos(i * 0.7) * 25; /* peak then decline */
      else if (i < 40)   v = 250 + Math.sin(i * 0.4) * 35;              /* 2013-2016 trough */
      else if (i < 55)   v = 230 + (i - 40) * 6 + Math.cos(i * 0.5) * 18; /* gentle rise */
      else if (i < 65)   v = 320 + (i - 55) * 28 + Math.sin(i * 0.6) * 30; /* 2019-2021 climb */
      else               v = 620 + (i - 65) * 12 + Math.sin(i * 0.55) * 55; /* 2022-2025 high */
      values.push(Math.max(100, Math.round(v)));
    }
    return { quarters, values };
  })(),
};
