/**
 * PPA Online Reports — Capital Cities data feed (Google Apps Script)
 * ────────────────────────────────────────────────────────────────────
 * Source spreadsheet: "Data - Online Reports (Capital Cities)"
 * Tabs: Sydney, Melbourne, Brisbane, Adelaide, Perth, Hobart,
 *       Canberra, Darwin, Gold Coast (or whichever 9), + AUSTRALIA (skipped).
 *
 * Returns:
 *   {
 *     _meta: { generated, sheetName },
 *     regions: {
 *       sydney: { year:[...], cashRate:[...], medianHousePrice:[...], ... },
 *       melbourne: { ... },
 *       ...
 *     }
 *   }
 *
 * Each column is returned as its own array (year-agnostic). Trailing blanks
 * are trimmed per-column so list-style blocks (Industry Sectors, Population
 * Pyramid, Current Investment Value) stop where the data actually ends,
 * even though the rest of the row still has yearly data.
 *
 * Deploy:
 *   1) Open the Capital Cities sheet → Extensions → Apps Script
 *   2) Replace Code.gs with this entire file → Save
 *   3) Deploy → New deployment → type: Web app
 *      - Execute as: Me
 *      - Who has access: Anyone
 *   4) Copy the /exec URL and paste it into online-reports.html
 *      (the REPORTS_DATA_URLS map)
 *
 * To update later:
 *   - Edit this file → Save → Deploy → Manage deployments → Edit (pencil)
 *     → Version: New version → Deploy
 */

/* Tabs to exclude from the response by exact (case-insensitive) name.
   Use this for tabs that DO have a "Year" column but aren't regions
   (AUSTRALIA, the V2 Perth backup, etc.). Pure admin/guide tabs are
   already auto-skipped by the isRegionTab() heuristic below — listing
   them here is just for documentation / belt-and-braces. */
const SKIP_TABS = [
  'AUSTRALIA',
  'DASHBOARD GUIDE',
  'NATIONAL CHARTS GUIDE',
  'V2 PERTH',
];

/* Australian state/territory codes that often trail tab names
   (e.g. "Sydney NSW", "Melbourne VIC"). Stripped during slug
   normalisation so the slug matches REGION_MANIFEST in online-reports. */
const STATE_CODES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'];

/* Sheet error literals returned by getValues() when a cell formula
   resolves to an error. Mapped to null in the JSON so client code can
   treat them as missing rather than crashing on the string. */
const ERROR_CELL_RE = /^#(REF|N\/A|VALUE|NAME|NUM|ERROR|DIV\/0)/;

/* Explicit column → camelCase key map. Keep in sync with the sheet headers.
   Unknown headers fall back to auto-normalization (lookupKey). */
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
  'Median Rent House (SQM)':           'medianRentHouse',
  'Median Rent Unit (SQM)':            'medianRentUnit',
  'Rent to Income - House':            'rentToIncomeHouse',
  'Rent to Income - Unit':             'rentToIncomeUnit',
  'Gross Yield - House':               'grossYieldHouse',
  'Gross Yield - Unit':                'grossYieldUnit',
  'Population - METRO':                'populationMetro',
  '% Change METRO':                    'changeMetro',
  'Population - STATE':                'populationState',
  '% Change STATE':                    'changeState',
  'Population - NATIONAL':             'populationNational',
  '% Change NATIONAL':                 'changeNational',
  'Natural Increase':                  'naturalIncrease',
  'Net Interstate Migration (NIM)':    'nim',
  'Net Overseas Migration (NOM)':      'nom',
  'METRO Unemployment':                'unemploymentMetro',
  'STATE Unemployment':                'unemploymentState',
  'NATIONAL Unemployment':             'unemploymentNational',
  'Building Approvals - House':        'buildingApprovalsHouse',
  'Building Approval - Units':         'buildingApprovalsUnits',
  'Building Approvals - Total':        'buildingApprovalsTotal',
  'Retail Turnover':                   'retailTurnover',
  'Business Investment':               'businessInvestment',
  'Annualised FHB':                    'annualisedFhb',
  'FHB as % of Population':            'fhbPctPopulation',
  'Date (Monthly)':                    'monthlyDate',
  'Median House per Month':            'medianHouseMonthly',
  'Median Unit per Month':             'medianUnitMonthly',
  'Owner Occupier (ABS)':              'ownerOccupier',
  'Investor (ABS)':                    'investor',
  'Job Creation Index Capital City':   'jobCreationIndex',
  'Arrears - State':                   'arrearsState',
  'Arrears - National':                'arrearsNational',
  'Industry Sectors':                  'industrySector',
  '$m Value':                          'industryValue',
  '% of GSP':                          'industryPctGsp',
  'Population Pyramid - AGE':          'pyramidAge',
  'Total Metro':                       'pyramidMetro',
  '% Metro':                           'pyramidPctMetro',
  'Total National':                    'pyramidNational',
  '% National':                        'pyramidPctNational',
  'Current Investment Value':          'currentInvestmentValue',
  'Capital Cities - House Yield':      'capCityYieldHouse',
  'Capital Cities - Unit Yield':       'capCityYieldUnit',
  'Current Job Creation Index Value':  'currentJobCreation',
  'Cap City Comparison':               'capCityComparison',
  'Cap City % Difference':             'capCityPctDifference',
  '# New Pop METRO':                   'newPopMetro',
  'Household':                         'household',
  'Long-Term Trends':                  'ltTrends',
  'LT CAGR - House':                   'ltCagrHouse',
  'LT CAGR - Unit':                    'ltCagrUnit',
  /* Perth-only columns. Iron Ore (annual, USD/tonne) pairs with the
     existing year + medianHousePrice axes for page p32. Mineral
     Exploration is quarterly with its own date column ("ME - Quarter")
     for page p33. Other capital tabs leave these columns empty. */
  'Iron Ore':                          'ironOre',
  'ME - Quarter':                      'meQuarter',
  'Mineral Exploration':               'mineralExploration',
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

    // Trim trailing blanks per column.
    let lastIdx = col.length - 1;
    while (lastIdx >= 0 && (col[lastIdx] === '' || col[lastIdx] === null || col[lastIdx] === undefined)) {
      lastIdx--;
    }
    if (lastIdx < 0) {
      result[key] = [];
      return;
    }

    // Normalise per-cell:
    //   - Date objects → ISO strings (JSON safety)
    //   - Error cells (#REF!, #N/A, etc.) → null
    //   - Everything else passes through unchanged
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
   Admin/guide tabs (Dashboard Guide, National Charts Guide, etc.) start
   with chart names or instructions instead, so this heuristic catches
   them even if SKIP_TABS doesn't list them by name. */
function isRegionTab(sheet) {
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return false;
  const firstHeader = String(sheet.getRange(1, 1).getValue() || '').trim().toLowerCase();
  return firstHeader === 'year';
}

function normalizeSlug(tabName) {
  let s = String(tabName || '').toLowerCase().trim();
  if (!s) return '';
  // Flatten punctuation/separators (parens, commas, slashes, ampersands)
  // into spaces so "Sydney, NSW" / "Sydney (NSW)" / "Sydney/NSW" /
  // "Sydney & NSW" all reduce to "sydney nsw" before state-code
  // stripping.
  s = s.replace(/[(),/&]/g, ' ').replace(/\s+/g, ' ').trim();
  // Strip trailing state code: "sydney nsw" → "sydney", "mt gambier sa" → "mt gambier"
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
