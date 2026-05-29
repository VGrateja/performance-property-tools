/**
 * PPA National Market Overview — data feed (Google Apps Script)
 * ────────────────────────────────────────────────────────────────
 * Source spreadsheet:
 *   docs.google.com/spreadsheets/d/1PrFd7Gb0VJpUZ5CR_7T0LfOnIaqS5lw7Idxy9WFkw2U/
 *
 * Pulls from a SINGLE tab named AUSTRALIA. Every column on that tab
 * becomes a key in the JSON response, keyed by camelCased header.
 * Trailing blank cells per column are trimmed so list-shape columns
 * (where data ends partway down the sheet) don't carry phantom nulls.
 *
 * Returns:
 *   {
 *     _meta: { generated, sheetName, tabName, rowCount },
 *     data:  { year: [...], cashRate: [...], ... }
 *   }
 *
 * NOTE — every top-level identifier in this file is prefixed with
 * NR_ (National Report) so the script can coexist with the
 * Commercial script (or any other Apps Script) inside the same
 * project without globals colliding. Don't rename them or the
 * collision will return.
 *
 * Deploy:
 *   1) Open the spreadsheet → Extensions → Apps Script
 *   2) Replace Code.gs with this entire file → Save
 *   3) Deploy → New deployment → type: Web app
 *      - Execute as: Me
 *      - Who has access: Anyone
 *   4) Copy the /exec URL and paste it back so we can wire it into
 *      tools/national-report.html
 *
 * To update later:
 *   - Edit this file → Save → Deploy → Manage deployments → Edit
 *     → Version: New version → Deploy
 */

const NR_SOURCE_TAB = 'AUSTRALIA';
const NR_ERROR_CELL_RE = /^#(REF|N\/A|VALUE|NAME|NUM|ERROR|DIV\/0)/;
const NR_COLUMN_MAP = {};

function doGet(e) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(NR_SOURCE_TAB);
  const out = {
    _meta: {
      generated: new Date().toISOString(),
      sheetName: ss.getName(),
      tabName:   NR_SOURCE_TAB,
      rowCount:  0,
    },
    data: {},
  };

  if (!sheet) {
    out._meta.error = 'Tab "' + NR_SOURCE_TAB + '" not found in spreadsheet';
    return nr_jsonResp(out);
  }

  out.data = nr_readSheet(sheet);
  out._meta.rowCount = sheet.getLastRow() - 1;

  return nr_jsonResp(out);
}

function nr_jsonResp(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function nr_readSheet(sheet) {
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

    const key = nr_lookupKey(header);
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
      if (typeof v === 'string' && NR_ERROR_CELL_RE.test(v)) return null;
      return v;
    });

    result[key] = trimmed;
  });

  return result;
}

function nr_lookupKey(header) {
  if (NR_COLUMN_MAP[header]) return NR_COLUMN_MAP[header];
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
