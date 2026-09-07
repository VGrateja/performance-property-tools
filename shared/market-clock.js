/* ===========================================================================
   shared/market-clock.js — the MARKET INDICATORS CLOCK, drawn live
   (window.PP_MARKET_CLOCK)

   WHY THIS EXISTS
   ---------------
   The Market Indicators Clock used to be a flat picture,
   `assets/Reports/market-position-clock.png`, pasted onto the Buying/Selling
   slide, into the Presentation B/S Library and into a few company decks. Its
   design is the PROPERTY CLOCK's face with the market markers taken off and
   twelve indicator annotations added round the rim — so every time the
   Investment Committee moves a band or changes a band colour in
   tools/property-clock.html, the picture goes stale and has to be redrawn by
   hand. It went stale on 2026-09-07, when the green Momentum band's end moved
   from 9:30 to 10:00 (`clock_state.payload.partitions`: green now a2=300).

   Van's instruction: "reproduce it so if we're changing something in the clock
   colour it will automatically be replicated to that as well."

   So this module draws the clock as INLINE SVG from the SAME data the Property
   Clock draws itself from:

       public.clock_state (id = 1) -> payload.partitions
                                       [{ id, label, color, a1, a2 }]

   `a1`/`a2` are degrees, 0 = 12 o'clock, CLOCKWISE, 30 deg per hour, a1 -> a2
   clockwise. Nothing about the bands is duplicated here: the wedge colours, the
   wedge boundaries, the two rim arrow colours and every annotation dot colour
   are all read off those partitions. When the row can't be read we fall back to
   the Property Clock's own compiled-in defaults (DEFAULT_PARTITIONS below,
   copied verbatim from tools/property-clock.html `PARTITIONS`).

   GEOMETRY — mirrored from tools/property-clock.html `renderClockFace()`
   ---------------------------------------------------------------------
   The face is drawn with the Property Clock's own constants and its own helper
   maths (`toXY` / `wedgePath` / `openArc` / `arrowHead`, copied below), so the
   two faces cannot drift:

       R = 230, OUTER = R + 28
       circle OUTER+6 #d8d8d8 | OUTER+2 #ececec | OUTER-2 radial-gradient face
       two arcs at OUTER-8 in the RED and GREEN partition colours, arrowheads
         at 6 o'clock (red, falling) and 12 o'clock (green, rising)
       wedges to R from the partitions, white 2.5 separators
       24 dots at R-17 (hour r7 / half-hour r4, rgba(255,255,255,.85))
       the AUS_MAP watermark, 322x297 at cy-10, opacity .25

   Everything OUTSIDE OUTER+6 is the Market Indicators Clock's own art and is
   measured off the 1600x1588 reference PNG (see MIC_* constants): the light
   grey outer ring, the thirteen rim dots, the twelve rim annotations, the four
   wedge labels, "Peak", and the centred Performance Property Research lockup.
   Those numbers are this clock's design, not the Property Clock's — but the
   COLOURS in them still come from the partitions, so a band edit moves the
   dots' colours and the wedge labels with it.

   USAGE
   -----
     await PP_MARKET_CLOCK.render(hostEl)                 // live, from clock_state
     await PP_MARKET_CLOCK.render(hostEl, { partitions }) // explicit bands
     await PP_MARKET_CLOCK.svgString()                    // standalone SVG markup
     await PP_MARKET_CLOCK.dataUri()                      // data:image/svg+xml,...
     PP_MARKET_CLOCK.VIEW                                 // { w, h, cx, cy }

   `svgString()` / `dataUri()` are DETERMINISTIC for a given set of partitions —
   no timestamps, no generated ids — because tools/presentation.html stores the
   data URI on a deck overlay and `refreshReportCharts()` only re-saves the deck
   when the string actually changes. The watermark and the logo are embedded as
   base64 data URIs: an SVG loaded through an <img> (which is what a deck
   overlay and html2canvas both do) cannot fetch external resources.

   No dependencies. `window.sb` is used only by `load()`, and only if present.
   =========================================================================== */
(function () {
  'use strict';

  /* ── the Property Clock's compiled-in defaults (verbatim) ───────────────
     Only used when clock_state can't be read. The live row is the truth. */
  var DEFAULT_PARTITIONS = [
    { id: 'red',    label: 'Correction / Hold',      color: '#D93025', a1: 30,  a2: 135 },
    { id: 'green',  label: 'Buy / Value / Momentum', color: '#4DB648', a1: 135, a2: 300 },
    { id: 'orange', label: 'Selling Window / Peak',  color: '#F47C20', a1: 300, a2: 30  }
  ];

  /* ── Property Clock face geometry (verbatim) ───────────────────────────── */
  var R = 230, OUTER = R + 28;

  /* ── Market Indicators Clock's own rim, measured off the reference PNG ───
     The PNG is 1600x1588 with the disc centred at (807.1, 788.1) and a wedge
     radius of 497.5px, i.e. 2.163 px per clock unit. Every figure below is that
     measurement divided by 2.163. */
  var MIC = {
    ringR: 270.3, ringW: 4, ringColor: '#e6e7e9',   /* thin outer ring, 268.3..272.3 */
    dotR: 281, dotSize: 2.4,                        /* the 13 rim dots            */
    dotShade: 0.78,                                 /* rim dots are the band colour, darkened */
    lblR: 315.5, lblLH: 18.5,                       /* innermost line, line pitch  */
    lblFS: 12.2, lblFSBig: 14.4, lblColor: '#2C2C2C',
    peakR: 323, peakFS: 29,
    wedgeFS: 21.8, wedgeR: 142,
    logoW: 145.2, logoAspect: 6.6283, logoDY: -88.6
  };

  /* Canvas: the reference PNG's own proportions (1600 x 1588, centre 50.4% /
     49.6%) so a box that used to hold the PNG with background-size:contain
     holds this SVG with preserveAspectRatio="xMidYMid meet" at the same size
     and in the same place. */
  var VIEW = { w: 744, h: 738, cx: 375, cy: 366 };

  /* ── the twelve rim annotations ─────────────────────────────────────────
     Angles and line breaks transcribed from the reference PNG (each label is
     centred on its radial line and rotated to follow the rim; the dot for a
     label sits at the same angle). "Oversupply" and "FOMO Conditions" are set
     larger in the artwork — they are the only two single-line labels. */
  var LABELS = [
    { a: 25.70,  lines: ['Oversupply'], big: true },
    { a: 44.50,  lines: ['Construction', 'Slows'] },
    { a: 63.70,  lines: ['Values Stagnate', 'or Decline'] },
    { a: 89.50,  lines: ['Development Sites', 'Unfeasible'] },
    { a: 119.85, lines: ['Population Starts', 'Absorbing Supply'] },
    { a: 149.90, lines: ['Low Vacancy Rate', 'Causes Rents to', 'Begin Rising'] },
    { a: 180.20, lines: ['Negative Media', 'Sentiment'] },
    { a: 210.70, lines: ['Rents Rise', 'Moderately to', 'Aggressively'] },
    { a: 240.50, lines: ['Media Sentiment', 'Improves, Accompanied', 'by Moderate Price Growth'] },
    { a: 270.45, lines: ['Development Sites', 'Become Feasible'] },
    { a: 300.25, lines: ['Construction Increases', 'as Prices Run', 'Aggressively'] },
    { a: 330.00, lines: ['FOMO Conditions'], big: true }
  ];

  /* The wedge labels are the Market Indicators Clock's own fixed copy, keyed by
     PARTITION ID so they travel with the band. A single-label band is written
     across its mid-angle; the green band carries two, at 32.5% and 81.5% of its
     sweep (where the artwork puts them), so VALUE stays in the lower half and
     MOMENTUM in the upper-left half however wide the band gets. */
  var WEDGE_LABELS = {
    orange: [{ text: 'SELLING WINDOW', at: 0.5 }],
    red:    [{ text: 'CORRECTION',     at: 0.5 }],
    green:  [{ text: 'VALUE',          at: 0.325 },
             { text: 'MOMENTUM',       at: 0.815 }]
  };

  var FONT = "'Montserrat','Segoe UI','Helvetica Neue',Arial,sans-serif";

  /* Australia watermark: the same base64 the Property Clock uses (AUS_MAP). */
  var AUS_MAP = 'data:image/png;base64,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';
  /* assets/Reports/logo-white.png, byte-for-byte — the white "Performance
     Property Research" lockup the artwork carries. Inlined because an SVG
     rendered through an <img> can't load an external file. */
  var LOGO = 'data:image/png;base64,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';

  /* ═══ helper maths — copied from tools/property-clock.html ═══ */
  function toXY(cx, cy, r, deg) {
    var rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }
  function wedgePath(cx, cy, r, a1, a2) {
    var s = toXY(cx, cy, r, a1), e = toXY(cx, cy, r, a2);
    var d = a2 - a1; if (d <= 0) d += 360;
    return 'M' + f(cx) + ',' + f(cy) + ' L' + f(s[0]) + ',' + f(s[1]) +
           ' A' + r + ',' + r + ' 0 ' + (d > 180 ? 1 : 0) + ' 1 ' + f(e[0]) + ',' + f(e[1]) + ' Z';
  }
  function openArc(cx, cy, r, a1, a2) {
    var s = toXY(cx, cy, r, a1), e = toXY(cx, cy, r, a2);
    var d = a2 - a1; if (d <= 0) d += 360;
    return 'M' + f(s[0]) + ',' + f(s[1]) +
           ' A' + r + ',' + r + ' 0 ' + (d > 180 ? 1 : 0) + ' 1 ' + f(e[0]) + ',' + f(e[1]);
  }
  function arrowHead(cx, cy, r, atDeg, cw) {
    var a = toXY(cx, cy, r, atDeg), b = toXY(cx, cy, r, cw ? atDeg + 6 : atDeg - 6);
    var tx = a[0] - b[0], ty = a[1] - b[1], len = Math.sqrt(tx * tx + ty * ty) || 1;
    var nx = tx / len, ny = ty / len, px = -ny * 5, py = nx * 5;
    return f(a[0]) + ',' + f(a[1]) + ' ' +
           f(a[0] - nx * 12 + px) + ',' + f(a[1] - ny * 12 + py) + ' ' +
           f(a[0] - nx * 12 - px) + ',' + f(a[1] - ny * 12 - py);
  }
  /* fixed 2dp, so the same partitions always serialise to the same string */
  function f(n) { return (Math.round(n * 100) / 100).toString(); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ═══ partitions ═══ */
  function deep(x) { return JSON.parse(JSON.stringify(x)); }

  /* Accept the clock_state shape as-is; drop anything unusable rather than
     throw, and fall back to the Property Clock's defaults if nothing survives
     (a broken row must never blank the slide). */
  function norm(list) {
    var ok = [];
    (Array.isArray(list) ? list : []).forEach(function (p) {
      if (!p) return;
      var a1 = Number(p.a1), a2 = Number(p.a2);
      if (!isFinite(a1) || !isFinite(a2)) return;
      var col = typeof p.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(p.color.trim()) ? p.color.trim() : null;
      if (!col) return;
      ok.push({ id: String(p.id || ''), label: String(p.label || ''), color: col,
                a1: ((a1 % 360) + 360) % 360, a2: ((a2 % 360) + 360) % 360 });
    });
    return ok.length ? ok : deep(DEFAULT_PARTITIONS);
  }
  function byId(parts, id) {
    for (var i = 0; i < parts.length; i++) if (parts[i].id === id) return parts[i];
    return null;
  }
  function span(p) { var d = p.a2 - p.a1; if (d <= 0) d += 360; return d; }
  /* which band covers this clock angle (a1 inclusive, a2 exclusive, clockwise) */
  function partitionAt(parts, deg) {
    var a = ((deg % 360) + 360) % 360;
    for (var i = 0; i < parts.length; i++) {
      var off = a - parts[i].a1; if (off < 0) off += 360;
      if (off < span(parts[i])) return parts[i];
    }
    return parts[0] || null;
  }
  /* the artwork's rim dots are the band colour darkened so a 5-unit dot reads
     against white; keep it a pure multiply so it tracks any band recolour */
  function shade(hex, k) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length > 6) h = h.slice(0, 6);
    var n = parseInt(h, 16); if (!isFinite(n)) return hex;
    var r = Math.round(((n >> 16) & 255) * k), g = Math.round(((n >> 8) & 255) * k), b = Math.round((n & 255) * k);
    return '#' + [r, g, b].map(function (v) { return Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0'); }).join('');
  }

  /* ═══ load the saved bands ═══ */
  var _parts = null, _loadP = null;
  function load(opts) {
    if (opts && Array.isArray(opts.partitions) && opts.partitions.length) {
      return Promise.resolve(norm(opts.partitions));
    }
    if (_parts) return Promise.resolve(_parts);
    if (_loadP) return _loadP;
    _loadP = (function () {
      var sb = window.sb;
      if (!sb || !sb.from) { _parts = deep(DEFAULT_PARTITIONS); return Promise.resolve(_parts); }
      return Promise.resolve()
        .then(function () { return sb.from('clock_state').select('payload').eq('id', 1).single(); })
        .then(function (res) {
          var p = res && res.data && res.data.payload && res.data.payload.partitions;
          _parts = norm(p);
          return _parts;
        })
        .catch(function () { _parts = deep(DEFAULT_PARTITIONS); return _parts; });
    })();
    return _loadP;
  }

  /* ═══ the drawing ═══
     Built as MARKUP rather than DOM nodes so that the inline render and the
     serialised `svgString()` come out of one code path and cannot disagree. */
  function body(parts, uid) {
    var cx = VIEW.cx, cy = VIEW.cy, s = [];
    var arcColor1 = (byId(parts, 'red') || {}).color || '#D93025';
    var arcColor2 = (byId(parts, 'green') || {}).color || '#4DB648';

    s.push('<defs>');
    s.push('<filter id="ppmc-sh-' + uid + '"><feDropShadow dx="0" dy="3" stdDeviation="8" flood-opacity="0.13"/></filter>');
    s.push('<radialGradient id="ppmc-face-' + uid + '" cx="45%" cy="40%" r="60%">' +
           '<stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#e8e8e8"/></radialGradient>');
    /* one arc per annotation LINE, for the text to sit on (see below) */
    LABELS.forEach(function (L, li) {
      var flip = L.a > 90 && L.a < 270;
      L.lines.forEach(function (_, i) {
        var r = flip ? (MIC.lblR + i * MIC.lblLH) : (MIC.lblR + (L.lines.length - 1 - i) * MIC.lblLH);
        var D = 70;
        var p1 = toXY(cx, cy, r, flip ? L.a + D : L.a - D);
        var p2 = toXY(cx, cy, r, flip ? L.a - D : L.a + D);
        s.push('<path id="ppmc-l' + li + '-' + i + '-' + uid + '" fill="none" d="M' + f(p1[0]) + ',' + f(p1[1]) +
               ' A' + f(r) + ',' + f(r) + ' 0 0 ' + (flip ? 0 : 1) + ' ' + f(p2[0]) + ',' + f(p2[1]) + '"/>');
      });
    });
    s.push('</defs>');

    /* ── Property Clock face, verbatim ── */
    s.push('<g class="ppmc-face">');
    s.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + (OUTER + 6) + '" fill="#d8d8d8"/>');
    s.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + (OUTER + 2) + '" fill="#ececec"/>');
    s.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + (OUTER - 2) + '" fill="url(#ppmc-face-' + uid + ')" filter="url(#ppmc-sh-' + uid + ')"/>');
    /* the two rim arrows: red falls 12 -> 6 down the right, green rises 6 -> 12
       up the left, arrowheads at 6 and 12. Same radius (OUTER-8), same angles
       and the same arrowHead() maths as the Property Clock, and the colours are
       the red / green partitions' own. The ONE difference is weight: the
       Property Clock draws them 2.2 wide at 0.7 opacity, the Market Indicators
       artwork draws them ~3.6 wide and opaque, because on this clock they are a
       headline element read from the back of a room rather than a hint behind
       36 market markers. Colour still propagates; only the weight is local. */
    s.push('<path d="' + openArc(cx, cy, OUTER - 8, 2, 177) + '" fill="none" stroke="' + arcColor1 + '" stroke-width="3.6" stroke-linecap="round"/>');
    s.push('<polygon points="' + arrowHead(cx, cy, OUTER - 8, 177, false) + '" fill="' + arcColor1 + '"/>');
    s.push('<path d="' + openArc(cx, cy, OUTER - 8, 183, 358) + '" fill="none" stroke="' + arcColor2 + '" stroke-width="3.6" stroke-linecap="round"/>');
    s.push('<polygon points="' + arrowHead(cx, cy, OUTER - 8, 358, false) + '" fill="' + arcColor2 + '"/>');
    /* wedges from the partitions */
    parts.forEach(function (p) {
      s.push('<path d="' + wedgePath(cx, cy, R, p.a1, p.a2) + '" fill="' + p.color +
             '" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>');
    });
    s.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="none" stroke="#ffffff" stroke-width="2"/>');
    /* 24 hour / half-hour dots */
    for (var i = 0; i < 24; i++) {
      var d = toXY(cx, cy, R - 17, i * 15);
      s.push('<circle cx="' + f(d[0]) + '" cy="' + f(d[1]) + '" r="' + (i % 2 === 0 ? 7 : 4) + '" fill="rgba(255,255,255,0.85)"/>');
    }
    /* Australia watermark */
    s.push('<image href="' + AUS_MAP + '" x="' + f(cx - 161) + '" y="' + f(cy - 148.5 - 10) +
           '" width="322" height="297" opacity="0.25" pointer-events="none"/>');
    s.push('</g>');

    /* ── the Market Indicators Clock's own rim ── */
    s.push('<g class="ppmc-rim">');
    s.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + MIC.ringR + '" fill="none" stroke="' + MIC.ringColor +
           '" stroke-width="' + MIC.ringW + '"/>');
    /* thirteen dots: one per annotation plus the marker under "Peak" at 12.
       Each takes the colour of the band that covers its own hour. */
    var dotAngles = LABELS.map(function (L) { return L.a; }).concat([0]);
    dotAngles.forEach(function (a) {
      var p = partitionAt(parts, a);
      var xy = toXY(cx, cy, MIC.dotR, a);
      s.push('<circle cx="' + f(xy[0]) + '" cy="' + f(xy[1]) + '" r="' + MIC.dotSize + '" fill="' +
             shade((p && p.color) || '#888888', MIC.dotShade) + '"/>');
    });
    s.push('</g>');

    /* ── rim annotations ──
       Each line rides a circular arc (textPath) so the words follow the rim the
       way the artwork does. On the right of the clock the reading direction is
       clockwise and the lines stack inward; past 90 deg the arc is reversed so
       the text isn't upside down, and the lines then stack outward — which is
       exactly how the artwork is laid out. */
    s.push('<g class="ppmc-labels" font-family="' + FONT + '" font-weight="500" fill="' + MIC.lblColor +
           '" text-anchor="middle" dominant-baseline="central">');
    LABELS.forEach(function (L, li) {
      var fs = L.big ? MIC.lblFSBig : MIC.lblFS;
      L.lines.forEach(function (line, i) {
        s.push('<text font-size="' + fs + '"><textPath href="#ppmc-l' + li + '-' + i + '-' + uid +
               '" xlink:href="#ppmc-l' + li + '-' + i + '-' + uid +
               '" startOffset="50%">' + esc(line) + '</textPath></text>');
      });
    });
    /* "Peak", bold above 12 */
    s.push('<text x="' + cx + '" y="' + f(cy - MIC.peakR) + '" font-size="' + MIC.peakFS +
           '" font-weight="800">Peak</text>');
    s.push('</g>');

    /* ── wedge labels: this clock's own copy, positioned from the bands ── */
    s.push('<g class="ppmc-wedge-labels" font-family="' + FONT + '" font-weight="800" font-size="' + MIC.wedgeFS +
           '" fill="#ffffff" text-anchor="middle" dominant-baseline="central">');
    parts.forEach(function (p) {
      var defs = WEDGE_LABELS[p.id]; if (!defs) return;
      defs.forEach(function (w) {
        var a = p.a1 + span(p) * w.at;
        var xy = toXY(cx, cy, MIC.wedgeR, a);
        s.push('<text x="' + f(xy[0]) + '" y="' + f(xy[1]) + '">' + esc(w.text) + '</text>');
      });
    });
    s.push('</g>');

    /* ── the logo lockup ── */
    var lw = MIC.logoW, lh = lw / MIC.logoAspect;
    s.push('<image href="' + LOGO + '" x="' + f(cx - lw / 2) + '" y="' + f(cy + MIC.logoDY - lh / 2) +
           '" width="' + f(lw) + '" height="' + f(lh) + '" preserveAspectRatio="xMidYMid meet" pointer-events="none"/>');

    return s.join('');
  }

  /* inline flavour: fills its host box, keeps the artwork's aspect */
  function markupInline(parts, uid, title) {
    return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"' +
           ' viewBox="0 0 ' + VIEW.w + ' ' + VIEW.h + '" width="100%" height="100%"' +
           ' preserveAspectRatio="xMidYMid meet" role="img" aria-label="' + esc(title || 'Market Indicators Clock') + '"' +
           ' style="display:block;width:100%;height:100%;overflow:visible">' +
           body(parts, uid) + '</svg>';
  }
  /* standalone flavour: explicit intrinsic size, for an <img>/data-URI */
  function markupStandalone(parts) {
    return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"' +
           ' viewBox="0 0 ' + VIEW.w + ' ' + VIEW.h + '" width="' + VIEW.w + '" height="' + VIEW.h + '"' +
           ' preserveAspectRatio="xMidYMid meet">' + body(parts, 'x') + '</svg>';
  }

  function paint(host, parts, opts) {
    host.innerHTML = markupInline(parts, (opts && opts.uid) || 'm', opts && opts.title);
    return host.firstElementChild;
  }

  window.PP_MARKET_CLOCK = {
    version: 1,
    VIEW: VIEW,
    DEFAULT_PARTITIONS: DEFAULT_PARTITIONS,

    /* the saved bands (cached for the page), or the Property Clock's defaults */
    load: load,

    /* Draw into `host` (element or selector). Resolves with the <svg>. Paints
       synchronously when the bands are already known, so a re-render of a slide
       doesn't blink. */
    render: function (host, opts) {
      /* never throws synchronously — a caller that wants to fall back to a
         picture attaches .catch() and must be able to rely on it */
      try {
        var el = (typeof host === 'string') ? document.querySelector(host) : host;
        if (!el) return Promise.resolve(null);
        var known = (opts && Array.isArray(opts.partitions) && opts.partitions.length)
          ? norm(opts.partitions) : _parts;
        if (known) return Promise.resolve(paint(el, known, opts));
        return load(opts).then(function (p) { return paint(el, p, opts); });
      } catch (e) { return Promise.reject(e); }
    },

    /* Standalone SVG markup — deterministic for a given set of bands. */
    svgString: function (opts) {
      var known = (opts && Array.isArray(opts.partitions) && opts.partitions.length)
        ? Promise.resolve(norm(opts.partitions)) : load(opts);
      return known.then(function (p) { return markupStandalone(p); });
    },

    /* the same thing as a data URI, ready to be an image overlay's src.
       Percent-encoded rather than base64: the artwork it carries is already
       base64, and re-encoding it would add ~20KB to every deck row that stores
       this slide. Brackets are escaped too, so the URI is also safe to drop
       into a CSS url() unquoted. */
    dataUri: function (opts) {
      /* PP_MARKET_CLOCK, not `this` — so a detached reference still works */
      return window.PP_MARKET_CLOCK.svgString(opts).then(function (svg) {
        return 'data:image/svg+xml;charset=utf-8,' +
          encodeURIComponent(svg).replace(/\(/g, '%28').replace(/\)/g, '%29');
      });
    },

    /* exposed for tests / callers that want the band maths */
    _norm: norm,
    _partitionAt: partitionAt,
    _shade: shade
  };
})();
