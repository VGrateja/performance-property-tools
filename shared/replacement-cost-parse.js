/* ============================================================================
   shared/replacement-cost-parse.js — parser for the research team's
   "<REGION> _ Replacement Cost.xlsx" workbooks (REPLACEMENT COST TEMPLATE).
   Used by the Data Forge Replacement Cost card (workbook drop) and
   scratch/seed-replacement-cost.mjs. Exposes PP_RCOST.parseWorkbook.

   Two dialects (both seen in the 2026-07 drop):
     · simple — one summary row driven by the OUTER land band
       (ADELAIDE / BRISBANE / Perth / ROCKINGHAM)
     · banded — INNER / MID / OUTER summary blocks, each with its own
       per-band Comparable-built averages (MELBOURNE / EAST MELBOURNE / SYDNEY)
   The canonical cross-region summary is the OUTER block (the template's own
   Replacement Cost sheet pulls 'Land Cost'!C4 = Outer).

   %-discount is stored SIGNED = (comparableMhp − replacementCost) /
   replacementCost — negative means established stock trades BELOW replacement
   (a discount). Six of seven workbooks author it that way; ADELAIDE wraps it
   in ABS() — we normalise and keep the authored value in authoredPct.
   ============================================================================ */
(function (root) {
  'use strict';

  var num = function (v) { return (typeof v === 'number' && isFinite(v)) ? v : null; };
  var str = function (v) { return String(v == null ? '' : v).trim(); };
  var lc = function (v) { return str(v).toLowerCase(); };
  /* Excel serial → 'YYYY-MM-DD' (round, don't cellDates — see project rule) */
  function serialToIso(v) {
    if (typeof v !== 'number' || !isFinite(v) || v < 20000 || v > 60000) return null;
    var d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  function normBand(v) {
    var s = lc(v);
    if (s === 'inner') return 'inner';
    if (s === 'middle' || s === 'mid') return 'middle';
    if (s === 'outer') return 'outer';
    return null;
  }
  function normQuality(v) {
    var s = lc(v);
    if (s === 'inferior') return 'Inferior';
    if (s === 'comparable') return 'Comparable';
    if (s === 'superior') return 'Superior';
    return null;
  }

  /* grid = 2D array of cell VALUES; fx = matching 2D array of formulas (or null) */
  function sheetGrid(XLSX, ws) {
    var vals = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    var fx = [];
    var range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    if (range) {
      for (var r = 0; r <= range.e.r; r++) {
        fx[r] = [];
        for (var c = 0; c <= range.e.c; c++) {
          var cell = ws[XLSX.utils.encode_cell({ r: r, c: c })];
          fx[r][c] = cell && cell.f ? cell.f : null;
          /* error cells (#DIV/0! etc.) come through as {t:'e'} — null them */
          if (cell && cell.t === 'e' && vals[r]) vals[r][c] = null;
        }
      }
    }
    return { vals: vals, fx: fx };
  }
  function findSheet(wb, res) {
    for (var i = 0; i < res.length; i++) {
      var name = wb.SheetNames.find(function (n) { return res[i].test(n); });
      if (name) return wb.Sheets[name];
    }
    return null;
  }

  /* ── Land Cost sheet ── bands at the top, sale listings below */
  function parseLand(XLSX, ws, warnings) {
    var g = sheetGrid(XLSX, ws), rows = g.vals;
    var out = { lotSize: 400, band: 'outer', bands: {}, rules: {}, sales: [], cost: null };
    for (var r = 0; r < Math.min(rows.length, 6); r++) {
      var b = normBand(rows[r] && rows[r][0]);
      if (!b) continue;
      var row = rows[r];
      out.bands[b] = { n: 0, sqm: num(row[3]), price: num(row[4]), perSqm: num(row[5]), cost: num(row[2]) };
      if (num(row[1]) != null) out.lotSize = num(row[1]);
      if (str(row[6])) out.rules[b] = str(row[6]);
    }
    /* listing header row: 'Link' in col A */
    var hr = -1;
    for (var r2 = 0; r2 < Math.min(rows.length, 10); r2++) if (lc(rows[r2] && rows[r2][0]) === 'link') { hr = r2; break; }
    if (hr < 0) { warnings.push('Land Cost: listing header row (Link/Date/…) not found'); }
    else {
      for (var r3 = hr + 1; r3 < rows.length; r3++) {
        var s = rows[r3]; if (!s) continue;
        var url = str(s[0]), price = num(s[4]);
        if (!url && price == null) continue;
        var band = normBand(s[2]);
        var note = str(s[6]); if (str(s[7])) note = (note ? note + ' ' : '') + str(s[7]);
        out.sales.push({ url: url || null, date: serialToIso(s[1]), band: band, sqm: num(s[3]), price: price, perSqm: num(s[5]), note: note || null });
        if (band && out.bands[band]) out.bands[band].n++;
      }
    }
    out.cost = out.bands.outer ? out.bands.outer.cost : null;
    return out;
  }

  /* ── Construction cost sheet ── FY base + quarterly index chain + 5% other */
  function parseConstruction(XLSX, ws, warnings) {
    var g = sheetGrid(XLSX, ws), rows = g.vals, fx = g.fx;
    var out = { baseFrom: null, baseFromCost: null, baseTo: null, baseCost: null, chain: [], chained: null, otherPct: 0.05, other: null, cost: null };
    var lr = -1;
    for (var r = 0; r < Math.min(rows.length, 6); r++) {
      if ((rows[r] || []).some(function (v) { return /^20\d{2}-\d{2}$/.test(str(v)); })) { lr = r; break; }
    }
    if (lr < 0) { warnings.push('Construction cost: FY label row not found'); return out; }
    var labels = rows[lr] || [], pcts = rows[lr + 1] || [], chained = rows[lr + 2] || [];
    var fys = [], qs = [];
    labels.forEach(function (v, c) {
      var s = str(v);
      if (/^20\d{2}-\d{2}$/.test(s)) fys.push({ c: c, fy: s });
      else { var m = s.match(/^(20\d{2})\s*Q([1-4])/i); if (m) qs.push({ c: c, q: m[1] + ' Q' + m[2] }); }
    });
    if (fys[0]) { out.baseFrom = fys[0].fy; out.baseFromCost = num(pcts[fys[0].c]); }
    if (fys[1]) { out.baseTo = fys[1].fy; out.baseCost = num(pcts[fys[1].c]); }
    qs.forEach(function (q, i) {
      var step = { q: q.q, pct: num(pcts[q.c]), value: num(chained[q.c]) };
      /* a chained cell with NO formula (past the first) is a hand override —
         Melbourne/East Melbourne hard-set 2024 Q4 to a newer ABS figure */
      if (i > 0 && step.value != null && !(fx[lr + 2] && fx[lr + 2][q.c])) step.override = true;
      out.chain.push(step);
    });
    out.chained = out.chain.length ? out.chain[out.chain.length - 1].value : null;
    /* other costs = 5% of the last chained value; total sits under an exact
       'Construction cost' / 'Replacement cost' label in row 1 */
    for (var c2 = 0; c2 < (rows[0] || []).length; c2++) {
      var l0 = lc(rows[0][c2]);
      if (l0 === 'construction cost' || l0 === 'replacement cost') { out.cost = num((rows[1] || [])[c2]); }
      if (/\*\s*0?\.05\b/.test((fx[0] && fx[0][c2]) || '')) { out.other = num(rows[0][c2]); }
    }
    if (out.other == null && out.chained != null && out.cost != null) out.other = out.cost - out.chained;
    if (out.cost == null) warnings.push('Construction cost: total cell not found');
    return out;
  }

  /* ── Comparable built / Comps for MHP sheet ── averages + tagged sales */
  function parseComps(XLSX, ws, warnings) {
    var g = sheetGrid(XLSX, ws), rows = g.vals;
    var out = { banded: false, avgs: {}, bandAvgs: {}, sales: [], mhp: null };
    /* data header row: contains 'Property' + 'Price' */
    var hr = -1, hdr = null;
    for (var r2 = 0; r2 < Math.min(rows.length, 8); r2++) {
      var cells = (rows[r2] || []).map(lc);
      if (cells.indexOf('property') >= 0 && cells.indexOf('price') >= 0) { hr = r2; hdr = cells; break; }
    }
    if (hr < 0) { warnings.push('Comparable built: data header row not found'); return out; }
    /* averages: value sits LEFT of each exact Inferior/Comparable/Superior label,
       on or above the header row (ADELAIDE keeps them ON the header row); a band
       word in col A of that row → per-band averages. Data rows are BELOW hr, so
       quality tags in the sales list can never be mistaken for average labels. */
    for (var r = 0; r <= hr; r++) {
      var row = rows[r] || [];
      var band = normBand(row[0]);
      for (var c = 1; c < row.length; c++) {
        var q = normQuality(row[c]);
        if (!q) continue;
        var key = q.toLowerCase(), avg = num(row[c - 1]);
        if (band) { out.banded = true; (out.bandAvgs[band] = out.bandAvgs[band] || {})[key] = avg; }
        else out.avgs[key] = avg;
      }
    }
    var iProp = hdr.indexOf('property');
    var iBand = iProp > 0 ? 0 : -1;                     // banded layout: band words in col A
    var iDate = hdr.indexOf('sold date'), iPrice = hdr.indexOf('price');
    var iQual = hdr.findIndex(function (h) { return h.indexOf('quality') === 0; });
    var iLand = hdr.indexOf('land', iProp + 1);         // sqm col (banded has 'Land' twice)
    var iNotes = hdr.indexOf('notes');
    var iAddr = iNotes >= 0 ? iNotes + 1 : -1;
    for (var r3 = hr + 1; r3 < rows.length; r3++) {
      var s = rows[r3]; if (!s) continue;
      var url = str(s[iProp]), price = num(s[iPrice]);
      if (!/^https?:/i.test(url) && price == null) continue;   // skip placeholder rows
      out.sales.push({
        band: iBand >= 0 ? normBand(s[iBand]) : null,
        url: /^https?:/i.test(url) ? url : null,
        date: serialToIso(s[iDate]),
        price: price,
        quality: normQuality(s[iQual]),
        land: iLand >= 0 ? num(s[iLand]) : null,
        notes: iNotes >= 0 && str(s[iNotes]) ? str(s[iNotes]) : null,
        addr: iAddr >= 0 && str(s[iAddr]) ? str(s[iAddr]) : null
      });
    }
    /* Adelaide's 'Comps for MHP': averages live on the header row itself
       (F1/H1/J1 values with G1/I1/K1 labels) — covered by the loop above */
    out.mhp = out.banded ? (out.bandAvgs.outer && out.bandAvgs.outer.comparable) : out.avgs.comparable;
    if (out.mhp == null) warnings.push('Comparable built: no Comparable average (outer) found');
    return out;
  }

  /* ── Replacement Cost summary sheet ── simple row or INNER/MID/OUTER blocks */
  function parseSummary(XLSX, ws, warnings) {
    var g = sheetGrid(XLSX, ws), rows = g.vals;
    var title = str((rows[0] || [])[0]).split('\n').slice(1).join(' ').trim() || null;
    var banded = rows.some(function (row) { return /^(INNER|MID|OUTER)$/i.test(str(row && row[0])); });
    function block(hdrRow, valRow) {
      var hdr = (rows[hdrRow] || []).map(lc), v = rows[valRow] || [];
      var iLand = hdr.findIndex(function (h) { return h.indexOf('land cost') === 0; });
      var iBuild = hdr.findIndex(function (h) { return h.indexOf('build cost') === 0; });
      var iRepl = hdr.findIndex(function (h) { return h.indexOf('replacement cost') === 0; });
      var iMhp = hdr.findIndex(function (h) { return h.indexOf('comparable mhp') === 0; });
      var iDisc = hdr.findIndex(function (h) { return h.indexOf('discount to buy') === 0; });
      var iPct = hdr.findIndex(function (h) { return h.indexOf('% discount') === 0; });
      return {
        landCost: iLand >= 0 ? num(v[iLand]) : null,
        buildCost: iBuild >= 0 ? num(v[iBuild]) : null,
        replacementCost: iRepl >= 0 ? num(v[iRepl]) : null,
        comparableMhp: iMhp >= 0 ? num(v[iMhp]) : null,
        discount: iDisc >= 0 ? num(v[iDisc]) : null,
        pctDiscount: iPct >= 0 ? num(v[iPct]) : null
      };
    }
    function medOf(r) {   // 'med price' row: label anywhere; med = next cell, adjusted = last numeric after
      var row = rows[r] || [];
      var iLab = row.findIndex(function (v) { return lc(v) === 'med price'; });
      if (iLab < 0) return null;
      var med = null, adj = null;
      for (var c = iLab + 1; c < row.length; c++) {
        var n = num(row[c]);
        if (n == null) continue;
        if (med == null) med = n; else adj = n;
      }
      return { med: med, adj: adj };
    }
    var out = { title: title, banded: banded, summary: null, bandSummaries: null, medPrice: null };
    if (!banded) {
      var hr = -1;
      for (var r = 0; r < Math.min(rows.length, 5); r++) {
        if ((rows[r] || []).some(function (v) { return lc(v).indexOf('land cost 400') === 0; })) { hr = r; break; }
      }
      if (hr < 0) { warnings.push('Replacement Cost: summary header row not found'); return out; }
      out.summary = block(hr, hr + 1);
      var m = medOf(hr + 2) || medOf(hr + 3);
      if (m) { out.medPrice = m.med; out.summary.medPrice = m.med; out.summary.medAdjusted = m.adj; }
    } else {
      out.bandSummaries = {};
      for (var r2 = 0; r2 < rows.length; r2++) {
        var mark = str(rows[r2] && rows[r2][0]).toUpperCase();
        if (mark !== 'INNER' && mark !== 'MID' && mark !== 'OUTER') continue;
        var band = mark === 'INNER' ? 'inner' : mark === 'MID' ? 'middle' : 'outer';
        var b = block(r2 + 1, r2 + 2);
        var m2 = medOf(r2 + 3);
        if (m2) { b.medPrice = m2.med; b.medAdjusted = m2.adj; if (out.medPrice == null) out.medPrice = m2.med; }
        out.bandSummaries[band] = b;
      }
      out.summary = out.bandSummaries.outer || null;
      if (!out.summary) warnings.push('Replacement Cost: no OUTER block found');
    }
    return out;
  }

  /* region slug guess from the file name / summary title */
  var RC_REGION_HINTS = [
    [/east\s*mel/i, 'east-melbourne'], [/melbourne/i, 'melbourne'], [/sydney/i, 'sydney'],
    [/brisbane/i, 'brisbane'], [/adelaide/i, 'adelaide'], [/rockingham/i, 'rockingham'],
    [/perth/i, 'perth'], [/hobart/i, 'hobart'], [/canberra/i, 'canberra'], [/darwin/i, 'darwin'],
    [/gold\s*coast/i, 'gold-coast'], [/sunshine\s*coast/i, 'sunshine-coast'], [/central\s*coast/i, 'central-coast'],
    [/newcastle/i, 'newcastle'], [/wollongong/i, 'wollongong'], [/geelong/i, 'geelong'], [/bendigo/i, 'bendigo'],
    [/ballarat/i, 'ballarat'], [/mandurah/i, 'mandurah'], [/bunbury/i, 'bunbury'], [/townsville/i, 'townsville'],
    [/cairns/i, 'cairns'], [/toowoomba/i, 'toowoomba'], [/mackay/i, 'mackay'], [/rockhampton/i, 'rockhampton'],
    [/bundaberg/i, 'bundaberg'], [/gladstone/i, 'gladstone'], [/ipswich/i, 'ipswich'], [/launceston/i, 'launceston'],
    [/albury/i, 'albury'], [/wodonga/i, 'wodonga'], [/wagga/i, 'wagga-wagga'], [/mildura/i, 'mildura'],
    [/tamworth/i, 'tamworth'], [/orange/i, 'orange'], [/coffs/i, 'coffs-harbour'], [/port\s*macquarie/i, 'port-macquarie'],
  ];
  function guessRegion(fileName, title) {
    for (var i = 0; i < RC_REGION_HINTS.length; i++) {
      if (RC_REGION_HINTS[i][0].test(fileName || '')) return RC_REGION_HINTS[i][1];
    }
    for (var j = 0; j < RC_REGION_HINTS.length; j++) {
      if (RC_REGION_HINTS[j][0].test(title || '')) return RC_REGION_HINTS[j][1];
    }
    return null;
  }

  /* main entry — XLSX = the SheetJS module, wb = a read workbook */
  function parseWorkbook(XLSX, wb, fileName) {
    var warnings = [];
    var wsSum = findSheet(wb, [/^replacement cost$/i, /replacement cost/i]);
    var wsCon = findSheet(wb, [/^construction cost$/i, /construction/i]);
    var wsLand = findSheet(wb, [/^land cost$/i, /land/i]);
    var wsComp = findSheet(wb, [/comparable built/i, /comps for mhp/i, /comparable/i, /comps/i]);
    if (!wsSum || !wsCon || !wsLand || !wsComp) {
      return { payload: null, warnings: ['Not a Replacement Cost workbook (missing ' +
        [!wsSum && 'Replacement Cost', !wsCon && 'Construction cost', !wsLand && 'Land Cost', !wsComp && 'Comparable built'].filter(Boolean).join(', ') + ' sheet)'] };
    }
    var sum = parseSummary(XLSX, wsSum, warnings);
    var land = parseLand(XLSX, wsLand, warnings);
    var build = parseConstruction(XLSX, wsCon, warnings);
    var comps = parseComps(XLSX, wsComp, warnings);
    var summary = sum.summary || {};
    /* normalise the % SIGNED from the stored parts (ADELAIDE authored ABS()) */
    if (summary.replacementCost != null && summary.comparableMhp != null) {
      var signed = (summary.comparableMhp - summary.replacementCost) / summary.replacementCost;
      if (summary.pctDiscount != null && Math.abs(summary.pctDiscount - signed) > 1e-9) {
        summary.authoredPct = summary.pctDiscount;
        warnings.push('% discount normalised to signed convention (authored ' + summary.pctDiscount.toFixed(6) + ' → ' + signed.toFixed(6) + ')');
      }
      summary.pctDiscount = signed;
    }
    /* cross-checks: summary should reconcile with the part sheets */
    function ck(a, b, label) { if (a != null && b != null && Math.abs(a - b) > 1) warnings.push(label + ' mismatch: summary ' + a + ' vs sheet ' + b); }
    ck(summary.landCost, land.cost, 'Land cost');
    ck(summary.buildCost, build.cost, 'Build cost');
    ck(summary.comparableMhp, comps.mhp, 'Comparable MHP');
    /* as-of = the newest sale date seen anywhere in the research */
    var maxDate = null;
    land.sales.concat(comps.sales).forEach(function (s2) { if (s2.date && (!maxDate || s2.date > maxDate)) maxDate = s2.date; });
    var payload = {
      title: sum.title, dialect: sum.banded ? 'banded' : 'simple',
      land: land, build: build, comps: comps,
      summary: summary, bandSummaries: sum.bandSummaries || undefined,
      medPrice: sum.medPrice != null ? sum.medPrice : undefined,
      source: { kind: 'workbook', file: fileName || null }
    };
    return {
      payload: payload, warnings: warnings,
      regionGuess: guessRegion(fileName, sum.title),
      asOf: maxDate ? maxDate.slice(0, 7) : null,
      counts: { landSales: land.sales.length, compSales: comps.sales.length }
    };
  }

  root.PP_RCOST = { parseWorkbook: parseWorkbook, guessRegion: guessRegion };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
