/* ─────────────────────────────────────────────────────────────────────
   Chart: Affordability Index v Year on Year Price Movement (HOUSE)
   ---------------------------------------------------------------------
   Mount: <div data-chart="affordability-house"></div>
   Data:  region.affordabilityHouse { years[], ai[], priceMovement[] }
   Layout: AI bars (left axis %), price-movement line (right axis %).
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { tooltipBase, dot, attachResize, standardLegend, staircaseYearAxis } = NS;

  NS.register('affordability-house', function (el, data) {
    const D = data.affordabilityHouse;
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
        { name: 'AI P&I Loan House', icon: 'rect' },
        { name: 'House Price Movement' },
      ]),
      xAxis: staircaseYearAxis(D.years, { boundaryGap: true }),
      /* ONE shared % axis (Van 2026-08-12, matching the B/S slides): the old
         dual-axis layout put the movement line's zero on a mid-plot gridline,
         so a negative year (Perth 1991: −2.2%) still drew above the chart
         floor and read as positive. On a shared axis negatives dip below the
         zero gridline; min snaps to a 5%-step so the floor stays tidy. */
      yAxis: {
        type: 'value',
        min: v => Math.min(0, Math.floor(v.min / 5) * 5),
        axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
        splitLine: { lineStyle: { color: T.colors.grid } },
      },
      series: [
        { name: 'AI P&I Loan House', type: 'bar', data: D.ai,
          itemStyle: { color: T.colors.houseBar }, barCategoryGap: '30%' },
        {
          name: 'House Price Movement', type: 'line',
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
