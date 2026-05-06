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
      yAxis: [
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'AI P&I Loan House',
          nameLocation: 'middle', nameGap: 45, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          type: 'value',
          axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
          splitLine: { show: false },
          name: 'House Price Movement',
          nameLocation: 'middle', nameGap: 40, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      series: [
        { name: 'AI P&I Loan House', type: 'bar', data: D.ai,
          itemStyle: { color: T.colors.houseBar }, barCategoryGap: '30%' },
        {
          name: 'House Price Movement', type: 'line', yAxisIndex: 1,
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
