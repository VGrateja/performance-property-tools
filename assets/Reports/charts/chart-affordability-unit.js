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
      yAxis: [
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'AI P&I Loan Unit',
          nameLocation: 'middle', nameGap: 45, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          type: 'value',
          axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
          splitLine: { show: false },
          name: 'Unit Price Movement',
          nameLocation: 'middle', nameGap: 40, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      series: [
        { name: 'AI P&I Loan Unit', type: 'bar', data: D.ai,
          itemStyle: { color: T.colors.houseBar }, barCategoryGap: '30%' },
        {
          name: 'Unit Price Movement', type: 'line', yAxisIndex: 1,
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
