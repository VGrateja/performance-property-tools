/**
 * PPA Online Reports — Regional clusters data feed (Google Apps Script)
 * ────────────────────────────────────────────────────────────────────
 * SHARED file for all 3 regional cluster sheets. All three sheets use
 * identical column headers (verified 2026-04-29 from xlsx samples), so
 * one Apps Script source covers them all — paste this into each sheet's
 * Apps Script editor and deploy a separate web-app per sheet.
 *
 * Deploy targets (3 separate web-apps, one per sheet):
 *   1. "Data - Online Reports (QLD - Regions)"
 *      Tabs: Mackay, Bundaberg, Ipswich, Rockhampton, Gladstone, Cairns,
 *            Townsville, Sunshine Coast, Toowoomba, Gold Coast (10).
 *   2. "Data - Online Reports (NSW - Regions)"
 *      Tabs: Albury, Central Coast, Coffs Harbour, Orange, Port Macquarie,
 *            Newcastle, Tamworth, Wagga Wagga, Wollongong (9).
 *   3. "Data - Online Reports (VIC/WA/TAS - Regions)"
 *      Tabs: Ballarat, Bendigo, Geelong, Wodonga, Mildura, Mandurah,
 *            Rockingham, Bunbury, Launceston (9).
 *
 * Each tab is named "Region (STATE)" — e.g. "Mackay (QLD)",
 * "Wagga Wagga (NSW)", "Mandurah (WA)". The slug normaliser strips the
 * paren-wrapped state code and lowercases / hyphenates so the response
 * key matches REGION_MANIFEST in online-reports.html (e.g.
 * "Sunshine Coast (QLD)" → "sunshine-coast").
 *
 * Returns:
 *   {
 *     _meta: { generated, sheetName },
 *     regions: {
 *       mackay:    { year:[...], cashRate:[...], medianHousePrice:[...], ... },
 *       bundaberg: { ... },
 *       ...
 *     }
 *   }
 *
 * Each column is returned as its own array (year-agnostic). Trailing blanks
 * are trimmed per-column.
 *
 * Deploy steps (per sheet):
 *   1) Open the cluster sheet → Extensions → Apps Script
 *   2) Replace Code.gs with this entire file → Save
 *   3) Deploy → New deployment → type: Web app
 *      - Execute as: Me
 *      - Who has access: Anyone
 *   4) Copy the /exec URL and paste it into online-reports.html at
 *      REPORTS_DATA_URLS.qld / .nsw / .vicwatas (one per cluster).
 *
 * To update later:
 *   - Edit this file in EACH sheet's Apps Script project → Save → Deploy
 *     → Manage deployments → Edit (pencil) → Version: New version → Deploy.
 *
 * Notes on column differences vs Capital Cities:
 *   - LGA-level columns are unique to regional sheets:
 *       Population, % LGA Growth, LGA Unemployment, Job Creation Index
 *       Region, Total LGA, % LGA, # New Pop LGA.
 *   - Regional sheets DROP these (since their reports are 26-page and
 *     don't include FHB / Retail / Mortgage Arrears / Business
 *     Investment / Current Investment Value pages):
 *       Retail Turnover, Annualised FHB, FHB as % of Population, Arrears
 *       (state/national), Business Investment, Current Investment Value,
 *       Capital Cities House/Unit Yield, Population - NATIONAL,
 *       % Change NATIONAL, Total Metro/National (pyramid uses LGA+State
 *       instead).
 *   - Pyramid in regional reports compares LGA vs STATE (not Metro vs
 *     National like capital cities).
 *   - Job Creation: regional sheets have BOTH "Index Region" (the LGA's
 *     own index) AND "Index Capital City" (peer comparison value).
 */

/* Tabs to exclude from the response by exact (case-insensitive) name.
   Pure admin/guide tabs are already auto-skipped by isRegionTab(); this
   is belt-and-braces for any sheet that adds an admin tab with a Year
   header. */
const SKIP_TABS = [
  'AUSTRALIA',
  'DASHBOARD GUIDE',
  'NATIONAL CHARTS GUIDE',
  'CHARTS GUIDE',
  /* Mandurah was split back out to its own report 2026-07, so its tab is
     emitted again (no longer skipped). Forge (rdp_report_feed) is the primary
     source; this legacy feed only matters as a fallback. */
];

/* Australian state/territory codes that often trail tab names — both
   "Mackay (QLD)" (paren-wrapped) and "Mackay QLD" (trailing). The
   slug normaliser flattens parentheses to whitespace first, then
   strips a trailing state code. */
const STATE_CODES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'];

/* Sheet error literals returned by getValues() when a cell formula
   resolves to an error. Mapped to null in the JSON. */
const ERROR_CELL_RE = /^#(REF|N\/A|VALUE|NAME|NUM|ERROR|DIV\/0)/;

/* Explicit column → camelCase key map. Verified against the QLD/NSW/
   VIC-WA-TAS xlsx files on 2026-04-29 — all three regional clusters
   use the identical 73-column header row. */
const COLUMN_MAP = {
  'Year':                              'year',
  'Cash Rate':                         'cashRate',
  'Bank Rate':                         'bankRate',
  'Median Income':                     'medianIncome',
  'Median HOUSE Price':                'medianHousePrice',
  'Median UNIT Price':                 'medianUnitPrice',
  '# Sales HOUSE':                     'salesHouse',
  '# Sales UNITS':                     'salesUnits',
  '#Sales TOTAL':                      'salesTotal',
  '% Difference H v U':                'pctDifferenceHvU',
  'House % Change Year on Year':       'houseYoY',
  'Unit % Change Year on Year':        'unitYoY',
  'CAGR - House - 3YR':                'cagrHouse3yr',
  'CAGR - House - 10YR':               'cagrHouse10yr',
  'CAGR - Unit - 3YR':                 'cagrUnit3yr',
  'CAGR - Unit - 10YR':                'cagrUnit10yr',
  'P&I Repayments HOUSE':              'piRepaymentsHouse',
  'P&I Repayments UNITS':              'piRepaymentsUnits',
  'AI P&I Loan HOUSE':                 'aiPiLoanHouse',
  'AI P&I Loan UNIT':                  'aiPiLoanUnit',
  'AI HOUSE State Income':             'aiHouseStateIncome',
  'AI UNIT State Income':              'aiUnitStateIncome',
  'Price to Income - HOUSE':           'priceToIncomeHouse',
  'Price to Income - UNIT':            'priceToIncomeUnit',
  'ADOM - House (CL)':                 'adomHouse',
  'ADOM - Unit (CL)':                  'adomUnit',
  'SOM - HOUSE (SQM)':                 'somHouse',
  'SOM - UNITS (SQM)':                 'somUnit',
  'Vacancy Rate (SQM)':                'vacancyRate',
  /* Note: actual sheet header has TWO spaces between "Rent" and "House".
     readSheet() collapses whitespace before lookup so single-space here
     matches both single- and double-spaced header variants. */
  'Median Rent House (SQM)':           'medianRentHouse',
  'Median Rent Unit (SQM)':            'medianRentUnit',
  'Rent to Income - House':            'rentToIncomeHouse',
  'Rent to Income - Unit':             'rentToIncomeUnit',
  'Gross Yield - House':               'grossYieldHouse',
  'Gross Yield - Unit':                'grossYieldUnit',

  /* LGA-level (region's own counts) — unique to regional sheets. */
  'Population':                        'populationLga',
  '% LGA Growth':                      'changeLga',

  /* Metro = SA4 (mid-tier between LGA and State). */
  'Population - METRO':                'populationMetro',
  '% Change METRO':                    'changeMetro',

  /* State-level. */
  'Population - STATE':                'populationState',
  '% Change STATE':                    'changeState',

  /* Migration components. */
  'Natural Increase':                  'naturalIncrease',
  'Net Interstate Migration (NIM)':    'nim',
  'Net Overseas Migration (NOM)':      'nom',

  /* Unemployment — regional sheets have LGA Unemployment instead of
     METRO Unemployment. STATE + NATIONAL still present. */
  'LGA Unemployment':                  'unemploymentLga',
  'STATE Unemployment':                'unemploymentState',
  'NATIONAL Unemployment':             'unemploymentNational',

  /* Building approvals. */
  'Building Approvals - House':        'buildingApprovalsHouse',
  'Building Approval - Units':         'buildingApprovalsUnits',
  'Building Approvals - Total':        'buildingApprovalsTotal',

  /* Monthly lending. */
  'Date (Monthly)':                    'monthlyDate',
  'Median House per Month':            'medianHouseMonthly',
  'Median Unit per Month':             'medianUnitMonthly',
  'Owner Occupier (ABS)':              'ownerOccupier',
  'Investor (ABS)':                    'investor',

  /* Job Creation Index — regional sheets have BOTH:
       Region    = the LGA's own JCI value (the canonical metric)
       Cap City  = the peer-capital JCI value (for comparison page) */
  'Job Creation Index Region':         'jobCreationIndex',
  'Job Creation Index Capital City':   'jobCreationIndexCapCity',

  /* Industry Value Added (page p29). */
  'Industry Sectors':                  'industrySector',
  '$m Value':                          'industryValue',
  '% of GSP':                          'industryPctGsp',

  /* Population Pyramid (page p30) — LGA vs State in regional reports
     (not Metro vs National like capital cities). */
  'Population Pyramid - AGE':          'pyramidAge',
  'Total LGA':                         'pyramidLga',
  '% LGA':                             'pyramidPctLga',
  'Total State':                       'pyramidState',
  '% State':                           'pyramidPctState',

  'Current Job Creation Index Value':  'currentJobCreation',

  /* Peer comparison — for QLD region vs Brisbane, NSW region vs Sydney,
     etc. The peer is determined by REGION_MANIFEST.peer, not by the
     sheet — these columns just supply the peer's values per row. */
  'Cap City Comparison':               'capCityComparison',
  'Cap City % Difference':             'capCityPctDifference',

  /* Year-on-year population growth in absolute terms. */
  '# New Pop LGA':                     'newPopLga',
  'Household':                         'household',

  /* Long-Term Trends (page p27). */
  'Long-Term Trends':                  'ltTrends',
  'LT CAGR - House':                   'ltCagrHouse',
  'LT CAGR - Unit':                    'ltCagrUnit',
};

function doGet(e) {
  const ss = SpreadsheetApp.getActive();
  const out = {
    _meta: {
      generated: new Date().toISOString(),
      sheetName: ss.getName(),
    },
    regions: {},
  };

  ss.getSheets().forEach(function (sheet) {
    const tabName = sheet.getName();
    if (SKIP_TABS.indexOf(String(tabName).trim().toUpperCase()) >= 0) return;
    if (!isRegionTab(sheet)) return;
    const slug = normalizeSlug(tabName);
    if (!slug) return;
    out.regions[slug] = readSheet(sheet);
  });

  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function readSheet(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return {};

  const all = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = all[0];
  const rows = all.slice(1);
  const result = {};

  headers.forEach(function (rawHeader, colIdx) {
    const header = String(rawHeader || '').trim().replace(/\s+/g, ' ');
    if (!header) return;

    const key = lookupKey(header);
    const col = rows.map(function (r) { return r[colIdx]; });

    let lastIdx = col.length - 1;
    while (lastIdx >= 0 && (col[lastIdx] === '' || col[lastIdx] === null || col[lastIdx] === undefined)) {
      lastIdx--;
    }
    if (lastIdx < 0) {
      result[key] = [];
      return;
    }

    const trimmed = col.slice(0, lastIdx + 1).map(function (v) {
      if (v instanceof Date) return v.toISOString();
      if (typeof v === 'string' && ERROR_CELL_RE.test(v)) return null;
      return v;
    });

    result[key] = trimmed;
  });

  return result;
}

/* A real region tab always starts with a "Year" header in column A.
   Admin/guide tabs ("Charts Guide" etc.) start with chart names or
   instructions instead, so this heuristic catches them even if
   SKIP_TABS doesn't list them by name. */
function isRegionTab(sheet) {
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return false;
  const firstHeader = String(sheet.getRange(1, 1).getValue() || '').trim().toLowerCase();
  return firstHeader === 'year';
}

/* "Mackay (QLD)"          → "mackay"
   "Sunshine Coast (QLD)"  → "sunshine-coast"
   "Coffs Harbour (NSW)"   → "coffs-harbour"
   "Sydney, NSW"           → "sydney"           (capital-cities format)
   "Wagga Wagga (NSW)"     → "wagga-wagga"
   Parens, commas, slashes, ampersands flatten to spaces first; trailing
   state code then stripped; remaining whitespace becomes hyphens. */
function normalizeSlug(tabName) {
  let s = String(tabName || '').toLowerCase().trim();
  if (!s) return '';
  s = s.replace(/[(),/&]/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < STATE_CODES.length; i++) {
    const code = STATE_CODES[i].toLowerCase();
    const re = new RegExp('\\s+' + code + '$');
    if (re.test(s)) {
      s = s.replace(re, '');
      break;
    }
  }
  return s.replace(/\s+/g, '-');
}

function lookupKey(header) {
  if (COLUMN_MAP[header]) return COLUMN_MAP[header];
  // Fallback: camelCase from words, strip non-alphanumeric.
  return header
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(function (w, i) {
      return i === 0
        ? w.toLowerCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join('');
}
