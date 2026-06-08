/* ─────────────────────────────────────────────────────────────────────
   National Research Report — chart modules (window.PpaCharts registry)
   ---------------------------------------------------------------------
   The National report (tools/national-report.html) historically built its
   charts INLINE (_baseChartOption + _mountChart + per-page _renderPN_*).
   This file lifts each page's chart into the SAME PpaCharts.register(...)
   contract the regional modules use, so BOTH the report and the presentation
   tool render from one definition — and the presentation's createFromModule()
   animates the build for free.

   Each module is registered as `national-p<N>` and reads the FLAT national
   feed columns (presentation passes the cached snapshot's `snap.data`; the
   report passes its mapped `payload.data`). Theme + the shared chart defaults
   (line markers, staircase year axis, rotated axis names, dark tooltip)
   mirror national-report.html's _baseChartOption + _mountChart exactly. The
   report-only bits of _mountChart (canvas/undo DOM handling, user-saved
   Growth/Correction bands) intentionally stay in the report.

   Loads AFTER _helpers.js (needs PpaCharts.register). ECharts required.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  if (!NS) { window.PpaCharts = window.PpaCharts || {}; NS = window.PpaCharts; }

  var FONT = 'Ubuntu, "Roboto", sans-serif';
  /* Palette — matches national-report.html CHART_COLORS exactly. */
  var COLORS = ['#000000', '#f5a623', '#5cc8e0', '#9aa3b1', '#c2a4d6', '#e58fa8', '#3ecf8e', '#86a8ff'];
  /* Recession markers (same set the report overlays via RECESSION_EVENTS). */
  var RECESSIONS = [
    { year: 1982, label: 'Severe Recession' }, { year: 1991, label: 'Major Recession' },
    { year: 2001, label: 'Dot Com Crash' }, { year: 2008, label: 'GFC' }, { year: 2020, label: 'Covid-19' },
  ];

  function baseOption() {
    return {
      backgroundColor: 'transparent',
      color: COLORS.slice(),
      textStyle: { fontFamily: FONT, color: '#1a2236' },
      grid: { left: 60, right: 60, top: 50, bottom: 70, containLabel: false },
      legend: {
        top: 4, left: 60, orient: 'horizontal', itemGap: 28, itemWidth: 22, itemHeight: 12,
        textStyle: { color: '#1a2236', fontSize: 12, fontWeight: 600 },
      },
      tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
      xAxis: { type: 'category', axisLine: { lineStyle: { color: '#1a2236' } }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11 }, splitLine: { show: false } },
      yAxis: { type: 'value', axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11 }, splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
    };
  }

  function recessionMarkLines(yearList) {
    if (!Array.isArray(yearList) || !yearList.length) return [];
    return RECESSIONS.filter(function (e) {
      return yearList.indexOf(String(e.year)) >= 0 || yearList.indexOf(e.year) >= 0;
    }).map(function (e) {
      return {
        xAxis: String(e.year),
        lineStyle: { color: '#d94242', type: 'dashed', width: 1.5 },
        label: { show: true, position: 'end', rotate: 0, distance: 4, formatter: e.label,
          backgroundColor: '#e57b7b', color: '#fff', padding: [3, 7, 3, 7], borderRadius: 3,
          fontSize: 10, fontWeight: 700, fontFamily: FONT, align: 'left', verticalAlign: 'top' },
      };
    });
  }

  /* The pure (DOM-free, band-free) half of national-report.html's _mountChart:
     line-marker defaults, staircase year axis, rotated y-axis names, and the
     dark axis tooltip that reuses each series' axis formatter. */
  function applyDefaults(option) {
    if (Array.isArray(option.series)) {
      option.series.forEach(function (s) {
        if (s && s.type === 'line') {
          if (s.symbol === undefined) s.symbol = 'circle';
          if (s.symbolSize === undefined) s.symbolSize = 8;
          if (s.showSymbol === undefined) s.showSymbol = false;
        }
      });
    }
    var xAxes = Array.isArray(option.xAxis) ? option.xAxis : (option.xAxis ? [option.xAxis] : []);
    xAxes.forEach(function (ax) {
      if (!ax || ax.type !== 'category') return;
      var al = ax.axisLabel = Object.assign({}, ax.axisLabel || {});
      if (typeof al.formatter !== 'function') {
        al.interval = 0; al.rotate = 0; al.lineHeight = 14;
        al.formatter = function (v, i) { return (i % 2 === 0) ? String(v) : '\n' + String(v); };
      }
    });
    var yAxes = Array.isArray(option.yAxis) ? option.yAxis : (option.yAxis ? [option.yAxis] : []);
    yAxes.forEach(function (ax, i) {
      if (!ax || !ax.name || ax.nameLocation) return;
      ax.nameLocation = 'middle'; ax.nameRotate = 90;
      if (ax.nameGap == null) ax.nameGap = (i === 0 ? 50 : 40);
      ax.nameTextStyle = { fontFamily: FONT, fontStyle: 'italic', fontSize: 10, color: '#2f3d4a', fontWeight: 500 };
    });
    if (option.tooltip && option.tooltip.trigger === 'axis' && typeof option.tooltip.formatter !== 'function') {
      var xa = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
      var horizontal = !!(xa && xa.type === 'value');
      var valFmt = function (p) {
        var f;
        if (horizontal) { f = xa.axisLabel && xa.axisLabel.formatter; }
        else {
          var s = (option.series || [])[p.seriesIndex];
          var yi = (s && s.yAxisIndex) || 0;
          var ax = yAxes[yi] || yAxes[0];
          f = ax && ax.axisLabel && ax.axisLabel.formatter;
        }
        var v = p.value;
        if (typeof f === 'function') { try { return f(v); } catch (_) {} }
        return (v == null || isNaN(Number(v))) ? '—' : Number(v).toLocaleString('en-AU');
      };
      Object.assign(option.tooltip, {
        backgroundColor: 'rgba(15,25,34,0.95)', borderColor: '#2a3a48',
        textStyle: { color: '#fff', fontFamily: FONT, fontSize: 12 },
        formatter: function (params) {
          var arr = Array.isArray(params) ? params : [params];
          var head = arr.length ? arr[0].axisValue : '';
          var lines = arr.map(function (p) {
            return '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + p.color + ';margin-right:6px"></span>' +
              p.seriesName + ': <strong>' + valFmt(p) + '</strong>';
          });
          return '<div style="font-weight:700;margin-bottom:4px">' + head + '</div>' + lines.join('<br/>');
        },
      });
    }
    return option;
  }

  /* Register a national chart: build(data) → ECharts option (pre-defaults).
     We apply the shared defaults, then init + setOption (animation off; the
     presentation engine turns it on for the click-to-build reveal). */
  function reg(name, build) {
    NS.register(name, function (el, data) {
      var opt = build(data || {});
      if (!opt) { return echarts.init(el); }   // nothing to draw
      applyDefaults(opt);
      var chart = echarts.init(el, null, { renderer: 'canvas' });
      chart.setOption(opt);
      return chart;
    });
  }

  /* index of the first year >= minYear (so a chart can start later than the
     1975 feed start); the renderer slices years + every series in lockstep. */
  function fromYear(years, minYear) {
    var i = years.findIndex(function (y) { return Number(y) >= minYear; });
    return i < 0 ? 0 : i;
  }
  var moneyAxis = function (v) { return v >= 1e6 ? (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'm' : v >= 1e3 ? (v / 1e3) + 'k' : v; };

  /* ── p2 — Median Price (Cap City vs Regional, from 1980) ── */
  reg('national-p2', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length || !d.capCityMedianPrice) return null;
    var f = fromYear(years, 1980), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var o = baseOption();
    o.grid = { left: 60, right: 25, top: 30, bottom: 55, containLabel: false };
    o.legend = Object.assign(o.legend, { data: ['Cap City Median Price', 'Regional Median Price'] });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = Object.assign(o.yAxis, { axisLabel: { color: '#1a2236', fontSize: 11, formatter: moneyAxis } });
    o.series = [
      { name: 'Cap City Median Price', type: 'line', data: sl(d.capCityMedianPrice), smooth: false, showSymbol: false, lineStyle: { width: 2 },
        markLine: { silent: true, symbol: 'none', data: recessionMarkLines(yrs) } },
      { name: 'Regional Median Price', type: 'line', data: sl(d.regionalMedianPrice || []), smooth: false, showSymbol: false, lineStyle: { width: 2 } },
    ];
    return o;
  });

  /* ── p3 — Median House Price, 5 capitals (from 1980) ── */
  reg('national-p3', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length) return null;
    var f = fromYear(years, 1980), yrs = years.slice(f);
    var series = [
      ['Sydney', d.nswMedianHousePrice], ['Perth', d.waMedianHousePrice], ['Melbourne', d.vicMedianHousePrice],
      ['Brisbane', d.qldMedianHousePrice], ['Adelaide', d.saMedianHousePrice],
    ].filter(function (s) { return Array.isArray(s[1]) && s[1].length; });
    if (!series.length) return null;
    var o = baseOption();
    o.grid = { left: 60, right: 25, top: 30, bottom: 55, containLabel: false };
    o.legend = Object.assign(o.legend, { data: series.map(function (s) { return s[0]; }) });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = Object.assign(o.yAxis, { axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + 'm' : v >= 1e3 ? (v / 1e3) + 'k' : v; } } });
    o.series = series.map(function (s, i) {
      return { name: s[0], type: 'line', data: s[1].slice(f), showSymbol: false, lineStyle: { width: 2 },
        markLine: i === 0 ? { silent: true, symbol: 'none', data: recessionMarkLines(yrs) } : undefined };
    });
    return o;
  });

  /* ── p4 — Median House Price, smaller capitals + key regions (from 1980) ── */
  reg('national-p4', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length) return null;
    var series = [
      ['Darwin', d.ntMedianHousePrice], ['Canberra', d.actMedianHousePrice], ['Hobart', d.tasMedianHousePrice],
      ['Sunshine Coast', d.sunshineCoastMedianHousePrice], ['Gold Coast', d.goldCoastMedianHousePrice],
      ['Central Coast', d.centralCoastMedianHousePrice], ['Geelong', d.geelongMedianHousePrice],
    ].filter(function (s) { return Array.isArray(s[1]) && s[1].length; });
    if (!series.length) return null;
    var f = fromYear(years, 1980), yrs = years.slice(f);
    var o = baseOption();
    o.grid = { left: 60, right: 25, top: 30, bottom: 55, containLabel: false };
    o.legend = Object.assign(o.legend, { data: series.map(function (s) { return s[0]; }) });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = Object.assign(o.yAxis, { axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + 'm' : v >= 1e3 ? (v / 1e3) + 'k' : v; } } });
    o.series = series.map(function (s, i) {
      return { name: s[0], type: 'line', data: s[1].slice(f), showSymbol: false, lineStyle: { width: 2 },
        markLine: i === 0 ? { silent: true, symbol: 'none', data: recessionMarkLines(yrs) } : undefined };
    });
    return o;
  });

  /* Expose the builders so the report can (later) render from this one
     source of truth instead of its inline copies. */
  NS.national = NS.national || {};
  Object.assign(NS.national, { baseOption: baseOption, applyDefaults: applyDefaults, recessionMarkLines: recessionMarkLines, COLORS: COLORS });
})(window.PpaCharts);
