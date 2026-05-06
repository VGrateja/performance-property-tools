/* ─────────────────────────────────────────────────────────────────────
   Chart: Mineral Exploration Expenditure (Perth-only, page 25)
   ---------------------------------------------------------------------
   Mount: <div data-chart="mineral-exploration-expenditure"></div>
   Data:  region.mineralExploration { quarters[], values[] }
          quarters[] entries are "Q1 2007" / "Q3 2025" style strings.

   Quarterly single-line chart matching the Perth PDF page 25. No
   crisis markers (the PDF doesn't show them on this page). Axis
   strategy mirrors chart-mortgage-arrears.js: every label rendered
   via interval:0 + formatter that returns '' for omitted quarters,
   so the rightmost label always shows even when it sits next to a
   regular tick.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { tooltipBase, dot, attachResize, standardLegend } = NS;

  NS.register('mineral-exploration-expenditure', function (el, data) {
    const D = data.mineralExploration;
    if (!D) return; /* Perth-only data; safe-guard for other regions */
    const labelEvery = 4;  /* one label per year (every 4 quarters) */
    const lastIdx    = D.quarters.length - 1;
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 50, right: 30, bottom: 70, left: 65 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
        formatter: (params) =>
          `<div style="font-weight:700;margin-bottom:4px">${params[0].axisValue}</div>` +
          params.map(p => `${dot(p.color)}${p.seriesName}: <strong>$${Number(p.value).toFixed(1)}m</strong>`).join('<br/>'),
      }),
      legend: standardLegend([{ name: 'Mineral Exploration' }]),
      xAxis: {
        type: 'category',
        data: D.quarters,
        axisLabel: Object.assign({}, T.axis, {
          /* Show one label per year (every 4th quarter) PLUS the last
             data point. Empty-string labels for the rest have zero
             rendered width, so they can't overlap or be auto-hidden —
             see chart-mortgage-arrears.js for the full rationale. */
          interval: 0,
          hideOverlap: false,
          formatter: (s, i) =>
            (i % labelEvery === 0 || i === lastIdx) ? s : '',
          rotate: 35,
          margin: 10,
        }),
        axisLine: { lineStyle: { color: T.colors.axisLine } },
        axisTick: {
          alignWithLabel: true,
          /* A visible tick on every quarter (quarterly cadence is the
             whole point of this chart) plus the last point. */
          interval: 0,
          lineStyle: { color: T.colors.axisLine },
        },
        boundaryGap: false,
      },
      yAxis: {
        type: 'value', min: 0,
        axisLabel: Object.assign({}, T.axis, { formatter: v => '$' + v + 'm' }),
        splitLine: { lineStyle: { color: T.colors.grid } },
        name: 'Mineral Exploration ($m)',
        nameLocation: 'middle', nameGap: 50, nameRotate: 90,
        nameTextStyle: T.axisName,
      },
      series: [{
        name: 'Mineral Exploration', type: 'line', smooth: 0.2,
        symbol: 'circle', symbolSize: 6, showSymbol: false,
        emphasis: { scale: false },
        lineStyle: { color: T.colors.house, width: 1.8 },
        itemStyle: { color: T.colors.house },
        data: D.values,
      }],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
