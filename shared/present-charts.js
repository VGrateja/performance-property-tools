/* ════════════════════════════════════════════════════════════════════
   shared/present-charts.js — presentation chart engine (window.PresentChart)
   ────────────────────────────────────────────────────────────────────
   Puts a report graph on a slide and BUILDS it step-by-step as the presenter
   clicks (Google Slides can't animate graphs — this is the differentiator).

   PRIMARY PATH — createFromModule (spec.module): render the EXACT online-
   report chart module (assets/Reports/charts/chart-*.js) so the slide graph
   is pixel-identical to the report (colours, staircase axis, legend icons,
   crisis lines + period bands, axis names — and no title, so it's just the
   graph), then layer the click-to-build reveal on top. This is what the
   recipes in presentation.html produce.

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
        if (def && def.type && def.type !== 'value') return {};
        try {
          var ext = chart.getModel().getComponent(k, i).axis.scale.getExtent();
          if (ext && isFinite(ext[0]) && isFinite(ext[1])) return { min: ext[0], max: ext[1] };
        } catch (_) {}
        return {};
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

    var shown = [];
    /* Pre-build state: only the always-on series (replaceMerge drops the
       data series cleanly so re-revealing animates again). */
    function showStatic() { chart.setOption({ series: staticSeries.slice() }, { replaceMerge: ['series'] }); }
    showStatic();

    var builds = revealSeries.map(function (s) {
      /* Default merge (no replaceMerge): the previously-shown series keep
         their index and DON'T re-animate; the newly appended one enters. */
      return function () { shown.push(s); chart.setOption({ series: staticSeries.concat(shown) }); };
    });
    return stepController(builds, {
      reset: function () { shown.length = 0; showStatic(); },
      resize: function () { try { chart.resize(); } catch (_) {} },
      dispose: function () { try { chart.dispose(); } catch (_) {} },
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

  /* ═══ BIG NUMBER (pure DOM, count-up) ═══ */
  function createBigNumber(host, spec) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;font-family:' + THEME.font + ';text-align:center;padding:24px;';
    if (spec.title) {
      var t = document.createElement('div');
      t.textContent = spec.title;
      t.style.cssText = 'font-size:22px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:' + THEME.inkDim + ';';
      wrap.appendChild(t);
    }
    var big = document.createElement('div');
    big.style.cssText = 'font-size:120px;font-weight:800;line-height:1.05;color:' + THEME.palette[0] + ';margin:10px 0;font-variant-numeric:tabular-nums;';
    big.textContent = '—';
    wrap.appendChild(big);
    var cap = document.createElement('div');
    cap.textContent = spec.subtitle || '';
    cap.style.cssText = 'font-size:20px;font-weight:600;color:' + THEME.ink + ';opacity:0;transition:opacity .6s ease;';
    wrap.appendChild(cap);
    host.appendChild(wrap);

    var target = Number(spec.value) || 0;
    var unit = spec.unit || 'num';
    var raf = null;

    /* Format the counting value in the TARGET's FIXED scale, so it never
       jumps units mid-count (e.g. $k → $M). With tabular-nums on the
       element, the digits change without the number jittering. */
    function fixedFmt(t, u) {
      var a = Math.abs(t);
      if (u === 'pct') return function (v) { return v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%'; };
      if (u === 'aud') {
        if (a >= 1e6) return function (v) { return '$' + (v / 1e6).toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + 'M'; };
        if (a >= 1e3) return function (v) { return '$' + Math.round(v / 1e3).toLocaleString('en-AU') + 'k'; };
        return function (v) { return '$' + Math.round(v).toLocaleString('en-AU'); };
      }
      if (a >= 1e6) return function (v) { return (v / 1e6).toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + 'M'; };
      if (a >= 1e3) return function (v) { return Math.round(v / 1e3).toLocaleString('en-AU') + 'k'; };
      return function (v) { return Math.round(v).toLocaleString('en-AU'); };
    }
    var countFmt = fixedFmt(target, unit);
    function countUp() {
      var startT = null, dur = 1200;
      cancelAnimationFrame(raf);
      function tick(ts) {
        if (startT == null) startT = ts;
        var p = Math.min(1, (ts - startT) / dur);
        var eased = 1 - Math.pow(1 - p, 3);   // cubicOut
        big.textContent = countFmt(target * eased);
        if (p < 1) raf = requestAnimationFrame(tick);
        else big.textContent = countFmt(target);
      }
      raf = requestAnimationFrame(tick);
    }

    var builds = [
      function () { countUp(); },
      function () { cap.style.opacity = '1'; },
    ];
    return stepController(builds, {
      reset: function () { cancelAnimationFrame(raf); big.textContent = '—'; cap.style.opacity = '0'; },
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

  /* ─── Public factory ─── */
  function create(container, spec) {
    if (!container || !spec) return nullController();
    clearEl(container);
    container.style.position = container.style.position || 'relative';
    /* Primary path: render the EXACT online-report chart module + animate.
       (Recipes that still carry a billboard `type` fall through below; the
       At-a-Glance big numbers use type:'bigNumber'.) */
    if (spec.module) return createFromModule(container, spec);
    switch (spec.type) {
      case 'line':
      case 'multiLine': return createLine(container, spec);
      case 'bars':      return createBars(container, spec);
      case 'dualBarLine': return createDualBarLine(container, spec);
      case 'pyramid':   return createPyramid(container, spec);
      case 'bigNumber': return createBigNumber(container, spec);
      default:
        container.textContent = 'Unsupported chart type: ' + spec.type;
        return nullController();
    }
  }

  window.PresentChart = { create: create, THEME: THEME, _fmt: fmt };
})();
