/* ─────────────────────────────────────────────────────────────────────
   Chart: Income to Rent vs Affordability Index (4 lines)
   ---------------------------------------------------------------------
   Mount: <div data-chart="income-to-rent-ai"></div>
   Data:  region.incomeToRentAi { years, house, unit, aiHouse, aiUnit }
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { tooltipBase, dot, attachResize, standardLegend, staircaseYearAxis } = NS;

  NS.register('income-to-rent-ai', function (el, data) {
    const D = data.incomeToRentAi;
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 50, right: 25, bottom: 55, left: 60 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params.map(p => `${dot(p.color)}${p.seriesName}: <strong>${Number(p.value).toFixed(1)}%</strong>`);
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'House'    },
        { name: 'Unit'     },
        { name: 'AI House' },
        { name: 'AI Unit'  },
      ]),
      xAxis: staircaseYearAxis(D.years),
      yAxis: {
        type: 'value', min: 0,
        axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
        splitLine: { lineStyle: { color: T.colors.grid } },
        name: 'House | Unit | AI House | AI Unit',
        nameLocation: 'middle', nameGap: 45, nameRotate: 90,
        nameTextStyle: T.axisName,
      },
      series: [
        line('House',    D.house,    T.colors.house),
        line('Unit',     D.unit,     T.colors.unit),
        line('AI House', D.aiHouse,  T.colors.houseBar),
        line('AI Unit',  D.aiUnit,   '#ec3c66'),
      ],
    });
    attachResize(chart);
    return chart;
  });

  function line(name, data, color) {
    return {
      name, type: 'line',
      symbol: 'circle', symbolSize: 8, showSymbol: false,
      emphasis: { scale: false },
      lineStyle: { color, width: 2 },
      itemStyle: { color },
      data,
    };
  }
})(window.PpaCharts);
