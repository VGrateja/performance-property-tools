/* ════════════════════════════════════════════════════════════════════════════
   RUNWAY v DEMAND — THE CHART (Sample A, "Refined classic")
   ────────────────────────────────────────────────────────────────────────────
   Sample A of the Runway v Demand handover (mockups 01–05), the only design
   since the Investment Committee approved it on 2026-11-23: the Original,
   Samples B and C and the Design dropdown were removed then.
   tools/runway-demand.html's render() is RVDD.render(), for every viewer and
   every embed; the page's own #chart svg stays hidden.

   This file READS the page's state and accessors (months, currentIdx,
   activeType, selectedCities, showTrail, runwayTickMid, getData,
   getRunwayValue, getTrailData, updateTimeline …) and never re-derives a score:
   a point's demand is the d.ds the page already mapped through rvdDsOf (the
   fixed-benchmark score, dsA), its runway is getRunwayValue(d, kind).

   Everything is drawn into ONE second <svg> inside .chart-wrap, so the ©
   line, the month label and the html2canvas export keep working. All styling is
   presentation attributes (not CSS classes): html2canvas rasterises an <svg> as
   a serialised image, which carries attributes but not the page's stylesheet.

   Label placement is a port of place_labels() from the handover's
   reference/layout_reference.py, measuring text in the browser.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  /* 'RVDD Montserrat' is the page's own Montserrat, embedded in the svg as data URIs (embedFont below)
     so the html2canvas export, which rasterises the svg as an image with no access to webfonts,
     draws the same letters as the screen. A private family name keeps it from touching the page. */
  var FONT = "'RVDD Montserrat', Montserrat, sans-serif";

  /* ── TOKENS (tokens/design-tokens.json of the handover) ── */
  var TK = {
    light: { bg: '#FFFFFF', ink: '#171B24', ink2: '#5A5D61', accent: '#007F8F', line: '#D9D9D6', grid: 'rgba(23,27,36,0.07)', card: '#FFFFFF',
        zone: { HH: '#DDF1F4', HL: '#E9F1F9', LH: '#FFF2DA', LL: '#EFEFED' },
        dot: { HH: '#007F8F', HL: '#2A66B0', LH: '#A86300', LL: '#63666A' },
        cap: { HH: '#00606C', HL: '#1F4F8C', LH: '#7A4800', LL: '#4A4D51' } },
    dark: { bg: '#171B24', ink: '#F1F3F5', ink2: '#A9AEB6', accent: '#25C6DA', line: '#343A46', grid: 'rgba(255,255,255,0.07)', card: '#0F1218',
        zone: { HH: '#12363F', HL: '#1B2B40', LH: '#30291C', LL: '#20242D' },
        dot: { HH: '#25C6DA', HL: '#74B8EC', LH: '#FFB545', LL: '#A9ADB3' },
        cap: { HH: '#25C6DA', HL: '#74B8EC', LH: '#FFB545', LL: '#A9ADB3' } }
  };
  var STATE_A = { HH: 'Strong demand, more room', HL: 'Strong demand, less room', LH: 'Soft demand, more room', LL: 'Soft demand, less room' };
  var MONTH_LONG = { Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June', Jul: 'July', Aug: 'August', Sep: 'September', Oct: 'October', Nov: 'November', Dec: 'December' };
  var DEMAND_T = 30;
  function isLight() { return document.documentElement.getAttribute('data-theme') === 'light'; }
  function longMonth(m) { var p = String(m || '').split(' '); return (MONTH_LONG[p[0]] || p[0]) + ' ' + (p[1] || ''); }
  function stateOf(rw, ds, mid) { return (ds >= DEMAND_T ? 'H' : 'L') + (rw > mid ? 'H' : 'L'); }
  function rentWords(ds) {
    if (ds >= 70) return 'Rents likely up 10% or more';
    if (ds >= 50) return 'Rents likely up 5% or more';
    if (ds >= 30) return 'Rents at or above inflation';
    if (ds >= 10) return 'Rents flat to inflation';
    if (ds >= 0) return 'Rents flat';
    return 'Rents falling';
  }
  function signed(v) { v = Math.round(v); return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function rwOn() { var c = document.getElementById('showRunwayAxis'); return !!(c && c.checked); }

  /* ── TEXT MEASUREMENT (the browser's, not the reference's estimate) ── */
  var measSvg = null, measText = null, measCache = {};
  function measure(str, size, weight, ls) {
    var key = str + '|' + size + '|' + (weight || 500) + '|' + (ls || 0);
    if (measCache[key]) return measCache[key];
    if (!measSvg) {
      measSvg = document.createElementNS(NS, 'svg');
      measSvg.setAttribute('aria-hidden', 'true');
      measSvg.style.cssText = 'position:absolute;left:-9999px;top:0;width:10px;height:10px;visibility:hidden;overflow:visible';
      measText = document.createElementNS(NS, 'text');
      measText.setAttribute('font-family', FONT);
      measSvg.appendChild(measText); document.body.appendChild(measSvg);
    }
    measText.setAttribute('font-size', size); measText.setAttribute('font-weight', weight || 500);
    if (ls) measText.setAttribute('letter-spacing', ls); else measText.removeAttribute('letter-spacing');
    measText.textContent = str;
    var bb = measText.getBBox();
    var out = { w: bb.width, h: bb.height, top: bb.y };   /* top = glyph box top relative to the baseline */
    measCache[key] = out; return out;
  }

  /* ── SHAPES ── Smooth is always a circle, Workforce always a diamond. */
  function shapeD(type, r) {
    if (type === 'workforce') { var s = r * 1.2; return 'M0,' + (-s) + 'L' + s + ',0L0,' + s + 'L' + (-s) + ',0Z'; }
    return 'M' + (-r) + ',0a' + r + ',' + r + ' 0 1,0 ' + (2 * r) + ',0a' + r + ',' + r + ' 0 1,0 ' + (-2 * r) + ',0Z';
  }

  /* ── LABEL PLACEMENT — port of place_labels() ─────────────────────────────
     items: [{id, ax, ay, ar, w, h, prio}] (ax/ay/ar = the anchor dot)
     dots:  [{id, x, y, r}] every mark labels must avoid (own dot excluded)
     opt:   {obstacles:[[x,y,w,h]], bounds:[x0,y0,x1,y1] | inside:fn(box), gap, distances}
     → {id: {x, y, w, h, d}}  (d > 0 = not touching its dot: draw a leader) */
  function overlap(a, b) {
    var w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
    var h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
    return (w > 0 && h > 0) ? w * h : 0;
  }
  function placeLabels(items, dots, opt) {
    var gap = opt.gap != null ? opt.gap : 5, dists = opt.distances || [0, 16, 34, 54, 78, 104, 134];
    var obstacles = opt.obstacles || [];
    var placed = {};
    function cands(p) {
      var w = p.w, h = p.h, x = p.ax, y = p.ay, r = p.ar, out = [];
      for (var i = 0; i < dists.length; i++) {
        var d = dists[i], g = r + gap + d, dg = g * 0.72;
        out.push([x + g, y - h / 2, d, 0], [x - g - w, y - h / 2, d, 1],
          [x - w / 2, y - g - h + 3, d, 2], [x - w / 2, y + g - 3, d, 3],
          [x + dg, y - dg - h + 4, d, 4], [x + dg, y + dg - 4, d, 5],
          [x - dg - w, y - dg - h + 4, d, 6], [x - dg - w, y + dg - 4, d, 7]);
      }
      return out;
    }
    function cost(p, c, lp) {
      var box = [c[0], c[1], p.w, p.h];
      var pad = [box[0] - 3, box[1] - 1, box[2] + 6, box[3] + 2];
      var s = c[3] * 6 + c[2] * 3;
      if (opt.inside) { if (!opt.inside(pad)) s += 1e5; }
      else if (opt.bounds) {
        var B = opt.bounds;
        if (pad[0] < B[0] || pad[1] < B[1] || pad[0] + pad[2] > B[2] || pad[1] + pad[3] > B[3]) s += 1e5;
      }
      var tx = Math.min(Math.max(p.ax, box[0]), box[0] + box[2]), ty = Math.min(Math.max(p.ay, box[1]), box[1] + box[3]);
      var L = Math.hypot(tx - p.ax, ty - p.ay);
      /* Any overlap at all costs a fixed 2000 on top of the reference's area × 30, so a label
         walks out to a clear spot rather than accepting a sliver of overlap. */
      var hit = function (a) { return a > 0 ? 2000 + a * 30 : 0; };
      for (var i = 0; i < dots.length; i++) {
        var q = dots[i]; if (q.id === p.dotId) continue;
        s += hit(overlap(pad, [q.x - q.r - 2, q.y - q.r - 2, 2 * q.r + 4, 2 * q.r + 4]));
        if (L > 1) {
          var t = Math.max(0, Math.min(1, ((q.x - p.ax) * (tx - p.ax) + (q.y - p.ay) * (ty - p.ay)) / (L * L)));
          if (Math.hypot(p.ax + (tx - p.ax) * t - q.x, p.ay + (ty - p.ay) * t - q.y) < q.r + 3) s += (lp || 6000);
        }
      }
      for (var j = 0; j < obstacles.length; j++) s += hit(overlap(pad, obstacles[j]));
      for (var k in placed) { if (k !== p.id) { var o = placed[k]; s += hit(overlap(pad, [o.x, o.y, o.w, o.h])) * (o.weight || 1); } }
      return s;
    }
    var order = items.slice().sort(function (a, b) {
      if ((b.prio || 0) !== (a.prio || 0)) return (b.prio || 0) - (a.prio || 0);
      var ca = 0, cb = 0;
      dots.forEach(function (q) { if (Math.abs(q.x - a.ax) < 140 && Math.abs(q.y - a.ay) < 60) ca++; if (Math.abs(q.x - b.ax) < 140 && Math.abs(q.y - b.ay) < 60) cb++; });
      return cb - ca;
    });
    for (var pass = 0; pass < 8; pass++) {
      order.forEach(function (p) {
        var best = null, bs = Infinity;
        cands(p).forEach(function (c) { var s = cost(p, c); if (s < bs) { bs = s; best = c; } });
        placed[p.id] = { x: best[0], y: best[1], w: p.w, h: p.h, d: best[2], cost: bs, weight: p.prio > 1 ? 4 : 1 };
      });
    }
    /* Not in the reference: a label whose best spot still overlaps something searches a finer grid
       around its dot for the nearest clear place, on a leader line that may now cross a dot (150, not 6000). */
    order.forEach(function (p) {
      if (placed[p.id].cost < 2000) return;
      var best = null, bs = placed[p.id].cost;
      for (var dx = -320; dx <= 320; dx += 8) for (var dy = -260; dy <= 260; dy += 6) {
        var c = [p.ax + dx - p.w / 2, p.ay + dy - p.h / 2, Math.round(Math.hypot(dx, dy) / 2), 8];
        var s = cost(p, c, 150); if (s < bs) { bs = s; best = c; }
      }
      if (best && bs < 2000) placed[p.id] = { x: best[0], y: best[1], w: p.w, h: p.h, d: Math.max(1, best[2]), cost: bs, weight: placed[p.id].weight };
    });
    return placed;
  }
  /* Markets with identical coordinates sit side by side, 2r + 3 px apart. */
  function dodge(points) {
    var seen = {};
    points.forEach(function (p) { var k = Math.round(p.x) + ',' + Math.round(p.y); (seen[k] = seen[k] || []).push(p); });
    Object.keys(seen).forEach(function (k) {
      var g = seen[k]; if (g.length < 2) return;
      g.forEach(function (p, i) { p.x += (i - (g.length - 1) / 2) * (2 * p.r + 3); });
    });
  }

  /* ── SVG helpers ── */
  function el(parent, tag, attrs, text) {
    var e = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    parent.appendChild(e); return e;
  }
  function txt(parent, x, y, str, o) {
    o = o || {};
    return el(parent, 'text', { x: x, y: y, 'font-size': o.size || 15, 'font-weight': o.weight || 500, fill: o.fill, 'text-anchor': o.anchor || null,
      'letter-spacing': o.ls || null, 'dominant-baseline': o.base || null, transform: o.transform || null, opacity: o.opacity != null ? o.opacity : null,
      'class': o.cls || null, 'font-style': o.italic ? 'italic' : null }, str);
  }
  /* text whose glyph-box TOP sits at y (matches the mockups' "top:" positions) */
  function txtTop(parent, x, y, str, o) {
    o = o || {}; var m = measure(str, o.size || 15, o.weight || 500, o.ls);
    return txt(parent, x, y - m.top, str, o);
  }
  function boxOfText(x, yTop, str, size, weight, anchor, ls) {
    var m = measure(str, size, weight, ls);
    var x0 = anchor === 'end' ? x - m.w : anchor === 'middle' ? x - m.w / 2 : x;
    return [x0, yTop, m.w, m.h];
  }

  /* ── DOM: the chart's svg and the hover card ── */
  var wrap, svgD, gRoot, layers = {}, card, built = false;
  function build() {
    if (built) return true;
    wrap = document.querySelector('#runwayView .chart-wrap');
    if (!wrap) return false;
    svgD = document.createElementNS(NS, 'svg');
    svgD.setAttribute('id', 'rvddChart');
    svgD.setAttribute('role', 'img');
    svgD.style.display = 'none';
    svgD.setAttribute('font-family', FONT);
    svgD.setAttribute('style', 'display:none;font-family:' + FONT.replace(/'/g, '"') + ';font-variant-numeric:tabular-nums lining-nums');
    var tip = document.getElementById('tooltip');
    wrap.insertBefore(svgD, tip || null);
    gRoot = el(svgD, 'g', { 'font-family': FONT });
    ['bg', 'trail', 'conn', 'guide', 'dots', 'labels', 'top'].forEach(function (k) { layers[k] = el(gRoot, 'g', { 'data-layer': k }); });
    card = document.createElement('div');
    card.id = 'rvddCard';
    card.setAttribute('role', 'tooltip');
    card.style.cssText = 'position:absolute;pointer-events:none;opacity:0;transition:opacity .12s;z-index:11;box-sizing:border-box;width:300px;padding:15px 16px;border-radius:9px;font-family:Montserrat,sans-serif;font-variant-numeric:tabular-nums lining-nums;box-shadow:0 12px 30px rgba(0,0,0,.35)';
    wrap.appendChild(card);
    built = true; return true;
  }

  /* Fetch the latin Montserrat faces the page already loads from Google Fonts and inline them. Fail-soft:
     without them the screen is unchanged and the export falls back to a system sans. */
  var fontAsked = false;
  function embedFont() {
    if (fontAsked || !window.fetch || !window.FileReader) return; fontAsked = true;
    fetch('https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600;700&display=swap').then(function (r) { return r.text(); }).then(function (css) {
      var faces = [], re = /\/\*\s*latin\s*\*\/\s*@font-face\s*\{([^}]*)\}/g, m;
      while ((m = re.exec(css))) faces.push(m[1]);
      var data = {};
      return Promise.all(faces.map(function (f) {
        var url = (f.match(/url\(([^)]+)\)/) || [])[1], w = (f.match(/font-weight:\s*(\d+)/) || [])[1], ur = (f.match(/unicode-range:\s*([^;]+);/) || [])[1];
        if (!url || !w) return '';
        var got = data[url] || (data[url] = fetch(url).then(function (r) { return r.blob(); }).then(function (b) {
          return new Promise(function (res) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.readAsDataURL(b); });
        }));
        return got.then(function (uri) { return "@font-face{font-family:'RVDD Montserrat';font-style:normal;font-weight:" + w + ";src:url(" + uri + ") format('woff2');" + (ur ? 'unicode-range:' + ur + ';' : '') + '}'; });
      }));
    }).then(function (rules) {
      rules = (rules || []).filter(Boolean); if (!rules.length) return;
      var st = document.createElementNS(NS, 'style'); st.textContent = rules.join('\n');
      svgD.insertBefore(st, svgD.firstChild);
      return document.fonts.load("500 16px 'RVDD Montserrat'").then(function () {
        measCache = {}; if (typeof render === 'function') render(false);
      });
    }).catch(function () {});
  }

  /* this svg in place of the page's own #chart and its quadrant legend, which are never shown */
  function applyVisibility() {
    if (!build()) return;
    var chart = document.getElementById('chart');
    if (chart) chart.style.display = 'none';
    svgD.style.display = 'block';
    var leg = document.querySelector('#runwayView .legend');
    if (leg) leg.style.display = 'none';
  }

  /* ════════════════════════════ DATA ════════════════════════════ */
  function collect() {
    var month = months[currentIdx];
    var mid = runwayTickMid;
    var combined = activeType === 'combined';
    var tab = combined ? 'house' : activeType;
    var hl = selectedCities.size > 0;
    var base = getData(tab, month);
    var pts = [];
    function mk(d, kind, role, faded, sel) {
      var rw = getRunwayValue(d, kind);
      return { key: d.city + '|' + kind, city: d.city, kind: kind, ring: combined && kind === 'unit', type: d.type, ds: d.ds, rw: rw, rec: d,
        state: stateOf(rw, d.ds, mid), role: role, faded: faded, hl: sel };
    }
    if (!combined) {
      base.forEach(function (d) { var s = selectedCities.has(d.city); pts.push(mk(d, tab, 'mark', hl && !s, hl && s)); });
    } else {
      var units = getData('unit', month), seenH = {};
      base.forEach(function (d) {
        var s = selectedCities.has(d.city); seenH[d.city] = 1;
        pts.push(mk(d, 'house', s ? 'mark' : 'ctx', hl && !s, s));
        if (s) { var u = units.find(function (r) { return r.city === d.city; }); if (u) pts.push(mk(u, 'unit', 'mark', false, true)); }
      });
      selectedCities.forEach(function (c) {   /* a picked market with a unit but no house point */
        if (seenH[c]) return; var u = units.find(function (r) { return r.city === c; }); if (u) pts.push(mk(u, 'unit', 'mark', false, true));
      });
    }
    var counts = { HH: 0, HL: 0, LH: 0, LL: 0 };
    base.forEach(function (d) { counts[stateOf(getRunwayValue(d, tab), d.ds, mid)]++; });
    return { month: month, mid: mid, combined: combined, tab: tab, hl: hl, pts: pts, counts: counts, total: base.length };
  }
  /* 12-month change for one point (or since the first month, early in the series) */
  function change12(p) {
    var i0 = Math.max(0, currentIdx - 12);
    if (i0 === currentIdx) return null;
    var r0 = getData(p.kind, months[i0]).find(function (r) { return r.city === p.city; });
    if (!r0) return null;
    var rw0 = getRunwayValue(Object.assign({}, r0, { monthIdx: i0 }), p.kind);
    return { dDs: p.ds - r0.ds, dRw: p.rw - rw0, since: longMonth(months[i0]) };
  }

  /* ════════════════════════════ GEOMETRY ════════════════════════════ */
  var GEO = { vb: [80, 132, 1760, 842], X0: 150, X1: 1650, Y0: 196, Y1: 886, rw: [-15, 135], ds: [-30, 92], r: 9, size: 16 };
  function scatterPos(G, rw, ds, mid) {
    var shift = mid - 60;
    var x = G.X0 + (rw - shift - G.rw[0]) / (G.rw[1] - G.rw[0]) * (G.X1 - G.X0);
    var y = G.Y0 + (G.ds[1] - ds) / (G.ds[1] - G.ds[0]) * (G.Y1 - G.Y0);
    var m = G.r + 3;
    return { x: Math.max(G.X0 + m, Math.min(G.X1 - m, x)), y: Math.max(G.Y0 + m, Math.min(G.Y1 - m, y)) };
  }
  function sx(G, nominal) { return G.X0 + (nominal - G.rw[0]) / (G.rw[1] - G.rw[0]) * (G.X1 - G.X0); }
  function sy(G, ds) { return G.Y0 + (G.ds[1] - ds) / (G.ds[1] - G.ds[0]) * (G.Y1 - G.Y0); }
  /* ════════════════════════════ RENDER ════════════════════════════ */
  var lastScene = null;
  function renderDesign(animate) {
    if (!build()) return;
    embedFont();
    if (rateBasis !== 'recorded' && _rateFactor.length !== months.length) _recomputeRateFactors();
    var month = months[currentIdx];
    if (month === undefined) return;
    applyVisibility();
    /* the page's own month display, timeline and numbers table */
    document.getElementById('monthDisplay').textContent = month;
    var ml = document.getElementById('chartMonthLabel'); if (ml) ml.textContent = longMonth(month);
    updateTimeline();
    try { renderCompareTable(month); } catch (e) {}

    var D = collect();
    var th = TK[isLight() ? 'light' : 'dark'];
    var G = GEO;
    svgD.setAttribute('viewBox', G.vb.join(' '));
    svgD.setAttribute('aria-label', 'Runway v Demand, ' + longMonth(month));
    wrap.style.background = th.bg;
    wrap.style.borderColor = th.line;
    ['chartCopyright', 'chartMonthLabel'].forEach(function (id) { var e = document.getElementById(id); if (e) e.style.color = th.ink2; });

    var ctx = { D: D, th: th, G: G, animate: animate, on: rwOn() };
    /* positions */
    D.pts.forEach(function (p) {
      var hlR = p.hl ? 2 : 0;
      p.r = G.r + hlR;
      var q = scatterPos(G, p.rw, p.ds, D.mid);
      p.x = q.x; p.y = q.y;
      p.col = th.dot[p.state];
    });
    dodge(D.pts);

    clearLayer('bg'); clearLayer('guide'); clearLayer('top');
    var obstacles = [];
    drawStatic(ctx, obstacles);

    var T = d3.transition().duration(animate ? 750 : 0).ease(d3.easeCubicInOut);
    var pathItems = drawTrails(ctx, T);
    drawConnectors(ctx, T);
    drawDots(ctx, T);
    drawLabels(ctx, T, obstacles, pathItems);
    lastScene = ctx;
  }
  function clearLayer(k) { var g = layers[k]; while (g.firstChild) g.removeChild(g.firstChild); }

  /* ── the static scene: four zones, the scales, the corner captions, the key ── */
  function drawStatic(ctx, obstacles) {
    var g = layers.bg, G = ctx.G, th = ctx.th, D = ctx.D;
    var xm = sx(G, 60), ym = sy(G, DEMAND_T);
    el(g, 'rect', { x: G.vb[0], y: G.vb[1], width: G.vb[2], height: G.vb[3], fill: th.bg });
    el(g, 'rect', { x: G.X0, y: G.Y0, width: xm - G.X0, height: ym - G.Y0, fill: th.zone.HL });
    el(g, 'rect', { x: xm, y: G.Y0, width: G.X1 - xm, height: ym - G.Y0, fill: th.zone.HH });
    el(g, 'rect', { x: G.X0, y: ym, width: xm - G.X0, height: G.Y1 - ym, fill: th.zone.LL });
    el(g, 'rect', { x: xm, y: ym, width: G.X1 - xm, height: G.Y1 - ym, fill: th.zone.LH });
    for (var v = -20; v <= 80; v += 10) {
      var y = sy(G, v);
      if (v !== DEMAND_T) el(g, 'line', { x1: G.X0, x2: G.X1, y1: y, y2: y, stroke: th.grid, 'stroke-width': 1 });
      txt(g, 138, y, String(v).replace('-', '−'), { size: 15, fill: th.ink2, anchor: 'end', base: 'central' });
    }
    el(g, 'rect', { x: G.X0, y: ym - 1.5, width: G.X1 - G.X0, height: 3, fill: th.bg });
    el(g, 'rect', { x: xm - 1.5, y: G.Y0, width: 3, height: G.Y1 - G.Y0, fill: th.bg });
    [[70, '10% or more'], [50, '5% or more'], [30, 'In line with inflation'], [10, 'Flat'], [-10, 'Falling']].forEach(function (r) {
      txt(g, 1664, sy(G, r[0]), r[1], { size: 15, weight: r[0] === 30 ? 600 : 500, fill: r[0] === 30 ? th.ink : th.ink2, base: 'central' });
    });
    txtTop(g, 96, 164, 'Demand score', { size: 15, weight: 600, fill: th.ink });
    txtTop(g, 1664, 164, 'Likely rent growth', { size: 15, weight: 600, fill: th.ink });
    /* zone captions in the outer corners */
    var c = D.counts;
    var caps = [
      ['HL', 168, G.Y0 + 14, 'start', plural(c.HL, 'market')],
      ['HH', G.X1 - 18, G.Y0 + 14, 'end', 'Strongest · ' + plural(c.HH, 'market')],
      ['LL', 168, G.Y1 - 58, 'start', 'Weakest · ' + plural(c.LL, 'market')],
      ['LH', G.X1 - 18, G.Y1 - 58, 'end', c.LH ? plural(c.LH, 'market') : 'No markets this month']
    ];
    if (c.HH === 0) caps[1][4] = 'No markets this month';
    caps.forEach(function (k) {
      txtTop(g, k[1], k[2], STATE_A[k[0]], { size: 17, weight: 600, fill: th.cap[k[0]], anchor: k[3] });
      txtTop(g, k[1], k[2] + 24, k[4], { size: 15, fill: th.ink2, anchor: k[3] });
      obstacles.push(boxOfText(k[1], k[2], STATE_A[k[0]], 17, 600, k[3]));
      obstacles.push(boxOfText(k[1], k[2] + 24, k[4], 15, 500, k[3]));
    });
    /* runway ticks: numbers only when switched on (positions fixed, labels follow the midpoint) */
    if (ctx.on) {
      var shift = D.mid - 60;
      [0, 20, 40, 60, 80, 100, 120].forEach(function (n) {
        txtTop(g, sx(G, n), G.Y1 + 8, (n + shift) + '%', { size: 14, fill: th.ink2, anchor: 'middle', cls: 'rvdd-rw' });
      });
    }
    var rowY = G.Y1 + 32;
    arrowText(g, G.X0, rowY, 'Less room to grow', th.ink, 'left');
    arrowText(g, G.X1, rowY, 'More room to grow', th.ink, 'right');
    txtTop(g, xm, rowY, 'Midpoint', { size: 15, fill: th.ink2, anchor: 'middle' });
    txtTop(g, G.X1, rowY + 30, 'Runway: how far prices can rise before they reach what local incomes can afford', { size: 15, fill: th.ink2, anchor: 'end' });
    keyRow(g, G.X0, rowY + 30, ctx, th.ink2, 15);
    headerLines(g, (G.X0 + G.X1) / 2, 160, ctx, th);
  }
  function arrowText(g, x, yTop, str, fill, side) {
    var m = measure(str, 15, 600);
    var cy = yTop + m.h / 2;
    if (side === 'left') {
      el(g, 'path', { d: 'M' + (x + 13) + ',' + cy + 'H' + (x + 2) + 'M' + (x + 6) + ',' + (cy - 4) + 'L' + (x + 2) + ',' + cy + 'l4,4', fill: 'none', stroke: fill, 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      txtTop(g, x + 22, yTop, str, { size: 15, weight: 600, fill: fill });
    } else {
      el(g, 'path', { d: 'M' + (x - 13) + ',' + cy + 'H' + (x - 2) + 'M' + (x - 6) + ',' + (cy - 4) + 'L' + (x - 2) + ',' + cy + 'l-4,4', fill: 'none', stroke: fill, 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      txtTop(g, x - 22, yTop, str, { size: 15, weight: 600, fill: fill, anchor: 'end' });
    }
  }
  /* Smooth / Workforce (+ House / Unit in Combined) */
  function keyRow(g, x, yTop, ctx, fill, size) {
    var m = measure('Smooth market', size, 500), cy = yTop + m.h / 2, items = [['smooth', 'Smooth market'], ['workforce', 'Workforce market']];
    if (ctx.D.combined) items.push(['house', 'House'], ['unit', 'Unit']);
    items.forEach(function (it) {
      var shape = it[0] === 'workforce' ? 'workforce' : 'smooth';
      var a = { d: shapeD(shape, 6), transform: 'translate(' + (x + 6) + ',' + cy + ')' };
      if (it[0] === 'unit') { a.fill = 'none'; a.stroke = fill; a['stroke-width'] = 2; } else a.fill = fill;
      el(g, 'path', a);
      txtTop(g, x + 18, yTop, it[1], { size: size, fill: fill });
      x += 18 + measure(it[1], size, 500).w + 26;
    });
  }
  /* The runway assumption (advisor-only) and the Combined prompt */
  function runwayAssumption() {
    var t = '';
    try { t = String(runwayAxisLabel.text() || ''); } catch (e) {}
    var m = t.match(/(\d+)\s*Year Wage Growth(?:\s*\|\s*PP Variable Rate:\s*([\d.]+)%)?/i);
    if (!m) return null;
    return 'Runway — ' + m[1] + '-year wage growth' + (m[2] ? ' | PP variable rate: ' + m[2] + '%' : '');
  }
  function headerLines(g, x, y, ctx, th) {
    var lines = [];
    if (ctx.on) { var a = runwayAssumption(); if (a) lines.push([a, th.ink2, 'rvdd-rw']); }
    if (ctx.D.combined && !ctx.D.hl) lines.push(['Choose one or more regions to compare House and Unit', th.accent || th.ink, null]);
    lines.forEach(function (l, i) { txtTop(g, x, y + i * 22, l[0], { size: 14, weight: 600, fill: l[1], anchor: 'middle', cls: l[2] }); });
  }

  /* ── TRAILS ("Paths"): driven by the existing Trail Lines + Trail Length selects ── */
  function drawTrails(ctx, T) {
    var g = layers.trail, D = ctx.D, th = ctx.th, G = ctx.G, items = [];
    var on = showTrail && !D.combined;
    var trailLen = parseInt(document.getElementById('trailSelect').value, 10);
    var byKey = {}; D.pts.forEach(function (p) { byKey[p.key] = p; });
    var focus = D.hl ? D.pts.filter(function (p) { return p.hl; }) : D.pts;
    var data = !on ? [] : focus.map(function (p) {
      var pts = getTrailData(p.city, currentIdx, trailLen);
      if (pts.length < 2) return null;
      var prev = getTrailData(p.city, Math.max(0, currentIdx - 1), trailLen);
      var pos = function (r) { return scatterPos(G, getRunwayValue(r, p.kind), r.ds, D.mid); };
      var xy = pts.map(pos); xy[xy.length - 1] = { x: p.x, y: p.y };
      var pl = prev.length ? pos(prev[prev.length - 1]) : xy[xy.length - 1];
      return { key: p.key, p: p, xy: xy, prev: pl, start: pts[0].monthIdx, detail: D.hl };
    }).filter(Boolean);
    var sel = d3.select(g).selectAll('g.rvdd-trail').data(data, function (d) { return d.key; });
    sel.exit().remove();
    var en = sel.enter().append('g').attr('class', 'rvdd-trail');
    en.append('path').attr('class', 'rvdd-trail-line').attr('fill', 'none').attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round');
    var all = en.merge(sel);
    /* a smooth curve through every monthly position (the mockups' path), so the markers still sit on the line */
    var curve = d3.line().x(function (q) { return +q.x.toFixed(1); }).y(function (q) { return +q.y.toFixed(1); }).curve(d3.curveCatmullRom.alpha(0.5));
    var lineGen = function (pts) { return curve(pts); };
    all.each(function (d) {
      var gg = d3.select(this);
      gg.selectAll('.rvdd-trail-deco').remove();
      var col = d.p.col, op = d.detail ? 1 : 0.55;
      gg.select('path.rvdd-trail-line').attr('stroke', col).attr('stroke-width', 2.5).attr('opacity', op).attr('data-pts', d.xy.length)
        .transition(T).attrTween('d', function () {
          var hist = d.xy.slice(0, -1), cur = d.xy[d.xy.length - 1], pv = ctx.animate ? d.prev : cur;
          return function (t) { return lineGen(hist.concat([{ x: pv.x + (cur.x - pv.x) * t, y: pv.y + (cur.y - pv.y) * t }])); };
        });
      var cur = d.xy[d.xy.length - 1], last = d.xy[d.xy.length - 2];
      /* arrowhead just before the current dot, pointing the way it travels */
      var dx = cur.x - last.x, dy = cur.y - last.y, L = Math.hypot(dx, dy);
      if (L > d.p.r + 8) {
        var ux = dx / L, uy = dy / L, ax = cur.x - ux * (d.p.r + 5), ay = cur.y - uy * (d.p.r + 5), s = 7;
        gg.append('path').attr('class', 'rvdd-trail-deco').attr('fill', col).attr('opacity', op)
          .attr('d', 'M' + ax + ',' + ay + 'L' + (ax - ux * s * 1.4 - uy * s * 0.75) + ',' + (ay - uy * s * 1.4 + ux * s * 0.75) + 'L' + (ax - ux * s * 1.4 + uy * s * 0.75) + ',' + (ay - uy * s * 1.4 - ux * s * 0.75) + 'Z');
      }
      /* a small dot where the market stood each month, and a ring where the trail starts: on every trail */
      d.xy.forEach(function (q, i) {
        if (i === d.xy.length - 1) return;
        if (i > 0 && Math.hypot(q.x - cur.x, q.y - cur.y) < 16) return;   /* omitted close to the current dot */
        gg.append('circle').attr('class', 'rvdd-trail-deco rvdd-trail-dot').attr('cx', q.x).attr('cy', q.y).attr('r', i === 0 ? 5.5 : 3.2).attr('opacity', op)
          .attr('fill', ctx.th.bg).attr('stroke', col).attr('stroke-width', i === 0 ? 2 : 1.6);
      });
      if (!d.detail) return;   /* the start month is named only for highlighted markets, where it has room */
      var st = d.xy[0], m = measure(months[d.start], 13, 500);
      items.push({ id: 'path|' + d.key, kind: 'path', text: months[d.start], size: 13, weight: 500, fill: th.ink2, ax: st.x, ay: st.y, ar: 6, w: m.w, h: m.h, top: m.top, prio: 3, dotId: null });
    });
    /* the highlighted markets' paths, for drawLabels: a faded name one of them runs through is hidden */
    ctx.trailLines = data.filter(function (d) { return d.detail; }).map(function (d) { return d.xy; });
    return items;
  }

  /* ── Combined: house solid, unit a hollow ring of the same shape, joined by a line ── */
  function drawConnectors(ctx, T) {
    var D = ctx.D, pairs = [];
    if (D.combined) {
      var by = {}; D.pts.forEach(function (p) { if (p.role === 'mark') (by[p.city] = by[p.city] || {})[p.kind] = p; });
      Object.keys(by).forEach(function (c) { if (by[c].house && by[c].unit) pairs.push({ city: c, h: by[c].house, u: by[c].unit }); });
    }
    var col = ctx.th.ink2;
    var s = d3.select(layers.conn).selectAll('line.rvdd-conn').data(pairs, function (d) { return d.city; });
    s.exit().remove();
    s.enter().append('line').attr('class', 'rvdd-conn').attr('x1', function (d) { return d.h.x; }).attr('y1', function (d) { return d.h.y; }).attr('x2', function (d) { return d.u.x; }).attr('y2', function (d) { return d.u.y; })
      .merge(s).attr('stroke', col).attr('stroke-width', 2).attr('opacity', 0.85)
      .transition(T).attr('x1', function (d) { return d.h.x; }).attr('y1', function (d) { return d.h.y; }).attr('x2', function (d) { return d.u.x; }).attr('y2', function (d) { return d.u.y; });
  }

  /* ── DOTS ── */
  function drawDots(ctx, T) {
    var D = ctx.D, th = ctx.th;
    var ringOf = function (p) {
      var xm = sx(ctx.G, 60), ym = sy(ctx.G, DEMAND_T);   /* the ring takes the colour of the zone the dot sits on */
      return th.zone[(p.y <= ym ? 'H' : 'L') + (p.x > xm ? 'H' : 'L')];
    };
    var s = d3.select(layers.dots).selectAll('path.rvdd-dot').data(D.pts, function (d) { return d.key; });
    s.exit().remove();
    var en = s.enter().append('path').attr('class', 'rvdd-dot').attr('tabindex', 0)
      .attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; })
      .on('mouseenter', function (e, d) { showCard(d, this); })
      .on('mouseleave', function () { hideCard(); })
      .on('focus', function (e, d) { showCard(d, this); })
      .on('blur', function () { hideCard(); })
      .on('click', function (e, d) { clickCity(d.city); });
    en.merge(s)
      .attr('data-key', function (d) { return d.key; }).attr('data-city', function (d) { return d.city; }).attr('data-kind', function (d) { return d.kind; }).attr('data-role', function (d) { return d.role; })
      .attr('aria-label', function (d) { return d.city + ', ' + (d.kind === 'unit' ? 'units' : 'houses') + ', demand ' + d.ds; })
      .attr('d', function (d) { return shapeD(d.type, d.ring ? d.r - 0.5 : d.r); })
      .attr('fill', function (d) { return d.ring ? 'none' : d.col; })
      .attr('stroke', function (d) { return d.ring ? d.col : ringOf(d); })
      .attr('stroke-width', function (d) { return d.ring ? 2.5 : 2; })
      .attr('pointer-events', 'all').style('cursor', 'pointer')
      .attr('opacity', function (d) { return d.faded ? 0.3 : 1; })
      .transition(T).attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; });
  }
  function clickCity(city) {
    if (selectedCities.has(city)) selectedCities.delete(city); else selectedCities.add(city);
    try { regionDropdown.querySelectorAll('input[type=checkbox]').forEach(function (cb) { if (cb.value === city) cb.checked = selectedCities.has(city); }); } catch (e) {}
    updateRegionBtn(); render();
  }

  /* ── LABELS: placed live, tweened between months so they never jump ── */
  /* does the segment a-b pass through the box [x, y, w, h], with 3px to spare (Liang-Barsky) */
  function segHitsBox(a, b, box) {
    var x0 = box[0] - 3, y0 = box[1] - 3, x1 = box[0] + box[2] + 3, y1 = box[1] + box[3] + 3, t0 = 0, t1 = 1;
    var dx = b.x - a.x, dy = b.y - a.y, p = [-dx, dx, -dy, dy], q = [a.x - x0, x1 - a.x, a.y - y0, y1 - a.y];
    for (var i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return false; continue; }
      var r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return true;
  }
  function drawLabels(ctx, T, obstacles, pathItems) {
    var D = ctx.D, G = ctx.G, th = ctx.th;
    var items = [];
    D.pts.forEach(function (p) {
      if (p.ring) {
        var mu = measure('Unit', 12.5, 500);
        items.push({ id: p.key, kind: 'unit', text: 'Unit', size: 12.5, weight: 500, fill: th.ink2, ax: p.x, ay: p.y, ar: p.r, w: mu.w, h: mu.h, top: mu.top, prio: 2, dotId: p.key, faded: false, city: p.city });
        return;
      }
      var size = p.hl ? G.size + 3 : G.size;
      var weight = p.hl ? 700 : 500;
      var m = measure(p.city, size, weight);
      items.push({ id: p.key, kind: 'market', text: p.city, size: size, weight: weight, fill: th.ink, ax: p.x, ay: p.y, ar: p.r, w: m.w, h: m.h, top: m.top, prio: p.hl ? 2 : 0, dotId: p.key, faded: p.faded, city: p.city });
    });
    items = items.concat(pathItems);
    var dots = D.pts.map(function (p) { return { id: p.key, x: p.x, y: p.y, r: p.r }; });
    var opt = { obstacles: obstacles, bounds: [G.X0 + 2, G.Y0 + 2, G.X1 - 2, G.Y1 - 2] };
    var placed = placeLabels(items, dots, opt);
    /* A faded label that would sit under a highlighted label, a path annotation or anything
       else is hidden rather than overlapping. */
    var keep = items.filter(function (it) {
      if (!it.faded) return true;
      var b = placed[it.id];
      if (b.cost >= 1e5) return false;
      var box = [b.x, b.y, b.w, b.h];
      for (var i = 0; i < items.length; i++) {
        var o = items[i]; if (o === it || o.faded) continue;
        var ob = placed[o.id]; if (overlap(box, [ob.x, ob.y, ob.w, ob.h]) > 0) return false;
      }
      for (var j = 0; j < dots.length; j++) { var q = dots[j]; if (q.id !== it.dotId && overlap(box, [q.x - q.r, q.y - q.r, 2 * q.r, 2 * q.r]) > 0) return false; }
      var trails = ctx.trailLines || [];
      for (var k = 0; k < trails.length; k++) for (var n = 1; n < trails[k].length; n++) if (segHitsBox(trails[k][n - 1], trails[k][n], box)) return false;
      return true;
    });
    keep.forEach(function (it) {
      var b = placed[it.id];
      it.bx = b.x; it.by = b.y; it.lead = b.d > 0; it.cost = Math.round(b.cost);
      /* leader: from the dot's edge to the nearest point of the label box */
      var tx = Math.min(Math.max(it.ax, b.x), b.x + b.w), ty = Math.min(Math.max(it.ay, b.y), b.y + b.h);
      var L = Math.hypot(tx - it.ax, ty - it.ay) || 1;
      it.l = { x1: it.ax + (tx - it.ax) / L * (it.ar + 1), y1: it.ay + (ty - it.ay) / L * (it.ar + 1), x2: tx, y2: ty };
    });
    var leaderCol = th.ink2;
    var ls = d3.select(layers.labels).selectAll('line.rvdd-leader').data(keep.filter(function (it) { return it.lead; }), function (d) { return d.id; });
    ls.exit().remove();
    ls.enter().append('line').attr('class', 'rvdd-leader').attr('pointer-events', 'none')
      .attr('x1', function (d) { return d.l.x1; }).attr('y1', function (d) { return d.l.y1; }).attr('x2', function (d) { return d.l.x2; }).attr('y2', function (d) { return d.l.y2; })
      .merge(ls).attr('stroke', leaderCol).attr('stroke-width', 1).attr('opacity', function (d) { return d.faded ? 0.5 : 1; })
      .transition(T).attr('x1', function (d) { return d.l.x1; }).attr('y1', function (d) { return d.l.y1; }).attr('x2', function (d) { return d.l.x2; }).attr('y2', function (d) { return d.l.y2; });
    var s = d3.select(layers.labels).selectAll('text.rvdd-text').data(keep, function (d) { return d.id; });
    s.exit().remove();
    s.enter().append('text').attr('class', function (d) { return 'rvdd-text ' + (d.kind === 'path' ? 'rvdd-pathlabel' : d.kind === 'unit' ? 'rvdd-label rvdd-unitlabel' : 'rvdd-label'); })
      .attr('x', function (d) { return d.bx; }).attr('y', function (d) { return d.by - d.top; }).attr('pointer-events', 'none')
      .merge(s).text(function (d) { return d.text; }).attr('data-city', function (d) { return d.city || null; }).attr('data-key', function (d) { return d.dotId || null; }).attr('data-cost', function (d) { return d.cost; })
      .attr('font-size', function (d) { return d.size; }).attr('font-weight', function (d) { return d.weight; })
      .attr('fill', function (d) { return d.fill; }).attr('opacity', function (d) { return d.faded ? 0.5 : 1; })
      .transition(T).attr('x', function (d) { return d.bx; }).attr('y', function (d) { return d.by - d.top; });
  }

  /* ════════════════════════════ HOVER CARD ════════════════════════════ */
  function showCard(p, node) {
    var ctx = lastScene; if (!ctx || !card) return;
    var th = ctx.th, on = ctx.on;
    var ink = th.ink, ink2 = th.ink2, line = th.line;
    var bg = th.card;
    var chipBg = th.zone[p.state];
    var chipDot = th.dot[p.state];
    var stateName = STATE_A[p.state];
    var ch = change12(p);
    var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    var row = function (k, v, sub, cls) {
      return '<div style="margin-top:10px;padding-top:10px;border-top:1px solid ' + line + '"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;white-space:nowrap">' +
        '<span style="font-size:11.5px;font-weight:500;color:' + ink2 + '">' + k + '</span><span style="font-size:12.5px;font-weight:600;color:' + ink + '">' + v + '</span></div>' +
        (sub ? '<div class="' + (cls || '') + '" style="font-size:11px;font-weight:500;color:' + ink2 + ';margin-top:3px;text-align:right">' + sub + '</div>' : '') + '</div>';
    };
    var moved = '—', movedSub = '';
    if (ch) {
      moved = 'Demand ' + signed(ch.dDs) + (on ? ' · Runway ' + signed(ch.dRw) : (Math.round(ch.dRw) ? ' · ' + (ch.dRw > 0 ? 'more' : 'less') + ' room' : ''));
      movedSub = 'Points moved since ' + ch.since;
    }
    card.innerHTML =
      '<div style="font-size:16px;font-weight:600;color:' + ink + ';line-height:1.2">' + esc(p.city) + '</div>' +
      '<div style="font-size:11.5px;font-weight:500;color:' + ink2 + ';margin-top:3px">' + (p.type === 'workforce' ? 'Workforce' : 'Smooth') + ' market · ' + (p.kind === 'unit' ? 'Units' : 'Houses') + ' · ' + esc(longMonth(months[currentIdx])) + '</div>' +
      '<div style="display:flex;align-items:center;gap:7px;margin-top:11px;padding:6px 10px;background:' + chipBg + ';border-radius:4px">' +
      '<span style="width:8px;height:8px;border-radius:50%;background:' + chipDot + ';flex-shrink:0"></span><span style="font-size:11.5px;font-weight:600;color:' + ink + '">' + stateName + '</span></div>' +
      row('Demand score', esc(p.ds), rentWords(p.ds)) +
      row('Room to grow', p.rw > ctx.D.mid ? 'Above midpoint' : 'Below midpoint', on && p.rw != null ? 'Runway ' + (+p.rw).toFixed(1) + '%, shown in advisor view only' : '', on ? 'rvdd-rw' : '') +
      row('Past 12 months', moved, movedSub);
    card.style.background = bg; card.style.border = '1px solid ' + line; card.style.color = ink;
    /* hovered dot gets a 2px ring */
    clearLayer('top');
    el(layers.top, 'circle', { cx: p.x, cy: p.y, r: p.r + 7, fill: 'none', stroke: ink, 'stroke-width': 2, 'pointer-events': 'none' });
    /* position beside the dot, inside the card */
    var z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    var wr = wrap.getBoundingClientRect(), nr = node.getBoundingClientRect();
    var cx = (nr.left + nr.width / 2 - wr.left) / z, cy = (nr.top + nr.height / 2 - wr.top) / z;
    card.style.opacity = '1';
    var cw = card.offsetWidth, chh = card.offsetHeight, W = wr.width / z, H = wr.height / z;
    var x = cx + 22; if (x + cw > W - 6) x = cx - 22 - cw; if (x < 6) x = 6;
    var y = cy - chh / 2; y = Math.max(6, Math.min(H - chh - 6, y));
    card.style.left = x + 'px'; card.style.top = y + 'px';
  }
  function hideCard() { if (card) card.style.opacity = '0'; if (layers.top) clearLayer('top'); }

  /* ════════════════════════════ BOOT ════════════════════════════ */
  window.RVDD = { render: renderDesign };
  function boot() {
    build(); applyVisibility();
    var cb = document.getElementById('showRunwayAxis');
    if (cb) cb.addEventListener('change', function () { render(false); });
    document.addEventListener('pp-theme-change', function () { render(false); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { measCache = {}; if (typeof render === 'function') render(false); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
