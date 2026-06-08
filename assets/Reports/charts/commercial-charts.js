/* ─────────────────────────────────────────────────────────────────────
   Commercial Research Report — chart modules (window.PpaCharts registry)
   ---------------------------------------------------------------------
   Same approach as national-charts.js: lift commercial-report.html's inline
   charts (_baseChartOption + _mountChart + per-page _renderPxx(tabs)) into the
   PpaCharts.register(...) contract so the report and the presentation tool
   render from one definition, and the presentation's createFromModule()
   animates the build.

   Each module is `commercial-p<N>` and reads the NESTED commercial snapshot:
   the data object passed in is the whole `tabs` map (presentation passes
   `snap.tabs`; the report passes its mapped tabs), and each builder looks up
   its own `tabs['<tab-slug>']`. Theme + defaults mirror commercial-report.html's
   _baseChartOption + _mountChart (incl. the line→marker colour mirroring that
   the commercial _mountChart does and national's does not). Report-only bits
   (canvas/undo DOM, user bands on p6) intentionally stay in the report.

   Loads AFTER _helpers.js (needs PpaCharts.register). ECharts required.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  if (!NS) { window.PpaCharts = window.PpaCharts || {}; NS = window.PpaCharts; }

  var FONT = 'Ubuntu, "Roboto", sans-serif';
  var COLORS = ['#000000', '#f5a623', '#5cc8e0', '#9aa3b1', '#c2a4d6', '#e58fa8', '#3ecf8e', '#86a8ff'];
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

  /* The pure (DOM-free, band-free) half of commercial-report.html's
     _mountChart: line markers, line→marker colour mirror, staircase year axis,
     rotated y-names, dark axis tooltip reusing each series' axis formatter. */
  function applyDefaults(option) {
    if (Array.isArray(option.series)) {
      option.series.forEach(function (s) {
        if (s && s.type === 'line') {
          if (s.symbol === undefined) s.symbol = 'circle';
          if (s.symbolSize === undefined) s.symbolSize = 8;
          if (s.showSymbol === undefined) s.showSymbol = false;
          /* commercial _mountChart mirrors the line colour onto the marker so
             the legend icon matches the line (national's does not). */
          if (s.lineStyle && s.lineStyle.color && (!s.itemStyle || s.itemStyle.color == null)) {
            s.itemStyle = Object.assign({}, s.itemStyle, { color: s.lineStyle.color });
          }
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
    /* Slide-fill: single value-axis charts don't need the wide dual-axis
       right margin — pull it in (see national-charts.js for rationale). */
    var _hasML = (option.series || []).some(function (s) { return s && s.markLine; });
    if (option.grid && !Array.isArray(option.yAxis) && !option.graphic && !_hasML &&
        typeof option.grid.right === 'number' && option.grid.right >= 50) {
      option.grid = Object.assign({}, option.grid, { right: 34 });
    }
    return option;
  }

  function reg(name, build) {
    NS.register(name, function (el, data) {
      var opt = build(data || {});
      if (!opt) { return echarts.init(el); }
      applyDefaults(opt);
      var chart = echarts.init(el, null, { renderer: 'canvas' });
      chart.setOption(opt);
      return chart;
    });
  }

  function fromYear(years, minYear) {
    var i = years.findIndex(function (y) { return Number(y) >= minYear; });
    return i < 0 ? 0 : i;
  }
  var moneyAxis = function (v) { return v >= 1e6 ? (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'm' : v >= 1e3 ? (v / 1e3) + 'k' : v; };

  /* Commercial date-axis helper — "MMM yy" from a "YYYY-MM…" ISO prefix
     (distinct from national's "D MMM YYYY" shortDate). Mirrors the commercial
     report's _shortDate. */
  var CR_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function crShortDate(isoStr) {
    if (!isoStr) return '';
    var s = String(isoStr);
    var m = s.match(/^(\d{4})-(\d{2})/);
    if (!m) return s;
    return CR_MON[parseInt(m[2], 10) - 1] + ' ' + m[1].slice(2);
  }

  /* ── p3 — Risk v Long Term Return (SCATTER, value axes, per-point labels) ── */
  reg('commercial-p3', function (tabs) {
    var t = tabs['riskreward-data'];
    if (!t || !t.investmentOption || !t['20YrAverageReturnsAsRewardPa'] || !t.totalRiskScore) return null;
    var labels = t.investmentOption;
    var xs = t['20YrAverageReturnsAsRewardPa'];
    var ys = t.totalRiskScore;
    var LABEL_POS = {
      'cash': 'right', 'term deposits': 'bottom', 'government bonds': 'top',
      'corporate bonds fund': 'bottom', 'corporate bonds': 'top', '1st mortgage secured debt': 'right',
      'reits': 'left', 'indexed etf': 'top', 'direct commercial property': 'left',
      'direct residential property': 'bottom', 'metals - gold, copper, silver': 'left', 'direct shares': 'left',
      'managed funds': 'top', 'private equity fund': 'left', '2nd mortgage secured debt': 'bottom',
      'leveraged residential property': 'right', 'leveraged commercial property': 'right',
      'performance property funds': 'right', 'development equity fund': 'right', 'private equity': 'top',
      'development equity': 'left', 'crypto (bitcoin)': 'left',
    };
    var norm = function (s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); };
    var points = labels.map(function (name, i) {
      return { name: name, value: [Number(xs[i]) || 0, Number(ys[i]) || 0], label: { position: LABEL_POS[norm(name)] || 'right' } };
    }).filter(function (p) {
      return !/\?/.test(p.name) && (p.value[0] !== 0 || p.value[1] !== 0);
    });
    return {
      backgroundColor: 'transparent',
      textStyle: { fontFamily: FONT, color: '#1a2236' },
      grid: { left: 54, right: 48, top: 26, bottom: 42, containLabel: false },
      tooltip: { trigger: 'item', formatter: function (p) { return p.data.name + '<br>Return: ' + (p.data.value[0] * 100).toFixed(1) + '%<br>Risk: ' + p.data.value[1]; } },
      xAxis: {
        type: 'value', min: 0, max: 0.25, interval: 0.025,
        axisLine: { lineStyle: { color: '#1a2236' } }, axisTick: { show: false },
        axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 0.25 ? '25%+' : (+(v * 100).toFixed(1)) + '%'; } },
        splitLine: { lineStyle: { color: 'rgba(26,34,54,0.10)' } },
      },
      yAxis: {
        type: 'value', name: 'Risk', min: 0, max: 35, interval: 5,
        nameLocation: 'middle', nameRotate: 90, nameGap: 34,
        nameTextStyle: { fontStyle: 'italic', fontSize: 11, color: '#1a2236' },
        axisLine: { lineStyle: { color: '#1a2236' } }, axisTick: { show: false },
        axisLabel: { color: '#1a2236', fontSize: 11 },
        splitLine: { lineStyle: { color: 'rgba(26,34,54,0.10)' } },
      },
      series: [{
        type: 'scatter', data: points, symbolSize: 9, itemStyle: { color: COLORS[2] },
        label: { show: true, formatter: function (p) { return p.data.name; }, fontSize: 11, color: '#1a2236', fontWeight: 500 },
        labelLayout: { hideOverlap: false },
      }],
    };
  });

  /* ── p5 — Cash Rate v Inflation (bar + line, MMM-yy date axis, callout) ── */
  reg('commercial-p5', function (tabs) {
    var t = tabs['cash-rateinflation-rate-data'];
    if (!t || !t.effectiveDate || !t.cashRate) return null;
    var labels = t.effectiveDate.map(crShortDate);
    var o = baseOption();
    o.grid = { left: 55, right: 28, top: 50, bottom: 74, containLabel: false };
    o.legend = Object.assign(o.legend, { data: ['Cash Rate', 'Inflation Rate'], left: 55 });
    o.graphic = [
      { type: 'text', right: 16, top: 52, style: { text: 'INVESTMENT\nCOMMITTEE\nPREDICTING CASH\nRATE TO', textAlign: 'right', fontStyle: 'italic', fontWeight: 'bold', fontSize: 12, fill: '#1a2236', lineHeight: 17 } },
      { type: 'text', right: 16, top: 120, style: { text: 'CONTRACT', textAlign: 'right', fontStyle: 'italic', fontWeight: 'bold', fontSize: 13, fill: '#3ecf8e' } },
    ];
    o.xAxis = Object.assign(o.xAxis, { data: labels, axisLabel: { color: '#1a2236', fontSize: 10 } });
    o.yAxis = Object.assign(o.yAxis, {
      min: -0.025, max: 0.20, interval: 0.025,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (+(v * 100).toFixed(1)) + '%'; } },
    });
    o.series = [
      { name: 'Inflation Rate', type: 'bar', data: t.inflationRate || [], itemStyle: { color: COLORS[2] }, barWidth: 3 },
      { name: 'Cash Rate', type: 'line', data: t.cashRate, showSymbol: false, lineStyle: { width: 2, color: '#000' }, z: 3 },
    ];
    return o;
  });

  /* ── p6 — Building Price Indices (5 capital lines, band page) ── */
  reg('commercial-p6', function (tabs) {
    var t = tabs['building-price-indices-data'];
    if (!t || !t.periodyearJune30) return null;
    var raw = t.periodyearJune30.map(String);
    var keep = [];
    raw.forEach(function (v, i) { if (/^\s*(19|20)\d{2}\b/.test(v)) keep.push(i); });
    var years = keep.map(function (i) { return raw[i].trim(); });
    var pick = function (arr) { return Array.isArray(arr) ? keep.map(function (i) { return arr[i]; }) : arr; };
    var series = [
      ['Adelaide', pick(t.adel)], ['Brisbane', pick(t.bris)], ['Darwin', pick(t.dwn)],
      ['Hobart', pick(t.hob)], ['Canberra', pick(t.can)],
    ].filter(function (s) { return Array.isArray(s[1]) && s[1].length; });
    if (!series.length) return null;
    var o = baseOption();
    o.grid = { left: 60, right: 25, top: 30, bottom: 55, containLabel: false };
    o.legend = Object.assign(o.legend, { data: series.map(function (s) { return s[0]; }) });
    o.xAxis = Object.assign(o.xAxis, { data: years });
    o.yAxis = Object.assign(o.yAxis, {
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + 'm' : v >= 1e3 ? (v / 1e3) + 'k' : v; } },
    });
    o.series = series.map(function (s, i) {
      return { name: s[0], type: 'line', data: s[1], showSymbol: false, lineStyle: { width: 2, color: COLORS[i % COLORS.length] } };
    });
    return o;
  });

  /* ── p7 — Building Approvals (5 state lines + National, dual axis) ── */
  reg('commercial-p7', function (tabs) {
    var t = tabs['building-approvals-data'];
    if (!t || !t.date) return null;
    var years = t.date.map(String);
    var stateSeries = [
      ['NSW', t.nswBa, '#f5a623'], ['VIC', t.vicBa, '#000000'], ['QLD', t.qldBa, '#5cc8e0'],
      ['SA', t.saBa, '#c2a4d6'], ['WA', t.waBa, '#3ecf8e'],
    ].filter(function (s) { return Array.isArray(s[1]) && s[1].length; });
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: stateSeries.map(function (s) { return s[0]; }).concat(['National']) });
    o.xAxis = Object.assign(o.xAxis, { data: years });
    o.yAxis = [
      { type: 'value', name: 'Major States', nameTextStyle: { color: '#1a2236' }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e3 ? (v / 1e3) + 'k' : v; } }, splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
      { type: 'value', name: 'National', nameTextStyle: { color: '#1a2236' }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e3 ? (v / 1e3) + 'k' : v; } }, splitLine: { show: false } },
    ];
    o.series = stateSeries.map(function (s) {
      return { name: s[0], type: 'line', yAxisIndex: 0, data: s[1], showSymbol: false, lineStyle: { width: 2, color: s[2] } };
    }).concat([
      { name: 'National', type: 'line', yAxisIndex: 1, data: t.nationalBa || [], showSymbol: false, lineStyle: { width: 2, color: '#e57b7b' } },
    ]);
    return o;
  });

  /* ── p8 — Retail Turnover (single line, MMM-yy date axis, $Billions) ── */
  reg('commercial-p8', function (tabs) {
    var t = tabs['retail-turnover-data'];
    if (!t || !t.date || !t.data) return null;
    var labels = t.date.map(crShortDate);
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Retail Turnover'] });
    o.xAxis = Object.assign(o.xAxis, { data: labels, axisLabel: { color: '#1a2236', fontSize: 10, rotate: 45, interval: Math.max(1, Math.floor(labels.length / 16)) } });
    o.yAxis = Object.assign(o.yAxis, {
      name: '$Billions', nameTextStyle: { color: '#1a2236' },
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v; } },
    });
    o.series = [
      { name: 'Retail Turnover', type: 'line', data: t.data, showSymbol: false, lineStyle: { width: 1.5, color: '#000' } },
    ];
    return o;
  });

  /* ── p9 — Population Growth (5 state lines + National, dual axis) ── */
  reg('commercial-p9', function (tabs) {
    var t = tabs['population-growth-data'];
    if (!t || !t.date) return null;
    var years = t.date.map(String);
    var stateSeries = [
      ['NSW', t.nsw, '#f5a623'], ['VIC', t.vic, '#000000'], ['QLD', t.qld, '#5cc8e0'],
      ['WA', t.wa, '#c2a4d6'], ['SA', t.sa, '#3ecf8e'],
    ].filter(function (s) { return Array.isArray(s[1]) && s[1].length; });
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: stateSeries.map(function (s) { return s[0]; }).concat(['National']) });
    o.xAxis = Object.assign(o.xAxis, { data: years });
    o.yAxis = [
      { type: 'value', name: 'States', nameTextStyle: { color: '#1a2236' }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e6 ? (v / 1e6).toFixed(0) + 'm' : v >= 1e3 ? (v / 1e3) + 'k' : v; } }, splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
      { type: 'value', name: 'National', nameTextStyle: { color: '#1a2236' }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e6 ? (v / 1e6).toFixed(0) + 'm' : v; } }, splitLine: { show: false } },
    ];
    o.series = stateSeries.map(function (s) {
      return { name: s[0], type: 'line', yAxisIndex: 0, data: s[1], showSymbol: false, lineStyle: { width: 2, color: s[2] } };
    }).concat([
      { name: 'National', type: 'line', yAxisIndex: 1, data: t.national || [], showSymbol: false, lineStyle: { width: 2, color: '#e57b7b' } },
    ]);
    return o;
  });

  /* ── p11 — Return on Stocks & Gold / Term Deposits (line, MMM-yy axis, callouts) ── */
  reg('commercial-p11', function (tabs) {
    var t = tabs['term-deposits'] || tabs['term-deposit'] || tabs['all-term-deposits'] || tabs['term-deposits-data'];
    if (!t) return null;
    var keys = Object.keys(t).filter(function (k) { return Array.isArray(t[k]) && t[k].length; });
    if (!keys.length) return null;
    var isDateVal = function (v) { return typeof v === 'string' && /^\d{4}-\d{2}/.test(v); };
    var dateKey = ['date', 'effectiveDate', 'period', 'month', 'asAtDate'].find(function (k) { return Array.isArray(t[k]) && t[k].some(isDateVal); });
    if (!dateKey) dateKey = keys.find(function (k) { return t[k].some(isDateVal); });
    var _norm = function (k) { return String(k).toLowerCase().replace(/[^a-z0-9]/g, ''); };
    var valKey = keys.find(function (k) { return k !== dateKey && /^5yearaverage/.test(_norm(k)); });
    if (!valKey) valKey = ['allTermDeposits', 'allTermDeposit', 'termDeposits'].find(function (k) { return Array.isArray(t[k]) && t[k].some(function (v) { return typeof v === 'number'; }); });
    if (!valKey) {
      var bestRange = -1;
      keys.forEach(function (k) {
        if (k === dateKey) return;
        var nums = t[k].filter(function (v) { return typeof v === 'number'; });
        if (nums.length < 3) return;
        var range = Math.max.apply(null, nums) - Math.min.apply(null, nums);
        if (range > bestRange) { bestRange = range; valKey = k; }
      });
    }
    if (!dateKey || !valKey) return null;
    var keep = [];
    t[dateKey].forEach(function (d, i) { var m = String(d).match(/(\d{4})/); if (m && +m[1] >= 2004) keep.push(i); });
    var rawDates = keep.map(function (i) { return String(t[dateKey][i]); });
    var labels = rawDates.map(crShortDate);
    var vals = keep.map(function (i) { var v = t[valKey][i]; return typeof v === 'number' ? v : (v == null ? null : parseFloat(v)); });
    var present = vals.filter(function (v) { return v != null && !isNaN(v); });
    if (!present.length) return null;
    var mx0 = Math.max.apply(null, present);
    var scale = mx0 <= 1 ? 100 : (mx0 > 20 ? 0.01 : 1);
    var pct = vals.map(function (v) { return (v == null || isNaN(v)) ? null : +(v * scale).toFixed(2); });
    var maxPct = Math.max.apply(null, pct.filter(function (v) { return v != null; }));
    var yearOf = function (d) { var m = String(d).match(/(\d{4})/); return m ? +m[1] : null; };
    var yrs = rawDates.map(yearOf);
    var latest = Math.max.apply(null, yrs.filter(Boolean));
    var avgWin = function (n) {
      var sum = 0, cnt = 0;
      for (var i = 0; i < pct.length; i++) {
        if (pct[i] == null || yrs[i] == null) continue;
        if (yrs[i] > latest - n) { sum += pct[i]; cnt++; }
      }
      return cnt ? sum / cnt : null;
    };
    var fmtAvg = function (a) { return a == null ? '—' : a.toFixed(2) + '%'; };
    var o = baseOption();
    o.grid = { left: 52, right: 28, top: 50, bottom: 74, containLabel: false };
    o.legend = Object.assign(o.legend, { data: ['All Term Deposits'] });
    o.graphic = [20, 10, 5].map(function (n, i) {
      return { type: 'text', right: 12 + (2 - i) * 96, top: 14,
        style: { text: n + ' YEAR\nAVERAGE\n' + fmtAvg(avgWin(n)), textAlign: 'center', fontWeight: 'bold', fontSize: 13, fill: '#1a2236', lineHeight: 18 } };
    });
    o.xAxis = Object.assign(o.xAxis, { data: labels, axisLabel: { color: '#1a2236', fontSize: 10 } });
    o.yAxis = Object.assign(o.yAxis, {
      min: 0, max: Math.max(9, Math.ceil(maxPct)), interval: 1,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v + '%'; } },
    });
    o.series = [
      { name: 'All Term Deposits', type: 'line', data: pct, showSymbol: false, lineStyle: { width: 2, color: '#000' } },
    ];
    return o;
  });

  /* ── p12 — Government Bonds Yield (line, MMM-yy axis from 2004, 20-YR callout).
     Dates live in the `10YearGovernmentBondYield` column; values in `yield`. ── */
  reg('commercial-p12', function (tabs) {
    var t = tabs['govt-bonds-data'];
    var dateKey = '10YearGovernmentBondYield';
    if (!t || !t[dateKey] || !t.yield) return null;
    var keep = [];
    t[dateKey].forEach(function (d, i) { var m = String(d).match(/(\d{4})/); if (m && +m[1] >= 2004) keep.push(i); });
    var labels = keep.map(function (i) { return crShortDate(String(t[dateKey][i])); });
    var vals = keep.map(function (i) { var v = t.yield[i]; return typeof v === 'number' ? v : (v == null ? null : parseFloat(v)); });
    var present = vals.filter(function (v) { return v != null && !isNaN(v); });
    if (!present.length) return null;
    var avg20 = present.reduce(function (s, v) { return s + v; }, 0) / present.length;
    var maxV = Math.max.apply(null, present);
    var o = baseOption();
    o.grid = { left: 52, right: 28, top: 50, bottom: 74, containLabel: false };
    o.legend = Object.assign(o.legend, { data: ['10 YR Bond'] });
    o.graphic = [
      { type: 'text', right: 14, top: 14, style: { text: '20 YEAR\nAVERAGE\n' + (avg20 * 100).toFixed(2) + '%', textAlign: 'right', fontWeight: 'bold', fontSize: 13, fill: '#1a2236', lineHeight: 18 } },
    ];
    o.xAxis = Object.assign(o.xAxis, { data: labels, axisLabel: { color: '#1a2236', fontSize: 10 } });
    o.yAxis = Object.assign(o.yAxis, {
      min: 0, max: Math.max(0.07, Math.ceil(maxV * 100) / 100), interval: 0.01,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } },
    });
    o.series = [
      { name: '10 YR Bond', type: 'line', data: vals, showSymbol: false, lineStyle: { width: 1.5, color: '#000' } },
    ];
    return o;
  });

  /* ── p13 — Corporate Bond Yield (line, MMM-yy axis, 20-YR callout) ── */
  reg('commercial-p13', function (tabs) {
    var t = tabs['corporate-bond-data'];
    if (!t || !t.date || !t.data) return null;
    var labels = t.date.map(crShortDate);
    var present = (t.data || []).filter(function (v) { return typeof v === 'number' && !isNaN(v); });
    if (!present.length) return null;
    var avg20 = present.reduce(function (s, v) { return s + v; }, 0) / present.length;
    var maxV = Math.max.apply(null, present);
    var o = baseOption();
    o.grid = { left: 52, right: 28, top: 50, bottom: 74, containLabel: false };
    o.legend = Object.assign(o.legend, { data: ['10YR Corporate Bond'] });
    o.graphic = [
      { type: 'text', right: 14, top: 14, style: { text: '20 YEAR\nAVERAGE\n' + (avg20 * 100).toFixed(2) + '%', textAlign: 'right', fontWeight: 'bold', fontSize: 13, fill: '#1a2236', lineHeight: 18 } },
    ];
    o.xAxis = Object.assign(o.xAxis, { data: labels, axisLabel: { color: '#1a2236', fontSize: 10 } });
    o.yAxis = Object.assign(o.yAxis, {
      min: 0, max: Math.max(0.10, Math.ceil(maxV * 50) / 50), interval: 0.02,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } },
    });
    o.series = [
      { name: '10YR Corporate Bond', type: 'line', data: t.data, showSymbol: false, lineStyle: { width: 1.5, color: '#000' } },
    ];
    return o;
  });

  /* ── p16 — Industrial Vacancy Rate (Australia + 5 capitals, %) ── */
  reg('commercial-p16', function (tabs) {
    var t = tabs['vacancy-rate'];
    if (!t || !t.industrial) return null;
    var years = t.industrial.map(String);
    var series = [
      ['Australia', t.australia, '#000'], ['Sydney', t.sydney, '#5cc8e0'], ['Melbourne', t.melbourne, '#f5a623'],
      ['Brisbane', t.brisbane, '#3ecf8e'], ['Perth', t.perth, '#c2a4d6'], ['Adelaide', t.adelaide, '#e57373'],
    ].filter(function (s) { return Array.isArray(s[1]) && s[1].length; });
    if (!series.length) return null;
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: series.map(function (s) { return s[0]; }) });
    o.xAxis = Object.assign(o.xAxis, { data: years });
    o.yAxis = Object.assign(o.yAxis, { axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v + '%'; } } });
    o.series = series.map(function (s, i) {
      return { name: s[0], type: 'line', data: s[1], showSymbol: false, connectNulls: true, lineStyle: { width: i === 0 ? 2.5 : 1.8, color: s[2] } };
    });
    return o;
  });

  /* ── p17 — Freight Movement (5 ports, TEU; pinned min/max + auto-grow) ── */
  reg('commercial-p17', function (tabs) {
    var t = tabs['freight-movement-data'];
    if (!t || !t.teu) return null;
    var years = t.teu.map(String);
    var series = [
      ['Adelaide (SA)', t.adelaideSa, '#f5a623'], ['Botany/Sydney (NSW)', t.botanysydneyNsw, '#000000'],
      ['Brisbane (QLD)', t.brisbaneQld, '#5cc8e0'], ['Fremantle (WA)', t.fremantleWa, '#c2a4d6'],
      ['Melbourne (VIC)', t.melbourneVic, '#e8654f'],
    ].filter(function (s) { return Array.isArray(s[1]) && s[1].length; });
    if (!series.length) return null;
    var maxV = 0;
    series.forEach(function (s) { s[1].forEach(function (v) { if (typeof v === 'number' && v > maxV) maxV = v; }); });
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: series.map(function (s) { return s[0]; }) });
    o.xAxis = Object.assign(o.xAxis, { data: years });
    o.yAxis = Object.assign(o.yAxis, {
      name: 'TEU', min: 0, max: Math.max(3.5e6, Math.ceil(maxV / 5e5) * 5e5), interval: 5e5,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v >= 1e6 ? +(v / 1e6).toFixed(1) + 'm' : v >= 1e3 ? +(v / 1e3).toFixed(0) + 'k' : v; } },
    });
    o.series = series.map(function (s) {
      return { name: s[0], type: 'line', data: s[1], showSymbol: false, connectNulls: true, lineStyle: { width: 2, color: s[2] } };
    });
    return o;
  });

  /* ── p19 — Individuals Accessing a GP (single line, count; FY labels) ── */
  reg('commercial-p19', function (tabs) {
    var t = tabs['individuals-who-accessed-gp-data'];
    if (!t || !t.date || !t.peopleWhoSawAGp) return null;
    var labels = t.date.map(String);
    var nums = (t.peopleWhoSawAGp || []).filter(function (v) { return typeof v === 'number' && !isNaN(v); });
    if (!nums.length) return null;
    var lo = Math.floor(Math.min.apply(null, nums) / 1e6) * 1e6;
    var hi = Math.ceil(Math.max.apply(null, nums) / 1e6) * 1e6;
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['People who saw a GP'] });
    o.xAxis = Object.assign(o.xAxis, { data: labels });
    o.yAxis = Object.assign(o.yAxis, {
      name: 'People who saw a GP', min: lo, max: hi, interval: 1e6,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v / 1e6) + 'm'; } },
    });
    o.series = [
      { name: 'People who saw a GP', type: 'line', data: t.peopleWhoSawAGp, showSymbol: false, lineStyle: { width: 2, color: '#000' } },
    ];
    return o;
  });

  /* ── p20 — Population Pyramid (HORIZONTAL grouped bars, 2000 vs 2020) ── */
  reg('commercial-p20', function (tabs) {
    var t = tabs['population-pyramid-data'];
    if (!t || !t.ageGroupYears) return null;
    var ageStart = function (label) { var m = String(label).match(/\d+/); return m ? +m[0] : 0; };
    var ages = t.ageGroupYears.map(String);
    var d2000 = t['2000'] || [];
    var d2020 = t['2020'] || [];
    var order = ages.map(function (_, i) { return i; }).sort(function (a, b) { return ageStart(ages[a]) - ageStart(ages[b]); });
    var cats = order.map(function (i) { return ages[i]; });
    var s2000 = order.map(function (i) { return d2000[i]; });
    var s2020 = order.map(function (i) { return d2020[i]; });
    var o = baseOption();
    return {
      backgroundColor: 'transparent',
      textStyle: o.textStyle,
      grid: { left: 64, right: 30, top: 50, bottom: 40 },
      legend: Object.assign(o.legend, { data: ['2000', '2020'] }),
      tooltip: o.tooltip,
      xAxis: {
        type: 'value', min: 0, max: 0.09, interval: 0.01,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } },
        splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } },
      },
      yAxis: {
        type: 'category', data: cats, axisLine: { lineStyle: { color: '#1a2236' } }, axisTick: { show: false },
        axisLabel: { color: '#1a2236', fontSize: 11 },
      },
      series: [
        { name: '2000', type: 'bar', data: s2000, itemStyle: { color: COLORS[2] } },
        { name: '2020', type: 'bar', data: s2020, itemStyle: { color: COLORS[3] } },
      ],
    };
  });

  /* ── p21 — GP Visits by Age (vertical bar, % accessing 0–100%) ── */
  reg('commercial-p21', function (tabs) {
    var t = tabs['pop-accessing-health-services-data'];
    if (!t || !t.range || !t.sawAGeneralPractitioner) return null;
    var o = baseOption();
    return {
      backgroundColor: 'transparent',
      textStyle: o.textStyle,
      grid: { left: 56, right: 28, top: 30, bottom: 40 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: {
        type: 'category', data: t.range, axisLine: { lineStyle: { color: '#1a2236' } }, axisTick: { show: false },
        axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v; } }, splitLine: { show: false },
      },
      yAxis: {
        type: 'value', min: 0, max: 1, interval: 0.2, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } },
        splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } },
      },
      series: [
        { name: 'Accessing health services', type: 'bar', data: t.sawAGeneralPractitioner, itemStyle: { color: COLORS[2] }, barWidth: '55%' },
      ],
    };
  });

  /* ── p22 — Federal Health Budget (vertical bar; $m→$b auto-scale) ── */
  reg('commercial-p22', function (tabs) {
    var t = tabs['fed-gov-health-budget-data'];
    if (!t || !t.date || !t.data) return null;
    var labels = t.date.map(String);
    var nums = (t.data || []).filter(function (v) { return typeof v === 'number' && !isNaN(v); });
    if (!nums.length) return null;
    var maxRaw = Math.max.apply(null, nums);
    var scale = maxRaw > 1000 ? 0.001 : 1;
    var data = t.data.map(function (v) { return (typeof v === 'number' && !isNaN(v)) ? +(v * scale).toFixed(1) : v; });
    var maxV = maxRaw * scale;
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Spendings'] });
    o.xAxis = Object.assign(o.xAxis, { data: labels });
    o.yAxis = Object.assign(o.yAxis, {
      min: 0, max: Math.max(120, Math.ceil(maxV / 20) * 20), interval: 20,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v; } },
    });
    o.series = [
      { name: 'Spendings', type: 'bar', data: data, itemStyle: { color: COLORS[2] }, barWidth: '60%' },
    ];
    return o;
  });

  /* ── p23 — Work From Home (5 state lines WITH symbols, census years, %) ── */
  reg('commercial-p23', function (tabs) {
    var t = tabs['work-from-home-data'];
    if (!t || !t.censusYear) return null;
    var years = t.censusYear.map(String);
    var series = [
      ['NSW', t.nsw, '#000'], ['VIC', t.vic, '#5cc8e0'], ['QLD', t.qld, '#f5a623'],
      ['SA', t.sa, '#c2a4d6'], ['WA', t.wa, '#3ecf8e'],
    ].filter(function (s) { return Array.isArray(s[1]) && s[1].length; });
    if (!series.length) return null;
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: series.map(function (s) { return s[0]; }) });
    o.xAxis = Object.assign(o.xAxis, { data: years });
    o.yAxis = Object.assign(o.yAxis, { axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return (v * 100).toFixed(0) + '%'; } } });
    o.series = series.map(function (s) {
      return { name: s[0], type: 'line', data: s[1], showSymbol: true, symbolSize: 5, lineStyle: { width: 2, color: s[2] } };
    });
    return o;
  });

  /* ── p24 — E-Commerce Sales (single line, $billions; calendar-year labels) ── */
  reg('commercial-p24', function (tabs) {
    var t = tabs['national-e-commerce-sales-data'];
    if (!t || !t.date || !t.data) return null;
    var labels = t.date.map(function (d) { var m = String(d).match(/(\d{4})/); return m ? m[1] : String(d); });
    var present = (t.data || []).filter(function (v) { return typeof v === 'number' && !isNaN(v); });
    var maxV = present.length ? Math.max.apply(null, present) : 45;
    var o = baseOption();
    o.legend = Object.assign(o.legend, { data: ['Sales'] });
    o.xAxis = Object.assign(o.xAxis, { data: labels });
    o.yAxis = Object.assign(o.yAxis, {
      name: 'Spendings (Billions)', min: 0, max: Math.max(45, Math.ceil(maxV / 5) * 5), interval: 5,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v; } },
    });
    o.series = [
      { name: 'Sales', type: 'line', data: t.data, showSymbol: false, lineStyle: { width: 2, color: '#000' } },
    ];
    return o;
  });

  NS.commercial = NS.commercial || {};
  Object.assign(NS.commercial, { baseOption: baseOption, applyDefaults: applyDefaults, COLORS: COLORS });
})(window.PpaCharts);
