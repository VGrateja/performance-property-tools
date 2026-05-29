/**
 * PPA Commercial Market Overview — data feed (Google Apps Script)
 * ─────────────────────────────────────────────────────────────────
 * Source spreadsheet:
 *   docs.google.com/spreadsheets/d/1kbiflIP5PHjP0_MUTZvDzDAaPbW0XPo5WfB1ShUmbj8/
 *
 * Pulls every GRID tab in the spreadsheet — the commercial report
 * uses the whole book. Each tab becomes a top-level entry in the
 * response, keyed by a slugified tab name. Every column on each tab
 * becomes a key inside that entry, keyed by camelCased header.
 * Trailing blank cells per column are trimmed.
 *
 * Returns:
 *   {
 *     _meta: { generated, sheetName, tabCount, skippedTabs },
 *     tabs: {
 *       'cash-rate-v-inflation': { year:[...], cashRate:[...], inflationRate:[...] },
 *       'retail-turnover':       { date:[...], retailTurnover:[...] },
 *       ...
 *     }
 *   }
 *
 * NOTE — every top-level identifier in this file is prefixed with
 * CR_ (Commercial Report) so the script can coexist with the
 * National script (or any other Apps Script) inside the same
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
 *      tools/commercial-report.html
 *
 * To update later:
 *   - Edit this file → Save → Deploy → Manage deployments → Edit
 *     → Version: New version → Deploy
 */

const CR_SKIP_TABS = [
  'README',
  'INSTRUCTIONS',
  'GUIDE',
  'DASHBOARD GUIDE',
];

const CR_ERROR_CELL_RE = /^#(REF|N\/A|VALUE|NAME|NUM|ERROR|DIV\/0)/;
const CR_COLUMN_MAP = {};

function doGet(e) {
  const ss = SpreadsheetApp.getActive();
  const out = {
    _meta: {
      generated:   new Date().toISOString(),
      sheetName:   ss.getName(),
      tabCount:    0,
      skippedTabs: [],
    },
    tabs: {},
  };

  ss.getSheets().forEach(function (sheet) {
    let tabName = '';
    try {
      tabName = sheet.getName();
      if (CR_SKIP_TABS.indexOf(String(tabName).trim().toUpperCase()) >= 0) {
        out._meta.skippedTabs.push(tabName + ' (in SKIP_TABS)');
        return;
      }
      /* Skip non-grid sheets — chart sheets and embedded-object
         sheets throw "Action not supported for sheet OBJECT" when
         you call getLastRow / getRange on them. There's no public
         getType() that distinguishes them reliably, so we just try
         and skip on error. */
      let lastRow, lastCol;
      try {
        lastRow = sheet.getLastRow();
        lastCol = sheet.getLastColumn();
      } catch (typeErr) {
        out._meta.skippedTabs.push(tabName + ' (not a grid sheet)');
        return;
      }
      if (lastRow < 2 || lastCol < 1) {
        out._meta.skippedTabs.push(tabName + ' (empty)');
        return;
      }
      const slug = cr_slugifyTabName(tabName);
      if (!slug) {
        out._meta.skippedTabs.push(tabName + ' (slug empty)');
        return;
      }
      out.tabs[slug] = cr_readSheet(sheet);
    } catch (err) {
      /* Last-ditch catch — anything else throws and we still don't
         want one broken tab to kill the whole response. */
      out._meta.skippedTabs.push((tabName || '?') + ' (error: ' + (err && err.message || err) + ')');
    }
  });

  out._meta.tabCount = Object.keys(out.tabs).length;
  return cr_jsonResp(out);
}

function cr_jsonResp(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function cr_readSheet(sheet) {
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

    const key = cr_lookupKey(header);
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
      if (typeof v === 'string' && CR_ERROR_CELL_RE.test(v)) return null;
      return v;
    });

    result[key] = trimmed;
  });

  return result;
}

function cr_slugifyTabName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cr_lookupKey(header) {
  if (CR_COLUMN_MAP[header]) return CR_COLUMN_MAP[header];
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
