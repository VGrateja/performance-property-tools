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
     cmk-lines         generic N-series line over one category axis (JLL series)

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
    /* The Australia axis only exists to carry the national line. Without it a
       second axis is an empty label and a second scale the reader has to rule
       out — so it is added only when there is a national series. The first
       axis is named for what it measures when it stands alone; "States and
       territories" is only meaningful as a contrast with "Australia". */
    var hasNational = (d.national || []).length > 0;
    o.yAxis = [
      { type: 'value', name: hasNational ? 'States and territories' : 'Annual increase', min: 0,
        max: Math.ceil(maxS / 20000) * 20000, interval: 20000,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#1a2236', fontSize: 11, formatter: thou },
        splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } } },
    ];
    if (hasNational) {
      o.yAxis.push({ type: 'value', name: 'Australia', min: 0,
        max: Math.ceil(maxN / 50000) * 50000, interval: 50000,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#1a2236', fontSize: 11, formatter: thou },
        splitLine: { show: false } });
    }
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
    /* The STEP labels can carry their own units, because a waterfall's steps
       and its total are often different magnitudes. Health runs ~0.4m steps
       against a 5m total: at two decimals in millions the small years read
       "+0.05m" and "-0.05m" — two different numbers printed identically.
       In thousands they read "+46k" and "-51k". Defaults to div/suffix/dp so
       every existing waterfall is untouched. */
    var ddiv = d.deltaDiv || div,
        dsuf = (d.deltaSuffix != null ? d.deltaSuffix : suffix),
        ddp  = (d.deltaDp == null ? dp : d.deltaDp);
    var fmtDelta = function (v, kind) {
      return (kind === 'down' ? '−' : '+') + (Math.abs(v) / ddiv).toFixed(ddp) + dsuf;
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

  /* ── cmk-lines ───────────────────────────────────────────────────────────
     Generic multi-series line chart over one shared category axis. The other
     four modules here each hard-code their shape; this one does not, so any
     "N named series over the same periods" chart is a DATA change from now on
     rather than a new module.

     data = { cats:['Q1 2000',…],
              series:[{ name:'Sydney', color:'#00A0B4', data:[0.0943,…] },…],
              scale:100, unit:'%', prefix:'', dp:2,        // label formatting
              min:, max:, interval:,                       // y-axis, in DISPLAY units
              tickEvery:8, smooth:false, endLabel:true,
              kind:'bar', diverging:true, overlapBars:true, stack:true } // bar variants

     Values are stored in SOURCE units and multiplied by `scale` for display —
     yields sit in the deck as 0.0521 and render as 5.21%, matching how
     cmk-bond-spread already stores fractions. Nulls are connected so a series
     that starts late (Perth vacancy) stays one line instead of fragmenting.
     `endLabel` writes the series name + latest value at the right of each
     line, which is why grid.right is generous — a legend costs a whole row
     and still makes the reader match colours by eye. */
  reg('cmk-lines', function (d) {
    if (!d || !Array.isArray(d.cats) || !d.cats.length) return null;
    var series = (d.series || []).filter(function (s) {
      return s && Array.isArray(s.data) && s.data.length;
    });
    if (!series.length) return null;

    var scale = (d.scale == null ? 1 : d.scale);
    var unit  = d.unit || '';
    var pre   = d.prefix || '';
    var dp    = (d.dp == null ? 2 : d.dp);
    var fmt = function (v) {
      if (v == null || !isFinite(v)) return '';
      return pre + (v * scale).toFixed(dp) + unit;
    };
    /* Axis ticks carry no decimals unless asked — "6%" reads better than
       "6.00%" next to a 5.21% end label. */
    var adp = (d.axisDp == null ? 0 : d.axisDp);

    /* diverging bars are read AGAINST a zero line, so the sign is half the
       message and has to survive into every label — "0.46" below the axis and
       "0.66" above it look like the same number. Declared up here because the
       tooltip, the axis and the column labels all have to agree. */
    var isBarH = (d.kind === 'barH');
    var isBar = (d.kind === 'bar') || isBarH;
    var isDiv = isBar && !!d.diverging;
    var sign = function (v) { return (v > 0 ? '+' : ''); };
    var fmtV = isDiv ? function (v) {
      if (v == null || !isFinite(v)) return '';
      return sign(v) + fmt(v);
    } : fmt;
    var fmtAxis = function (v) {
      return (isDiv ? sign(v) : '') + pre + (v * scale).toFixed(adp) + unit;
    };

    /* Category axis: label every Nth point, else a 106-quarter axis is a
       smear. tickEvery counts POINTS, not years. */
    var every = d.tickEvery || Math.ceil(d.cats.length / 12);
    var o = baseOption();
    o.grid = { left: 62, right: 118, top: 30, bottom: 46, containLabel: false };
    o.legend = { show: false };
    o.xAxis = Object.assign(o.xAxis, {
      data: d.cats.map(String),
      axisLabel: {
        color: '#1a2236', fontSize: 10, interval: function (i) { return i % every === 0; },
        /* rotateCats is for NAME categories, not periods. Twenty precinct
           names across one axis collide flat — "Outer Central West" alone is
           wider than its slot — and ECharts does not drop or angle them on its
           own, it just overprints. Quarters never need it; they are short and
           thinned by tickEvery. */
        rotate: d.rotateCats || 0,
        formatter: function (v) { return d.stripPrefix ? String(v).slice(3) : String(v); },
      },
    });
    /* WRAPPED IN AN ARRAY ON PURPOSE. commercial-charts.js applyDefaults()
       runs after every module builds, and its slideFill rule rewrites
       grid.right to 34 whenever grid.right >= 50 — which squeezed the 118 set
       above and clipped the end labels to "Melbo…". That rule skips charts
       whose yAxis is an array (it is aimed at single value-axis charts), so a
       one-element array is the supported way to keep the margin. ECharts
       treats [axis] and axis identically. Do not unwrap this. */
    o.yAxis = [Object.assign(o.yAxis, {
      min: (d.min != null ? d.min / scale : null),
      max: (d.max != null ? d.max / scale : null),
      interval: (d.interval != null ? d.interval / scale : null),
      axisLabel: { color: '#1a2236', fontSize: 11, formatter: fmtAxis },
    })];
    /* kind:'barH' is the same chart on its side — a RANKED comparison, where
       the eye runs down a list rather than along a timeline. The axes swap
       wholesale: categories move to y, values to x. `inverse` puts the first
       category at the TOP, because a ranking handed to this module is already
       in the order it should be read, and ECharts otherwise starts from the
       bottom. The category axis stays wrapped in the array for the same
       slideFill reason as above — a horizontal bar needs its right margin for
       the value labels that sit past the end of each bar. */
    if (isBarH) {
      var valueAxis = o.yAxis[0], catAxis = o.xAxis;
      o.xAxis = Object.assign({}, valueAxis, {
        type: 'value', data: undefined,
        splitLine: { lineStyle: { color: 'rgba(26,34,54,0.08)' } },
        axisLine: { show: false }, axisTick: { show: false },
      });
      o.yAxis = [Object.assign({}, catAxis, {
        type: 'category', inverse: true,
        min: undefined, max: undefined, interval: undefined,
        splitLine: { show: false },
        axisLine: { lineStyle: { color: 'rgba(26,34,54,0.25)' } },
        axisTick: { show: false },
        axisLabel: { color: '#1a2236', fontSize: 12, fontWeight: 600, rotate: 0,
                     formatter: function (v) { return String(v); } },
      })];
    }
    o.tooltip = {
      trigger: 'axis',
      backgroundColor: 'rgba(15,25,34,0.95)', borderColor: '#2a3a48',
      textStyle: { color: '#fff', fontFamily: FONT, fontSize: 12 },
      formatter: function (params) {
        var arr = Array.isArray(params) ? params : [params];
        var head = arr.length ? arr[0].axisValue : '';
        /* `tag` is what the legend cannot say. Once two series share a name so
           one chip toggles both, the tooltip would read "Sydney" twice with no
           way to tell the grades apart — the tag ("prime" / "secondary") puts
           that back, and only in the tooltip, where there is room for it. */
        var body = arr.filter(function (p) { return p.value != null; })
          .map(function (p) {
            var s = series[p.seriesIndex];
            var nm = p.seriesName + ((s && s.tag) ? ' ' + s.tag : '');
            return p.marker + nm + ': <strong>' + fmtV(p.value) + '</strong>';
          })
          .join('<br>');
        return '<div style="font-weight:700;margin-bottom:4px">' + head + '</div>' + body;
      },
    };
    var PAL = [C_CYAN, C_BLACK, C_AMBER, C_LILAC, C_GREEN, C_PINK, C_BLUE, C_GREY];
    /* kind:'bar' draws the same data as columns instead of lines. The module
       keeps its name for the sake of the decks already pointing at it — what
       it really is, either way, is "N named series over one category axis".
       Bars want their value ON the column and no end label: a single-period
       chart has no right-hand edge to run a label off, and the reader is
       comparing heights, not following a line. grid.right shrinks to match,
       since the room reserved for end labels is dead space without them. */
    if (isBar) o.grid = Object.assign({}, o.grid, { right: 28 });
    /* Legend mode, for when end labels stop working. Ten series on one axis
       (five cities x two grades) cannot carry a readable label each, so the
       chart instead colours by city, distinguishes the grade with a dashed
       line, and lists the cities once in a legend. Series opt out of the
       legend with inLegend:false, which is how the second grade stays off it.
       End labels are suppressed here — a legend and ten end labels is two
       answers to the same question. */
    var useLegend = !!d.legend;
    if (useLegend) {
      o.grid = Object.assign({}, o.grid, { right: 28, top: 44 });
      o.legend = {
        show: true, top: 4, itemGap: 18, itemWidth: 22, itemHeight: 12,
        textStyle: { color: '#1a2236', fontSize: 11, fontWeight: 600 },
        /* DEDUPED, because a shared name is how two series get ONE legend
           chip. ECharts toggles by name, so naming a city's prime and
           secondary lines both "Sydney" makes one click hide the pair — which
           is the only way a ten-line grade chart becomes readable: tick the
           city you want, leave the rest off. Without the dedupe the legend
           prints "Sydney" twice, one chip per series. */
        data: series.filter(function (s) { return s.inLegend !== false; })
                    .map(function (s) { return s.name; })
                    .filter(function (n, i, a) { return a.indexOf(n) === i; }),
      };
    }
    /* Angled labels need the room back from the plot, or they are clipped by
       the frame instead of colliding with each other — no improvement. Applied
       last so the bar and legend grids above do not overwrite it. */
    if (d.rotateCats) o.grid = Object.assign({}, o.grid, { bottom: 96 });
    /* barH LAST, for the same reason: the bar and legend rules above both
       rewrite grid.right, and a sideways chart needs that margin for the value
       labels running off the end of each bar — the widest of which carries a
       labelNote too. */
    if (isBarH) {
      o.grid = { left: 78, right: 250, top: (d.legend ? 44 : 24), bottom: 40, containLabel: false };
    }
    o.series = series.map(function (s, i) {
      var col = s.color || PAL[i % PAL.length];
      if (isBar) {
        /* Label position is per DATUM, not per series: ECharts puts 'top' at
           the top EDGE of a bar, which for a negative column is the zero end —
           so a whole set of below-axis labels piles up on the axis line.
           'bottom' is the outer end down there, and only the datum knows which
           side it is on. */
        var bars = s.data.map(function (v) {
          if (v == null || !isFinite(v)) return v;
          if (!isDiv) return v;
          return { value: v, label: { position: v < 0 ? 'bottom' : 'top' } };
        });
        var ser = {
          name: s.name || ('Series ' + (i + 1)),
          type: 'bar',
          barMaxWidth: d.barMaxWidth || 64,
          data: bars,
          itemStyle: { color: col },
          label: {
            show: true, position: isBarH ? 'right' : 'top',
            fontSize: 11, fontWeight: 600, color: '#1a2236',
            /* labelNote rides alongside the value, one entry per category —
               "7.08m   84% of residents". A ranked bar usually carries a
               second number that is context rather than magnitude, and it
               belongs on the bar it describes, not in a second series that
               would draw its own bar. */
            formatter: function (p) {
              var txt = fmtV(p.value);
              if (isBarH && Array.isArray(d.labelNote) && d.labelNote[p.dataIndex]) {
                txt += '   ' + d.labelNote[p.dataIndex];
              }
              return txt;
            },
          },
          /* Drop a label rather than print it over its neighbour. Grouped bars
             whose values are nearly equal — four projection years that barely
             move — overlap into "1.43%1.43%", which is worse than no label at
             all. ECharts keeps whichever it can fit and the chart is
             hoverable, so nothing is actually lost. */
          labelLayout: { hideOverlap: true },
        };
        /* overlapBars stacks every series into the SAME slot instead of
           side-by-side. It is what lets one column per category be split
           across N series — the sparse city series behind the precinct bars —
           without ECharts reserving an empty sliver for each series that has
           no value there. */
        if (d.overlapBars) { ser.barGap = '-100%'; ser.z = 2 + i; }
        /* stack makes the N series ONE column per category — the development
           stages of a pipeline rather than six bars side by side. Segment
           labels come off with it: six numbers inside one column is
           unreadable at slide size, and the chart is hoverable, so the
           tooltip is the better place for the breakdown. */
        if (d.stack) { ser.stack = 'total'; ser.label = { show: false }; }
        /* One zero line for the chart, hung off the first series. */
        if (isDiv && i === 0) {
          ser.markLine = {
            silent: true, symbol: 'none', animation: false,
            lineStyle: { color: '#1a2236', width: 1.2, type: 'solid' },
            label: { show: false }, data: [{ yAxis: 0 }],
          };
        }
        return ser;
      }
      return {
        name: s.name || ('Series ' + (i + 1)),
        type: 'line',
        smooth: !!d.smooth,
        showSymbol: false,
        connectNulls: true,
        data: s.data,
        /* dashed marks a second series of the same colour — the other grade
           of the same city — so colour reads as place and pattern as grade. */
        lineStyle: { width: 2.2, color: col, type: s.dashed ? 'dashed' : 'solid' },
        itemStyle: { color: col },
        endLabel: (d.endLabel === false || useLegend) ? { show: false } : {
          show: true, fontSize: 10, fontWeight: 600, color: col,
          formatter: function (p) { return (s.name || '') + ' ' + fmt(p.value); },
        },
        labelLayout: { moveOverlap: 'shiftY' },
      };
    });
    return o;
  });
})(window.PpaCharts);
