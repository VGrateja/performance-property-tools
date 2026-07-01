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

  /* Per-page option BUILDERS keyed by page id ('p2'..). Populated by reg().
     Both the slide engine (via createFromModule → the registry) and the
     national report (via _mountChart) render from these — one source. */
  NS.national = NS.national || {};
  NS.national.builders = NS.national.builders || {};

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
  function applyDefaults(option, opts) {
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
    /* Slide-fill (opt-in via opts.slideFill — the slide engine passes it; the
       report does NOT, so the report's look is unchanged): a SINGLE value-axis
       chart doesn't need the wide right margin the dual-axis default (right:60)
       reserves for a 2nd axis — pull it in so the plot fills the slide. Skipped
       for dual-axis (yAxis array), right-anchored callouts (graphic), or any
       markLine (whose end-labels can sit in the right margin), so nothing clips. */
    var _hasML = (option.series || []).some(function (s) { return s && s.markLine; });
    if (opts && opts.slideFill && option.grid && !Array.isArray(option.yAxis) && !option.graphic && !_hasML &&
        typeof option.grid.right === 'number' && option.grid.right >= 50) {
      option.grid = Object.assign({}, option.grid, { right: 34 });
    }
    return option;
  }

  /* Register a national chart: build(data) → ECharts option (pre-defaults).
     We apply the shared defaults, then init + setOption (animation off; the
     presentation engine turns it on for the click-to-build reveal). */
  function reg(name, build) {
    /* Expose the raw builder (the report renders from these too — one source). */
    NS.national.builders[name.replace(/^national-/, '')] = build;
    NS.register(name, function (el, data) {
      var opt = build(data || {});
      if (!opt) { return echarts.init(el); }   // nothing to draw
      applyDefaults(opt, { slideFill: true });   // slide path → fill the box
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

  /* ── p5 — Rental Vacancy Rate by region (Nov 2023 vs Nov 2024 bars) ── */
  reg('national-p5', function (d) {
    var labels = d.vacancyRate, prior = d.vacancyRateNov2023, curr = d.vacancyRateNov2024;
    if (!Array.isArray(labels) || !labels.length || !prior || !curr) return null;
    var priorLabel = d.vacancyRatePriorLabel || 'Nov 2023', currLabel = d.vacancyRateCurrLabel || 'Nov 2024';
    var o = baseOption();
    o.tooltip = {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      backgroundColor: 'rgba(15,25,34,0.95)', borderColor: '#2a3a48',
      textStyle: { color: '#fff', fontFamily: FONT, fontSize: 12 },
      formatter: function (params) {
        var head = (params && params[0]) ? params[0].axisValue : '';
        var lines = (params || []).map(function (p) {
          var v = Number(p.value); var fmt = isNaN(v) ? '—' : (v * 100).toFixed(1) + '%';
          return '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + p.color + ';margin-right:6px"></span>' + p.seriesName + ': <strong>' + fmt + '</strong>';
        });
        return '<div style="font-weight:700;margin-bottom:4px">' + head + '</div>' + lines.join('<br/>');
      },
    };
    o.legend = Object.assign(o.legend, { data: [priorLabel, currLabel] });
    o.xAxis = Object.assign(o.xAxis, { data: labels,
      axisLabel: { color: '#1a2236', fontSize: 11, interval: 0, rotate: 0, formatter: function (v) { return v; } } });
    o.yAxis = Object.assign(o.yAxis, { axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(1) + '%'; } } });
    o.series = [
      { name: priorLabel, type: 'bar', data: prior, itemStyle: { color: COLORS[3] }, barGap: '12%' },
      { name: currLabel, type: 'bar', data: curr, itemStyle: { color: COLORS[2] }, barGap: '12%',
        markLine: { silent: true, symbol: 'none', data: [
          { yAxis: 0.025, lineStyle: { color: '#3ecf8e', type: 'dashed' }, label: { formatter: 'Balanced 2.5%', color: '#3ecf8e', position: 'end' } },
          { yAxis: 0.030, lineStyle: { color: '#3ecf8e', type: 'dashed' }, label: { formatter: 'Balanced 3%', color: '#3ecf8e', position: 'end' } },
        ] } },
    ];
    return o;
  });

  /* ── p6 — Dwelling Approvals (House/Units/Total + Pop Change %, from 1990) ── */
  reg('national-p6', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length) return null;
    if (!d.buildingApprovalsHouse && !d.buildingApprovalUnits && !d.buildingApprovalsTotal) return null;
    var f = fromYear(years, 1990), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var o = baseOption();
    o.tooltip = {
      trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
      backgroundColor: 'rgba(15,25,34,0.95)', borderColor: '#2a3a48',
      textStyle: { color: '#fff', fontFamily: FONT, fontSize: 12 },
      formatter: function (params) {
        var head = (params && params[0]) ? params[0].axisValue : '';
        var lines = (params || []).map(function (p) {
          var v = Number(p.value), fmt;
          if (isNaN(v)) fmt = '—';
          else if (p.seriesName === 'National Population Change %') fmt = (v * 100).toFixed(1) + '%';
          else fmt = Math.round(v).toLocaleString('en-AU');
          return '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + p.color + ';margin-right:6px"></span>' + p.seriesName + ': <strong>' + fmt + '</strong>';
        });
        return '<div style="font-weight:700;margin-bottom:4px">' + head + '</div>' + lines.join('<br/>');
      },
    };
    o.legend = Object.assign(o.legend, { data: ['House', 'Units', 'Total', 'National Population Change %'] });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = [
      { type: 'value', name: 'House / Units / Total', nameLocation: 'middle', nameGap: 50, nameRotate: 90, nameTextStyle: { fontFamily: FONT, fontStyle: 'italic', fontSize: 10, color: '#2f3d4a', fontWeight: 500 }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e3 ? (v / 1e3) + 'k' : v; } }, splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
      { type: 'value', name: 'Pop Change %', nameLocation: 'middle', nameGap: 40, nameRotate: 90, nameTextStyle: { fontFamily: FONT, fontStyle: 'italic', fontSize: 10, color: '#2f3d4a', fontWeight: 500 }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(1) + '%'; } }, splitLine: { show: false } },
    ];
    o.series = [
      { name: 'House', type: 'line', yAxisIndex: 0, data: sl(d.buildingApprovalsHouse || []), showSymbol: false, lineStyle: { width: 2, color: '#000' } },
      { name: 'Units', type: 'line', yAxisIndex: 0, data: sl(d.buildingApprovalUnits || []), showSymbol: false, lineStyle: { width: 2, color: '#f5a623' } },
      { name: 'Total', type: 'line', yAxisIndex: 0, data: sl(d.buildingApprovalsTotal || []), showSymbol: false, lineStyle: { width: 2, color: '#5cc8e0' } },
      { name: 'National Population Change %', type: 'line', yAxisIndex: 1, data: sl(d.changeNational || []), showSymbol: false, lineStyle: { width: 2, color: '#c2a4d6' } },
    ];
    return o;
  });

  /* ── p7 — Dwelling Commencements (House/Other/Total, from 1990) ── */
  reg('national-p7', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length) return null;
    if (!d.dwellingCommencedH && !d.dwellingCommencedOther && !d.dwellingCommencedTotal) return null;
    var f = fromYear(years, 1990), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['House', 'Other', 'Total'] });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = Object.assign(o.yAxis, {
      name: 'House / Other / Total', nameTextStyle: { color: '#1a2236' },
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e3 ? (v / 1e3) + 'k' : v; } },
    });
    o.series = [
      { name: 'House', type: 'line', data: sl(d.dwellingCommencedH || []), showSymbol: false, lineStyle: { width: 2, color: '#000' } },
      { name: 'Other', type: 'line', data: sl(d.dwellingCommencedOther || []), showSymbol: false, lineStyle: { width: 2, color: '#f5a623' } },
      { name: 'Total', type: 'line', data: sl(d.dwellingCommencedTotal || []), showSymbol: false, lineStyle: { width: 2, color: '#5cc8e0' } },
    ];
    return o;
  });

  /* ── p8 — Population Growth (count + % change dual-axis, LTA ref line, from 1983) ── */
  reg('national-p8', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length || !d.populationNational) return null;
    var f = fromYear(years, 1983), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var pctVals = sl(d.changeNational || []).filter(function (v) { return v != null && !isNaN(Number(v)); });
    var lta = pctVals.length ? pctVals.reduce(function (s, v) { return s + Number(v); }, 0) / pctVals.length : null;
    var o = baseOption();
    o.tooltip = {
      trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
      backgroundColor: 'rgba(15,25,34,0.95)', borderColor: '#2a3a48',
      textStyle: { color: '#fff', fontFamily: FONT, fontSize: 12 },
      formatter: function (params) {
        var arr = Array.isArray(params) ? params : [params];
        var head = arr.length ? arr[0].axisValue : '';
        var lines = arr.filter(function (p) { return p.seriesName !== 'Long-Term Average'; }).map(function (p) {
          var v = Number(p.value);
          var fmt = (p.seriesName === '% Change of Population')
            ? (isNaN(v) ? '—' : (v * 100).toFixed(1) + '%')
            : (isNaN(v) ? '—' : (v / 1e6).toFixed(2) + 'm');
          return '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + p.color + ';margin-right:6px"></span>' + p.seriesName + ': <strong>' + fmt + '</strong>';
        });
        if (lta != null) {
          lines.push('<span style="display:inline-block;width:10px;border-top:2px dashed #9aa7b2;margin-right:6px;vertical-align:middle"></span>Long-Term Average: <strong>' + (lta * 100).toFixed(2) + '%</strong>');
        }
        return '<div style="font-weight:700;margin-bottom:4px">' + head + '</div>' + lines.join('<br/>');
      },
    };
    o.legend = Object.assign(o.legend, { data: ['Number of Population', '% Change of Population'] });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = [
      { type: 'value', min: 14000000, max: 28000000, interval: 2000000, name: 'Population', nameTextStyle: { color: '#1a2236' }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e6 ? (v / 1e6).toFixed(0) + 'm' : v; } }, splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
      { type: 'value', min: 0, max: 0.025, interval: 0.005, name: '% Change', nameTextStyle: { color: '#1a2236' }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(1) + '%'; } }, splitLine: { show: false } },
    ];
    o.series = [
      { name: 'Number of Population', type: 'line', yAxisIndex: 0, data: sl(d.populationNational), showSymbol: false, lineStyle: { width: 2, color: '#000' } },
      { name: '% Change of Population', type: 'line', yAxisIndex: 1, data: sl(d.changeNational || []), showSymbol: false, lineStyle: { width: 2, color: '#f5a623' } },
    ].concat(lta == null ? [] : [{
      name: 'Long-Term Average', type: 'line', yAxisIndex: 1, silent: true, z: 3,
      showSymbol: true, symbol: 'circle', symbolSize: 0.1,
      lineStyle: { color: '#6a7a88', type: 'dashed', width: 1.5 },
      data: yrs.map(function (y, i) {
        return i === 4 ? {
          value: lta, symbol: 'circle', symbolSize: 0.1,
          label: { show: true, position: 'top', distance: 6,
            formatter: 'Long-Term Average (' + (lta * 100).toFixed(2) + '%)',
            backgroundColor: '#6a7a88', color: '#fff', padding: [3, 7, 3, 7], borderRadius: 3,
            fontSize: 10, fontWeight: 700, fontFamily: FONT },
        } : lta;
      }),
    }]);
    return o;
  });

  /* ── p9 — Population Pyramid (HORIZONTAL grouped bars, value x-axis) ── */
  reg('national-p9', function (d) {
    if (!d.populationPyramidAge || !d.national) return null;
    var o = baseOption();
    return {
      backgroundColor: 'transparent',
      color: COLORS.slice(),
      textStyle: o.textStyle,
      grid: { left: 90, right: 40, top: 30, bottom: 70 },
      legend: Object.assign(o.legend, { data: ['National', 'Capital Cities'] }),
      tooltip: o.tooltip,
      xAxis: { type: 'value', min: 0, max: 0.08, interval: 0.01, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } }, splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
      yAxis: { type: 'category', data: d.populationPyramidAge, axisLine: { lineStyle: { color: '#1a2236' } }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, interval: 0 } },
      series: [
        { name: 'National', type: 'bar', data: d.national || [], itemStyle: { color: COLORS[2] } },
        { name: 'Capital Cities', type: 'bar', data: d.capitalCities || [], itemStyle: { color: COLORS[3] } },
      ],
    };
  });

  /* ── p10 — Household Type (census-year grouped bars; shares × total → counts) ── */
  reg('national-p10', function (d) {
    var rawYears = d.householdTypeYear || [];
    if (!rawYears.length) return null;
    var years = rawYears.map(function (s) { var dt = new Date(s); return String(dt.getUTCMonth() === 11 ? dt.getUTCFullYear() + 1 : dt.getUTCFullYear()); });
    var total = d.householdByTypeTotal || [];
    var toCounts = function (arr) { return Array.isArray(arr) ? arr.map(function (v, i) { return (v == null || total[i] == null) ? null : Math.round(v * total[i]); }) : arr; };
    var fields = [
      ['Couples w/ Children', toCounts(d.coupleWithChildren), COLORS[2]],
      ['Couples w/o Children', toCounts(d.couplesWithoutChildren), COLORS[3]],
      ['1 Parent Fam', toCounts(d.oneParentFamilies), '#f5d566'],
      ['Lone Person', toCounts(d.lonePerson), COLORS[1]],
      ['Other', toCounts(d.otherFamilies), '#f5a623'],
      ['Group', toCounts(d.groupHousehold), '#3ecf8e'],
    ].filter(function (x) { return Array.isArray(x[1]) && x[1].length; });
    if (!fields.length) return null;
    var o = baseOption();
    o.tooltip = {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      backgroundColor: 'rgba(15,25,34,0.95)', borderColor: '#2a3a48',
      textStyle: { color: '#fff', fontFamily: FONT, fontSize: 12 },
      formatter: function (params) {
        var arr = Array.isArray(params) ? params : [params];
        var head = arr.length ? arr[0].axisValue : '';
        var fmt = function (val) { var v = Number(val); return isNaN(v) ? '—' : (v >= 1e6 ? (v / 1e6).toFixed(2) + 'm' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'k' : String(Math.round(v))); };
        var lines = arr.map(function (p) { return '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + p.color + ';margin-right:6px"></span>' + p.seriesName + ': <strong>' + fmt(p.value) + '</strong>'; });
        return '<div style="font-weight:700;margin-bottom:4px">' + head + '</div>' + lines.join('<br/>');
      },
    };
    o.legend = Object.assign(o.legend, { data: fields.map(function (x) { return x[0]; }) });
    o.xAxis = Object.assign(o.xAxis, { data: years, axisLabel: { color: '#1a2236', fontSize: 11, interval: 0, formatter: function (v) { return v; } } });
    o.yAxis = Object.assign(o.yAxis, {
      min: 0, max: 3000000, interval: 500000,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e6 ? (v / 1e6) + 'm' : v >= 1e3 ? (v / 1e3) + 'k' : v; } },
    });
    o.series = fields.map(function (x) { return { name: x[0], type: 'bar', data: x[1], itemStyle: { color: x[2] }, barGap: '12%' }; });
    return o;
  });

  /* ── p11 — Affordability Index, Cap City (bar) + Median House Price (line), from 1990 ── */
  reg('national-p11', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length) return null;
    if (!d.aiCapCity && !d.capCityMedianPrice) return null;
    var f = fromYear(years, 1990), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Affordability Index', 'Median House Price'] });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = [
      { type: 'value', name: 'Affordability Index', nameTextStyle: { color: '#1a2236' }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } }, splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
      { type: 'value', name: 'Median House Price', nameTextStyle: { color: '#1a2236' }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + 'm' : v >= 1e3 ? (v / 1e3) + 'k' : v; } }, splitLine: { show: false } },
    ];
    o.series = [
      { name: 'Affordability Index', type: 'bar', yAxisIndex: 0, data: sl(d.aiCapCity || []), itemStyle: { color: COLORS[2] } },
      { name: 'Median House Price', type: 'line', yAxisIndex: 1, data: sl(d.capCityMedianPrice || []), showSymbol: false, lineStyle: { width: 2, color: '#000' } },
    ];
    return o;
  });

  /* ── p12 — Affordability Index Regional (bar) + Regional Median Price (line), from 1990 ── */
  reg('national-p12', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length || (!d.aiRegions && !d.regionalMedianPrice)) return null;
    var f = fromYear(years, 1990), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Affordability Index', 'Median House Price'] });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = [
      { type: 'value', name: 'Affordability Index', nameTextStyle: { color: '#1a2236' }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } }, splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
      { type: 'value', name: 'Median House Price', nameTextStyle: { color: '#1a2236' }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + 'm' : v >= 1e3 ? (v / 1e3) + 'k' : v; } }, splitLine: { show: false } },
    ];
    o.series = [
      { name: 'Affordability Index', type: 'bar', yAxisIndex: 0, data: sl(d.aiRegions || []), itemStyle: { color: COLORS[2] } },
      { name: 'Median House Price', type: 'line', yAxisIndex: 1, data: sl(d.regionalMedianPrice || []), showSymbol: false, lineStyle: { width: 2, color: '#000' } },
    ];
    return o;
  });

  /* ── p13 — Price to Income Ratio, Cap Cities (from 1994) ── */
  reg('national-p13', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length || !d.priceToIncomeRatioCapCity) return null;
    var f = fromYear(years, 1994), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Capital Cities'] });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.series = [
      { name: 'Capital Cities', type: 'line', data: sl(d.priceToIncomeRatioCapCity), showSymbol: false, lineStyle: { width: 2, color: '#000' },
        markLine: { silent: true, symbol: 'none', data: recessionMarkLines(yrs) } },
    ];
    return o;
  });

  /* ── p14 — Price to Income Ratio Regional (from 1994) ── */
  reg('national-p14', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length || !d.priceToIncomeRatioRegions) return null;
    var f = fromYear(years, 1994), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Regional'] });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.series = [
      { name: 'Regional', type: 'line', data: sl(d.priceToIncomeRatioRegions), showSymbol: false, lineStyle: { width: 2, color: '#000' },
        markLine: { silent: true, symbol: 'none', data: recessionMarkLines(yrs) } },
    ];
    return o;
  });

  /* ── p15 — FHB % Population (bar) + Annualized FHB (line), from 2003 ── */
  reg('national-p15', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length) return null;
    if (!d.fhbPopulation && !d.annualizedFhb) return null;
    var f = fromYear(years, 2003), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Annualized FHB', 'FHB % Population'] });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = [
      { type: 'value', axisLine: { show: false }, axisTick: { show: false }, name: 'FHB % Population', nameTextStyle: { color: '#1a2236' }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(1) + '%'; } }, splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
      { type: 'value', axisLine: { show: false }, axisTick: { show: false }, name: 'Annualized FHB', nameTextStyle: { color: '#1a2236' }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e3 ? (v / 1e3) + 'k' : v; } }, splitLine: { show: false } },
    ];
    o.series = [
      { name: 'FHB % Population', type: 'bar', yAxisIndex: 0, data: sl(d.fhbPopulation || []), itemStyle: { color: COLORS[2] } },
      { name: 'Annualized FHB', type: 'line', yAxisIndex: 1, data: sl(d.annualizedFhb || []), showSymbol: false, lineStyle: { width: 2, color: '#000' } },
    ];
    return o;
  });

  /* ── p16 — National Retail Spending (Retail Turnover % Change, from 1990) ── */
  reg('national-p16', function (d) {
    var years = (d.year || []).map(String);
    var vals = d.retailTurnoverChange;
    if (!years.length || !Array.isArray(vals) || !vals.length) return null;
    var f = fromYear(years, 1990), yrs = years.slice(f);
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Retail Turnover % Change'] });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = Object.assign(o.yAxis, { axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } } });
    o.series = [
      { name: 'Retail Turnover % Change', type: 'line', data: vals.slice(f), showSymbol: false, lineStyle: { width: 2 } },
    ];
    return o;
  });

  /* ── p17 — Unemployment Rate + Underemployment Rate (from 1980) ── */
  reg('national-p17', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length || (!d.nationalUnemployment && !d.nationalUnderemployment)) return null;
    var f = fromYear(years, 1980), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Unemployment Rate', 'Underemployment Rate'] });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = Object.assign(o.yAxis, { axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } } });
    o.series = [
      { name: 'Unemployment Rate', type: 'line', data: sl(d.nationalUnemployment || []), showSymbol: false, lineStyle: { width: 2, color: '#000' } },
      { name: 'Underemployment Rate', type: 'line', data: sl(d.nationalUnderemployment || []), showSymbol: false, lineStyle: { width: 2, color: '#f5a623' } },
    ];
    return o;
  });

  /* ── p18 — Business Investment ($M, Manufacturing/Mining/Total, from 2000) ── */
  reg('national-p18', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length || (!d.manufacturingIndustry && !d.miningIndustry && !d.totalIncludingEducationAndHealth)) return null;
    var f = fromYear(years, 2000), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Manufacturing Industry', 'Mining Industry', 'Total including Education and Health'] });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = Object.assign(o.yAxis, {
      name: '$Millions', nameTextStyle: { color: '#1a2236' },
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e3 ? (v / 1e3) + 'k' : v; } },
    });
    o.series = [
      { name: 'Manufacturing Industry', type: 'line', data: sl(d.manufacturingIndustry || []), showSymbol: false, lineStyle: { width: 2, color: '#000' } },
      { name: 'Mining Industry', type: 'line', data: sl(d.miningIndustry || []), showSymbol: false, lineStyle: { width: 2, color: '#f5a623' } },
      { name: 'Total including Education and Health', type: 'line', data: sl(d.totalIncludingEducationAndHealth || []), showSymbol: false, lineStyle: { width: 2, color: '#5cc8e0' } },
    ];
    return o;
  });

  /* Date helper shared by the date-axis pages (p19/p20/p29/p30/p31/p32):
     feed dates are the prior month/quarter-end stored in UTC; shift +12h and
     read UTC so the label is the intended local "D MMM YYYY". */
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(s) {
    var dt = new Date(new Date(s).getTime() + 12 * 3600 * 1000);
    return dt.getUTCDate() + ' ' + MON[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear();
  }
  function dateAxisLabel(len) {
    return { color: '#1a2236', fontSize: 10, rotate: 45, interval: Math.max(1, Math.floor(len / 28)), showMinLabel: true, showMaxLabel: true, formatter: function (v) { return v; } };
  }

  /* ── p19 — National Job Vacancies (Private vs Public), monthly date axis ── */
  reg('national-p19', function (d) {
    var raw = d.dateNationalJobVacancies || [];
    if (!raw.length || (!d.nationalJobVacanciesPrivate && !d.nationalJobVacanciesPublic)) return null;
    var dates = raw.map(shortDate);
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Private', 'Public'] });
    o.xAxis = Object.assign(o.xAxis, { data: dates, axisLabel: dateAxisLabel(dates.length) });
    o.yAxis = Object.assign(o.yAxis, {
      name: 'Private / Public', nameTextStyle: { color: '#1a2236' },
      axisLabel: { color: '#1a2236', fontSize: 11 },
    });
    o.series = [
      { name: 'Private', type: 'line', data: d.nationalJobVacanciesPrivate || [], showSymbol: false, lineStyle: { width: 2, color: '#000' } },
      { name: 'Public', type: 'line', data: d.nationalJobVacanciesPublic || [], showSymbol: false, lineStyle: { width: 2, color: '#f5a623' } },
    ];
    return o;
  });

  /* ── p20 — National Internet Job Vacancies, monthly date axis (from Jan 2006) ── */
  reg('national-p20', function (d) {
    var raw = d.dateInternetJobVacancies || [];
    var vals = d.nationalInternetJobVacancies;
    if (!raw.length || !Array.isArray(vals) || !vals.length) return null;
    var parsed = raw.map(function (s) { return new Date(new Date(s).getTime() + 12 * 3600 * 1000); });
    var _i = parsed.findIndex(function (dt) { return dt.getUTCFullYear() >= 2006; });
    var _from = _i < 0 ? 0 : _i;
    var dates = parsed.slice(_from).map(function (dt) { return dt.getUTCDate() + ' ' + MON[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear(); });
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['National Internet Job Vacancies'] });
    o.xAxis = Object.assign(o.xAxis, { data: dates, axisLabel: dateAxisLabel(dates.length) });
    o.series = [
      { name: 'National Internet Job Vacancies', type: 'line', data: vals.slice(_from), showSymbol: false, lineStyle: { width: 2 } },
    ];
    return o;
  });

  /* ── p21 — Federal Budget (signed bars, fiscal-year axis) ── */
  reg('national-p21', function (d) {
    var labels = d.federalBudgetDates || [];
    var vals = d.federalBudgetInMillions || [];
    var pairs = labels.map(function (y, i) { return [y, vals[i]]; }).filter(function (p) { return p[0] && (typeof p[1] === 'number'); });
    if (!pairs.length) return null;
    var xs = pairs.map(function (p) {
      var s = String(p[0]);
      if (/^\d{4}-\d{2}$/.test(s)) return s;
      var dt = new Date(new Date(s).getTime() + 12 * 3600 * 1000);
      var Y = dt.getUTCFullYear();
      return Y + '-' + String((Y + 1) % 100).padStart(2, '0');
    });
    var ys = pairs.map(function (p) { return p[1]; });
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Federal Budget (in Millions)'] });
    o.xAxis = Object.assign(o.xAxis, { data: xs });
    o.yAxis = Object.assign(o.yAxis, {
      name: '$Millions', nameTextStyle: { color: '#1a2236' },
      min: -150000, max: 100000, interval: 50000,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v === 0 ? '0' : (v / 1000) + 'k'; } },
    });
    o.series = [
      { name: 'Federal Budget (in Millions)', type: 'bar', data: ys, itemStyle: { color: '#5cc8e0' } },
    ];
    return o;
  });

  /* ── p22 — Inflation Rate vs Cash Rate (% axis, full year axis) ── */
  reg('national-p22', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length || (!d.inflationRate && !d.cashRate)) return null;
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Inflation Rate', 'Cash Rate'] });
    o.xAxis = Object.assign(o.xAxis, { data: years });
    o.yAxis = Object.assign(o.yAxis, {
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } },
    });
    o.series = [
      { name: 'Inflation Rate', type: 'line', data: d.inflationRate || [], showSymbol: false, lineStyle: { width: 2, color: '#000' } },
      { name: 'Cash Rate', type: 'line', data: d.cashRate || [], showSymbol: false, lineStyle: { width: 2, color: '#f5a623' } },
    ];
    return o;
  });

  /* ── p23 — Engineering Work Done, Private vs Public (from 1987) ── */
  reg('national-p23', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length || (!d.valueOfWorkDonePublic && !d.valueOfWorkDonePrivate)) return null;
    var f = fromYear(years, 1987), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Private', 'Public'] });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = Object.assign(o.yAxis, {
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e6 ? (v / 1e6).toFixed(0) + 'm' : v >= 1e3 ? (v / 1e3) + 'k' : v; } },
    });
    o.series = [
      { name: 'Private', type: 'line', data: sl(d.valueOfWorkDonePrivate || []), showSymbol: false, lineStyle: { width: 2, color: '#000' } },
      { name: 'Public', type: 'line', data: sl(d.valueOfWorkDonePublic || []), showSymbol: false, lineStyle: { width: 2, color: '#f5a623' } },
    ];
    return o;
  });

  /* ── p24 — National Population Movement (NI/NOM bars + Unemployment line, from 1990) ── */
  reg('national-p24', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length || (!d.naturalIncrease && !d.netOverseasMigrationNom)) return null;
    var f = fromYear(years, 1990), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Natural Increase', 'NOM', 'Unemployment'] });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = [
      { type: 'value', name: 'Natural Increase / NOM', nameTextStyle: { color: '#1a2236' }, min: -100000, max: 600000, interval: 100000, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(0) + 'k' : v; } }, splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
      { type: 'value', name: 'Unemployment', nameTextStyle: { color: '#1a2236' }, min: 0, max: 0.12, interval: 0.02, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } }, splitLine: { show: false } },
    ];
    o.series = [
      { name: 'Natural Increase', type: 'bar', yAxisIndex: 0, data: sl(d.naturalIncrease || []), itemStyle: { color: '#5cc8e0' }, barGap: '10%' },
      { name: 'NOM', type: 'bar', yAxisIndex: 0, data: sl(d.netOverseasMigrationNom || []), itemStyle: { color: '#b3bcc4' }, barGap: '10%' },
      { name: 'Unemployment', type: 'line', yAxisIndex: 1, data: sl(d.nationalUnemployment || []), showSymbol: false, lineStyle: { width: 2, color: '#000' } },
    ];
    return o;
  });

  /* ── p25 — State Net Overseas Migration (5 state lines, from 1985) ── */
  reg('national-p25', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length) return null;
    var f = fromYear(years, 1985), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var series = [
      ['NSW', d.nswNom], ['VIC', d.vicNom], ['QLD', d.qldNom], ['SA', d.saNom], ['WA', d.waNom],
    ].filter(function (s) { return Array.isArray(s[1]) && s[1].length; });
    if (!series.length) return null;
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: series.map(function (s) { return s[0]; }) });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = Object.assign(o.yAxis, {
      min: -50000, max: 200000, interval: 50000,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(0) + 'k' : v; } },
    });
    o.series = series.map(function (s) {
      return { name: s[0], type: 'line', data: sl(s[1]), showSymbol: false, lineStyle: { width: 2 } };
    });
    return o;
  });

  /* ── p26 — State Net Interstate Migration (5 state lines + zero ref line, from 1985) ── */
  reg('national-p26', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length) return null;
    var f = fromYear(years, 1985), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var series = [
      ['NSW', d.nswNim, '#000000'], ['VIC', d.vicNim, '#f5a623'], ['QLD', d.qldNim, '#5cc8e0'],
      ['SA', d.saNim, '#c2a4d6'], ['WA', d.waNim, '#e8799a'],
    ].filter(function (s) { return Array.isArray(s[1]) && s[1].length; });
    if (!series.length) return null;
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: series.map(function (s) { return s[0]; }) });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = Object.assign(o.yAxis, {
      min: -60000, max: 60000, interval: 20000,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(0) + 'k' : v; } },
    });
    o.series = series.map(function (s) {
      return { name: s[0], type: 'line', data: sl(s[1]), showSymbol: false, lineStyle: { width: 2, color: s[2] },
        markLine: s[0] === 'NSW' ? { silent: true, symbol: 'none', label: { show: false }, data: [{ yAxis: 0, lineStyle: { color: 'rgba(26,34,54,0.4)', type: 'dashed' } }] } : undefined };
    });
    return o;
  });

  /* ── p27 — Govt Debt to GDP vs RBA Cash Rate (both % on one axis, from 2000) ── */
  reg('national-p27', function (d) {
    var years = (d.year || []).map(String);
    if (!years.length || (!d.govtDebtToGdp && !d.cashRate)) return null;
    var f = fromYear(years, 2000), yrs = years.slice(f);
    var sl = function (a) { return Array.isArray(a) ? a.slice(f, f + yrs.length) : a; };
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Govt Debt to GDP', 'Cash Rate'] });
    o.xAxis = Object.assign(o.xAxis, { data: yrs });
    o.yAxis = Object.assign(o.yAxis, {
      min: 0, max: 0.45, interval: 0.05,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } },
    });
    o.series = [
      { name: 'Govt Debt to GDP', type: 'line', data: sl(d.govtDebtToGdp || []), showSymbol: false, lineStyle: { width: 2, color: '#000' } },
      { name: 'Cash Rate', type: 'line', data: sl(d.cashRate || []), showSymbol: false, lineStyle: { width: 2, color: '#f5a623' } },
    ];
    return o;
  });

  /* ── p28 — Top 20 Economies (dual-axis grouped bars by country, rotated x) ── */
  reg('national-p28', function (d) {
    if (!d.country || (!d.nominalGdpInTrillions && !d.debtToGdpRatio)) return null;
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Nominal GDP (in trillions)', 'Debt to GDP Ratio'] });
    o.xAxis = Object.assign(o.xAxis, {
      data: d.country,
      axisLabel: { color: '#1a2236', fontSize: 10, rotate: 35, interval: 0 },
    });
    o.yAxis = [
      { type: 'value', name: 'Nominal GDP ($T)', nameTextStyle: { color: '#1a2236' }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11 }, splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
      { type: 'value', name: 'Debt to GDP Ratio', nameTextStyle: { color: '#1a2236' }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } }, splitLine: { show: false } },
    ];
    o.series = [
      { name: 'Nominal GDP (in trillions)', type: 'bar', yAxisIndex: 0, data: d.nominalGdpInTrillions || [], itemStyle: { color: COLORS[2] }, barGap: '12%' },
      { name: 'Debt to GDP Ratio', type: 'bar', yAxisIndex: 1, data: d.debtToGdpRatio || [], itemStyle: { color: COLORS[3] }, barGap: '12%' },
    ];
    return o;
  });

  /* ── p29 — Investor v Homebuyer Lending (Owner Occupier vs Investor, monthly date axis) ── */
  reg('national-p29', function (d) {
    var raw = d.lendingDate || [];
    if (!raw.length || (!d.ownerOccupierAbs && !d.investorAbs)) return null;
    // Owner-occupier / investor lending only begins ~2004; the shared lendingDate
    // axis starts earlier (other monthly series), so trim the leading blank span
    // and start the chart where the data actually begins — no empty 1990-2003 gap.
    var oo = d.ownerOccupierAbs || [], inv = d.investorAbs || [];
    var f = 0; while (f < raw.length && oo[f] == null && inv[f] == null) f++;
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var dates = raw.slice(f).map(shortDate);
    var o = baseOption();
    o.tooltip = {
      trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
      backgroundColor: 'rgba(15,25,34,0.95)', borderColor: '#2a3a48',
      textStyle: { color: '#fff', fontFamily: FONT, fontSize: 12 },
      formatter: function (params) {
        var arr = Array.isArray(params) ? params : [params];
        var head = arr.length ? arr[0].axisValue : '';
        var fmt = function (val) { var v = Number(val); return isNaN(v) ? '—' : (v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(Math.round(v))); };
        var lines = arr.map(function (p) { return '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + p.color + ';margin-right:6px"></span>' + p.seriesName + ': <strong>' + fmt(p.value) + '</strong>'; });
        return '<div style="font-weight:700;margin-bottom:4px">' + head + '</div>' + lines.join('<br/>');
      },
    };
    o.legend = Object.assign(o.legend, { data: ['Owner Occupier (ABS)', 'Investor (ABS)'] });
    o.xAxis = Object.assign(o.xAxis, { data: dates, axisLabel: dateAxisLabel(dates.length) });
    o.yAxis = Object.assign(o.yAxis, {
      min: 0, max: 25000, interval: 5000,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e3 ? (v / 1e3) + 'k' : v; } },
    });
    o.series = [
      { name: 'Owner Occupier (ABS)', type: 'line', data: sl(oo), showSymbol: false, lineStyle: { width: 2, color: '#000' } },
      { name: 'Investor (ABS)', type: 'line', data: sl(inv), showSymbol: false, lineStyle: { width: 2, color: '#f5a623' } },
    ];
    return o;
  });

  /* ── p30 — Household Debt to Income (ratio left + Quarterly Cash Rate right, quarterly date axis) ── */
  reg('national-p30', function (d) {
    var raw = d.quarterYear || [];
    if (!raw.length || (!d.householdDebttoincomeRatio && !d.quarterlyCashRate)) return null;
    var dates = raw.map(shortDate);
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Household debt-to-income ratio', 'Quarterly Cash Rate'] });
    o.xAxis = Object.assign(o.xAxis, { data: dates, axisLabel: dateAxisLabel(dates.length) });
    o.yAxis = [
      { type: 'value', name: 'Household debt-to-income ratio', nameTextStyle: { color: '#1a2236' }, min: 0, max: 200, interval: 25, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11 }, splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
      { type: 'value', name: 'Quarterly Cash Rate', nameTextStyle: { color: '#1a2236' }, min: 0, max: 0.14, interval: 0.02, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } }, splitLine: { show: false } },
    ];
    o.series = [
      { name: 'Household debt-to-income ratio', type: 'line', yAxisIndex: 0, data: d.householdDebttoincomeRatio || [], showSymbol: false, lineStyle: { width: 2, color: '#000' } },
      { name: 'Quarterly Cash Rate', type: 'line', yAxisIndex: 1, data: d.quarterlyCashRate || [], showSymbol: false, lineStyle: { width: 2, color: '#f5a623' } },
    ];
    return o;
  });

  /* ── p31 — Mortgage Arrears National (Arrears % left + Monthly Cash Rate % right, monthly date axis) ── */
  reg('national-p31', function (d) {
    var raw = d.lendingDate || [];
    if (!raw.length || (!d.arrearsNational && !d.monthlyCashRate)) return null;
    // Arrears data begins ~2004; the shared lendingDate axis starts 1990, so trim
    // the leading blank span and start the chart at the arrears start date.
    var arrN = d.arrearsNational || [], mcr = d.monthlyCashRate || [];
    var f = arrN.findIndex(function (v) { return v != null; }); if (f < 0) f = 0;
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var dates = raw.slice(f).map(shortDate);
    var o = baseOption();
    o.tooltip = {
      trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
      backgroundColor: 'rgba(15,25,34,0.95)', borderColor: '#2a3a48',
      textStyle: { color: '#fff', fontFamily: FONT, fontSize: 12 },
      formatter: function (params) {
        var arr = Array.isArray(params) ? params : [params];
        var head = arr.length ? arr[0].axisValue : '';
        var lines = arr.map(function (p) { var v = Number(p.value); var fmt = isNaN(v) ? '—' : (v * 100).toFixed(2) + '%'; return '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + p.color + ';margin-right:6px"></span>' + p.seriesName + ': <strong>' + fmt + '</strong>'; });
        return '<div style="font-weight:700;margin-bottom:4px">' + head + '</div>' + lines.join('<br/>');
      },
    };
    o.legend = Object.assign(o.legend, { data: ['Arrears', 'Monthly Cash Rate'] });
    o.xAxis = Object.assign(o.xAxis, { data: dates, axisLabel: dateAxisLabel(dates.length) });
    o.yAxis = [
      { type: 'value', name: 'Arrears', nameTextStyle: { color: '#1a2236' }, min: 0, max: 0.02, interval: 0.0025, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (Math.round(v * 10000) / 100) + '%'; } }, splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
      { type: 'value', name: 'Monthly Cash Rate', nameTextStyle: { color: '#1a2236' }, min: 0, max: 0.08, interval: 0.01, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } }, splitLine: { show: false } },
    ];
    o.series = [
      { name: 'Arrears', type: 'line', yAxisIndex: 0, data: sl(arrN), showSymbol: false, lineStyle: { width: 2, color: '#f5a623' }, itemStyle: { color: '#f5a623' } },
      { name: 'Monthly Cash Rate', type: 'line', yAxisIndex: 1, data: sl(mcr), showSymbol: false, lineStyle: { width: 2, color: '#000' }, itemStyle: { color: '#000' } },
    ];
    return o;
  });

  /* ── p32 — Mortgage Arrears State (5 state lines % 30+ days, monthly date axis) ── */
  reg('national-p32', function (d) {
    var raw = d.lendingDate || [];
    var series = [
      ['NSW', d.arrearsNsw, '#f5a623'], ['VIC', d.arrearsVic, '#000000'], ['QLD', d.arrearsQld, '#5cc8e0'],
      ['WA', d.arrearsWa, '#c2a4d6'], ['SA', d.arrearsSa, '#e8799a'],
    ].filter(function (s) { return Array.isArray(s[1]) && s[1].length; });
    if (!raw.length || !series.length) return null;
    // arrears data begins ~2004; the shared lendingDate axis starts 1990, so trim
    // the leading blank span and start the chart at the arrears start date.
    var f = 0; while (f < raw.length && series.every(function (s) { return s[1][f] == null; })) f++;
    var sl = function (a) { return Array.isArray(a) ? a.slice(f) : a; };
    var dates = raw.slice(f).map(shortDate);
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: series.map(function (s) { return s[0]; }) });
    o.xAxis = Object.assign(o.xAxis, { data: dates, axisLabel: dateAxisLabel(dates.length) });
    o.yAxis = Object.assign(o.yAxis, {
      min: 0, max: 0.035, interval: 0.005,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (Math.round(v * 10000) / 100) + '%'; } },
    });
    o.series = series.map(function (s) {
      return { name: s[0], type: 'line', data: sl(s[1]), showSymbol: false, lineStyle: { width: 2, color: s[2] }, itemStyle: { color: s[2] } };
    });
    return o;
  });

  /* Expose the builders so the report can (later) render from this one
     source of truth instead of its inline copies. */
  NS.national = NS.national || {};
  Object.assign(NS.national, { baseOption: baseOption, applyDefaults: applyDefaults, recessionMarkLines: recessionMarkLines, COLORS: COLORS });
})(window.PpaCharts);
