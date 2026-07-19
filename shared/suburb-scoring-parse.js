/* ============================================================================
   shared/suburb-scoring-parse.js — parser for the "Simple Suburb Scoring"
   market workbooks (window.PP_SSCORE / globalThis.PP_SSCORE)
   ----------------------------------------------------------------------------
   One parser, two consumers: the in-tool ingest drop-zone in
   tools/suburb-scoring.html (monthly refresh, dev/admin) and the Node seed
   scratch/seed-suburb-scores.mjs (initial load). Feed it a SheetJS workbook.

   Workbook dialects (surveyed across all 13 markets, 2026-07-19):
   • Sheet names:  "H Current Place in Cycle" | "H - Current Place in Cycle";
                   "H Suburbs Ranking" (7 regionals have NO ranking sheet —
                   their cycle sheet IS the suburb list); "H Scoring Ref".
   • First column: "LGA" | "LGA / SUBURB" | "Suburbs"+"LGA Name".
   • LT growth:    "LT Growth" | "Price LT CAGR".
   • Baselines:    "… at start of stagnation - 2018" | "… start of growth - 2018".
   • CAGRs:        "Stagnation CAGR - Rent" | "Growth CAGR - Rent" |
                   "Rent CAGR Since 2018" (same for Price).
   • Top price:    "Top MHP" | "Top MUP".
   Values are read RAW (typed): percents arrive as fractions, currency as
   numbers — no string scraping.

   Output shape per market:
     { marketSlug, label, kinds: { h?:DATASET, u?:DATASET }, warnings[] }
     DATASET = { benchmark:ROW, rows:[ROW…], scoringRef:[{band,adj,applied}] }
     ROW = { suburb, lga, isLga, yield, lt, quality, topPrice, runway, rec,
             rent0, rent, price0, price, cagrRent, cagrPrice, scoreRent,
             scorePrice, scoreValue, adjValue, dom, demand }
   benchmark = the first data row of the cycle sheet (GREATER <MARKET> /
   the region total); ranking rows repeating it are dropped.
   ============================================================================ */
(function (root) {
  'use strict';

  /* filename / hint → market slug (rdp_regions slugs, so Forge joins work later) */
  var MARKETS = {
    'melbourne': 'Melbourne', 'adelaide': 'Adelaide', 'sydney': 'Sydney',
    'perth': 'Perth', 'brisbane': 'Brisbane', 'darwin': 'Darwin',
    'ballarat': 'Ballarat', 'bendigo': 'Bendigo', 'geelong': 'Geelong',
    'rockhampton': 'Rockhampton', 'rockingham': 'Rockingham',
    'townsville': 'Townsville', 'toowoomba': 'Toowoomba'
  };

  function detectMarket(hint) {
    var h = String(hint || '').toLowerCase();
    for (var slug in MARKETS) if (h.indexOf(slug) >= 0) return slug;
    return null;
  }

  /* normalized header → field key */
  function normHdr(s) {
    return String(s || '').toLowerCase().replace(/\s*-\s*20\d\d\s*$/, '').replace(/\s+/g, ' ').trim();
  }
  var HEADMAP = {
    'suburbs': 'suburb', 'suburb': 'suburb',
    'lga name': 'lga', 'lga': 'lga', 'lga / suburb': 'suburb',   /* cycle sheets: the col is the row's NAME */
    'yield': 'yield',
    'lt growth': 'lt', 'price lt cagr': 'lt',
    'fixed suburb quality': 'quality',
    'top mhp': 'topPrice', 'top mup': 'topPrice',
    'runway left': 'runway',
    'recommendation': 'rec',
    'rent at start of stagnation': 'rent0', 'rent at start of growth': 'rent0',
    'current rent': 'rent',
    'current price': 'price',
    'price at start of stagnation': 'price0', 'price at start of growth': 'price0',
    'stagnation cagr - rent': 'cagrRent', 'growth cagr - rent': 'cagrRent', 'rent cagr since': 'cagrRent',
    'stagnation cagr - price': 'cagrPrice', 'growth cagr - price': 'cagrPrice', 'price cagr since': 'cagrPrice',
    'rental score': 'scoreRent',
    'price score': 'scorePrice',
    'value score': 'scoreValue',
    'adjusted value score': 'adjValue',
    'days on market': 'dom',
    'demand': 'demand'
  };
  function fieldFor(hdr) {
    var n = normHdr(hdr);
    if (HEADMAP[n]) return HEADMAP[n];
    if (/^rent cagr since/.test(n)) return 'cagrRent';
    if (/^price cagr since/.test(n)) return 'cagrPrice';
    return null;
  }

  var NUMF = { yield: 1, lt: 1, topPrice: 1, runway: 1, rent0: 1, rent: 1, price0: 1, price: 1, cagrRent: 1, cagrPrice: 1, scoreRent: 1, scorePrice: 1, scoreValue: 1, adjValue: 1, dom: 1 };

  function num(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var n = Number(String(v).replace(/[$,%\s,]/g, ''));
    if (!isFinite(n)) return null;
    return /%\s*$/.test(String(v)) ? n / 100 : n;
  }

  function findSheet(names, re) {
    for (var i = 0; i < names.length; i++) if (re.test(names[i])) return names[i];
    return null;
  }

  function sheetRows(XLSX, ws) {
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  }

  function parseTable(XLSX, ws, marketLabel, isCycle, warnings, tag) {
    var rows = sheetRows(XLSX, ws);
    if (!rows.length) return [];
    var hdr = rows[0], map = {};
    for (var c = 0; c < hdr.length; c++) { var f = fieldFor(hdr[c]); if (f && map[f] == null) map[f] = c; }
    var missing = ['yield', 'quality', 'runway', 'price'].filter(function (f) { return map[f] == null; });
    if (missing.length) warnings.push(tag + ': missing columns ' + missing.join(','));
    var nameCol = map.suburb != null ? map.suburb : map.lga;
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      var name = row && row[nameCol] != null ? String(row[nameCol]).trim() : '';
      if (!name) continue;
      var o = {
        suburb: name,
        lga: map.lga != null && map.lga !== nameCol && row[map.lga] != null ? String(row[map.lga]).trim() : (isCycle ? name : marketLabel),
        isLga: !!isCycle
      };
      for (var f in map) {
        if (f === 'suburb' || f === 'lga') continue;
        var v = row[map[f]];
        o[f] = NUMF[f] ? num(v) : (v == null ? null : String(v).trim());
      }
      out.push(o);
    }
    return out;
  }

  function parseScoringRef(XLSX, ws) {
    var rows = sheetRows(XLSX, ws), out = [];
    for (var r = 0; r < rows.length; r++) {
      var a = rows[r] || [];
      /* rows look like: [band, adjustment, applied%, appliedRaw] under a "Score | Adjustment | …" header */
      if (a[0] != null && String(a[0]).trim() && a[1] != null && isFinite(Number(a[1])) && !/score/i.test(String(a[0]))) {
        out.push({ band: String(a[0]).trim(), adj: Number(a[1]), applied: num(a[2]) });
      }
    }
    return out;
  }

  /* wb = SheetJS workbook; hint = filename or market label; XLSX = the SheetJS namespace */
  function parseWorkbook(XLSX, wb, hint) {
    var slug = detectMarket(hint);
    var warnings = [];
    if (!slug) return { marketSlug: null, warnings: ['market not recognized from "' + hint + '"'] };
    var label = MARKETS[slug];
    var kinds = {};
    ['H', 'U'].forEach(function (K) {
      var kkey = K.toLowerCase();
      var cyc = findSheet(wb.SheetNames, new RegExp('^' + K + '\\s*-?\\s*Current Place in Cycle$', 'i'));
      if (!cyc) { warnings.push(label + ': no ' + K + ' cycle sheet'); return; }
      var rank = findSheet(wb.SheetNames, new RegExp('^' + K + '\\s*-?\\s*Suburbs? Ranking$', 'i'));
      var sref = findSheet(wb.SheetNames, new RegExp('^' + K + '\\s*-?\\s*Scoring Ref$', 'i'));
      var tag = label + ' ' + K;
      var cycRows = parseTable(XLSX, wb.Sheets[cyc], label, true, warnings, tag + ' cycle');
      if (!cycRows.length) { warnings.push(tag + ': cycle sheet empty'); return; }
      var benchmark = cycRows[0];
      var rows;
      if (rank) {
        var subRows = parseTable(XLSX, wb.Sheets[rank], label, false, warnings, tag + ' ranking')
          .filter(function (r) { return r.suburb.toUpperCase() !== benchmark.suburb.toUpperCase(); });
        /* LGAs from the cycle sheet + suburbs from the ranking sheet, LGAs first */
        rows = cycRows.slice(1).concat(subRows);
      } else {
        /* no ranking sheet — the cycle sheet IS the suburb list */
        rows = cycRows.slice(1).map(function (r) { r.isLga = false; return r; });
      }
      kinds[kkey] = {
        benchmark: benchmark,
        rows: rows,
        scoringRef: sref ? parseScoringRef(XLSX, wb.Sheets[sref]) : []
      };
    });
    return { marketSlug: slug, label: label, kinds: kinds, warnings: warnings };
  }

  root.PP_SSCORE = {
    MARKETS: MARKETS,
    detectMarket: detectMarket,
    parseWorkbook: parseWorkbook
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
