/* ─────────────────────────────────────────────────────────────────────
   Chart: Iron Ore Price vs Median House Price (Perth-only, page 14)
   ---------------------------------------------------------------------
   Mount: <div data-chart="iron-ore-price"></div>
   Data:  region.ironOrePrice { years[], medianHouse[], ironOre[] }

   Dual-axis comparison line chart matching the Perth PDF page 14
   layout. Mirrors the pattern of chart-yield-vs-cash-house.js: same
   staircase year axis + crisis markers from data.crises, two series
   on opposing y-axes (Median House Price on the LEFT in dark navy,
   Iron Ore on the RIGHT in orange — matching the PDF).
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, attachResize, standardLegend,
          staircaseYearAxis, crisisMarkLines } = NS;

  NS.register('iron-ore-price', function (el, data) {
    const D = data.ironOrePrice;
    if (!D) return; /* Perth-only data; safe-guard for other regions */
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
              ? fmt.money(v)
              : '$' + v.toFixed(0) + '/t';
            return `${dot(p.color)}${p.seriesName}: <strong>${f}</strong>`;
          });
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'Median House Price' },
        { name: 'Iron Ore'           },
      ]),
      xAxis: staircaseYearAxis(D.years),
      yAxis: [
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: fmt.moneyAxis }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'Median House Price',
          nameLocation: 'middle', nameGap: 50, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: v => v }),
          splitLine: { show: false },
          name: 'Iron Ore (USD / tonne)',
          nameLocation: 'middle', nameGap: 40, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      series: [
        {
          name: 'Median House Price', type: 'line',
          yAxisIndex: 0,
          symbol: 'circle', symbolSize: 7, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.house, width: 2 },
          itemStyle: { color: T.colors.house },
          data: D.medianHouse,
          /* Crisis markers attached to the first series so they only
             draw once. */
          markLine: {
            symbol: 'none', silent: true,
            data: crisisMarkLines(data.crises),
          },
        },
        {
          name: 'Iron Ore', type: 'line',
          yAxisIndex: 1,
          symbol: 'circle', symbolSize: 7, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.unit, width: 2 },
          itemStyle: { color: T.colors.unit },
          data: D.ironOre,
        },
      ],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
