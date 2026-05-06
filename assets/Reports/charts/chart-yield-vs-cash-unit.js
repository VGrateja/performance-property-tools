/* ─────────────────────────────────────────────────────────────────────
   Chart: Yield vs Cash Rate (UNIT) — 4 lines + crisis markers
   ---------------------------------------------------------------------
   Mount: <div data-chart="yield-vs-cash-unit"></div>
   Data:  region.yieldVsCashUnit { years[], yieldRate[], cashRate[],
          variableRate[], unitPrice[] }
   Notes: Mirror of yield-vs-cash-house but unit-keyed.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, attachResize, standardLegend,
          staircaseYearAxis, crisisMarkLines } = NS;

  NS.register('yield-vs-cash-unit', function (el, data) {
    const D = data.yieldVsCashUnit;
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
            const f = p.seriesName === 'Median Unit Price'
              ? fmt.money(v) : v.toFixed(2) + '%';
            return `${dot(p.color)}${p.seriesName}: <strong>${f}</strong>`;
          });
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'Yield Rate'        },
        { name: 'Cash Rate'         },
        { name: 'Variable Rate'     },
        { name: 'Median Unit Price' },
      ]),
      xAxis: staircaseYearAxis(D.years),
      yAxis: [
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'Yield Rate | Cash Rate | Variable Rate',
          nameLocation: 'middle', nameGap: 50, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: fmt.moneyAxis }),
          splitLine: { show: false },
          name: 'Median Unit Price',
          nameLocation: 'middle', nameGap: 45, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      /* Series colours match the Sydney PDF (page 26):
         - Yield Rate         → cyan / sky blue
         - Cash Rate          → orange
         - Variable Rate      → medium gray
         - Median Unit Price  → dark navy on the right axis */
      series: [
        {
          name: 'Yield Rate', type: 'line',
          symbol: 'circle', symbolSize: 8, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.houseBar, width: 2 },
          itemStyle: { color: T.colors.houseBar },
          data: D.yieldRate,
          markLine: {
            symbol: 'none', silent: true,
            data: crisisMarkLines(data.crises),
          },
        },
        line('Cash Rate',         D.cashRate,     T.colors.cashRate,     0),
        line('Variable Rate',     D.variableRate, T.colors.variableRate, 0),
        line('Median Unit Price', D.unitPrice,    T.colors.house,        1),
      ],
    });
    attachResize(chart);
    return chart;
  });

  function line(name, data, color, axisIndex) {
    return {
      name, type: 'line',
      yAxisIndex: axisIndex,
      symbol: 'circle', symbolSize: 8, showSymbol: false,
      emphasis: { scale: false },
      lineStyle: { color, width: 2 },
      itemStyle: { color },
      data,
    };
  }
})(window.PpaCharts);
