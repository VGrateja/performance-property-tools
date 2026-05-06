/* ─────────────────────────────────────────────────────────────────────
   Chart: Price to Income Ratio (House + Unit lines + crisis markers)
   ---------------------------------------------------------------------
   Mount:   <div data-chart="price-to-income"></div>
   Data:    region.priceToIncome { years[], house[], unit[] }
            region.crises[] (shared)
   Notes:   Same crisis-overlay treatment as Median Price + YoY so the
            three "long-history price" charts read as a family.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, attachResize, standardLegend,
          staircaseYearAxis, crisisMarkLines } = NS;

  NS.register('price-to-income', function (el, data) {
    const D = data.priceToIncome;
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 30, right: 25, bottom: 55, left: 60 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params
            .filter(p => p.seriesName === 'House' || p.seriesName === 'Unit')
            .map(p => `${dot(p.color)}${p.seriesName}: <strong>${Number(p.value).toFixed(2)}</strong>`);
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'House' },
        { name: 'Unit'  },
      ]),
      xAxis: staircaseYearAxis(D.years),
      yAxis: {
        type: 'value', min: 0,
        axisLabel: Object.assign({}, T.axis, { formatter: v => Number(v).toFixed(0) }),
        splitLine: { lineStyle: { color: T.colors.grid } },
        name: 'House | Unit',
        nameLocation: 'middle', nameGap: 45, nameRotate: 90,
        nameTextStyle: T.axisName,
      },
      series: [
        {
          name: 'House', type: 'line',
          symbol: 'circle', symbolSize: 8, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.house, width: 2 },
          itemStyle: { color: T.colors.house },
          data: D.house,
          markLine: {
            symbol: 'none', silent: true,
            data: crisisMarkLines(data.crises),
          },
        },
        {
          name: 'Unit', type: 'line',
          symbol: 'circle', symbolSize: 8, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.unit, width: 2 },
          itemStyle: { color: T.colors.unit },
          data: D.unit,
        },
      ],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
