/* ─────────────────────────────────────────────────────────────────────
   Commercial Market deck — extra chart modules (window.PpaCharts registry)
   ---------------------------------------------------------------------
   Four charts the Commercial Research Report does NOT have, built for the
   one-click "Commercial Market deck" in tools/presentation.html (Saskia's
   2026-09-07 brief). They are DECK-ONLY: nothing in commercial-report.html
   renders them.

   Why a module and not a raw ECharts option: a deck is stored as JSON, so an
   option carrying formatter FUNCTIONS loses them on the first save. A module
   stores only plain `data` and rebuilds the option in code at every render —
   exactly how the report charts survive a round trip. It also means the deck's
   auto-refresh can hand the same module fresh numbers.

   Look: built on commercial-charts.js's own baseOption() + applyDefaults() so
   these sit beside the transplanted report graphs without a visible seam.
   Every module sets its x-axis axisLabel.formatter as a FUNCTION on purpose —
   applyDefaults only injects its staircase/interval-0 label rule when there is
   no formatter, and interval 0 on a 270-point monthly axis is a black smear.

   Modules:
     cmk-bond-spread   10-yr government + corporate bond yields on one axis
     cmk-retail-split  in-store v online retail, stacked $bn + online-share line
     cmk-pop-growth    Centre for Population growth: state bars + national line
     cmk-waterfall     generic waterfall (base + delta stack), used for health

   Loads AFTER commercial-charts.js. ECharts required.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  if (!NS) { window.PpaCharts = window.PpaCharts || {}; NS = window.PpaCharts; }
  if (typeof NS.register !== 'function') return;   /* _helpers.js missing → nothing to hang off */

  var FONT = 'Ubuntu, "Roboto", sans-serif';
  var CR = NS.commercial || {};
  /* Report palette (commercial-charts.js COLORS): black, amber, cyan, grey… */
  var C_BLACK = '#000000', C_AMBER = '#f5a623', C_CYAN = '#5cc8e0', C_GREY = '#9aa3b1',
      C_GREEN = '#3ecf8e', C_LILAC = '#c2a4d6', C_PINK = '#e58fa8', C_BLUE = '#86a8ff',
      C_RED = '#e57b7b';

  /* Fallback for the two helpers commercial-charts.js exports, so a load-order
     surprise degrades to a plain chart instead of a thrown error. */
  function baseOption() {
    if (typeof CR.baseOption === 'function') return CR.baseOption();
    return {
      backgroundColor: 'transparent',
      textStyle: { fontFamily: FONT, color: '#1a2236' },
      grid: { left: 60, right: 60, top: 50, bottom: 70, containLabel: false },
      legend: { top: 4, left: 60, orient: 'horizontal', itemGap: 28, itemWidth: 22, itemHeight: 12,
        textStyle: { color: '#1a2236', fontSize: 12, fontWeight: 600 } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
      xAxis: { type: 'category', axisLine: { lineStyle: { color: '#1a2236' } }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11 }, splitLine: { show: false } },
      yAxis: { type: 'value', axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#1a2236', fontSize: 11 }, splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
    };
  }
  function applyDefaults(option, opts) {
    if (typeof CR.applyDefaults === 'function') return CR.applyDefaults(option, opts);
    return option;
  }

  /* Same contract as commercial-charts.js's own reg(): the registry entry
     builds the option, applies the shared slide defaults and inits ECharts.
     present-charts.js createFromModule() then animates the build. */
  function reg(name, build) {
    NS.register(name, function (el, data) {
      var opt = build(data || {});
      if (!opt) return echarts.init(el);
      applyDefaults(opt, { slideFill: true });
      var chart = echarts.init(el, null, { renderer: 'canvas' });
      chart.setOption(opt);
      return chart;
    });
  }

  var pct0 = function (v) { return (v * 100).toFixed(0) + '%'; };
  var pct1 = function (v) { return (v * 100).toFixed(1) + '%'; };
  var thou = function (v) { return v >= 1000 ? Math.round(v / 1000) + 'k' : String(v); };
  var same = function (v) { return String(v); };

  /* ── cmk-bond-spread ─────────────────────────────────────────────────────
     data = { labels:['Jan 04',…], gov:[0.0561,…], corp:[…|null],
              tickEvery:18, maxV:0.07, callout:'SPREAD (JUN 2026)\n…' }
     Both series are FRACTIONS (0.0492 = 4.92%), as stored in the commercial
     snapshot. Nulls are drawn through (connectNulls) so the corporate line,
     which starts a year later and ends two months earlier, stays one line. */
  reg('cmk-bond-spread', function (d) {
    if (!d || !Array.isArray(d.labels) || !d.labels.length) return null;
    var o = baseOption();
    var maxV = (typeof d.maxV === 'number' && d.maxV > 0) ? d.maxV : 0.08;
    o.grid = { left: 52, right: 28, top: 52, bottom: 46, containLabel: false };
    o.legend = Object.assign(o.legend, { data: ['10 yr government bond', '10 yr corporate bond'] });
    if (d.callout) {
      o.graphic = [{ type: 'text', right: 14, top: 12, style: {
        text: d.callout, textAlign: 'right', fontWeight: 'bold', fontSize: 12,
        fill: '#1a2236', lineHeight: 17, font: 'bold 12px ' + FONT } }];
    }
    o.xAxis = Object.assign(o.xAxis, {
      data: d.labels,
      axisLabel: { color: '#1a2236', fontSize: 10, rotate: 0,
        interval: Math.max(1, d.tickEvery || Math.floor(d.labels.length / 14)),
        formatter: same },
    });
    o.yAxis = Object.assign(o.yAxis, {
      min: 0, max: Math.ceil(maxV * 100) / 100, interval: 0.01,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: pct0 },
    });
    o.tooltip = Object.assign({}, o.tooltip, {
      backgroundColor: 'rgba(15,25,34,0.95)', borderColor: '#2a3a48',
      textStyle: { color: '#fff', fontFamily: FONT, fontSize: 12 },
      formatter: function (params) {
        var arr = Array.isArray(params) ? params : [params];
        var head = arr.length ? arr[0].axisValue : '';
        var lines = arr.filter(function (p) { return p.value != null; }).map(function (p) {
          return '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' +
            p.color + ';margin-right:6px"></span>' + p.seriesName + ': <strong>' + pct1(p.value) + '</strong>';
        });
        return '<div style="font-weight:700;margin-bottom:4px">' + head + '</div>' + lines.join('<br/>');
      },
    });
    o.series = [
      { name: '10 yr government bond', type: 'line', data: d.gov || [], showSymbol: false,
        connectNulls: true, lineStyle: { width: 1.6, color: C_BLACK } },
      { name: '10 yr corporate bond', type: 'line', data: d.corp || [], showSymbol: false,
        connectNulls: true, lineStyle: { width: 1.6, color: C_CYAN } },
    ];
    return o;
  });

  /* ── cmk-retail-split ────────────────────────────────────────────────────
     data = { years:[2013,…], instore:[$bn…], online:[$bn…], share:[8.5,…] }
     Stacked bars are the two halves of total retail turnover; the line is the
     online share on its own right axis. */
  reg('cmk-retail-split', function (d) {
    if (!d || !Array.isArray(d.years) || !d.years.length) return null;
    var totals = d.years.map(function (_, i) {
      return (Number(d.instore[i]) || 0) + (Number(d.online[i]) || 0);
    });
    var maxT = Math.max.apply(null, totals.concat([1]));
    var maxS = Math.max.apply(null, (d.share || []).concat([1]));
    var o = baseOption();
    o.grid = { left: 62, right: 58, top: 52, bottom: 40, containLabel: false };
    o.legend = Object.assign(o.legend, { data: ['In-store', 'Online', 'Online share'] });
    o.xAxis = Object.assign(o.xAxis, {
      data: d.years.map(String),
      axisLabel: { color: '#1a2236', fontSize: 11, interval: 0, formatter: same },
    });
    o.yAxis = [
      { type: 'value', name: 'Retail turnover ($ billions)', min: 0,
        max: Math.ceil(maxT / 50) * 50, interval: 50,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#1a2236', fontSize: 11, formatter: same },
        splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
      { type: 'value', name: 'Online share', min: 0,
        max: Math.max(10, Math.ceil(maxS / 2) * 2), interval: 2,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#1a2236', fontSize: 11, formatter: function (v) { return v + '%'; } },
        splitLine: { show: false } },
    ];
    o.series = [
      { name: 'In-store', type: 'bar', stack: 'retail', barWidth: '58%',
        data: d.instore, itemStyle: { color: C_GREY } },
      { name: 'Online', type: 'bar', stack: 'retail',
        data: d.online, itemStyle: { color: C_CYAN } },
      { name: 'Online share', type: 'line', yAxisIndex: 1, data: d.share,
        showSymbol: true, symbolSize: 6, lineStyle: { width: 2, color: C_AMBER },
        itemStyle: { color: C_AMBER } },
    ];
    return o;
  });

  /* ── cmk-pop-growth ──────────────────────────────────────────────────────
     data = { years:['2025-26',…], states:[{name,data,color}], national:[…] }
     Grouped state bars on the left axis; the national total is an order of
     magnitude larger so it rides a right axis as a line — the same dual-axis
     convention the report's own Population Growth page (p9) uses. */
  reg('cmk-pop-growth', function (d) {
    if (!d || !Array.isArray(d.years) || !d.years.length) return null;
    var states = (d.states || []).filter(function (s) { return s && Array.isArray(s.data) && s.data.length; });
    if (!states.length) return null;
    var maxS = 1, maxN = 1;
    states.forEach(function (s) { s.data.forEach(function (v) { if (typeof v === 'number' && v > maxS) maxS = v; }); });
    (d.national || []).forEach(function (v) { if (typeof v === 'number' && v > maxN) maxN = v; });
    var o = baseOption();
    o.grid = { left: 62, right: 62, top: 52, bottom: 40, containLabel: false };
    o.legend = Object.assign(o.legend, {
      itemGap: 18,
      data: states.map(function (s) { return s.name; }).concat((d.national || []).length ? ['Australia'] : []),
    });
    o.xAxis = Object.assign(o.xAxis, {
      data: d.years.map(String),
      axisLabel: { color: '#1a2236', fontSize: 11, interval: 0, formatter: same },
    });
    o.yAxis = [
      { type: 'value', name: 'States and territories', min: 0,
        max: Math.ceil(maxS / 20000) * 20000, interval: 20000,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#1a2236', fontSize: 11, formatter: thou },
        splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
      { type: 'value', name: 'Australia', min: 0,
        max: Math.ceil(maxN / 50000) * 50000, interval: 50000,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#1a2236', fontSize: 11, formatter: thou },
        splitLine: { show: false } },
    ];
    o.series = states.map(function (s) {
      return { name: s.name, type: 'bar', barMaxWidth: 22, data: s.data,
        itemStyle: { color: s.color || C_GREY } };
    });
    if ((d.national || []).length) {
      o.series.push({ name: 'Australia', type: 'line', yAxisIndex: 1, data: d.national,
        showSymbol: true, symbolSize: 7, lineStyle: { width: 2.4, color: C_RED, type: 'dashed' },
        itemStyle: { color: C_RED } });
    }
    return o;
  });

  /* ── cmk-waterfall ───────────────────────────────────────────────────────
     Generic waterfall: an invisible `base` bar carries each visible `delta`
     bar up to its cumulative position (the standard stacked-bar trick).
     data = { cats:[], base:[], delta:[], dir:['total'|'up'|'down'],
              axis:{min,max,interval}, div:1e6, suffix:'m', dp:2, name:'…' }
     `div`/`suffix`/`dp` only format the bar labels and tooltip — the values
     themselves stay in their source units. */
  reg('cmk-waterfall', function (d) {
    if (!d || !Array.isArray(d.cats) || !d.cats.length) return null;
    var div = d.div || 1, suffix = d.suffix || '', dp = (d.dp == null ? 2 : d.dp);
    /* Bar labels carry the precision that matters; the axis ticks do not need
       it (…6.00m, 5.00m reads as noise next to +0.43m). */
    var adp = (d.axisDp == null ? 0 : d.axisDp);
    var ax = d.axis || {};
    var COL = { total: C_BLACK, up: C_CYAN, down: C_RED };
    var fmtAbs = function (v) { return (v / div).toFixed(dp) + suffix; };
    var fmtAxis = function (v) { return (v / div).toFixed(adp) + suffix; };
    /* `delta` is always POSITIVE (an ECharts stack sums negatives on the other
       side of zero, so a down step is carried by a lower base instead of a
       negative value). The sign therefore comes from `dir`, not the number. */
    var fmtDelta = function (v, kind) {
      return (kind === 'down' ? '−' : '+') + (Math.abs(v) / div).toFixed(dp) + suffix;
    };
    var o = baseOption();
    o.grid = { left: 58, right: 28, top: 34, bottom: 52, containLabel: false };
    o.legend = { show: false };
    o.xAxis = Object.assign(o.xAxis, {
      data: d.cats.map(String),
      axisLabel: { color: '#1a2236', fontSize: 10, interval: 0, rotate: d.cats.length > 10 ? 45 : 0, formatter: same },
    });
    o.yAxis = Object.assign(o.yAxis, {
      min: (ax.min != null ? ax.min : 0),
      max: (ax.max != null ? ax.max : null),
      interval: ax.interval || null,
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: fmtAxis },
    });
    o.tooltip = {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      backgroundColor: 'rgba(15,25,34,0.95)', borderColor: '#2a3a48',
      textStyle: { color: '#fff', fontFamily: FONT, fontSize: 12 },
      formatter: function (params) {
        var arr = Array.isArray(params) ? params : [params];
        var head = arr.length ? arr[0].axisValue : '';
        var i = arr.length ? arr[0].dataIndex : 0;
        var kind = (d.dir || [])[i] || 'up';
        var val = (d.delta || [])[i];
        var body = (kind === 'total')
          ? (d.name || 'Total') + ': <strong>' + fmtAbs(val) + '</strong>'
          : 'Change: <strong>' + fmtDelta(val, kind) + '</strong>';
        return '<div style="font-weight:700;margin-bottom:4px">' + head + '</div>' + body;
      },
    };
    o.series = [
      { name: '_base', type: 'bar', stack: 'wf', silent: true, barMaxWidth: 46,
        data: d.base, itemStyle: { color: 'transparent' },
        emphasis: { itemStyle: { color: 'transparent' } } },
      { name: d.name || 'Change', type: 'bar', stack: 'wf', barMaxWidth: 46,
        data: (d.delta || []).map(function (v, i) {
          var kind = (d.dir || [])[i] || 'up';
          return { value: v, itemStyle: { color: COL[kind] || C_CYAN } };
        }),
        label: {
          show: true, position: 'top', fontFamily: FONT, fontSize: 10, fontWeight: 600,
          color: '#1a2236',
          formatter: function (p) {
            var kind = (d.dir || [])[p.dataIndex] || 'up';
            return kind === 'total' ? fmtAbs(p.value) : fmtDelta(p.value, kind);
          },
        } },
    ];
    return o;
  });
})(window.PpaCharts);
