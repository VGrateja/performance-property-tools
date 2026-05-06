/* ─────────────────────────────────────────────────────────────────────
   Chart: Job Creation Index (single line, monthly)
   ---------------------------------------------------------------------
   Mount:   <div data-chart="job-creation"></div>
   Data:    region.jobCreation { months[YYYY-MM], sydney[] }
   Notes:   Long monthly time-series. Months thinned to one tick per
            quarter so the axis stays readable across ~14 years of data.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { tooltipBase, dot, attachResize, standardLegend } = NS;

  /* Tooltip uses the full "Mon YYYY" form so hover gives a clear
     month-level read even though the axis only shows quarterly ticks. */
  function monthLabel(s) {
    const [y, m] = s.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
  }

  /* Compact "Mon YY" form for the visible axis labels. `month: 'short'`
     resolves to the 3-letter form on en-AU ("Jul", not "July"). */
  function shortMonthLabel(s) {
    const [y, m] = s.split('-').map(Number);
    const mon = new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'short' });
    return mon + ' ' + String(y).slice(-2);
  }

  NS.register('job-creation', function (el, data) {
    const D = data.jobCreation;
    /* Region-specific legend / axis name. Falls back to the active
       region's name (via NS.regionLabels()) even when D doesn't carry
       a regionLabel — happens on first paint when non-Sydney regions
       are rendering from Sydney's static baseline before liveBoot's
       mapped data flows in. */
    const RL = NS.regionLabels();
    const regionLabel = D.regionLabel || RL.region;
    const labelEvery = 6; /* one label every 6 months → Jan + Jul */
    const tickEvery  = 3; /* a tick mark every quarter */
    const lastIdx    = D.months.length - 1; /* always pin the last data point (e.g. Dec 2025) */
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 50, right: 25, bottom: 65, left: 60 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
        formatter: (params) => {
          const p = params[0];
          return `<div style="font-weight:700;margin-bottom:4px">${monthLabel(p.axisValue)}</div>${dot(p.color)}${p.seriesName}: <strong>${Number(p.value).toFixed(1)}</strong>`;
        },
      }),
      legend: standardLegend([{ name: regionLabel }]),
      xAxis: {
        type: 'category',
        data: D.months,
        axisLabel: Object.assign({}, T.axis, {
          /* `interval: 0` + formatter that returns '' for non-eligible
             indices renders every Jan/Jul label AND the very last
             data point, with no risk of ECharts auto-hiding a label
             whose neighbour is being force-shown. See
             chart-mortgage-arrears.js for the full rationale. */
          interval: 0,
          hideOverlap: false,
          formatter: (s, i) =>
            (i % labelEvery === 0 || i === lastIdx) ? shortMonthLabel(s) : '',
          /* Rotated 50° so close-spaced labels (e.g. Oct 25 next to
             the always-shown last point Dec 25) stack more vertically
             and don't overlap horizontally. */
          rotate: 50,
          margin: 10,
        }),
        axisLine: { lineStyle: { color: T.colors.axisLine } },
        axisTick: {
          alignWithLabel: true,
          /* Quarter-tick rhythm: a visible mark every 3 months, plus
             the last data point so the final tick lines up with the
             always-shown last label. */
          interval: (i) => i % tickEvery === 0 || i === lastIdx,
          lineStyle: { color: T.colors.axisLine },
        },
        boundaryGap: false,
      },
      yAxis: {
        type: 'value',
        axisLabel: T.axis,
        splitLine: { lineStyle: { color: T.colors.grid } },
        name: regionLabel,
        nameLocation: 'middle', nameGap: 45, nameRotate: 90,
        nameTextStyle: T.axisName,
      },
      series: [{
        name: regionLabel, type: 'line', smooth: 0.25,
        symbol: 'circle', symbolSize: 7, showSymbol: false,
        emphasis: { scale: false },
        lineStyle: { color: T.colors.house, width: 2 },
        itemStyle: { color: T.colors.house },
        data: D.sydney,
      }],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
