/* ─────────────────────────────────────────────────────────────────────
   Chart: Current Investment Value (gross yield by capital city)
   ---------------------------------------------------------------------
   Mount: <div data-chart="current-investment-value"></div>
   Data:  region.currentInvestmentValue { cities[], houseYield[], unitYield[] }
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, attachResize, standardLegend } = NS;

  NS.register('current-investment-value', function (el, data) {
    const D = data.currentInvestmentValue;
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 50, right: 25, bottom: 50, left: 65 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(92,200,224,0.1)' } },
        formatter: (params) => {
          const city = params[0].axisValue;
          const lines = params.map(p => `${dot(p.color)}${p.seriesName}: <strong>${Number(p.value).toFixed(2)}%</strong>`);
          return `<div style="font-weight:700;margin-bottom:4px">${city}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'House Yield', icon: 'rect' },
        { name: 'Unit Yield',  icon: 'rect' },
      ]),
      xAxis: {
        type: 'category', data: D.cities,
        axisLabel: Object.assign({}, T.axis, { fontSize: 12, fontWeight: 600 }),
        axisLine: { lineStyle: { color: T.colors.axisLine } },
        axisTick: { alignWithLabel: true },
      },
      yAxis: {
        type: 'value', min: 0,
        axisLabel: Object.assign({}, T.axis, { formatter: v => v.toFixed(2) + '%' }),
        splitLine: { lineStyle: { color: T.colors.grid } },
      },
      series: [
        { name: 'House Yield', type: 'bar', data: D.houseYield,
          itemStyle: { color: T.colors.houseBar, borderRadius: [3, 3, 0, 0] },
          barGap: '0%', barCategoryGap: '40%',
          label: { show: true, position: 'top',
                   formatter: p => Number(p.value).toFixed(2) + '%',
                   color: T.colors.text, fontFamily: T.fonts.chart,
                   fontSize: 11, fontWeight: 600 },
        },
        { name: 'Unit Yield', type: 'bar', data: D.unitYield,
          itemStyle: { color: T.colors.unitBar, borderRadius: [3, 3, 0, 0] },
          label: { show: true, position: 'top',
                   formatter: p => Number(p.value).toFixed(2) + '%',
                   color: T.colors.text, fontFamily: T.fonts.chart,
                   fontSize: 11, fontWeight: 600 },
        },
      ],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
