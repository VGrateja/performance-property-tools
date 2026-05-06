/**
 * PPA Runway v Demand — V2 runway data feed (Google Apps Script)
 * ────────────────────────────────────────────────────────────────────
 * Source spreadsheet: contains two tabs:
 *   - "Wage growth Prediction"  (Houses)
 *       Year cell:        I9
 *       Variable rate:    S10
 *       Region names:     B18:B53
 *       Runway values:    R18:R53
 *   - "Wage (Units)"            (Units)
 *       Year cell:        O9
 *       Variable rate:    J10
 *       Region names:     B16:B51
 *       Runway values:    Q16:Q51
 *
 * Returns:
 *   {
 *     _meta: { generated, sheetId },
 *     house: {
 *       year: 5,
 *       rate: 4.94,
 *       regions: { "Sydney": 65.2, "Melbourne": 58.1, ... }
 *     },
 *     unit: {
 *       year: 5,
 *       rate: 4.94,
 *       regions: { "Sydney": 67.0, ... }
 *     }
 *   }
 *
 * Region names are passed through as-is from column B. The client
 * (runway-demand.html) does its own fuzzy matching against its
 * canonical region list — sheet entries like "Greater Geelong" or
 * "Port Macquarie-Hastings" map to "Geelong" / "Port Macquarie" via
 * a contains-test there. "Mandurah" has no canonical match and is
 * silently dropped. This Apps Script stays simple and just returns
 * everything; the client decides what to keep.
 *
 * Deploy:
 *   1) Open the source sheet → Extensions → Apps Script
 *   2) Replace Code.gs with this entire file → Save
 *   3) Deploy → New deployment → type: Web app
 *      - Execute as: Me
 *      - Who has access: Anyone
 *   4) Copy the /exec URL and paste it into runway-demand.html as
 *      RUNWAY_V2_URL (search for "TODO: paste Apps Script Web App URL").
 *
 * To update later:
 *   - Edit this file → Save → Deploy → Manage deployments → Edit
 *     (pencil) → Version: New version → Deploy.
 */

const HOUSE_TAB_NAME = 'Wage growth Prediction';
const UNIT_TAB_NAME  = 'Wage (Units)';

/* Coerce a cell value to a finite number, or null if it isn't.
   Apps Script returns "" for empty cells and Date for date-formatted
   ones; both should fall through to null. */
function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* Read a tab's runway block + legend cells. nameRange is the column-B
   address (e.g. "B18:B53") and rwRange is the runway-column address
   (e.g. "R18:R53"). yearCell + rateCell are single-cell A1 refs. */
function _readTab(sheet, nameRange, rwRange, yearCell, rateCell) {
  if (!sheet) return null;
  const names = sheet.getRange(nameRange).getValues().map(r => r[0]);
  const rws   = sheet.getRange(rwRange).getValues().map(r => r[0]);
  const regions = {};
  names.forEach((raw, i) => {
    if (!raw) return;
    const name = String(raw).trim();
    if (!name) return;
    const v = _num(rws[i]);
    if (v === null) return;
    regions[name] = v;
  });
  return {
    year: _num(sheet.getRange(yearCell).getValue()),
    rate: _num(sheet.getRange(rateCell).getValue()),
    regions: regions
  };
}

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const houseSheet = ss.getSheetByName(HOUSE_TAB_NAME);
  const unitSheet  = ss.getSheetByName(UNIT_TAB_NAME);

  const out = {
    _meta: {
      generated: new Date().toISOString(),
      sheetId: ss.getId(),
      houseTab: HOUSE_TAB_NAME,
      unitTab: UNIT_TAB_NAME
    },
    house: _readTab(houseSheet, 'B18:B53', 'R18:R53', 'I9', 'S10'),
    unit:  _readTab(unitSheet,  'B16:B51', 'Q16:Q51', 'O9', 'J10')
  };

  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}
