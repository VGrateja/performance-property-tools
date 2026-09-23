/* ═══════════════════════════════════════════════════════════════════════════
   Chart zoom — drag a date range on a time-series chart to zoom into it, the
   way SQM Research's charts work (Van, 2026-09-22). A "Reset zoom" pill (or a
   double-click) brings the full range back.

   Installs by wrapping echarts.init, so every chart a page creates after this
   script runs gets the behaviour when it qualifies:
     · an x axis that is a category axis with ≥ 12 points, or a time axis;
     · line / bar / scatter series only (no pies, gauges, maps, pyramids);
     · not opted out — option.ppZoom === false, or data-nozoom on the container.
   Nothing changes visually until the reader drags: the zoom is an "inside"
   dataZoom on every x axis with wheel and pan switched off, so the chart's own
   tooltips, legends and layout are untouched.

   The y axis follows the zoom (Saskia, 2026-09-23: "when we zoom in we need
   the scale of the y axis to increase as we do so, so we can see the actual
   scale"). While a chart is zoomed its value axes stop honouring the page's
   min / max / interval and fit the visible data, the way SQM's do — ECharts
   would otherwise keep zero on the axis (scale:false is its default) and a
   $100k–$900k line zoomed into one decade stays squashed against the top.
   An axis that carries bars keeps its zero baseline and frees only the top
   and the tick interval, because a bar drawn from a raised floor lies about
   its size. Reset puts the authored bounds back exactly.

   Off entirely for the PDF renderers (exportMode=1 / embed=1) and on touch-only
   devices. Ignored while the page is in an editing or exporting state, so the
   report editor's and the slide editors' own drags win:
     online reports  body.edit-mode
     B/S slides      body.bss-edit · body.bss-exporting
     presentation    body.pres-edit-mode · body.pres-exporting

   Composes with the other init wrappers in this codebase (online-reports'
   locked-page filter, present-charts' export wrapper): each wraps whatever
   window.echarts.init is when it runs, and every one calls through.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.PP_CHART_ZOOM) return;

  var q = null;
  try { q = new URLSearchParams(location.search); } catch (e) { /* no location */ }
  var OFF = !!(q && (q.get('exportMode') === '1' || q.get('embed') === '1')) ||
            !(window.matchMedia && window.matchMedia('(pointer:fine)').matches);
  var MIN_POINTS = 12;
  var MIN_DRAG_PX = 6;
  var ID = 'pp-zoom';
  var BUSY = ['edit-mode', 'bss-edit', 'bss-exporting', 'pres-edit-mode', 'pres-exporting'];

  function arr(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }
  function pageBusy() {
    var c = document.body && document.body.classList;
    if (!c) return false;
    for (var i = 0; i < BUSY.length; i++) if (c.contains(BUSY[i])) return true;
    return false;
  }

  /* ── which charts qualify ───────────────────────────────────────────────── */
  function eligible(opt, el) {
    if (!opt || typeof opt !== 'object' || Array.isArray(opt) || opt.ppZoom === false) return false;
    if (el && el.getAttribute && el.getAttribute('data-nozoom') != null) return false;
    var xs = arr(opt.xAxis);
    if (!xs.length) return false;
    var axisOk = xs.some(function (x) {
      if (!x) return false;
      var t = x.type || (Array.isArray(x.data) ? 'category' : 'value');
      if (t === 'time') return true;
      return t === 'category' && Array.isArray(x.data) && x.data.length >= MIN_POINTS;
    });
    if (!axisOk) return false;
    var ser = arr(opt.series);
    if (!ser.length) return false;
    return ser.every(function (s) {
      var t = (s && s.type) || 'line';
      return t === 'line' || t === 'bar' || t === 'scatter';
    });
  }

  /* the invisible dataZoom the drag drives — one per x axis, wheel + pan off */
  function augment(opt) {
    var n = arr(opt.xAxis).length, idx = [];
    for (var i = 0; i < n; i++) idx.push(i);
    var keep = arr(opt.dataZoom).filter(function (d) { return d && d.id !== ID; });
    keep.push({ id: ID, type: 'inside', xAxisIndex: idx, filterMode: 'filter',
      zoomOnMouseWheel: false, moveOnMouseMove: false, moveOnMouseWheel: false, preventDefaultMouseMove: false });
    opt.dataZoom = keep;
  }

  function zoomState(ch) {
    try {
      var dz = arr(ch.getOption().dataZoom).filter(function (d) { return d && d.id === ID; })[0];
      if (!dz) return null;
      var s = dz.start == null ? 0 : +dz.start, e = dz.end == null ? 100 : +dz.end;
      return { start: s, end: e, zoomed: s > 0.01 || e < 99.99 };
    } catch (e) { return null; }
  }

  /* ── the y axis while zoomed ────────────────────────────────────────────── */
  /* Recorded from every real setOption: what the page authored for each y
     axis, and whether bars hang off it. Applied by refresh(): zoomed → fit the
     visible data (bars keep their floor); not zoomed → the authored bounds. */
  var Y_KEYS = ['min', 'max', 'interval', 'scale'];
  function recordY(ch, opt, notMerge) {
    /* An option that already carries our dataZoom came back out of
       getOption(): it holds our override, not the page's bounds. Skip it. */
    if (arr(opt.dataZoom).some(function (d) { return d && d.id === ID; })) return;
    var prev = (!notMerge && ch.__ppY) || [];
    var ser = arr(opt.series), bars = null;
    if (ser.length) { bars = {}; ser.forEach(function (s) { if (s && s.type === 'bar') bars[s.yAxisIndex || 0] = true; }); }
    /* Mirror ECharts' merge: a key the new option omits keeps its earlier value
       (the pages pin bounds in a follow-up partial setOption as often as in the
       first one); only notMerge starts from nothing. */
    var ys = arr(opt.yAxis), n = Math.max(ys.length, prev.length), out = [];
    for (var i = 0; i < n; i++) {
      var y = ys[i], was = prev[i], auth = {};
      Y_KEYS.forEach(function (k) {
        if (y && Object.prototype.hasOwnProperty.call(y, k)) auth[k] = y[k];
        else auth[k] = was ? was.auth[k] : null;
      });
      var t = (y && y.type) || (was ? (was.value ? 'value' : 'other') : 'value');
      out.push({ auth: auth, value: t === 'value', bar: bars ? !!bars[i] : !!(was && was.bar) });
    }
    ch.__ppY = out;
    ch.__ppYFreed = false;   /* the authored bounds are in force again */
  }
  function applyY(ch, zoomed) {
    var ys = ch.__ppY;
    if (!ys || !ys.length || !!ch.__ppYFreed === !!zoomed) return;
    var over = ys.map(function (y) {
      if (!y.value) return {};
      if (!zoomed) return { min: y.auth.min, max: y.auth.max, interval: y.auth.interval, scale: y.auth.scale };
      if (y.bar) return { min: y.auth.min, max: null, interval: null, scale: y.auth.scale };
      return { min: null, max: null, interval: null, scale: true };
    });
    ch.__ppYFreed = !!zoomed;
    ch.__ppYApplying = true;   /* so the wrapper does not record our own override as the page's */
    try { ch.setOption({ yAxis: over }); } catch (e) { /* disposed mid-zoom */ }
    ch.__ppYApplying = false;
  }

  /* ── styles, injected once ──────────────────────────────────────────────── */
  function css() {
    if (document.getElementById('pp-chart-zoom-css')) return;
    var st = document.createElement('style');
    st.id = 'pp-chart-zoom-css';
    st.textContent =
      '.pp-zoom-band{position:absolute;top:0;bottom:0;background:rgba(84,166,222,.22);border-left:1px solid rgba(84,166,222,.75);border-right:1px solid rgba(84,166,222,.75);pointer-events:none;z-index:5}' +
      '.pp-zoom-reset{position:absolute;left:50%;bottom:4px;transform:translateX(-50%);z-index:6;font:700 11px/1.2 "Montserrat",system-ui,sans-serif;letter-spacing:.04em;padding:5px 11px;border-radius:999px;border:0;background:rgba(23,27,36,.88);color:#fff;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.2);pointer-events:auto}' +
      '.pp-zoom-reset:hover{background:#00A0B4}' +
      '.pp-zoom-reset[hidden],.pp-zoom-band[hidden]{display:none}' +
      '.pp-zoom-dragging,.pp-zoom-dragging *{user-select:none!important;-webkit-user-select:none!important}' +
      '@media print{.pp-zoom-reset,.pp-zoom-band{display:none!important}}' +
      'body.bss-exporting .pp-zoom-reset,body.pres-exporting .pp-zoom-reset,body.export-mode .pp-zoom-reset{display:none!important}';
    (document.head || document.documentElement).appendChild(st);
  }

  /* ── the drag ───────────────────────────────────────────────────────────── */
  var MIN_W = 320, MIN_H = 120;   /* sparklines and thumbnails stay plain */
  function arm(ch, host) {
    if (ch.__ppZoomArmed || !host || !host.appendChild) return;
    if ((host.offsetWidth || 0) < MIN_W || (host.offsetHeight || 0) < MIN_H) return;   /* re-checked on the next setOption */
    ch.__ppZoomArmed = true;
    css();
    try { if (getComputedStyle(host).position === 'static') host.style.position = 'relative'; } catch (e) { /* detached */ }

    var band = document.createElement('div'); band.className = 'pp-zoom-band'; band.hidden = true; host.appendChild(band);
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'pp-zoom-reset'; btn.textContent = 'Reset zoom'; btn.hidden = true;
    btn.title = 'Show the full date range'; host.appendChild(btn);

    function reset() { try { ch.dispatchAction({ type: 'dataZoom', dataZoomId: ID, start: 0, end: 100 }); } catch (e) { /* disposed */ } }
    function refresh() {
      var z = zoomState(ch); var on = !!(z && z.zoomed);
      btn.hidden = !on; host.classList.toggle('pp-zoomed', on);
      applyY(ch, on);
    }
    ch.__ppZoomRefresh = refresh;
    btn.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); reset(); });
    btn.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    ch.on('datazoom', refresh);

    /* client x → the chart's own pixel x (the slide may be transform-scaled) */
    function zrDom() { try { return ch.getZr().dom; } catch (e) { return null; } }
    function chartX(clientX) {
      var d = zrDom(); if (!d) return null;
      var r = d.getBoundingClientRect(); var w = ch.getWidth() || r.width || 1;
      return (clientX - r.left) * (w / (r.width || 1));
    }
    /* client x → host-local px for the band */
    function hostX(clientX) {
      var r = host.getBoundingClientRect(); var sc = (r.width || 1) / (host.offsetWidth || r.width || 1);
      return (clientX - r.left) / sc;
    }
    var drag = null;
    function onMove(e) {
      if (!drag) return;
      drag.x1 = e.clientX;
      var a = hostX(Math.min(drag.x0, drag.x1)), b = hostX(Math.max(drag.x0, drag.x1));
      if (Math.abs(drag.x1 - drag.x0) >= MIN_DRAG_PX) { band.hidden = false; band.style.left = a + 'px'; band.style.width = Math.max(1, b - a) + 'px'; }
    }
    function onUp(e) {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      document.documentElement.classList.remove('pp-zoom-dragging');
      band.hidden = true;
      if (!drag) return;
      var d = drag; drag = null;
      if (Math.abs(e.clientX - d.x0) < MIN_DRAG_PX) return;
      var pa = chartX(Math.min(d.x0, e.clientX)), pb = chartX(Math.max(d.x0, e.clientX));
      if (pa == null || pb == null) return;
      try {
        var xs = arr(ch.getOption().xAxis), x0 = xs[0] || {};
        var va = ch.convertFromPixel({ xAxisIndex: 0 }, pa), vb = ch.convertFromPixel({ xAxisIndex: 0 }, pb);
        if (va == null || vb == null || isNaN(va) || isNaN(vb)) return;
        var lo = Math.min(va, vb), hi = Math.max(va, vb);
        if (x0.type !== 'time' && Array.isArray(x0.data)) {
          var n = x0.data.length;
          lo = Math.max(0, Math.round(lo)); hi = Math.min(n - 1, Math.round(hi));
          if (hi - lo < 1) { lo = Math.max(0, lo - 1); hi = Math.min(n - 1, hi + 1); }
          if (hi <= lo) return;
        }
        ch.dispatchAction({ type: 'dataZoom', dataZoomId: ID, startValue: lo, endValue: hi });
      } catch (err) { /* chart mid-update */ }
    }
    host.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || pageBusy()) return;
      var t = e.target;
      if (t && t.closest && t.closest('.pp-zoom-reset, button, a, input, select, textarea, [contenteditable]')) return;
      drag = { x0: e.clientX, x1: e.clientX };
      document.documentElement.classList.add('pp-zoom-dragging');
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
    });
    host.addEventListener('dblclick', function (e) {
      if (pageBusy()) return;
      var z = zoomState(ch); if (z && z.zoomed) { e.preventDefault(); reset(); }
    });
  }

  /* ── the init wrapper ───────────────────────────────────────────────────── */
  function install() {
    if (OFF || !window.echarts || window.echarts.__ppZoomWrapped) return !!(window.echarts && window.echarts.__ppZoomWrapped);
    var orig = window.echarts.init;
    if (typeof orig !== 'function') return false;
    window.echarts.init = function (el, theme, opts) {
      var ch = orig.apply(this, arguments);
      try {
        var so = ch.setOption;
        ch.setOption = function (opt, a1) {
          var on = false, notMerge = a1 === true || !!(a1 && typeof a1 === 'object' && a1.notMerge === true);
          var partialY = false;
          try {
            if (!ch.__ppNoZoom && eligible(opt, el)) { recordY(ch, opt, notMerge); augment(opt); on = true; }
            /* a follow-up partial update that pins the y axis (no series with it) */
            else if (!ch.__ppYApplying && ch.__ppY && opt && opt.yAxis) { recordY(ch, opt, false); partialY = true; }
          } catch (e) { on = false; }
          var r = so.apply(this, arguments);
          if (on) { try { arm(ch, el); if (ch.__ppZoomRefresh) ch.__ppZoomRefresh(); } catch (e) { /* keep the chart */ } }
          else if (partialY) { try { if (ch.__ppZoomRefresh) ch.__ppZoomRefresh(); } catch (e) { /* keep the chart */ } }
          return r;
        };
      } catch (e) { /* leave the instance untouched */ }
      return ch;
    };
    window.echarts.__ppZoomWrapped = true;
    return true;
  }

  /* echarts may load deferred after this script — keep trying briefly */
  var tries = 0;
  (function tick() { if (install() || OFF || ++tries > 200) return; setTimeout(tick, 50); })();
  document.addEventListener('DOMContentLoaded', install);
  window.addEventListener('load', install);

  window.PP_CHART_ZOOM = { install: install, eligible: eligible, off: OFF, MIN_POINTS: MIN_POINTS };
})();
