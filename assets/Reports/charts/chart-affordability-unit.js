/* ─────────────────────────────────────────────────────────────────────
   Chart: Affordability Index v Year on Year Price Movement (UNIT)
   ---------------------------------------------------------------------
   Mount: <div data-chart="affordability-unit"></div>
   Data:  region.affordabilityUnit { years[], ai[], priceMovement[] }
   Layout: Mirror of affordability-house but unit-keyed.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { tooltipBase, dot, attachResize, standardLegend, staircaseYearAxis } = NS;

  NS.register('affordability-unit', function (el, data) {
    const D = data.affordabilityUnit;
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 50, right: 60, bottom: 55, left: 65 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(92,200,224,0.1)' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params.map(p => `${dot(p.color)}${p.seriesName}: <strong>${Number(p.value).toFixed(1)}%</strong>`);
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'AI P&I Loan Unit', icon: 'rect' },
        { name: 'Unit Price Movement' },
      ]),
      xAxis: staircaseYearAxis(D.years, { boundaryGap: true }),
      /* ONE shared % axis — same fix as the house chart (Van 2026-08-12):
         the dual-axis layout let negative movement years draw above the
         chart floor. Negatives now dip below the shared zero gridline. */
      yAxis: {
        type: 'value',
        min: v => Math.min(0, Math.floor(v.min / 5) * 5),
        axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
        splitLine: { lineStyle: { color: T.colors.grid } },
      },
      series: [
        { name: 'AI P&I Loan Unit', type: 'bar', data: D.ai,
          itemStyle: { color: T.colors.houseBar }, barCategoryGap: '30%' },
        {
          name: 'Unit Price Movement', type: 'line',
          symbol: 'circle', symbolSize: 8, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.house, width: 2 },
          itemStyle: { color: T.colors.house },
          data: D.priceMovement,
        },
      ],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
