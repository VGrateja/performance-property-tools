/**
 * PPA Presentation — Google Slides import feed (Google Apps Script)
 * ─────────────────────────────────────────────────────────────────────
 * Reads a Google Slides deck and returns its slides as JSON (text boxes,
 * shapes, lines, tables + images, with positions + styles), so the
 * Presentation tool can turn an advisor's existing deck into an editable
 * presentation to redesign. RAW MATERIALS only — NOT an auto-redesign.
 *
 * TWO DATA SOURCES, combined:
 *   • SlidesApp — the element WALK (geometry, text, shapes, tables, images).
 *   • Slides REST API (presentations.get, via UrlFetch + the script's own
 *     OAuth token — no Advanced Service to enable) — ENRICHMENT keyed by
 *     objectId: theme-colour scheme (so theme-coloured text/fills resolve to
 *     real hex), image CROP rectangles + contentUrl (fixes "cut"/"missing"
 *     images), and exact table row heights. REST is best-effort: if it fails
 *     (scope/quota), the walk still returns everything it can.
 *   ⚠ Adding UrlFetch introduces the external-request scope, so the FIRST
 *     run after this update will prompt to RE-AUTHORISE on redeploy.
 *
 * Unlike the report feeds, this script is STANDALONE (not bound to a
 * spreadsheet) and takes the deck to read as a query parameter:
 *   <web-app-url>/exec?id=<deck id or full Slides URL>
 *
 * Two response modes (image bytes are NOT inlined by default — a deck full
 * of base64 images balloons into multi-MB JSON that breaks Apps Script's
 * output limits and is too big to share/debug):
 *
 *   1) STRUCTURAL (default)  …/exec?id=<deck>
 *      {
 *        _meta: { generated, title, pageW, pageH, slideCount, imageCount,
 *                 inlineImages:false, enriched:<bool>, skipped:{...} },
 *        slides: [ { background?, elements: [
 *           { type:'text',  x,y,w,h, rotation, text, fontSize?, bold?, italic?,
 *             underline?, color?, bgColor?, fontFamily?, lineHeight?, align?, valign? },
 *           { type:'shape', x,y,w,h, rotation, kind, fill?, stroke?, strokeWidth? },
 *           { type:'image', x,y,w,h, rotation, imgIndex,
 *             cropFracL?, cropFracR?, cropFracT?, cropFracB? }   // crop, no bytes
 *        ] }, ... ]
 *      }
 *      Geometry + styles, no image bytes — a few KB for a whole deck.
 *      `background` = the slide's solid bg colour (slide→layout→master,
 *      theme-resolved). Colours are theme-resolved to hex where possible.
 *      Straight lines import as a thin line/bar; bent/elbow connectors are
 *      skipped (counted as `connector`). Table cells become positioned text
 *      + shape (cell-fill) overlays (no `table` type). `valign` = vertical
 *      anchoring (middle/bottom) so text sits where the box placed it.
 *      `cropFrac*` are crop offsets as fractions (the tool windows the
 *      image). `imgIndex` = the image's deck-wide position (walk order);
 *      fetch its bytes via mode 2.
 *
 *   2) ONE IMAGE  …/exec?id=<deck>&img=<imgIndex>
 *      { imgIndex, contentType, dataUrl }   // base64 data URL for that one image
 *      The tool loops imgIndex 0..imageCount-1, uploading each to Storage.
 *      Falls back to the REST contentUrl when SlidesApp can't export the blob.
 *
 *   3) SNAPSHOT (pixel-perfect, NON-editable) — the reliable copy mode:
 *      …/exec?id=<deck>&mode=snapshot  → { _meta:{…,slideCount,snapshot:true}, slides:[…] }
 *      …/exec?id=<deck>&thumb=<n>      → { thumbIndex, contentType, dataUrl }  // slide n as a PNG
 *      Each slide is rendered to a PNG by Google (REST thumbnail). The tool
 *      sets each as a LOCKED full-slide background image, so the slide looks
 *      identical to Google Slides — you can still layer editable text/charts
 *      on top, but the snapshot itself isn't element-editable.
 *
 *   (?inlineImages=1 forces the old behaviour — base64 inlined in the
 *    structural response. Tiny decks / debugging only.)
 *
 * x/y/w/h are in POINTS on a page of pageW × pageH points; the tool scales
 * them to its 1280×720 slide. On error: { error: "<message>" }.
 *
 * Deploy (the advisor / admin whose decks will be imported does this):
 *   1) script.google.com → New project → paste this file into Code.gs → Save
 *   2) Deploy → New deployment → type: Web app
 *        - Execute as: Me   (so it can read decks YOU can access)
 *        - Who has access: Anyone   (the tool calls it anonymously; it only
 *          ever reads a deck whose id is passed in, and only decks you can see)
 *   3) Authorize the Slides + external-request scopes when prompted
 *   4) Copy the /exec URL and paste it back so it can be wired into
 *      tools/presentation.html
 *
 * To update later: edit → Save → Deploy → Manage deployments → Edit →
 * Version: New version → Deploy (re-authorise if new scopes are requested).
 *
 * All identifiers are prefixed SL_ so this can coexist with other Apps
 * Scripts in the same project without global collisions.
 */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var raw = p.id || p.deck || p.url || '';
  var id = SL_extractDeckId(raw);
  if (!id) return SL_json({ error: 'Pass ?id=<deck id or Slides URL>' });

  var pres;
  try {
    pres = SlidesApp.openById(id);
  } catch (err) {
    /* SlidesApp.openById throws a runtime error LOCALIZED to this account's
       language (e.g. Tagalog "Hindi sinusuportahan ang pagpapatakbong ito para
       sa dokumentong ito" = "This operation is not supported for this document"),
       so we DON'T surface err.message — return a clear, always-English message.
       The overwhelmingly common cause is the file being a PowerPoint (.pptx)
       opened in Google Slides' Office compatibility mode rather than a NATIVE
       Google Slides deck; the Slides API can't open those. */
    return SL_json({ error: 'Could not open deck (' + id + '). The most common cause is that the ' +
      'file is a PowerPoint (.pptx) opened in Google Slides’ Office compatibility mode, not a ' +
      'native Google Slides deck — the Slides importer cannot read those. Fix: open it in Google ' +
      'Slides and use File → Save as Google Slides, then import the converted copy. (If it is a ' +
      'native deck, make sure this importer account has access to it.)' });
  }

  // Mode 2 — return ONE image's bytes by its deck-wide index. Keeps the
  // structural response (below) tiny: the tool pulls images one at a time
  // and uploads each straight to Supabase Storage.
  if (p.img !== undefined && p.img !== '') {
    var want = parseInt(p.img, 10);
    if (isNaN(want) || want < 0) return SL_json({ error: 'img must be a non-negative integer' });
    var found = SL_findImage(pres, want);
    if (!found) return SL_json({ error: 'No image at index ' + want });
    if (found.dataUrl) return SL_json({ imgIndex: want, contentType: found.contentType, dataUrl: found.dataUrl });
    // SlidesApp couldn't export the blob (linked / odd source): fetch bytes
    // from a content URL — SlidesApp's own, else the REST contentUrl.
    var url = found.contentUrl;
    if (!url && found.oid) { var r = SL_fetchRest(id); if (r) url = SL_findContentUrl(r, found.oid); }
    if (url) {
      var fetched = SL_fetchImageBytes(url);
      if (fetched) return SL_json({ imgIndex: want, contentType: fetched.contentType, dataUrl: fetched.dataUrl });
    }
    return SL_json({ imgIndex: want, error: 'Could not export image ' + want + ' (linked or unsupported source).' });
  }

  // Mode 3a — ONE slide rendered to a PNG by slide index (pixel-perfect
  // snapshot). The tool sets each as a locked full-slide background image.
  if (p.thumb !== undefined && p.thumb !== '') {
    var tn = parseInt(p.thumb, 10);
    if (isNaN(tn) || tn < 0) return SL_json({ error: 'thumb must be a non-negative integer' });
    var tslides = pres.getSlides();
    if (tn >= tslides.length) return SL_json({ error: 'No slide at index ' + tn });
    var pageId = ''; try { pageId = tslides[tn].getObjectId(); } catch (e) {}
    var snap = pageId ? SL_slideThumb(id, pageId) : null;
    if (snap && snap.dataUrl) return SL_json({ thumbIndex: tn, contentType: snap.contentType, dataUrl: snap.dataUrl });
    return SL_json({ thumbIndex: tn, error: 'Could not render slide ' + tn + '.',
                     pageId: pageId, detail: (snap && snap._err) || 'no pageId',
                     code: (snap && snap._code) || null, body: (snap && snap._body) || null });
  }

  // Mode 3b — snapshot manifest: slide count + page size, no bytes. The tool
  // then pulls each slide's PNG via ?thumb=<n>.
  if (p.mode === 'snapshot' || p.snapshots === '1' || p.snapshots === 'true') {
    var ss = pres.getSlides();
    return SL_json({
      _meta: {
        generated: new Date().toISOString(),
        title: pres.getName(),
        pageW: pres.getPageWidth(),
        pageH: pres.getPageHeight(),
        slideCount: ss.length,
        snapshot: true,
        revisionId: SL_revisionId(id),   // lets the tool re-sync only when the deck actually changed
      },
      /* Per-slide page id = stable identity so the tool can keep user overlays
         attached to the right source slide across inserts / deletes / reorders. */
      slides: ss.map(function (s) { var pid = ''; try { pid = s.getObjectId(); } catch (e) {} return { id: pid }; }),
    });
  }

  // Mode 1 (default) — structural JSON. Build REST enrichment first (theme
  // colours, image crop, table geometry), then walk with SlidesApp.
  var rest = SL_fetchRest(id);
  var ctx = SL_buildEnrichment(rest);   // { theme, crop, contentUrl, tableGeom }
  ctx.imgCount = 0;
  ctx.skipped = {};
  ctx.inline = (p.inlineImages === '1' || p.inlineImages === 'true');

  var slides = pres.getSlides().map(function (slide) {
    var elements = [];
    SL_collectElements(slide.getPageElements(), elements, ctx);
    var out = { elements: elements };
    var bg = SL_slideBg(slide, ctx);
    if (bg) out.background = bg;
    return out;
  });

  return SL_json({
    _meta: {
      generated: new Date().toISOString(),
      title: pres.getName(),
      pageW: pres.getPageWidth(),
      pageH: pres.getPageHeight(),
      slideCount: slides.length,
      imageCount: ctx.imgCount,
      inlineImages: ctx.inline,
      enriched: !!rest,                 // did the REST enrichment pass succeed?
      skipped: ctx.skipped,             // counts of element kinds we didn't import
    },
    slides: slides,
  });
}

/* Accept a bare id or any Slides URL (…/presentation/d/<ID>/edit). */
function SL_extractDeckId(s) {
  s = String(s || '').trim();
  if (!s) return '';
  var m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  // Otherwise assume it's already a bare id (Drive ids have no slashes).
  return s.indexOf('/') === -1 ? s : '';
}

/* ─── REST enrichment ──────────────────────────────────────────────────
   Pull the presentation via the Slides REST API using the script's own
   OAuth token (SlidesApp already authorises a presentations scope; this
   just needs the external-request scope). Best-effort — returns null on
   any failure so the SlidesApp walk can carry on without enrichment. */
function SL_fetchRest(id) {
  try {
    var url = 'https://slides.googleapis.com/v1/presentations/' + encodeURIComponent(id);
    var res = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    });
    if (res.getResponseCode() !== 200) return null;
    return JSON.parse(res.getContentText());
  } catch (e) { return null; }
}

/* Build the objectId-keyed lookup maps from a REST presentation payload. */
function SL_buildEnrichment(rest) {
  var ctx = { theme: {}, crop: {}, contentUrl: {}, tableGeom: {} };
  if (!rest) return ctx;

  // Theme colour scheme — from the master(s). Covers theme-coloured text /
  // fills / backgrounds, which SlidesApp can flag as THEME but can't resolve.
  try {
    var masters = rest.masters || [];
    for (var m = 0; m < masters.length; m++) {
      var sc = masters[m].pageProperties && masters[m].pageProperties.colorScheme;
      var colors = sc && sc.colors;
      if (!colors) continue;
      for (var c = 0; c < colors.length; c++) {
        var en = colors[c];
        if (en && en.type && en.color && en.color.rgbColor && ctx.theme[en.type] === undefined) {
          ctx.theme[en.type] = SL_rgbToHex(en.color.rgbColor);
        }
      }
    }
  } catch (e) {}

  // Per-element crop + contentUrl + table geometry, keyed by objectId.
  try {
    var slides = rest.slides || [];
    for (var s = 0; s < slides.length; s++) SL_restWalk(slides[s].pageElements || [], ctx);
  } catch (e) {}
  return ctx;
}

function SL_restWalk(pageElements, ctx) {
  for (var i = 0; i < pageElements.length; i++) {
    var pe = pageElements[i];
    if (pe.elementGroup && pe.elementGroup.children) { SL_restWalk(pe.elementGroup.children, ctx); continue; }
    var oid = pe.objectId;
    if (!oid) continue;
    if (pe.image) {
      if (pe.image.contentUrl) ctx.contentUrl[oid] = pe.image.contentUrl;
      var cp = pe.image.imageProperties && pe.image.imageProperties.cropProperties;
      if (cp && (cp.leftOffset || cp.rightOffset || cp.topOffset || cp.bottomOffset)) {
        ctx.crop[oid] = { l: cp.leftOffset || 0, r: cp.rightOffset || 0, t: cp.topOffset || 0, b: cp.bottomOffset || 0 };
      }
    } else if (pe.table) {
      ctx.tableGeom[oid] = {
        rowH: (pe.table.tableRows || []).map(function (rw) { return SL_dimPt(rw.rowHeight); }),
        colW: (pe.table.tableColumns || []).map(function (cl) { return SL_dimPt(cl.columnWidth); }),
      };
    }
  }
}

/* Find an image's REST contentUrl by objectId (used for the img-bytes fallback). */
function SL_findContentUrl(rest, oid) {
  var en = SL_buildEnrichment(rest);
  return en.contentUrl[oid] || '';
}

function SL_rgbToHex(rgb) {
  function h(v) { var n = Math.round((v || 0) * 255); n = n < 0 ? 0 : (n > 255 ? 255 : n); var s = n.toString(16); return s.length === 1 ? '0' + s : s; }
  return '#' + h(rgb.red) + h(rgb.green) + h(rgb.blue);
}

/* Slides REST Dimension {magnitude, unit} → points (handles EMU + PT). */
function SL_dimPt(dim) {
  if (!dim || !dim.magnitude) return 0;
  if (dim.unit === 'EMU') return dim.magnitude / 12700;   // 12700 EMU per point
  return dim.magnitude;                                   // PT (or unspecified)
}

/* ─── SlidesApp walk ───────────────────────────────────────────────────
   Walk page elements (recursing into groups) and push entries. `ctx` carries
   the deck-wide image counter, skip tallies, inline flag, and the REST
   enrichment maps. Anything we don't import is counted in `ctx.skipped`. */
function SL_collectElements(pageElements, out, ctx) {
  var T = SlidesApp.PageElementType;
  for (var i = 0; i < pageElements.length; i++) {
    var el = pageElements[i];
    var type;
    try { type = el.getPageElementType(); } catch (e) { continue; }

    if (type === T.GROUP) {
      try { SL_collectElements(el.asGroup().getChildren(), out, ctx); } catch (e) {}
      continue;
    }

    var geom = SL_geom(el);

    if (type === T.SHAPE) {
      var shape = el.asShape();
      var text = '';
      try { text = shape.getText().asString(); } catch (e) {}
      text = (text || '').replace(/\v/g, '\n').trim();
      if (text) {
        var entry = { type: 'text', x: geom.x, y: geom.y, w: geom.w, h: geom.h, rotation: geom.r, text: text };
        SL_textStyle(shape, entry, ctx);
        out.push(entry);
      } else {
        /* Empty shape: keep it ONLY if it's a visible design element (solid
           fill or a real border) → import as a shape overlay; else drop. */
        var sh = SL_shapeStyle(shape, ctx);
        if (sh) {
          out.push({ type: 'shape', kind: SL_mapShapeKind(shape),
                     x: geom.x, y: geom.y, w: geom.w, h: geom.h, rotation: geom.r,
                     fill: sh.fill, stroke: sh.stroke, strokeWidth: sh.strokeWidth });
        } else {
          SL_bump(ctx.skipped, 'emptyShape');
        }
      }
    } else if (type === T.LINE) {
      var ln = SL_lineStyle(el, ctx);
      // ONLY import straight, thin lines (dividers, underlines). A bent/elbow/
      // diagonal connector has a large bounding box in BOTH dimensions — drawn
      // as a single box overlay it becomes a huge filled rectangle that smothers
      // the slide, so skip those (advisor re-draws connectors if needed).
      var thin = Math.min(geom.w, geom.h);
      if (ln && thin <= Math.max((ln.weight || 1) * 3, 6)) {
        if (geom.w >= geom.h) {
          // Horizontal straight line → the tool's centred horizontal line.
          out.push({ type: 'shape', kind: 'line', x: geom.x, y: geom.y, w: geom.w,
                     h: Math.max(geom.h, ln.weight || 1), rotation: geom.r,
                     fill: 'transparent', stroke: ln.stroke, strokeWidth: ln.weight || 1 });
        } else {
          // Vertical straight line → a thin filled bar (tool line is horizontal-only).
          out.push({ type: 'shape', kind: 'rect', x: geom.x, y: geom.y,
                     w: Math.max(geom.w, ln.weight || 1), h: geom.h, rotation: geom.r,
                     fill: ln.stroke, stroke: ln.stroke, strokeWidth: 0 });
        }
      } else {
        SL_bump(ctx.skipped, 'connector');
      }
    } else if (type === T.IMAGE) {
      // Placeholder by default; bytes fetched on demand via ?img=<imgIndex>.
      var idx = ctx.imgCount++;   // deck-wide index, in this same walk order
      var imgEntry = { type: 'image', x: geom.x, y: geom.y, w: geom.w, h: geom.h, rotation: geom.r, imgIndex: idx };
      var oid = ''; try { oid = el.getObjectId(); } catch (e) {}
      var cr = oid && ctx.crop && ctx.crop[oid];
      if (cr) { imgEntry.cropFracL = cr.l; imgEntry.cropFracR = cr.r; imgEntry.cropFracT = cr.t; imgEntry.cropFracB = cr.b; }
      if (ctx.inline) {
        try {
          var blob = el.asImage().getBlob();
          imgEntry.dataUrl = 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
        } catch (e) {
          try { imgEntry.contentUrl = el.asImage().getContentUrl(); } catch (e2) {}   // temporary Google URL
        }
      }
      out.push(imgEntry);
    } else if (type === T.TABLE) {
      SL_collectTable(el, out, ctx);
    } else if (type === T.SHEETS_CHART) {
      SL_bump(ctx.skipped, 'chart');
    } else {
      SL_bump(ctx.skipped, String(type));
    }
  }
}

/* Decompose a table into per-cell overlays: each non-empty cell → a text
   overlay at the cell's computed rectangle (carrying the cell's text style +
   its fill as bgColor); an empty but filled cell → a shape overlay (so
   banded/coloured tables keep their look). Cell rectangles use the column
   widths (SlidesApp) + row heights (REST actual, else SlidesApp minimum),
   scaled to fill the table's box exactly. Borders aren't reconstructed. */
function SL_collectTable(tableEl, out, ctx) {
  var table = tableEl.asTable();
  var nR, nC;
  try { nR = table.getNumRows(); nC = table.getNumColumns(); } catch (e) { SL_bump(ctx.skipped, 'table'); return; }
  if (!nR || !nC) { SL_bump(ctx.skipped, 'table'); return; }

  var g = SL_geom(tableEl);
  var oid = ''; try { oid = tableEl.getObjectId(); } catch (e) {}
  var rest = oid && ctx.tableGeom && ctx.tableGeom[oid];
  var i, j;

  /* Build cell rects from the ACTUAL column widths + row heights, anchored at
     the table's top-left — do NOT scale into table.getWidth()/getHeight():
     SlidesApp reports those as ~0 for some tables, which collapsed every
     column onto the left edge (1-char-per-line). getLeft/getTop are reliable. */
  var colW = [], rowH = [], sC = 0;
  for (i = 0; i < nC; i++) {
    var w = 0; try { w = table.getColumn(i).getWidth() || 0; } catch (e) {}
    if (w <= 0 && rest && rest.colW) w = rest.colW[i] || 0;   // REST column width backup
    colW.push(w); sC += w;
  }
  if (sC <= 1) {   // columns unknown → equal split (use table width if it's sane, else a default)
    var dw = (g.w > 1) ? (g.w / nC) : 120;
    for (i = 0; i < nC; i++) colW[i] = dw;
  }
  for (j = 0; j < nR; j++) {
    var h = 0; try { h = table.getRow(j).getMinimumHeight() || 0; } catch (e) {}   // points, reliable
    var rh = (rest && rest.rowH) ? (rest.rowH[j] || 0) : 0;   // REST actual (≥ minimum)
    if (rh > h && rh <= 600) h = rh;                          // prefer it when sane
    if (h <= 0) h = 24;                                       // default row height
    rowH.push(h);
  }

  // Cumulative offsets from the table's top-left — actual sizes, no scaling.
  var xOff = [g.x]; for (i = 0; i < nC; i++) xOff.push(xOff[i] + colW[i]);
  var yOff = [g.y]; for (j = 0; j < nR; j++) yOff.push(yOff[j] + rowH[j]);

  var any = false;
  for (j = 0; j < nR; j++) {
    for (i = 0; i < nC; i++) {
      var cell;
      try { cell = table.getCell(j, i); } catch (e) { continue; }
      if (!cell) continue;
      // Skip cells merged INTO a head cell — only the head carries content.
      try { if (String(cell.getMergeState && cell.getMergeState()) === 'MERGED') continue; } catch (e) {}

      var cSpan = 1, rSpan = 1;
      try { cSpan = cell.getColumnSpan() || 1; } catch (e) {}
      try { rSpan = cell.getRowSpan() || 1; } catch (e) {}
      var cx = xOff[i], cy = yOff[j];
      var cw = xOff[Math.min(nC, i + cSpan)] - cx;
      var ch = yOff[Math.min(nR, j + rSpan)] - cy;

      var ctext = '';
      try { ctext = cell.getText().asString(); } catch (e) {}
      ctext = (ctext || '').replace(/\v/g, '\n').trim();
      var fill = SL_solidFillHex(cell, ctx);   // TableCell has getFill() like a Shape

      if (ctext) {
        var centry = { type: 'text', x: cx, y: cy, w: cw, h: ch, rotation: 0, text: ctext };
        SL_textStyle(cell, centry, ctx);
        out.push(centry);
        any = true;
      } else if (fill) {
        out.push({ type: 'shape', kind: 'rect', x: cx, y: cy, w: cw, h: ch, rotation: 0,
                   fill: fill, stroke: fill, strokeWidth: 0 });
        any = true;
      }
    }
  }
  if (!any) SL_bump(ctx.skipped, 'table');   // table held nothing we could import
}

/* Mode 2 helper: re-walk the deck (same order as SL_collectElements assigns
   `imgIndex`) and return the image at deck-wide index `want` — either its
   bytes, or (if SlidesApp can't export it) its objectId + content URL so the
   caller can fetch the bytes another way. */
function SL_findImage(pres, want) {
  var state = { i: 0, hit: null };
  var slides = pres.getSlides();
  for (var s = 0; s < slides.length && !state.hit; s++) {
    SL_scanImages(slides[s].getPageElements(), want, state);
  }
  return state.hit;
}

function SL_scanImages(pageElements, want, state) {
  var T = SlidesApp.PageElementType;
  for (var i = 0; i < pageElements.length && !state.hit; i++) {
    var el = pageElements[i];
    var type;
    try { type = el.getPageElementType(); } catch (e) { continue; }
    if (type === T.GROUP) {
      try { SL_scanImages(el.asGroup().getChildren(), want, state); } catch (e) {}
      continue;
    }
    if (type !== T.IMAGE) continue;
    if (state.i === want) {
      var img = el.asImage();
      var oid = ''; try { oid = el.getObjectId(); } catch (e) {}
      try {
        var blob = img.getBlob();
        state.hit = {
          imgIndex: want,
          contentType: blob.getContentType(),
          dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()),
        };
      } catch (e) {
        var url = ''; try { url = img.getContentUrl(); } catch (e2) {}
        state.hit = { imgIndex: want, oid: oid, contentUrl: url };
      }
      return;
    }
    state.i++;
  }
}

/* Fetch image bytes from a content URL (the SlidesApp-export fallback).
   contentUrls are usually public for ~30 min; retry with auth if needed. */
function SL_fetchImageBytes(url) {
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
      if (res.getResponseCode() !== 200) return null;
    }
    var blob = res.getBlob();
    var ct = blob.getContentType() || 'image/png';
    return { contentType: ct, dataUrl: 'data:' + ct + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
  } catch (e) { return null; }
}

/* Render ONE slide to a PNG via the Slides REST thumbnail endpoint and return
   its bytes (base64 data URL). LARGE ≈ 1600px on the long edge — crisp for a
   1280-wide slide. Used by snapshot import (pixel-perfect, non-editable). */
/* The deck's current revisionId (cheap REST call, existing presentations
   scope) — the tool stores it and only re-pulls slide images when it changes. */
function SL_revisionId(id) {
  try {
    var res = UrlFetchApp.fetch('https://slides.googleapis.com/v1/presentations/' + encodeURIComponent(id) + '?fields=revisionId',
      { method: 'get', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
    if (res.getResponseCode() !== 200) return '';
    var j = JSON.parse(res.getContentText());
    return (j && j.revisionId) ? j.revisionId : '';
  } catch (e) { return ''; }
}

function SL_slideThumb(presId, pageId) {
  var url = 'https://slides.googleapis.com/v1/presentations/' + encodeURIComponent(presId) +
            '/pages/' + encodeURIComponent(pageId) +
            '/thumbnail?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=LARGE';
  var res;
  try {
    res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
  } catch (e) { return { _err: 'thumbnail fetch threw: ' + (e && e.message ? e.message : e) }; }
  var code = res.getResponseCode();
  if (code !== 200) return { _err: 'thumbnail HTTP ' + code, _code: code, _body: String(res.getContentText()).slice(0, 400) };
  var meta;
  try { meta = JSON.parse(res.getContentText()); } catch (e) { return { _err: 'thumbnail JSON parse failed' }; }
  if (!meta || !meta.contentUrl) return { _err: 'no contentUrl in thumbnail response' };
  var img = SL_fetchImageBytes(meta.contentUrl);
  if (!img) return { _err: 'contentUrl byte fetch failed' };
  return img;   // { contentType, dataUrl }
}

function SL_geom(el) {
  var g = { x: 0, y: 0, w: 0, h: 0, r: 0 };
  try { g.x = el.getLeft(); } catch (e) {}
  try { g.y = el.getTop(); } catch (e) {}
  try { g.w = el.getWidth(); } catch (e) {}
  try { g.h = el.getHeight(); } catch (e) {}
  try { g.r = el.getRotation() || 0; } catch (e) {}
  return g;
}

/* Representative text style for the box. Size / family / colour come from the
   FIRST run (whole-range getters return null when a box mixes styles). BOLD is
   true if ANY run reads bold (attribute, weight ≥ 600, or a bold font variant)
   — decks vary how they bold, and first-run-only missed it. Per-run rich
   formatting is otherwise flattened (raw materials). */
function SL_textStyle(node, entry, ctx) {
  var tr; try { tr = node.getText(); } catch (e) {}
  if (!tr) return;

  var runs = [];
  try { runs = tr.getRuns() || []; } catch (e) {}
  var ts0;
  if (runs.length) { try { ts0 = runs[0].getTextStyle(); } catch (e) {} }
  if (!ts0) { try { ts0 = tr.getTextStyle(); } catch (e) {} }
  if (!ts0) return;

  try { var sz = ts0.getFontSize(); if (sz) entry.fontSize = sz; } catch (e) {}
  try { var fam = ts0.getFontFamily && ts0.getFontFamily(); if (fam) entry.fontFamily = fam; } catch (e) {}
  try {
    var wff0 = ts0.getWeightedFontFamily && ts0.getWeightedFontFamily();
    if (wff0 && !entry.fontFamily) { var f0 = wff0.getFontFamily(); if (f0) entry.fontFamily = f0; }
  } catch (e) {}
  try { if (ts0.isItalic && ts0.isItalic()) entry.italic = true; } catch (e) {}
  try { if (ts0.isUnderline && ts0.isUnderline()) entry.underline = true; } catch (e) {}
  try { var hx = SL_colorHex(ts0.getForegroundColor && ts0.getForegroundColor(), ctx); if (hx) entry.color = hx; } catch (e) {}

  // Bold across ALL runs (or the box style if no runs).
  var styleList = [];
  for (var r = 0; r < runs.length; r++) { try { styleList.push(runs[r].getTextStyle()); } catch (e) {} }
  if (!styleList.length) styleList.push(ts0);
  for (var k = 0; k < styleList.length; k++) {
    var rs = styleList[k];
    if (!rs) continue;
    var isB = false;
    try { if (rs.isBold && rs.isBold()) isB = true; } catch (e) {}
    if (!isB) { try { var wff = rs.getWeightedFontFamily && rs.getWeightedFontFamily(); if (wff && wff.getWeight && wff.getWeight() >= 600) isB = true; } catch (e) {} }
    if (!isB) { try { var fm = rs.getFontFamily && rs.getFontFamily(); if (fm && /bold|black|heavy|semibold|demibold|extrabold/i.test(fm)) isB = true; } catch (e) {} }
    if (isB) { entry.bold = true; break; }
  }

  try {
    var ps = tr.getParagraphStyle();
    var a = ps.getParagraphAlignment();
    if (a) entry.align = String(a).toLowerCase();   // start | center | end | justified
    var lsp = ps.getLineSpacing && ps.getLineSpacing();
    if (lsp && lsp > 0) entry.lineHeight = Math.round(lsp) / 100;   // 115 -> 1.15
  } catch (e) {}

  /* Vertical anchoring inside the box. Slides centres / bottom-aligns text in
     a tall box; we render top by default, so titles drift upward without this. */
  try {
    var ca = node.getContentAlignment && node.getContentAlignment();
    if (ca) { var va = String(ca).toLowerCase(); if (va === 'middle' || va === 'bottom') entry.valign = va; }
  } catch (e) {}

  /* Solid fill behind the text → the overlay's box background colour. */
  var bg = SL_solidFillHex(node, ctx);
  if (bg) entry.bgColor = bg;
}

/* Resolve a SlidesApp Color (RGB or THEME) to hex, using the REST theme map
   for THEME colours (SlidesApp can flag a theme colour but not give its RGB). */
function SL_colorHex(color, ctx) {
  if (!color) return '';
  try {
    if (color.getColorType && color.getColorType() === SlidesApp.ColorType.THEME) {
      var tt = String(color.asThemeColor().getThemeColorType());
      return (ctx && ctx.theme && ctx.theme[tt]) || '';
    }
    return color.asRgbColor().asHexString();
  } catch (e) {
    try { return color.asRgbColor().asHexString(); } catch (e2) { return ''; }
  }
}

/* Hex of a node's SOLID fill (alpha-aware, theme-resolved), or '' if none. */
function SL_solidFillHex(node, ctx) {
  try {
    var f = node.getFill();
    if (f && f.getType() === SlidesApp.FillType.SOLID) {
      var sf = f.getSolidFill();
      if (sf && (sf.getAlpha ? sf.getAlpha() : 1) > 0.05) return SL_colorHex(sf.getColor(), ctx);
    }
  } catch (e) {}
  return '';
}

/* Map a Slides shape type to one of the tool's shape kinds. */
function SL_mapShapeKind(shape) {
  var t = '';
  try { t = String(shape.getShapeType()); } catch (e) {}
  if (t.indexOf('ELLIPSE') !== -1 || t === 'OVAL') return 'ellipse';
  return 'rect';   // rectangles, rounded rects, text boxes, everything else
}

/* Fill + border for an EMPTY shape (a design element). Returns null when the
   shape is effectively invisible (no fill AND no border) — not worth keeping. */
function SL_shapeStyle(shape, ctx) {
  var fill = SL_solidFillHex(shape, ctx);
  var stroke = '', sw = 0;
  try {
    var b = shape.getBorder();
    if (b) {
      var lf = b.getLineFill && b.getLineFill();
      if (lf && lf.getFillType && lf.getFillType() === SlidesApp.LineFillType.SOLID) {
        stroke = SL_colorHex(lf.getSolidFill().getColor(), ctx);
        try { sw = b.getWeight() || 0; } catch (e) {}
      }
    }
  } catch (e) {}
  if (!fill && !stroke) return null;
  return { fill: fill || 'transparent', stroke: stroke || fill || '#000000', strokeWidth: sw || (stroke ? 1 : 0) };
}

/* Solid stroke colour + weight of a line/connector, or null if invisible. */
function SL_lineStyle(el, ctx) {
  var stroke = '', wt = 1;
  try {
    var line = el.asLine();
    try { wt = line.getWeight() || 1; } catch (e) {}
    var lf = line.getLineFill && line.getLineFill();
    if (lf && lf.getFillType && lf.getFillType() === SlidesApp.LineFillType.SOLID) {
      stroke = SL_colorHex(lf.getSolidFill().getColor(), ctx);
    }
  } catch (e) {}
  if (!stroke) stroke = '#000000';
  return { stroke: stroke, weight: wt };
}

/* Slide background as a hex colour — the slide's own, else its layout's, else
   its master's (theme-resolved). Picture / gradient backgrounds are NOT
   captured in this pass. */
function SL_slideBg(slide, ctx) {
  var hex = SL_solidBgHex(slide, ctx);
  if (hex) return hex;
  try {
    var lay = slide.getLayout && slide.getLayout();
    if (lay) {
      hex = SL_solidBgHex(lay, ctx);
      if (hex) return hex;
      var mas = lay.getMaster && lay.getMaster();
      if (mas) { hex = SL_solidBgHex(mas, ctx); if (hex) return hex; }
    }
  } catch (e) {}
  return '';
}
function SL_solidBgHex(page, ctx) {
  try {
    var bg = page.getBackground();
    if (bg && bg.getType && bg.getType() === SlidesApp.PageBackgroundType.SOLID) {
      var sf = bg.getSolidFill();
      if (sf && (sf.getAlpha ? sf.getAlpha() : 1) > 0.02) return SL_colorHex(sf.getColor(), ctx);
    }
  } catch (e) {}
  return '';
}

function SL_bump(obj, key) { obj[key] = (obj[key] || 0) + 1; }

function SL_json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ─── ONE-TIME AUTHORIZATION ────────────────────────────────────────────
   Run THIS function once in the Apps Script editor (pick `SL_authorize` in the
   function dropdown → Run → Review permissions → approve) to grant the
   external-request scope that UrlFetchApp needs for the Slides REST API
   (thumbnails / snapshots, and theme + crop enrichment).

   WHY THIS IS NEEDED: deploying a "New version" of a web app does NOT prompt
   for newly-added scopes — only RUNNING the script in the editor does. Without
   this, every UrlFetch throws "no permission to call UrlFetchApp" (snapshots
   fail, and `_meta.enriched` stays false). You only need to do this once. */
function SL_authorize() {
  UrlFetchApp.fetch('https://slides.googleapis.com/$discovery/rest?version=v1', { muteHttpExceptions: true });
  Logger.log('OK — external_request granted. UrlFetch now works; re-test the web app (snapshots + enrichment).');
}
