/* ════════════════════════════════════════════════════════════════════
   shared/present-charts.js — presentation chart engine (window.PresentChart)
   ────────────────────────────────────────────────────────────────────
   Puts a report graph on a slide and BUILDS it step-by-step as the presenter
   clicks (Google Slides can't animate graphs — this is the differentiator).

   PRIMARY PATH — createFromModule (spec.module): render the EXACT online-
   report chart module (assets/Reports/charts/chart-*.js) so the slide graph
   matches the report (colours, staircase axis, legend icons, crisis lines +
   period bands, axis names — and no title, so it's just the graph), then
   layer the click-to-build reveal on top. This is what the recipes in
   presentation.html produce. ONE deliberate divergence: gridlines are
   re-tinted darker (THEME.gridSlide) because the report's 6%-black lines
   vanish on a projector.

   At-a-Glance headline stats use the bigNumber type (count-up). The older
   type-based "billboard" renderers (line/bars/dualBarLine/pyramid) are kept
   for the standalone preview lab (present-chart-lab.html) but are no longer
   the path the real tool takes.

   Usage:
     const ctrl = PresentChart.create(containerEl, spec);
     ctrl.next();      // advance one build step (presenter click / ArrowRight)
     ctrl.prev();      // step back
     ctrl.reset();     // back to the pre-build state (just title, empty plot)
     ctrl.play();      // autoplay through all steps with pauses
     ctrl.steps;       // total number of build steps
     ctrl.index;       // current step (0 = nothing built yet)
     ctrl.isComplete();// true once every step is revealed
     ctrl.resize();    // re-fit after a container resize
     ctrl.dispose();

   A `spec` is chart-type + data + copy — NOT tied to where the data came
   from, so a spec can be produced from the cached report feed (the real
   path) or from sample data (the preview lab). Supported types:
     'line'      — 1+ time-series lines; draws in left→right, one series
                   per step, then a final step pops the latest-value
                   callout on the lead series.
     'bigNumber' — one headline stat; counts up from 0, then the caption
                   fades in.
     'bars'      — category comparison; bars grow up (one step), then a
                   final step highlights the biggest.

   Depends on window.echarts (loaded by the host page) for line/bars.
   bigNumber is pure DOM (no ECharts needed).
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ─── House style — the one consistent "billboard" look ───
     LIGHT theme: slides default to a white canvas (and we want to echo the
     online reports' look), so dark ink on transparent, with a vivid
     series palette that reads on white. */
  var THEME = {
    font: 'Montserrat, "DM Sans", system-ui, sans-serif',
    ink: '#1a2838',            // report chart text colour, on the white slide
    inkDim: 'rgba(26,40,56,0.58)',
    grid: 'rgba(26,40,56,0.10)',
    /* Gridlines for the MODULE path. The report theme draws them at
       rgba(0,0,0,0.06) — fine on a screen a foot away, invisible on a
       projector — so slides re-tint them (Van, 2026-08-21). Reports and the
       monthly PDFs render the modules directly and keep the lighter value. */
    gridSlide: 'rgba(26,40,56,0.18)',
    /* PERFORMANCE PROPERTY BRAND COLOURS lead the palette: brand teal
       (--accent #00b6cb) + brand navy (#1f283f), then the report-chart
       palette colours (assets/Reports/charts/_theme.js) for extra series.
       All chosen to read on a white slide at a distance. */
    palette: ['#00b6cb', '#1f283f', '#1e6feb', '#e8a04b', '#5d48c2', '#5db34a'],
    lineWidth: 5,
    symbolSize: 0,             // clean line; the callout marks the key point
    easing: 'cubicOut',
    drawMs: 1100,              // line draw-in / bar grow duration
    titleSize: 34,
    axisSize: 16,
    valueSize: 18,
  };

  /* True while a deck export is running (setExporting). ECharts animation is
     silenced by the init wrapper below, but this file also animates with raw
     TIMERS — the legend stagger (setTimeout), the count-ups (rAF, 1.2s) and
     the sparkline wipe (a 1.05s CSS transition). A capture taken during any
     of them ships half a slide: Van’s PPTX had the industry donut with 4 of
     14 legend items. While exporting, every one of these jumps straight to
     its final state instead. */
  var _exportingNow = false;

  function isArr(a) { return Array.isArray(a); }
  function lastNum(a) {
    if (!isArr(a)) return null;
    for (var i = a.length - 1; i >= 0; i--) {
      if (a[i] != null && !(typeof a[i] === 'number' && isNaN(a[i]))) return a[i];
    }
    return null;
  }
  function clearEl(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  /* Format a value for labels/callouts. unit: 'pct' | 'aud' | 'num'. */
  function fmt(v, unit) {
    if (v == null || (typeof v === 'number' && isNaN(v))) return '—';
    var n = Number(v);
    if (unit === 'pct') return (Math.round(n * 100) / 100).toLocaleString('en-AU') + '%';
    if (unit === 'aud') {
      if (Math.abs(n) >= 1e6) return '$' + (Math.round(n / 1e5) / 10).toLocaleString('en-AU') + 'M';
      if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3).toLocaleString('en-AU') + 'k';
      return '$' + Math.round(n).toLocaleString('en-AU');
    }
    if (Math.abs(n) >= 1e6) return (Math.round(n / 1e5) / 10).toLocaleString('en-AU') + 'M';
    if (Math.abs(n) >= 1e3) return (Math.round(n / 1e2) / 10).toLocaleString('en-AU') + 'k';
    return (Math.round(n * 100) / 100).toLocaleString('en-AU');
  }

  /* ─── Title block (shared by every chart type) ─── */
  function mountTitle(host, spec) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'padding:28px 36px 6px;font-family:' + THEME.font + ';';
    if (spec.title) {
      var h = document.createElement('div');
      h.textContent = spec.title;
      h.style.cssText = 'font-size:' + THEME.titleSize + 'px;font-weight:800;letter-spacing:0.2px;color:' + THEME.ink + ';line-height:1.15;';
      wrap.appendChild(h);
    }
    if (spec.subtitle) {
      var s = document.createElement('div');
      s.textContent = spec.subtitle;
      s.style.cssText = 'margin-top:6px;font-size:16px;font-weight:600;color:' + THEME.inkDim + ';';
      wrap.appendChild(s);
    }
    host.appendChild(wrap);
    return wrap;
  }

  /* ── Shared axes — match the ONLINE REPORTS' presentation ──
     X (category/years): every label shown on a 2-ROW STAIRCASE (even index
     on the upper row, odd index dropped to a lower row via a '\n' prefix),
     so no years are skipped — mirrors the reports' staircaseYearAxis.
     Y (value): formatted labels, subtle splitLine, and a rotated axis NAME
     down the side (nameLocation middle, rotate 90) like the reports.
     Pass yMin (e.g. 0) to anchor the baseline; otherwise the axis auto-
     scales tight to the data. */
  function axisX(cats) {
    return {
      type: 'category', data: cats, boundaryGap: false,
      axisLine: { lineStyle: { color: THEME.grid } },
      axisTick: { show: false, alignWithLabel: true },
      axisLabel: {
        color: THEME.inkDim, fontSize: 12, interval: 0, lineHeight: 15,
        formatter: function (v, i) { return (i % 2 === 0) ? v : '\n' + v; },
      },
    };
  }
  function axisY(unit, name, yMin) {
    var y = {
      type: 'value',
      name: name || '', nameLocation: 'middle', nameRotate: 90, nameGap: 52,
      nameTextStyle: { color: THEME.inkDim, fontSize: 13, fontStyle: 'italic' },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: THEME.grid } },
      axisLabel: { color: THEME.inkDim, fontSize: THEME.axisSize, formatter: function (v) { return fmt(v, unit); } },
    };
    if (yMin == null) y.scale = true; else y.min = yMin;
    return y;
  }

  /* Reveal a chart one series at a time by ADDING each series via a merge
     setOption — ECharts then plays that series' ENTRANCE animation (line
     draws in, bars grow). A plain empty→full data swap does NOT animate (a
     data length change isn't tweened — the points just appear), which is
     why reveals looked instant. `finals` are extra build steps run after
     all series are shown, each called with (chart, shownSeries). baseOption
     must not depend on its own `series` (the helper manages it). */
  function revealBySeries(chart, baseOption, fullSeries, finals) {
    baseOption.series = [];
    chart.setOption(baseOption);
    var shown = [];
    var builds = fullSeries.map(function (s) {
      return function () { shown.push(s); chart.setOption({ series: shown.slice() }); };
    });
    (finals || []).forEach(function (fn) { builds.push(function () { fn(chart, shown); }); });
    return stepController(builds, {
      reset: function () { shown.length = 0; chart.setOption({ series: [] }, { replaceMerge: ['series'] }); },
      resize: function () { chart.resize(); },
      dispose: function () { chart.dispose(); },
    });
  }

  /* ═══ EXACT REPORT CHART (window.PpaCharts module) + build animation ═══
     The primary Phase-3 path: render the SAME chart module the online
     reports use (shared/../assets/Reports/charts/chart-*.js) so the slide
     graph is pixel-identical to the report — its colours, staircase axis,
     legend icons, crisis lines + growth/correction bands, axis names. The
     report modules carry NO title, so the slide chart shows just the graph
     (the page header/sub-header from the report is intentionally absent —
     more room for the graph).

     The modules render statically (animation:false). We layer the
     click-to-build reveal on top WITHOUT touching them: render once, harvest
     the fully-resolved option via getOption(), lock the value-axis bounds to
     the full-data extent (so the axis doesn't jump as lines appear), then
     reveal each data-bearing series one click at a time by ADDING it back via
     a merge setOption — which is what makes ECharts play the entrance
     (draw-in / grow) animation (a plain data swap doesn't tween; see
     revealBySeries note). Empty legend-only series (e.g. the Growth /
     Correction swatches) stay on screen the whole time.

     spec = { module:'median-price', data:{...module's own shape...} } */
  function createFromModule(host, spec) {
    if (!window.echarts) { host.textContent = 'Chart engine needs ECharts.'; return nullController(); }
    if (!window.PpaCharts || !window.PpaCharts.registry || !window.PpaCharts.registry[spec.module]) {
      host.textContent = 'Report chart library not loaded (' + spec.module + ').';
      return nullController();
    }
    var renderFn = window.PpaCharts.registry[spec.module];
    /* The module calls echarts.init() itself — hand it a plot div that fills
       the (px-sized) host so it renders at the slide's base size. */
    clearEl(host);
    var plot = document.createElement('div');
    plot.style.cssText = 'width:100%;height:100%;';
    host.appendChild(plot);

    var chart;
    try { chart = renderFn(plot, spec.data || {}); }
    catch (e) { host.textContent = 'Chart failed: ' + (e && e.message || e); return nullController(); }
    if (!chart && window.echarts.getInstanceByDom) chart = window.echarts.getInstanceByDom(plot);
    if (!chart) return nullController();

    var full = chart.getOption();
    var allSeries = full.series || [];

    /* Lock value-axis min/max to the full-data extent (read from the rendered
       model) so the axis stays put while series are revealed. Category axes
       are already stable; left untouched. Best-effort — if the internal
       accessor ever changes, we just fall back to ECharts' auto-scaling. */
    var axisLock = {};
    ['xAxis', 'yAxis'].forEach(function (k) {
      var defs = full[k]; if (!defs) return;
      var arr = Array.isArray(defs) ? defs : [defs];
      axisLock[k] = arr.map(function (def, i) {
        if (def && def.type && def.type !== 'value') return {};   // category / log axes are already stable
        if (def && typeof def.max === 'number') return {};        // module already pinned a NICE max (niceAxis) — keep it exactly like the report
        try {
          var axis = chart.getModel().getComponent(k, i).axis;
          var ext  = axis.scale.getExtent();
          var step = (axis.scale.getInterval && axis.scale.getInterval()) || 0;
          if (ext && isFinite(ext[0]) && isFinite(ext[1]) && step > 0) {
            /* Freeze an AUTO-scaled axis to the SAME nice tick grid ECharts
               shows at full data (the report's look): snap min DOWN / max UP to
               the tick step so the top tick is a clean multiple — not a stub
               like …12,14 or …20k,21k that pinning the raw data max produced.
               Honour an explicit module min (e.g. min:0) so a zero-based axis
               stays zero-based. */
            var lo = (def && typeof def.min === 'number') ? def.min : Math.floor((ext[0] + 1e-9) / step) * step;
            var hi = Math.ceil((ext[1] - 1e-9) / step) * step;
            if (hi <= lo) hi = lo + step;
            return { min: lo, max: hi, interval: step };
          }
        } catch (_) {}
        return {};   // couldn't compute a clean grid → leave ECharts to nice it
      });
    });

    /* Darken the gridlines for projection — only on axes that actually draw
       them, and merged into the same axis patch as the lock so the module's
       own axis config is otherwise untouched. */
    ['xAxis', 'yAxis'].forEach(function (k) {
      var defs = full[k]; if (!defs || !axisLock[k]) return;
      var arr = Array.isArray(defs) ? defs : [defs];
      axisLock[k] = axisLock[k].map(function (patch, i) {
        var sl = (arr[i] || {}).splitLine;
        if (!sl || sl.show === false) return patch;
        var out = {}; for (var p in patch) if (Object.prototype.hasOwnProperty.call(patch, p)) out[p] = patch[p];
        out.splitLine = { lineStyle: { color: THEME.gridSlide } };
        return out;
      });
    });

    /* Data-bearing series reveal on clicks; empty (legend-only) series stay. */
    var staticSeries = [], revealSeries = [];
    allSeries.forEach(function (s) {
      var hasData = Array.isArray(s.data) && s.data.some(function (d) {
        var v = (d && typeof d === 'object' && 'value' in d) ? d.value : d;
        return v != null && !(typeof v === 'number' && isNaN(v));
      });
      (hasData ? revealSeries : staticSeries).push(s);
    });

    /* Enable the build animation (modules ship animation:false) + apply the
       axis lock. Same easing/duration as the rest of the engine for a
       consistent feel. */
    chart.setOption({
      animation: true,
      animationDuration: THEME.drawMs, animationEasing: THEME.easing,
      animationDurationUpdate: THEME.drawMs, animationEasingUpdate: THEME.easing,
      animationDelay: function (i) { return i * 14; },
      animationDelayUpdate: function (i) { return i * 14; },
      xAxis: axisLock.xAxis, yAxis: axisLock.yAxis,
    });
    /* Optional slide-only layout tweak: a report module's grid is tuned for
       the report's panel; a recipe can reclaim empty slide space WITHOUT
       touching the shared module (e.g. median-price ships a tall bottom
       margin that leaves a big gap on a 16:9 slide). Merges over the grid. */
    if (spec.grid) chart.setOption({ grid: spec.grid });
    /* Same idea for the legend: a recipe can pull it closer to the plot /
       resize its text for the slide WITHOUT touching the shared module
       (e.g. the industry donut sits left, so the report's far-right legend
       leaves a big mid-slide gap). Merges over the legend. */
    if (spec.legend) chart.setOption({ legend: spec.legend });

    /* Optional slide-only legend ENTRANCE: cascade the legend items in (synced
       with the data reveal) instead of showing them all at once. Opt-in via
       spec.legendStagger (e.g. the industry donut). Item names come from the
       legend's own data, else the pie series' slice names. */
    var legendNames = null, legendTimer = null, legendStarted = false;
    if (spec.legendStagger) {
      var lg = full.legend; if (Array.isArray(lg)) lg = lg[0];
      if (lg && lg.data && lg.data.length) {
        legendNames = lg.data.slice();
      } else {
        var pieS = allSeries.filter(function (s) { return s && s.type === 'pie'; })[0];
        if (pieS && Array.isArray(pieS.data)) {
          legendNames = pieS.data.map(function (d) { return (d && typeof d === 'object') ? d.name : d; })
                             .filter(function (n) { return n != null && n !== ''; });
        }
      }
      if (legendNames && legendNames.length) {
        /* Pin the legend's top so cascading items append DOWNWARD. The module's
           top:'middle' re-centres the whole block every time an item is added,
           yanking the existing items up each tick — that was the start-of-
           animation glitch. Centre the FULL list once, up front, then hold it. */
        var legH = (chart.getHeight && chart.getHeight()) || 540;
        var topPx = Math.max(8, Math.round((legH - legendNames.length * 22) / 2));   // ~22px per row
        chart.setOption({ legend: { top: topPx, data: [] } });   // fixed top + start hidden
      } else legendNames = null;
    }
    function startLegendReveal() {
      if (!legendNames || legendStarted) return;
      legendStarted = true;
      if (_exportingNow) { chart.setOption({ legend: { data: legendNames.slice() } }); return; }
      var total = legendNames.length;
      var per = Math.max(16, Math.min(40, Math.round((THEME.drawMs || 1100) / (total * 2))));   // snappy stagger
      var i = 0;
      (function tick() {
        i += 1;
        chart.setOption({ legend: { data: legendNames.slice(0, i) } });
        if (i < total) legendTimer = setTimeout(tick, per);
      })();
    }
    function resetLegend() {
      if (legendTimer) { clearTimeout(legendTimer); legendTimer = null; }
      legendStarted = false;
      if (legendNames) chart.setOption({ legend: { data: [] } });
    }

    var shown = [];
    /* Pre-build state: only the always-on series (replaceMerge drops the
       data series cleanly so re-revealing animates again). */
    function showStatic() { chart.setOption({ series: staticSeries.slice() }, { replaceMerge: ['series'] }); }
    showStatic();

    var builds = revealSeries.map(function (s, idx) {
      /* Default merge (no replaceMerge): the previously-shown series keep
         their index and DON'T re-animate; the newly appended one enters.
         The first data reveal also kicks off the legend cascade (if any). */
      return function () {
        shown.push(s);
        chart.setOption({ series: staticSeries.concat(shown) });
        if (idx === 0) startLegendReveal();
      };
    });
    /* Requested a staggered legend but there's no data series to trigger it →
       just show it, so the legend isn't left permanently empty. */
    if (legendNames && revealSeries.length === 0) startLegendReveal();
    return stepController(builds, {
      reset: function () { shown.length = 0; resetLegend(); showStatic(); },
      resize: function () { try { chart.resize(); } catch (_) {} },
      dispose: function () { if (legendTimer) { try { clearTimeout(legendTimer); } catch (_) {} } try { chart.dispose(); } catch (_) {} },
    });
  }

  /* ═══ LINE / MULTILINE ═══ */
  function createLine(host, spec) {
    if (!window.echarts) { host.textContent = 'Chart engine needs ECharts.'; return nullController(); }
    host.style.display = 'flex';
    host.style.flexDirection = 'column';
    mountTitle(host, spec);
    var plot = document.createElement('div');
    /* flex:1 + min-height:0 → the plot fills EXACTLY the space below the
       title, so the legend/axes can never be pushed off the slide edge. */
    plot.style.cssText = 'flex:1 1 auto;min-height:0;width:100%;';
    host.appendChild(plot);

    var chart = window.echarts.init(plot, null, { renderer: 'svg' });
    var cats = spec.data.x || [];
    var series = (spec.data.series || []).map(function (s, i) {
      return {
        name: s.name,
        type: 'line',
        smooth: 0.18,
        showSymbol: false,
        symbolSize: THEME.symbolSize,
        lineStyle: { width: THEME.lineWidth, color: THEME.palette[i % THEME.palette.length] },
        itemStyle: { color: THEME.palette[i % THEME.palette.length] },
        emphasis: { disabled: true },
        _values: s.values || [],
        data: [],                 // revealed step by step
      };
    });
    var unit = spec.unit || 'num';

    /* Full series (with data) — revealed one at a time by the helper so
       each line plays its entrance DRAW animation. */
    var fullSeries = series.map(function (s) {
      return { name: s.name, type: 'line', smooth: s.smooth, showSymbol: s.showSymbol,
               symbolSize: s.symbolSize, lineStyle: s.lineStyle, itemStyle: s.itemStyle,
               emphasis: s.emphasis, data: s._values };
    });
    var baseOption = {
      backgroundColor: 'transparent',
      textStyle: { fontFamily: THEME.font, color: THEME.ink },
      /* Legend on TOP (reports' convention; auto-grows from shown series).
         Top margin leaves room for it + the latest-value callout. */
      grid: { left: 70, right: 48, top: 50, bottom: 52, containLabel: true },
      legend: series.length > 1
        ? { top: 8, left: 'center', itemGap: 26, textStyle: { color: THEME.ink, fontSize: THEME.axisSize, fontWeight: 600 }, icon: 'roundRect' }
        : undefined,
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(15,23,42,0.94)', borderColor: 'rgba(255,255,255,0.12)', textStyle: { color: '#fff', fontSize: 15 } },
      xAxis: axisX(cats),
      yAxis: axisY(unit, spec.yName, spec.yMin),
      /* Smooth eased entrance; per-point stagger draws the line left→right.
         (See ANIMATION SMOOTHNESS notes.) */
      animation: true,
      animationDuration: THEME.drawMs, animationEasing: THEME.easing,
      animationDurationUpdate: THEME.drawMs, animationEasingUpdate: THEME.easing,
      animationDelay: function (i) { return i * 14; },
      animationDelayUpdate: function (i) { return i * 14; },
    };
    /* Final step: pop the latest value on the lead series as a callout. */
    var calloutBuild = function (chart, shown) {
      var lv = lastNum(series[0]._values);
      if (lv == null || !shown[0]) return;
      shown[0].markPoint = {
        symbol: 'circle', symbolSize: 14,
        itemStyle: { color: THEME.palette[0], borderColor: '#fff', borderWidth: 2 },
        label: {
          show: true, position: 'top', distance: 12,
          formatter: fmt(lv, unit), color: '#fff', fontSize: THEME.valueSize, fontWeight: 800,
          backgroundColor: 'rgba(10,21,32,0.88)', padding: [5, 9], borderRadius: 7,
        },
        data: [{ type: 'max' }], animationDuration: 500,
      };
      chart.setOption({ series: shown.slice() });
    };
    return revealBySeries(chart, baseOption, fullSeries, [calloutBuild]);
  }

  /* ═══ BARS ═══ */
  function createBars(host, spec) {
    if (!window.echarts) { host.textContent = 'Chart engine needs ECharts.'; return nullController(); }
    host.style.display = 'flex';
    host.style.flexDirection = 'column';
    mountTitle(host, spec);
    var plot = document.createElement('div');
    plot.style.cssText = 'flex:1 1 auto;min-height:0;width:100%;';
    host.appendChild(plot);
    var chart = window.echarts.init(plot, null, { renderer: 'svg' });
    var cats = spec.data.x || [];
    var unit = spec.unit || 'num';
    /* Single bar series (spec.data.values) OR grouped (spec.data.series). */
    var multi = Array.isArray(spec.data.series);
    var defs = multi ? spec.data.series : [{ name: spec.title || '', values: spec.data.values || [] }];
    var maxIdx = (!multi) ? defs[0].values.reduce(function (m, v, i) { return (v != null && (defs[0].values[m] == null || v > defs[0].values[m])) ? i : m; }, 0) : -1;

    /* Full bar series (with data) — revealed one group at a time so each
       grows on entry. */
    var fullSeries = defs.map(function (d, i) {
      return {
        name: d.name, type: 'bar', data: d.values.slice(),
        barWidth: multi ? undefined : '52%',
        itemStyle: { color: THEME.palette[i % THEME.palette.length], borderRadius: [6, 6, 0, 0] },
        /* Per-bar value labels only for single-series (grouped would crowd). */
        label: multi ? { show: false } : { show: true, position: 'top', color: THEME.ink, fontSize: THEME.valueSize, fontWeight: 800, formatter: function (p) { return fmt(p.value, unit); } },
      };
    });
    var baseOption = {
      backgroundColor: 'transparent',
      textStyle: { fontFamily: THEME.font, color: THEME.ink },
      grid: { left: 62, right: 36, top: multi ? 50 : 44, bottom: 36, containLabel: true },
      legend: multi ? { top: 8, left: 'center', itemGap: 24, textStyle: { color: THEME.ink, fontSize: THEME.axisSize, fontWeight: 600 }, icon: 'roundRect' } : undefined,
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(15,23,42,0.94)', textStyle: { color: '#fff', fontSize: 15 } },
      /* Bar categories (e.g. growth horizons) are few — keep them on one
         row, all shown. */
      xAxis: { type: 'category', data: cats, axisLine: { lineStyle: { color: THEME.grid } }, axisTick: { show: false }, axisLabel: { color: THEME.ink, fontSize: THEME.axisSize, fontWeight: 600, interval: 0 } },
      yAxis: axisY(unit, spec.yName, spec.yMin),
      animation: true,
      animationDuration: THEME.drawMs, animationEasing: THEME.easing,
      animationDurationUpdate: THEME.drawMs, animationEasingUpdate: THEME.easing,
      animationDelay: function (i) { return i * 14; },
      animationDelayUpdate: function (i) { return i * 14; },
    };
    /* Single-series final step: highlight the biggest bar. */
    var finals = multi ? [] : [function (chart, shown) {
      if (!shown[0]) return;
      shown[0].data = defs[0].values.map(function (v, i) {
        return { value: v, itemStyle: { color: i === maxIdx ? THEME.palette[1] : THEME.palette[0], borderRadius: [6, 6, 0, 0] } };
      });
      chart.setOption({ series: shown.slice() });
    }];
    return revealBySeries(chart, baseOption, fullSeries, finals);
  }

  /* ═══ DUAL AXIS: bars (left) + line (right) ═══
     spec.data = { x, bars:[{name,values}], line:{name,values} } with
     spec.barUnit / spec.lineUnit. Build: grow each bar series, then draw
     the line. */
  function createDualBarLine(host, spec) {
    if (!window.echarts) { host.textContent = 'Chart engine needs ECharts.'; return nullController(); }
    host.style.display = 'flex';
    host.style.flexDirection = 'column';
    mountTitle(host, spec);
    var plot = document.createElement('div');
    plot.style.cssText = 'flex:1 1 auto;min-height:0;width:100%;';
    host.appendChild(plot);
    var chart = window.echarts.init(plot, null, { renderer: 'svg' });
    var cats = (spec.data && spec.data.x) || [];
    var bars = (spec.data && spec.data.bars) || [];
    var lineDef = (spec.data && spec.data.line) || null;
    var barUnit = spec.barUnit || 'num';
    var lineUnit = spec.lineUnit || 'num';
    var lineColor = THEME.palette[bars.length % THEME.palette.length];

    /* Full series (with data) — bars first, then the line, revealed in
       that order so each enters with its own grow/draw animation. */
    var fullSeries = bars.map(function (b, i) {
      return { name: b.name, type: 'bar', yAxisIndex: 0, data: b.values.slice(), itemStyle: { color: THEME.palette[i % THEME.palette.length], borderRadius: [4, 4, 0, 0] } };
    }).concat(lineDef ? [{
      name: lineDef.name, type: 'line', yAxisIndex: 1, smooth: 0.18, showSymbol: false,
      data: lineDef.values.slice(), lineStyle: { width: THEME.lineWidth, color: lineColor }, itemStyle: { color: lineColor },
    }] : []);
    var baseOption = {
      backgroundColor: 'transparent',
      textStyle: { fontFamily: THEME.font, color: THEME.ink },
      grid: { left: 70, right: 70, top: 50, bottom: 52, containLabel: true },
      legend: { top: 8, left: 'center', itemGap: 22, textStyle: { color: THEME.ink, fontSize: THEME.axisSize, fontWeight: 600 }, icon: 'roundRect' },
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(15,23,42,0.94)', borderColor: 'rgba(255,255,255,0.12)', textStyle: { color: '#fff', fontSize: 15 } },
      xAxis: axisX(cats),
      yAxis: [
        Object.assign(axisY(barUnit, spec.barName), {}),
        Object.assign(axisY(lineUnit, spec.lineName), { splitLine: { show: false } }),
      ],
      animation: true,
      animationDuration: THEME.drawMs, animationEasing: THEME.easing,
      animationDurationUpdate: THEME.drawMs, animationEasingUpdate: THEME.easing,
      animationDelay: function (i) { return i * 14; },
      animationDelayUpdate: function (i) { return i * 14; },
    };
    return revealBySeries(chart, baseOption, fullSeries, []);
  }

  /* ═══ PYRAMID: back-to-back horizontal bars ═══
     spec.data = { ages:[...], left:{name,values}, right:{name,values} }.
     Left bars extend left of zero, right bars extend right — a population-
     pyramid shape comparing two cohorts by age group. Build: left, then
     right. */
  function createPyramid(host, spec) {
    if (!window.echarts) { host.textContent = 'Chart engine needs ECharts.'; return nullController(); }
    host.style.display = 'flex';
    host.style.flexDirection = 'column';
    mountTitle(host, spec);
    var plot = document.createElement('div');
    plot.style.cssText = 'flex:1 1 auto;min-height:0;width:100%;';
    host.appendChild(plot);
    var chart = window.echarts.init(plot, null, { renderer: 'svg' });
    var ages = (spec.data && spec.data.ages) || [];
    var left = (spec.data && spec.data.left) || { name: 'Left', values: [] };
    var right = (spec.data && spec.data.right) || { name: 'Right', values: [] };
    var unit = spec.unit || 'pct';
    var negate = function (arr) { return arr.map(function (v) { return v == null ? null : -Math.abs(v); }); };

    /* Full series (with data) — left (extends left, negated) then right;
       revealed in order so each side grows in. */
    var fullSeries = [
      { name: left.name,  type: 'bar', data: negate(left.values), barWidth: '92%', itemStyle: { color: THEME.palette[0] } },
      { name: right.name, type: 'bar', data: right.values.slice(), barWidth: '92%', barGap: '-100%', itemStyle: { color: THEME.palette[1] } },
    ];
    var baseOption = {
      backgroundColor: 'transparent',
      textStyle: { fontFamily: THEME.font, color: THEME.ink },
      grid: { left: 24, right: 24, top: 50, bottom: 36, containLabel: true },
      legend: { top: 8, left: 'center', itemGap: 24, textStyle: { color: THEME.ink, fontSize: THEME.axisSize, fontWeight: 600 }, icon: 'roundRect' },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(15,23,42,0.94)', textStyle: { color: '#fff', fontSize: 15 },
        formatter: function (ps) {
          var s = ps && ps[0] ? ('Age ' + ps[0].axisValue) : '';
          (ps || []).forEach(function (p) { s += '<br/>' + p.marker + p.seriesName + ': ' + fmt(Math.abs(p.value), unit); });
          return s;
        } },
      xAxis: { type: 'value', axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: THEME.grid } }, axisLabel: { color: THEME.inkDim, fontSize: THEME.axisSize, formatter: function (v) { return fmt(Math.abs(v), unit); } } },
      yAxis: { type: 'category', data: ages, axisLine: { lineStyle: { color: THEME.grid } }, axisTick: { show: false }, axisLabel: { color: THEME.ink, fontSize: 13 } },
      animation: true,
      animationDuration: THEME.drawMs, animationEasing: THEME.easing,
      animationDurationUpdate: THEME.drawMs, animationEasingUpdate: THEME.easing,
      animationDelay: function (i) { return i * 14; },
      animationDelayUpdate: function (i) { return i * 14; },
    };
    return revealBySeries(chart, baseOption, fullSeries, []);
  }

  /* ═══ BIG NUMBER (pure-DOM card: title + value + bottom sparkline) ═══
     Left-aligned card — title top-left, the count-up value below it, and a
     small area sparkline pinned to the bottom. Optional style overrides (from
     the builder's panel): spec.font, spec.bg (card background), spec.titleColor
     (label), spec.valueColor (number). spec.spark = numeric series for the
     sparkline; spec.decimals = fixed decimals for a 'num' value. */
  var _bnSparkSeq = 0;
  function _bnSparkSvg(vals, color) {
    var W = 500, H = 90, pad = 6, topRoom = 10;
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var range = (max - min) || 1, n = vals.length;
    var pts = vals.map(function (v, i) {
      var x = (n === 1) ? W / 2 : pad + (i / (n - 1)) * (W - pad * 2);
      var y = H - pad - ((v - min) / range) * (H - pad - topRoom);
      return [x, y];
    });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var area = line + ' L' + pts[n - 1][0].toFixed(1) + ' ' + H + ' L' + pts[0][0].toFixed(1) + ' ' + H + ' Z';
    /* Unique id per render — url(#id) resolves to the FIRST match in the whole
       document, so a shared id would paint from a stale copy elsewhere. */
    var gid = 'bn-spark-' + (++_bnSparkSeq);
    var last = pts[n - 1];
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:100%;display:block;overflow:visible;">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.32"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<path class="bn-spark-area" d="' + area + '" fill="url(#' + gid + ')"/>' +
      '<path class="bn-spark-line" d="' + line + '" fill="none" stroke="' + color + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
      '<circle class="bn-spark-dot" cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="3.4" fill="' + color + '"/>' +
      '</svg>';
  }
  /* Shared value formatter: pct → 2dp + %; aud → $ + full commas; num → full
     commas. `decimals` = fixed decimals (default 0). No k/M abbreviation. */
  function _bnFmt(unit, decimals) {
    decimals = decimals || 0;
    if (unit === 'pct') return function (v) { return v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%'; };
    var pre = (unit === 'aud') ? '$' : '';
    return function (v) { return pre + v.toLocaleString('en-AU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); };
  }
  /* Hover tooltip + marker for a sparkline host (interactive in view / present
     — the chart host is pointer-events:none in edit). fmtFn formats the value. */
  function _attachSparkTooltip(sparkHost, vals, fmtFn, color) {
    var smin = Math.min.apply(null, vals), smax = Math.max.apply(null, vals);
    var srange = (smax - smin) || 1;
    var SH = 90, sPad = 6, sTop = 10;
    var tip = document.createElement('div');
    tip.style.cssText = 'position:absolute;transform:translate(-50%,-118%);background:rgba(8,16,26,0.92);color:#fff;' +
      'padding:5px 9px;border-radius:6px;font-size:24px;font-weight:600;white-space:nowrap;pointer-events:none;' +
      'opacity:0;transition:opacity .12s;z-index:3;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
    var dot = document.createElement('div');
    dot.style.cssText = 'position:absolute;width:14px;height:14px;border-radius:50%;background:' + color + ';' +
      'box-shadow:0 0 0 3px rgba(255,255,255,0.22);transform:translate(-50%,-50%);pointer-events:none;opacity:0;transition:opacity .12s;z-index:3;';
    sparkHost.appendChild(tip);
    sparkHost.appendChild(dot);
    sparkHost.addEventListener('pointermove', function (e) {
      var r = sparkHost.getBoundingClientRect();
      if (!r.width) return;
      var frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      var idx = Math.round(frac * (vals.length - 1));
      var val = vals[idx];
      /* Position in the host's UNSCALED local box — the chart host is CSS
         transform:scale'd, so the scaled rect size would double-apply it. */
      var ow = sparkHost.offsetWidth || r.width, oh = sparkHost.offsetHeight || r.height;
      var px = (vals.length === 1) ? ow / 2 : (idx / (vals.length - 1)) * ow;
      var vy = SH - sPad - ((val - smin) / srange) * (SH - sPad - sTop);
      var py = (vy / SH) * oh;
      dot.style.left = px + 'px'; dot.style.top = py + 'px'; dot.style.opacity = '1';
      tip.style.left = px + 'px'; tip.style.top = py + 'px';
      tip.textContent = fmtFn(val);
      tip.style.opacity = '1';
    });
    sparkHost.addEventListener('pointerleave', function () { tip.style.opacity = '0'; dot.style.opacity = '0'; });
  }
  /* Reveal: wipe a sparkline host's <svg> in left→right (line + shadow area +
     dot together) via an animated clip-path. */
  function _bnRevealSpark(sparkHost) {
    sparkHost.style.opacity = '1';
    var svg = sparkHost.querySelector('svg');
    if (!svg) return;
    if (_exportingNow) {
      svg.style.transition = 'none';
      svg.style.webkitClipPath = svg.style.clipPath = 'inset(0 0 0 0)';
      return;
    }
    svg.style.webkitClipPath = svg.style.clipPath = 'inset(0 100% 0 0)';
    svg.getBoundingClientRect();                 // force reflow so the transition runs
    svg.style.transition = 'clip-path 1.05s ease, -webkit-clip-path 1.05s ease';
    svg.style.webkitClipPath = svg.style.clipPath = 'inset(0 0 0 0)';
  }
  function createBigNumber(host, spec) {
    var titleColor = spec.titleColor || 'rgba(175,216,232,0.92)';
    var valueColor = spec.valueColor || '#ffffff';
    var sparkColor = spec.sparkColor || THEME.palette[0];
    var font       = spec.font || THEME.font;

    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;justify-content:space-between;height:100%;' +
      'box-sizing:border-box;padding:24px 28px;border-radius:14px;overflow:hidden;text-align:left;font-family:' + font + ';';
    /* Card background — subtle dark gradient unless overridden. */
    wrap.style.background = spec.bg || 'linear-gradient(155deg, rgba(22,44,60,0.92) 0%, rgba(11,23,34,0.96) 100%)';
    wrap.style.border = '1px solid rgba(255,255,255,0.08)';

    var top = document.createElement('div');
    top.style.cssText = 'flex:0 0 auto;';
    if (spec.title) {
      var t = document.createElement('div');
      t.textContent = spec.title;
      t.style.cssText = 'font-size:28px;font-weight:700;letter-spacing:0.3px;color:' + titleColor + ';margin:0 0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      top.appendChild(t);
    }
    var big = document.createElement('div');
    big.style.cssText = 'font-size:78px;font-weight:800;line-height:1;color:' + valueColor + ';font-variant-numeric:tabular-nums;white-space:nowrap;';
    big.textContent = '—';
    top.appendChild(big);
    wrap.appendChild(top);

    var sparkHost = document.createElement('div');
    sparkHost.style.cssText = 'position:relative;flex:0 0 auto;width:100%;height:84px;margin-top:14px;opacity:0;transition:opacity .6s ease;';
    var sparkVals = (Array.isArray(spec.spark) && spec.spark.length >= 2) ? spec.spark : null;
    if (sparkVals) sparkHost.innerHTML = _bnSparkSvg(sparkVals, sparkColor);
    wrap.appendChild(sparkHost);

    host.appendChild(wrap);

    var target = Number(spec.value) || 0;
    var fmt = _bnFmt(spec.unit || 'num', (typeof spec.decimals === 'number') ? spec.decimals : 0);
    var raf = null;
    function countUp() {
      if (_exportingNow) { big.textContent = fmt(target); return; }
      var startT = null, dur = 1200;
      cancelAnimationFrame(raf);
      function tick(ts) {
        if (startT == null) startT = ts;
        var p = Math.min(1, (ts - startT) / dur);
        var eased = 1 - Math.pow(1 - p, 3);   // cubicOut
        big.textContent = fmt(target * eased);
        if (p < 1) raf = requestAnimationFrame(tick);
        else big.textContent = fmt(target);
      }
      raf = requestAnimationFrame(tick);
    }
    if (sparkVals) _attachSparkTooltip(sparkHost, sparkVals, fmt, sparkColor);

    var builds = [
      function () { countUp(); },
      function () { _bnRevealSpark(sparkHost); },
    ];
    return stepController(builds, {
      reset: function () { cancelAnimationFrame(raf); big.textContent = '—'; sparkHost.style.opacity = '0'; },
      resize: function () {},
      dispose: function () { cancelAnimationFrame(raf); },
    });
  }

  /* ═══ STAT LIST (Houses / Units card: title + rows of label/value/spark) ═══
     spec.rows = [{ label, value (display string), spark (numeric array), unit,
     decimals }]. Style overrides: titleColor (heading), labelColor (row
     labels), valueColor (row values), font, bg (card). Row backgrounds are the
     light cards; only the sparklines animate (wipe in). */
  function createStatList(host, spec) {
    var titleColor = spec.titleColor || '#ffffff';
    var labelColor = spec.labelColor || '#5a6b7b';
    var valueColor = spec.valueColor || '#0a1520';
    var sparkColor = spec.sparkColor || THEME.palette[0];
    var font       = spec.font || THEME.font;

    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;height:100%;box-sizing:border-box;padding:22px;' +
      'border-radius:16px;overflow:hidden;font-family:' + font + ';';
    wrap.style.background = spec.bg || 'linear-gradient(160deg, rgba(20,40,56,0.95) 0%, rgba(9,18,28,0.97) 100%)';
    wrap.style.border = '1px solid rgba(255,255,255,0.10)';

    var h = document.createElement('div');
    h.textContent = spec.title || '';
    h.style.cssText = 'flex:0 0 auto;font-size:44px;font-weight:800;letter-spacing:0.3px;color:' + titleColor + ';' +
      'margin:0 0 14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    wrap.appendChild(h);

    var list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-height:0;';
    wrap.appendChild(list);

    var sparks = [];
    var counters = [];
    (spec.rows || []).forEach(function (row) {
      var r = document.createElement('div');
      r.style.cssText = 'display:flex;align-items:center;gap:14px;flex:1 1 0;min-height:0;padding:8px 16px;border-radius:10px;' +
        'background:linear-gradient(120deg, rgba(233,245,251,0.97) 0%, rgba(206,233,244,0.93) 100%);';
      var left = document.createElement('div');
      left.style.cssText = 'flex:0 0 40%;min-width:0;';
      var lbl = document.createElement('div');
      lbl.textContent = row.label || '';
      lbl.style.cssText = 'font-size:17px;font-weight:700;color:' + labelColor + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      var val = document.createElement('div');
      val.style.cssText = 'font-size:34px;font-weight:800;color:' + valueColor + ';line-height:1.05;white-space:nowrap;font-variant-numeric:tabular-nums;';
      /* Count-up target: the numeric `num` when present, else parse it back out
         of the formatted value string (so cards inserted before `num` existed
         still animate). */
      var rTarget = (typeof row.num === 'number') ? row.num
        : (function () { var n = parseFloat(String(row.value == null ? '' : row.value).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : null; })();
      if (rTarget != null) {
        val.textContent = '—';
        counters.push({ el: val, target: rTarget, fmt: _bnFmt(row.unit, row.decimals || 0) });
      } else {
        val.textContent = (row.value != null) ? row.value : '—';
      }
      left.appendChild(lbl); left.appendChild(val);
      r.appendChild(left);
      var sh = document.createElement('div');
      sh.style.cssText = 'position:relative;flex:1 1 auto;height:100%;min-height:0;opacity:0;transition:opacity .6s ease;';
      var svals = (Array.isArray(row.spark) && row.spark.length >= 2) ? row.spark : null;
      if (svals) {
        sh.innerHTML = _bnSparkSvg(svals, sparkColor);
        _attachSparkTooltip(sh, svals, _bnFmt(row.unit, row.decimals || 0), sparkColor);
        sparks.push(sh);
      }
      r.appendChild(sh);
      list.appendChild(r);
    });
    host.appendChild(wrap);

    var raf = null;
    function countUpAll() {
      if (_exportingNow) { counters.forEach(function (c) { c.el.textContent = c.fmt(c.target); }); return; }
      var startT = null, dur = 1200;
      cancelAnimationFrame(raf);
      function tick(ts) {
        if (startT == null) startT = ts;
        var p = Math.min(1, (ts - startT) / dur);
        var eased = 1 - Math.pow(1 - p, 3);   // cubicOut
        counters.forEach(function (c) { c.el.textContent = c.fmt(c.target * eased); });
        if (p < 1) raf = requestAnimationFrame(tick);
        else counters.forEach(function (c) { c.el.textContent = c.fmt(c.target); });
      }
      raf = requestAnimationFrame(tick);
    }
    /* Two build steps, matching the big number: count the values up first,
       then wipe the sparklines in (separate presenter advance / autoplay step). */
    var builds = [
      function () { countUpAll(); },
      function () { sparks.forEach(function (sh) { _bnRevealSpark(sh); }); },
    ];
    return stepController(builds, {
      reset: function () {
        cancelAnimationFrame(raf);
        counters.forEach(function (c) { c.el.textContent = '—'; });
        sparks.forEach(function (sh) { sh.style.opacity = '0'; });
      },
      resize: function () {},
      dispose: function () { cancelAnimationFrame(raf); },
    });
  }

  /* ─── Step controller shared by every type ───
     builds = array of functions, each revealing one more piece. The host
     (slide / lab) calls next() on each presenter click; once index ===
     builds.length the chart is fully built and the deck can advance. */
  function stepController(builds, hooks) {
    var index = 0;
    var ctrl = {
      steps: builds.length,
      get index() { return index; },
      isComplete: function () { return index >= builds.length; },
      next: function () {
        if (index >= builds.length) return false;
        builds[index]();
        index += 1;
        return index < builds.length;     // true if more steps remain
      },
      prev: function () {
        if (index <= 0) return false;
        index -= 1;
        hooks.reset();
        for (var i = 0; i < index; i++) builds[i]();
        return true;
      },
      reset: function () { index = 0; hooks.reset(); },
      play: function (gap) {
        gap = gap || 1300;
        function step() { if (ctrl.next()) setTimeout(step, gap); }
        if (index >= builds.length) ctrl.reset();
        step();
      },
      resize: function () { hooks.resize(); },
      dispose: function () { hooks.dispose(); },
    };
    return ctrl;
  }

  function nullController() {
    return { steps: 0, index: 0, isComplete: function () { return true; }, next: function () { return false; },
             prev: function () { return false; }, reset: function () {}, play: function () {}, resize: function () {}, dispose: function () {} };
  }

  /* ─── Raw ECharts option (spec.echarts) ───
     Used by the Buying/Selling Library. Those slides are not report chart
     modules — the Buying/Selling tool authors a complete ECharts option per
     slide — so there is nothing to look up in the registry. We render the option
     as given, which is exactly what the B/S tool does, so a slide pulled into a
     deck matches the tool it came from pixel for pixel.

     These BUILD like every other chart in the deck. The B/S options ship
     animation:false (they are authored for a static page), so the animation is
     layered on here exactly as createFromModule does it for the report modules,
     and the data-bearing series are revealed one at a time so each one plays its
     entrance. Autoplay is the default for graphs (Van 2026-08-22), and it can
     only mean something if there are steps to play. */
  function createFromOption(host, spec) {
    if (!window.echarts) { host.textContent = 'Chart engine unavailable.'; return nullController(); }
    const box = document.createElement('div');
    box.style.cssText = 'width:100%;height:100%';
    host.appendChild(box);
    let chart;
    try { chart = window.echarts.init(box, null, { renderer: 'canvas' }); }
    catch (e) { host.textContent = 'Chart failed to render.'; return nullController(); }

    const full = spec.echarts || {};
    const allSeries = Array.isArray(full.series) ? full.series : (full.series ? [full.series] : []);
    /* Only series that carry data are worth revealing; empty ones exist to hold
       a legend entry or an axis and must stay visible from the start. */
    const staticSeries = [], revealSeries = [];
    allSeries.forEach(function (s) {
      const hasData = Array.isArray(s && s.data) && s.data.some(function (d) {
        const v = (d && typeof d === 'object' && 'value' in d) ? d.value : d;
        return v != null && !(typeof v === 'number' && isNaN(v));
      });
      (hasData ? revealSeries : staticSeries).push(s);
    });

    /* Base = the option exactly as the tool authored it, minus the series
       (added back step by step), with the build animation switched on. Same
       easing and duration as the rest of the engine so a B/S slide feels like
       the report slides beside it. */
    const base = {};
    Object.keys(full).forEach(function (k) { if (k !== 'series') base[k] = full[k]; });
    base.animation = true;
    base.animationDuration = THEME.drawMs;
    base.animationEasing = THEME.easing;
    base.animationDurationUpdate = THEME.drawMs;
    base.animationEasingUpdate = THEME.easing;
    base.animationDelay = function (i) { return i * 14; };
    base.animationDelayUpdate = function (i) { return i * 14; };

    let shown = [];
    /* replaceMerge drops the revealed series cleanly, so replaying animates
       again instead of silently keeping the built state. */
    function showStatic() {
      try {
        chart.setOption(Object.assign({}, base, { series: staticSeries.slice() }),
          { notMerge: true });
      } catch (_) {}
    }
    showStatic();

    const builds = revealSeries.map(function (s) {
      /* plain merge: series already shown keep their index and don't re-animate;
         the newly appended one plays its entrance */
      return function () {
        shown.push(s);
        try { chart.setOption({ series: staticSeries.concat(shown) }); } catch (_) {}
      };
    });
    /* An option with no data-bearing series (a pure annotation/graphic slide)
       still has to render — otherwise it would come out blank. */
    if (!builds.length) {
      try { chart.setOption(Object.assign({}, base, { series: allSeries.slice() }), { notMerge: true }); } catch (_) {}
    }
    return stepController(builds, {
      reset: function () { shown = []; showStatic(); },
      resize: function () { try { chart.resize(); } catch (_) {} },
      dispose: function () { try { chart.dispose(); } catch (_) {} },
    });
  }

  /* ─── Public factory ─── */
  function create(container, spec) {
    if (!container || !spec) return nullController();
    clearEl(container);
    container.style.position = container.style.position || 'relative';
    /* Primary path: render the EXACT online-report chart module + animate.
       (Recipes that still carry a billboard `type` fall through below; the
       At-a-Glance big numbers use type:'bigNumber'.) */
    if (spec.module) return createFromModule(container, spec);
    if (spec.echarts) return createFromOption(container, spec);
    switch (spec.type) {
      case 'line':
      case 'multiLine': return createLine(container, spec);
      case 'bars':      return createBars(container, spec);
      case 'dualBarLine': return createDualBarLine(container, spec);
      case 'pyramid':   return createPyramid(container, spec);
      case 'bigNumber': return createBigNumber(container, spec);
      case 'statList':  return createStatList(container, spec);
      default:
        container.textContent = 'Unsupported chart type: ' + spec.type;
        return nullController();
    }
  }

  /* ─── Export mode ───
     A PDF has no animation, so waiting out every chart's build is pure delay:
     it was 1.5s per chart page, about two thirds of a deck export's entire
     running time (measured over 35 pages, Van 2026-08-22). With export mode on,
     charts render at their FINAL state immediately and the exporter can shoot
     the page as soon as it is laid out.

     Done by wrapping echarts.init rather than editing each builder: every
     chart type in this file goes through it, including the report modules,
     which author their own options and would each need the same edit. The
     wrapper forces animation off on every setOption and is removed again when
     export finishes, so normal viewing keeps its build animation. */
  let _initWas = null;
  function setExporting(on) {
    _exportingNow = !!on;
    if (on && window.echarts && !_initWas) {
      _initWas = window.echarts.init;
      window.echarts.init = function () {
        const inst = _initWas.apply(this, arguments);
        const so = inst.setOption.bind(inst);
        inst.setOption = function (opt, o2) {
          if (opt && typeof opt === 'object' && !Array.isArray(opt)) {
            opt = Object.assign({}, opt, { animation: false });
          }
          return so(opt, o2);
        };
        return inst;
      };
    } else if (!on && _initWas) {
      window.echarts.init = _initWas;
      _initWas = null;
    }
  }

  window.PresentChart = { create: create, THEME: THEME, _fmt: fmt, setExporting: setExporting };
})();
