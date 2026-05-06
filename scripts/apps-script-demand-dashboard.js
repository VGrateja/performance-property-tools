/**
 * PPA Demand Dashboard — Apps Script (Google)
 * ────────────────────────────────────────────────────────────────────
 * Returns a single JSON payload combining data from the House and Unit
 * source spreadsheets. Consumed by performance-property/tools/
 * demand-score.html and (after Push) by tools/runway-demand.html.
 *
 * Response shape:
 *   {
 *     houses: { "DATA":[[...]], "Runway v Demand":[[...]], ... },
 *     units:  { "DATA":[[...]], "Runway v Demand":[[...]], ... },
 *     legend: {
 *       house: { year:<num>, rate:<num> },
 *       unit:  { year:<num>, rate:<num> }
 *     }
 *   }
 *
 * legend.house and legend.unit are read from the "Imported Data" tab
 * in each spreadsheet (cells R2 + S2). Same cell references in both
 * spreadsheets; the values may match or differ depending on what's
 * loaded in each sheet. Falls through to {year:null, rate:null} if
 * the tab is missing — the client treats null as "no override" and
 * uses its hardcoded default 5 / 4.94.
 *
 * Deploy:
 *   Apps Script editor → Deploy → Manage deployments → Edit (pencil)
 *   → Version: New version → Deploy. The Web App URL stays the same.
 */

function doGet(e) {
  var houseId = "1U2kWpGiuhsz4Xs63b9HlpjDJqmJRPH0X6wxCCSxqXQs";
  var unitId  = "1v9Z3MMD-fAQQdkvteGUKS7mrI5czcmKYW9BQqtBxCdw";

  var houseSheets = {
    "DATA": "1122177345",
    "Runway v Demand": "1902286674",
    "Prev - Cur": "1880289616",
    "Median prices": "1483673332",
    "Rental Growth": "2110151934"
  };

  var unitSheets = {
    "DATA": "1122177345",
    "Runway v Demand": "1288755439",
    "Prev - Cur": "1588139535",
    "Median prices": "1483673332",
    "Rental Growth": "136764409"
  };

  var result = { houses: {}, units: {} };

  for (var name in houseSheets) {
    var sheet = SpreadsheetApp.openById(houseId).getSheets().filter(function(s) {
      return s.getSheetId() == houseSheets[name];
    })[0];
    if (sheet) result.houses[name] = sheet.getDataRange().getValues();
  }

  for (var name in unitSheets) {
    var sheet = SpreadsheetApp.openById(unitId).getSheets().filter(function(s) {
      return s.getSheetId() == unitSheets[name];
    })[0];
    if (sheet) result.units[name] = sheet.getDataRange().getValues();
  }

  // Wage-growth year + PP variable rate from each spreadsheet's
  // "Imported Data" tab (R2 + S2). Top-level legend block is the
  // shape the client (demand-score.html) prefers.
  result.legend = {
    house: readLegend_(houseId),
    unit:  readLegend_(unitId)
  };

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/* Read R2 (year) + S2 (rate) off the "Imported Data" tab of the
   given spreadsheet. Returns { year:<num|null>, rate:<num|null> }.
   Empty / non-numeric / error cells fall through to null so the
   client falls back to its defaults rather than rendering NaN. */
function readLegend_(spreadsheetId) {
  try {
    var sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName('Imported Data');
    if (!sheet) return { year: null, rate: null };
    var num = function(v) {
      if (v === null || v === undefined || v === '') return null;
      var n = Number(v);
      return isFinite(n) ? n : null;
    };
    return {
      year: num(sheet.getRange('R2').getValue()),
      rate: num(sheet.getRange('S2').getValue())
    };
  } catch (err) {
    return { year: null, rate: null };
  }
}
