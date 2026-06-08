/* ════════════════════════════════════════════════════════════════════
   shared/present-charts.js — "billboard" presentation chart engine
   (window.PresentChart)
   ────────────────────────────────────────────────────────────────────
   Renders a single report chart onto a slide as a BIG, bold, animated
   "billboard" (vs the dense "spreadsheet" look of the reports). The whole
   point of Phase 3: the graph itself lives on the slide, redesigned for a
   live audience, and it BUILDS step-by-step as the presenter clicks
   (Google Slides can't animate graphs — this is the differentiator).

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

    var baseOption = {
      backgroundColor: 'transparent',
      textStyle: { fontFamily: THEME.font, color: THEME.ink },
      /* Legend on TOP (matches the reports' convention + never clips at the
         bottom). Extra top margin leaves room for the legend AND the
         latest-value callout that pops above the lead line. */
      grid: { left: 64, right: 48, top: 50, bottom: 36, containLabel: true },
      legend: series.length > 1
        ? { top: 8, left: 'center', itemGap: 26, textStyle: { color: THEME.ink, fontSize: THEME.axisSize, fontWeight: 600 }, icon: 'roundRect' }
        : undefined,
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(15,23,42,0.94)', borderColor: 'rgba(255,255,255,0.12)', textStyle: { color: '#fff', fontSize: 15 } },
      xAxis: {
        type: 'category', data: cats, boundaryGap: false,
        axisLine: { lineStyle: { color: THEME.grid } },
        axisTick: { show: false },
        axisLabel: { color: THEME.inkDim, fontSize: THEME.axisSize, hideOverlap: true },
      },
      yAxis: {
        type: 'value', scale: true,
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: THEME.grid } },
        axisLabel: {
          color: THEME.inkDim, fontSize: THEME.axisSize,
          formatter: function (v) { return fmt(v, unit); },
        },
      },
      animationDuration: THEME.drawMs,
      animationEasing: THEME.easing,
      series: series.map(function (s) {
        return { name: s.name, type: s.type, smooth: s.smooth, showSymbol: s.showSymbol,
                 symbolSize: s.symbolSize, lineStyle: s.lineStyle, itemStyle: s.itemStyle,
                 emphasis: s.emphasis, data: [] };
      }),
    };
    chart.setOption(baseOption);

    /* Build steps: one per series (draw it in), then a callout pop. */
    var builds = [];
    series.forEach(function (s, i) {
      builds.push(function () {
        baseOption.series[i].data = s._values;
        chart.setOption(baseOption);
      });
    });
    builds.push(function () {
      // Pop the latest value on the lead (first) series as a callout.
      var lead = series[0];
      var lv = lastNum(lead._values);
      if (lv == null) return;
      baseOption.series[0].markPoint = {
        symbol: 'circle', symbolSize: 14,
        itemStyle: { color: THEME.palette[0], borderColor: '#fff', borderWidth: 2 },
        label: {
          show: true, position: 'top', distance: 12,
          formatter: fmt(lv, unit), color: '#fff', fontSize: THEME.valueSize, fontWeight: 800,
          backgroundColor: 'rgba(10,21,32,0.88)', padding: [5, 9], borderRadius: 7,
        },
        data: [{ type: 'max' }],
        animationDuration: 500,
      };
      chart.setOption(baseOption);
    });

    return stepController(builds, {
      reset: function () {
        series.forEach(function (s, i) { baseOption.series[i].data = []; baseOption.series[i].markPoint = undefined; });
        chart.setOption(baseOption, { replaceMerge: ['series'] });
        chart.setOption(baseOption);
      },
      resize: function () { chart.resize(); },
      dispose: function () { chart.dispose(); },
    });
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

    var option = {
      backgroundColor: 'transparent',
      textStyle: { fontFamily: THEME.font, color: THEME.ink },
      grid: { left: 24, right: 36, top: multi ? 50 : 44, bottom: 36, containLabel: true },
      legend: multi ? { top: 8, left: 'center', itemGap: 24, data: defs.map(function (d) { return d.name; }), textStyle: { color: THEME.ink, fontSize: THEME.axisSize, fontWeight: 600 }, icon: 'roundRect' } : undefined,
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(15,23,42,0.94)', textStyle: { color: '#fff', fontSize: 15 } },
      xAxis: { type: 'category', data: cats, axisLine: { lineStyle: { color: THEME.grid } }, axisTick: { show: false }, axisLabel: { color: THEME.ink, fontSize: THEME.axisSize, fontWeight: 600 } },
      yAxis: { type: 'value', scale: true, axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: THEME.grid } }, axisLabel: { color: THEME.inkDim, fontSize: THEME.axisSize, formatter: function (v) { return fmt(v, unit); } } },
      animationDuration: THEME.drawMs, animationEasing: THEME.easing,
      series: defs.map(function (d, i) {
        return {
          name: d.name, type: 'bar', data: [],
          barWidth: multi ? undefined : '52%',
          itemStyle: { color: THEME.palette[i % THEME.palette.length], borderRadius: [6, 6, 0, 0] },
          /* Per-bar value labels only for single-series (grouped would crowd). */
          label: multi ? { show: false } : { show: true, position: 'top', color: THEME.ink, fontSize: THEME.valueSize, fontWeight: 800, formatter: function (p) { return fmt(p.value, unit); } },
        };
      }),
    };
    chart.setOption(option);

    var builds;
    if (multi) {
      /* Reveal one series (grow its bars) per step. */
      builds = defs.map(function (d, i) { return function () { option.series[i].data = d.values; chart.setOption(option); }; });
    } else {
      builds = [
        function () { option.series[0].data = defs[0].values.slice(); chart.setOption(option); },
        function () {
          option.series[0].data = defs[0].values.map(function (v, i) {
            return { value: v, itemStyle: { color: i === maxIdx ? THEME.palette[1] : THEME.palette[0], borderRadius: [6, 6, 0, 0] } };
          });
          chart.setOption(option);
        },
      ];
    }
    return stepController(builds, {
      reset: function () { option.series.forEach(function (s) { s.data = []; }); chart.setOption(option); },
      resize: function () { chart.resize(); },
      dispose: function () { chart.dispose(); },
    });
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

    var option = {
      backgroundColor: 'transparent',
      textStyle: { fontFamily: THEME.font, color: THEME.ink },
      grid: { left: 60, right: 60, top: 50, bottom: 36, containLabel: true },
      legend: { top: 8, left: 'center', itemGap: 22,
        data: bars.map(function (b) { return b.name; }).concat(lineDef ? [lineDef.name] : []),
        textStyle: { color: THEME.ink, fontSize: THEME.axisSize, fontWeight: 600 }, icon: 'roundRect' },
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(15,23,42,0.94)', borderColor: 'rgba(255,255,255,0.12)', textStyle: { color: '#fff', fontSize: 15 } },
      xAxis: { type: 'category', data: cats, axisLine: { lineStyle: { color: THEME.grid } }, axisTick: { show: false }, axisLabel: { color: THEME.inkDim, fontSize: THEME.axisSize, hideOverlap: true } },
      yAxis: [
        { type: 'value', scale: true, axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: THEME.grid } }, axisLabel: { color: THEME.inkDim, fontSize: THEME.axisSize, formatter: function (v) { return fmt(v, barUnit); } } },
        { type: 'value', scale: true, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { color: THEME.inkDim, fontSize: THEME.axisSize, formatter: function (v) { return fmt(v, lineUnit); } } },
      ],
      animationDuration: THEME.drawMs, animationEasing: THEME.easing,
      series: bars.map(function (b, i) {
        return { name: b.name, type: 'bar', yAxisIndex: 0, data: [], itemStyle: { color: THEME.palette[i % THEME.palette.length], borderRadius: [4, 4, 0, 0] } };
      }).concat(lineDef ? [{
        name: lineDef.name, type: 'line', yAxisIndex: 1, smooth: 0.18, showSymbol: false,
        data: [], lineStyle: { width: THEME.lineWidth, color: lineColor }, itemStyle: { color: lineColor },
      }] : []),
    };
    chart.setOption(option);

    var builds = [];
    bars.forEach(function (b, i) { builds.push(function () { option.series[i].data = b.values; chart.setOption(option); }); });
    if (lineDef) builds.push(function () { option.series[bars.length].data = lineDef.values; chart.setOption(option); });

    return stepController(builds, {
      reset: function () { option.series.forEach(function (s) { s.data = []; }); chart.setOption(option); },
      resize: function () { chart.resize(); },
      dispose: function () { chart.dispose(); },
    });
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
    big.style.cssText = 'font-size:120px;font-weight:800;line-height:1.05;color:' + THEME.palette[0] + ';margin:10px 0;';
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

    function countUp() {
      var startT = null, dur = 1100;
      cancelAnimationFrame(raf);
      function tick(ts) {
        if (startT == null) startT = ts;
        var p = Math.min(1, (ts - startT) / dur);
        var eased = 1 - Math.pow(1 - p, 3);   // cubicOut
        big.textContent = fmt(target * eased, unit);
        if (p < 1) raf = requestAnimationFrame(tick);
        else big.textContent = fmt(target, unit);
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
    switch (spec.type) {
      case 'line':
      case 'multiLine': return createLine(container, spec);
      case 'bars':      return createBars(container, spec);
      case 'dualBarLine': return createDualBarLine(container, spec);
      case 'bigNumber': return createBigNumber(container, spec);
      default:
        container.textContent = 'Unsupported chart type: ' + spec.type;
        return nullController();
    }
  }

  window.PresentChart = { create: create, THEME: THEME, _fmt: fmt };
})();
