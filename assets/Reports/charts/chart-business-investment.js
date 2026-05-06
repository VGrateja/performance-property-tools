/* ─────────────────────────────────────────────────────────────────────
   Chart: Business Investment (2 lines + crisis markers)
   ---------------------------------------------------------------------
   Mount: <div data-chart="business-investment"></div>
   Data:  region.businessInvestment { years[], investment[], housePrice[] }
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, attachResize, standardLegend,
          staircaseYearAxis, crisisMarkLines } = NS;

  NS.register('business-investment', function (el, data) {
    const D = data.businessInvestment;
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 30, right: 60, bottom: 55, left: 65 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params.map(p => {
            const v = Number(p.value);
            const f = p.seriesName === 'Median House Price'
              ? fmt.money(v) : (v / 1000).toFixed(0) + 'k';
            return `${dot(p.color)}${p.seriesName}: <strong>${f}</strong>`;
          });
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'Business Investment' },
        { name: 'Median House Price'  },
      ]),
      xAxis: staircaseYearAxis(D.years),
      yAxis: [
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: v => (v / 1000).toFixed(0) + 'k' }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'Business Investment',
          nameLocation: 'middle', nameGap: 50, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: fmt.moneyAxis }),
          splitLine: { show: false },
          name: 'Median House Price',
          nameLocation: 'middle', nameGap: 45, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      series: [
        {
          name: 'Business Investment', type: 'line',
          symbol: 'circle', symbolSize: 8, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.house, width: 2 },
          itemStyle: { color: T.colors.house },
          data: D.investment,
          markLine: {
            symbol: 'none', silent: true,
            data: crisisMarkLines(data.crises),
          },
        },
        {
          name: 'Median House Price', type: 'line', yAxisIndex: 1,
          symbol: 'circle', symbolSize: 8, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.unit, width: 2 },
          itemStyle: { color: T.colors.unit },
          data: D.housePrice,
        },
      ],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
