/* ─────────────────────────────────────────────────────────────────────
   Chart: FHB as a % of Population (bars + percentage line)
   ---------------------------------------------------------------------
   Mount: <div data-chart="fhb-percentage"></div>
   Data:  region.fhbPopulation { years[], annualised[], pct[] }
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { tooltipBase, dot, attachResize, standardLegend, staircaseYearAxis } = NS;

  NS.register('fhb-percentage', function (el, data) {
    const D = data.fhbPopulation;
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 50, right: 60, bottom: 55, left: 65 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(92,200,224,0.1)' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params.map(p => {
            const v = Number(p.value);
            const f = p.seriesName === 'FHB as % of Population'
              ? v.toFixed(2) + '%'
              : (v / 1000).toFixed(1) + 'k';
            return `${dot(p.color)}${p.seriesName}: <strong>${f}</strong>`;
          });
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'Annualised FHB', icon: 'rect' },
        { name: 'FHB as % of Population' },
      ]),
      xAxis: staircaseYearAxis(D.years, { boundaryGap: true }),
      yAxis: [
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: v => (v / 1000).toFixed(0) + 'k' }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'Annualised FHB',
          nameLocation: 'middle', nameGap: 50, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: v => v.toFixed(1) + '%' }),
          splitLine: { show: false },
          name: 'FHB as % of Population',
          nameLocation: 'middle', nameGap: 45, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      series: [
        { name: 'Annualised FHB', type: 'bar', data: D.annualised,
          itemStyle: { color: T.colors.houseBar }, barCategoryGap: '30%' },
        {
          name: 'FHB as % of Population', type: 'line', yAxisIndex: 1,
          symbol: 'circle', symbolSize: 8, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.house, width: 2 },
          itemStyle: { color: T.colors.house },
          data: D.pct,
        },
      ],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
