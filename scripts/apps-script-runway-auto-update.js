/**
 * PPA Runway Auto-Update — Apps Script (Google)
 * ────────────────────────────────────────────────────────────────────
 * Monthly job that mirrors Runway Workbook's per-region affordability
 * runway calculation and writes the result back to the Houses + Units
 * spreadsheets that feed the Demand Score Dashboard.
 *
 * Designed to be added to the SAME Apps Script project that contains
 * apps-script-demand-dashboard.js — it already has authorisation to
 * open both spreadsheets, so no fresh OAuth.
 *
 * Output: a new "Runway v Demand (auto)" tab on each spreadsheet,
 * three columns:
 *   A: Region
 *   B: Runway % (Forecast scenario — IC Forecast + Bank Margin + APRA F)
 *   C: Runway % (Current  scenario — RBA Bank Variable + APRA buffer)
 *
 * The existing "Runway v Demand" tab is NEVER touched — users transfer
 * values manually after eyeballing for accuracy. After a couple of
 * months of side-by-side review the manual tab can be retired by
 * updating apps-script-demand-dashboard.js to read from the auto tab
 * instead.
 *
 * Trigger: monthly time-based, 15th of the month, 06:00 AEST.
 * Install once via installMonthlyRunwayTrigger() below.
 * ──────────────────────────────────────────────────────────────────── */

/* ===== CONFIG ============================================================ */

/* Spreadsheet IDs — same ones doGet() in the demand-dashboard script uses. */
const RWA_HOUSE_ID = '1U2kWpGiuhsz4Xs63b9HlpjDJqmJRPH0X6wxCCSxqXQs';
const RWA_UNIT_ID  = '1v9Z3MMD-fAQQdkvteGUKS7mrI5czcmKYW9BQqtBxCdw';

/* Source of truth for live CoreLogic + ABS + RBA data. Same endpoint
   Runway Workbook fetches from — keeps the inputs aligned between the
   live workbook view and the monthly automation. */
const RWA_PRICES_API = 'https://script.google.com/macros/s/AKfycbwi0vd2X5CFwUJG-0zEKhtkZzWKrDNHkjSwn_JD1drR95KgbwpHzM9d-edJKz3SBWs6/exec';

/* Target tab name. Lives alongside the existing "Runway v Demand" tab. */
const RWA_AUTO_TAB = 'Runway v Demand (auto)';

/* Where the summary email goes. */
const RWA_NOTIFY_EMAIL = 'vandolf@performanceproperty.com.au';

/* Scenario defaults — mirror Runway Workbook's variable inputs. Live
   rates (cashRate, bankVar) get overridden by the rates sub-feed; the
   others stay as configured defaults. Edit here if PPA's modelling
   assumptions change. */
const RWA_SCENARIO_DEFAULTS = {
  cashRate:   4.35,   // overridden by rates.cashRate
  bankVar:    6.16,   // overridden by rates.bankRate
  apra:       0.50,
  icForecast: 2.69,
  bankMargin: 1.75,
  apraF:      0.50,
};


/* ===== FINANCE HELPERS (port of Runway Workbook math) ==================== */

function rwaPMT(rate, nper, pv) {
  if (rate === 0) return pv / nper;
  return pv * rate / (1 - Math.pow(1 + rate, -nper));
}
function rwaPV(rate, nper, pmt) {
  if (rate === 0) return pmt * nper;
  return pmt * (1 - Math.pow(1 + rate, -nper)) / rate;
}
/* Affordability ceiling price: the price at which Affordability Index
   matches the region's aiCeiling. Assumes 80% LVR, 30y term. */
function rwaCalcCeilingPrice(bankRate, weeklyIncome, aiCeiling) {
  if (weeklyIncome == null || aiCeiling == null
      || isNaN(weeklyIncome) || isNaN(aiCeiling) || isNaN(bankRate)) return null;
  const r = bankRate / 100 / 12;
  const annualIncome = weeklyIncome * 52;
  return rwaPV(r, 360, (annualIncome * aiCeiling) / 12) / 0.8;
}

/* Region normaliser — match the same patterns Runway Workbook uses so
   "Central Coast (NSW)" from CoreLogic lines up with "Central Coast"
   in the spreadsheet. */
function rwaNormalizeRegion(name) {
  return String(name || '').toLowerCase()
    .replace(/\s*\((?:nsw|vic|qld|sa|wa|tas\.?|nt|act)\)\s*$/i, '')
    .replace(/\s*\([cam]\)\s*$/i, '')
    .replace(/\s+regional$/i, '')
    .replace(/[\s\-]+/g, ' ')
    .trim();
}
function rwaExtractState(name) {
  const m = String(name || '').match(/\((nsw|vic|qld|sa|wa|tas\.?|nt|act)\)\s*$/i);
  if (!m) return '';
  return m[1].toUpperCase().replace('.', '');
}


/* ===== DATA FETCH ======================================================== */

/* Pulls all six endpoints in parallel — same shape Runway Workbook's
   loadLatestPrices() uses. Each sub-feed is best-effort; if one fails
   we log + continue with whatever did come back. */
function rwaFetchAll() {
  const urls = [
    RWA_PRICES_API,
    RWA_PRICES_API + '?source=pops',
    RWA_PRICES_API + '?source=incomes',
    RWA_PRICES_API + '?source=aic',
    RWA_PRICES_API + '?source=rates',
  ];
  const responses = UrlFetchApp.fetchAll(urls.map(u => ({ url: u, muteHttpExceptions: true })));
  const data = {};
  try { Object.assign(data, JSON.parse(responses[0].getContentText())); }
  catch (e) { throw new Error('Primary prices feed parse failed: ' + e.message); }

  function tryParse(resp, key, inner) {
    if (!resp || resp.getResponseCode() !== 200) return;
    try {
      const body = JSON.parse(resp.getContentText());
      if (body && !body.error && body[inner]) data[key] = body[inner];
    } catch (_) { /* swallow — sub-feed best-effort */ }
  }
  tryParse(responses[1], 'populations', 'populations');
  tryParse(responses[2], 'incomes',     'incomes');
  tryParse(responses[3], 'aic',         'aic');
  tryParse(responses[4], 'rates',       'rates');
  return data;
}


/* ===== PRICE / INCOME / AIC LOOKUPS ====================================== */

/* Build a STATE::PROPTYPE::region → price map from the main prices feed,
   matching the keying Runway Workbook uses so "Central Coast (NSW)"
   doesn't collide with "Central Coast (Tas.)". */
function rwaBuildPriceMap(data) {
  const map = {};
  function ingest(rows) {
    if (!Array.isArray(rows) || rows.length < 2) return;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const region   = r[1];
      const propType = String(r[2] || '').trim().toUpperCase();
      const price    = Number(r[16]);
      if (!region || !propType || !price || isNaN(price)) continue;
      const state = rwaExtractState(region);
      const base  = rwaNormalizeRegion(region);
      if (state) map[state + '::' + propType + '::' + base] = price;
      else {
        const k = propType + '::' + base;
        if (map[k] == null) map[k] = price;
      }
    }
  }
  ingest(data.capitalCities);
  ingest(data.lga);
  return map;
}

function rwaLookupPrice(priceMap, state, region, propType) {
  const base = rwaNormalizeRegion(region);
  return priceMap[state.toUpperCase() + '::' + propType + '::' + base]
      ?? priceMap[propType + '::' + base]
      ?? null;
}

/* AI ceilings: returns a normalised-region → {H, U} map. */
function rwaBuildAicMap(data) {
  const aic = data.aic;
  if (!aic || aic.error) return {};
  const out = {};
  [aic.lga || {}, aic.capitalCities || {}].forEach(dict => {
    Object.keys(dict).forEach(name => {
      out[rwaNormalizeRegion(name)] = dict[name];
    });
  });
  return out;
}


/* ===== CORE: per-region runway calc ====================================== */

function rwaComputeForRegion(state, region, propType, priceMap, aicMap, incomes, scenario) {
  const price    = rwaLookupPrice(priceMap, state, region, propType);
  const income   = (incomes && incomes.states) ? Number(incomes.states[state.toUpperCase()]) : null;
  const aicHit   = aicMap[rwaNormalizeRegion(region)];
  const aiCeiling = aicHit ? Number(propType === 'H' ? aicHit.H : aicHit.U) : null;

  /* Current scenario: live bank var + APRA buffer. */
  const bankRate = (scenario.bankVar) + scenario.apra;
  /* Forecast scenario: PP's modelled forward rate. */
  const ppVar    = scenario.icForecast + scenario.bankMargin + scenario.apraF;

  const ceilCurrent  = rwaCalcCeilingPrice(bankRate, income, aiCeiling);
  const ceilForecast = rwaCalcCeilingPrice(ppVar,    income, aiCeiling);

  const runwayCurrent  = (price && ceilCurrent  != null) ? (ceilCurrent  - price) / price : null;
  const runwayForecast = (price && ceilForecast != null) ? (ceilForecast - price) / price : null;
  return { region, price, income, aiCeiling, runwayForecast, runwayCurrent };
}


/* ===== SHEET I/O ========================================================= */

/* Read the existing "Runway v Demand" tab's column A so the auto tab
   ends up with the same region set + order. Skips a leading "Region"
   header row if present. */
function rwaReadRegions(spreadsheetId) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const src = ss.getSheetByName('Runway v Demand');
  if (!src) throw new Error('"Runway v Demand" tab not found on ' + spreadsheetId);
  const values = src.getRange(1, 1, src.getLastRow(), 1).getValues();
  const regions = [];
  for (let i = 0; i < values.length; i++) {
    const v = String(values[i][0] || '').trim();
    if (!v) continue;
    if (i === 0 && /^region$|^suburb$/i.test(v)) continue;
    regions.push(v);
  }
  return regions;
}

function rwaInferState(spreadsheetId, regionName) {
  /* Look up state in the DATA tab (column 0 = state, column 1 = region
     by convention from the Runway Workbook seeds). Falls back to ''
     if no match — calc will still run but priceMap state-scoped key
     won't hit, so the unstated alias is used. */
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const data = ss.getSheetByName('DATA');
  if (!data) return '';
  const rows = data.getRange(1, 1, data.getLastRow(), 2).getValues();
  const norm = rwaNormalizeRegion(regionName);
  for (let i = 1; i < rows.length; i++) {
    if (rwaNormalizeRegion(rows[i][1]) === norm) return String(rows[i][0] || '').trim().toUpperCase();
  }
  return '';
}

function rwaWriteAutoTab(spreadsheetId, results) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  let sheet = ss.getSheetByName(RWA_AUTO_TAB);
  if (!sheet) sheet = ss.insertSheet(RWA_AUTO_TAB);
  sheet.clearContents();
  const header = ['Region', 'Runway % (Forecast)', 'Runway % (Current)', 'Median Price', 'Income', 'AI Ceiling'];
  const rows = results.map(r => [r.region, r.runwayForecast, r.runwayCurrent, r.price, r.income, r.aiCeiling]);
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  if (rows.length) sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  /* Format the runway columns as percent with two decimal places so the
     reviewer sees "12.34%" instead of "0.1234". */
  sheet.getRange(2, 2, Math.max(rows.length, 1), 2).setNumberFormat('0.00%');
  sheet.getRange(2, 4, Math.max(rows.length, 1), 1).setNumberFormat('$#,##0');
  sheet.getRange(2, 5, Math.max(rows.length, 1), 1).setNumberFormat('$#,##0.00');
  sheet.getRange(2, 6, Math.max(rows.length, 1), 1).setNumberFormat('0.00%');
  /* Timestamp the bottom so reviewers know the last run. */
  const stampRow = rows.length + 3;
  sheet.getRange(stampRow, 1).setValue('Last auto-update:');
  sheet.getRange(stampRow, 2).setValue(new Date());
  sheet.getRange(stampRow, 2).setNumberFormat('d mmm yyyy hh:mm');
}


/* ===== EMAIL ============================================================= */

function rwaSendSummary(houseResults, unitResults, scenario, sourceFile) {
  const ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'd MMM yyyy HH:mm');
  function table(rows, propType) {
    const header = '<tr><th align="left">Region</th><th align="right">Runway (Forecast)</th><th align="right">Runway (Current)</th><th align="right">Median Price</th></tr>';
    const body = rows.map(r => {
      const fmtPct = v => (v == null || isNaN(v)) ? '—' : (v * 100).toFixed(2) + '%';
      const fmtMon = v => (v == null || isNaN(v)) ? '—' : '$' + Math.round(v).toLocaleString('en-AU');
      const colorF = (r.runwayForecast >= 0.3) ? '#15803d' : (r.runwayForecast < 0 ? '#b91c1c' : '#92400e');
      return '<tr>'
        + '<td style="padding:3px 8px">' + r.region + '</td>'
        + '<td style="padding:3px 8px; text-align:right; color:' + colorF + '">' + fmtPct(r.runwayForecast) + '</td>'
        + '<td style="padding:3px 8px; text-align:right">' + fmtPct(r.runwayCurrent) + '</td>'
        + '<td style="padding:3px 8px; text-align:right">' + fmtMon(r.price) + '</td>'
        + '</tr>';
    }).join('');
    return '<h3>' + propType + ' &middot; ' + rows.length + ' regions</h3>'
         + '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-family:Arial,sans-serif; font-size:12px">'
         + '<thead style="background:#f1f5f9; border-bottom:1px solid #cbd5e1">' + header + '</thead>'
         + '<tbody>' + body + '</tbody></table>';
  }
  const ppVar    = scenario.icForecast + scenario.bankMargin + scenario.apraF;
  const bankRate = scenario.bankVar    + scenario.apra;
  const meta = '<p style="font-family:Arial; font-size:12px; color:#475569">'
    + '<b>Run:</b> ' + ts + '<br>'
    + '<b>Source file:</b> ' + (sourceFile || '—') + '<br>'
    + '<b>Forecast bank rate:</b> ' + ppVar.toFixed(2) + '% &middot; '
    + '<b>Current bank rate:</b> ' + bankRate.toFixed(2) + '%<br>'
    + 'Values written to the "Runway v Demand (auto)" tab on both spreadsheets. '
    + 'Manual "Runway v Demand" tab untouched.'
    + '</p>';
  const html = '<h2 style="font-family:Arial; color:#0a6266">Runway auto-update &mdash; ' + ts + '</h2>'
             + meta + table(houseResults, 'HOUSES') + '<br>' + table(unitResults, 'UNITS');
  MailApp.sendEmail({
    to: RWA_NOTIFY_EMAIL,
    subject: 'PPA · Runway auto-update · ' + ts,
    htmlBody: html,
  });
}


/* ===== MAIN =============================================================== */

function updateRunwayVsDemand() {
  const scenario = Object.assign({}, RWA_SCENARIO_DEFAULTS);
  try {
    const data = rwaFetchAll();

    /* Override live values from the rates sub-feed if present. */
    if (data.rates && !data.rates.error) {
      if (data.rates.cashRate != null) scenario.cashRate = Number(data.rates.cashRate);
      if (data.rates.bankRate != null) scenario.bankVar  = Number(data.rates.bankRate);
    }

    const priceMap = rwaBuildPriceMap(data);
    const aicMap   = rwaBuildAicMap(data);

    /* Read the canonical region list from each spreadsheet's existing
       "Runway v Demand" tab so we don't drift from what the user is
       used to seeing. */
    const houseRegions = rwaReadRegions(RWA_HOUSE_ID);
    const unitRegions  = rwaReadRegions(RWA_UNIT_ID);

    const houseResults = houseRegions.map(r => {
      const state = rwaInferState(RWA_HOUSE_ID, r);
      return rwaComputeForRegion(state, r, 'H', priceMap, aicMap, data.incomes, scenario);
    });
    const unitResults  = unitRegions.map(r => {
      const state = rwaInferState(RWA_UNIT_ID, r);
      return rwaComputeForRegion(state, r, 'U', priceMap, aicMap, data.incomes, scenario);
    });

    rwaWriteAutoTab(RWA_HOUSE_ID, houseResults);
    rwaWriteAutoTab(RWA_UNIT_ID,  unitResults);
    rwaSendSummary(houseResults, unitResults, scenario, data.sourceFile);
  } catch (err) {
    /* Failure email so the silent-cron problem doesn't catch you out. */
    MailApp.sendEmail({
      to: RWA_NOTIFY_EMAIL,
      subject: 'PPA · Runway auto-update FAILED',
      body: 'Error: ' + err.message + '\n\nStack:\n' + (err.stack || '(no stack)'),
    });
    throw err;
  }
}


/* ===== TRIGGER INSTALL ==================================================== */

/* Run ONCE from the Apps Script editor to set up the monthly cron.
   Apps Script time-based triggers fire at the start of the chosen
   hour, so atHour(6) → roughly 06:00 in the script's timezone (set
   via File → Project properties → Timezone, default Australia/Sydney
   for PPA accounts). */
function installMonthlyRunwayTrigger() {
  /* Remove any prior installs so re-running doesn't stack triggers. */
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'updateRunwayVsDemand') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('updateRunwayVsDemand')
    .timeBased()
    .onMonthDay(15)
    .atHour(6)
    .create();
}

/* Convenience for ad-hoc manual runs from the Apps Script editor. */
function runRunwayUpdateNow() { updateRunwayVsDemand(); }
