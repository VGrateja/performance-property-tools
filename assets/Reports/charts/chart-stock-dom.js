/* ─────────────────────────────────────────────────────────────────────
   Chart: Stock on Market vs Avg Days on Market (combo bar + line)
   ---------------------------------------------------------------------
   Mount:   <div data-chart="stock-dom"></div>
   Data:    region.stockVsDom {years[], house[], unit[], dom[]}
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, attachResize } = NS;

  NS.register('stock-dom', function (el, data) {
    const D = data.stockVsDom;
    const chart = echarts.init(el);
    chart.setOption({
      animation: false,
      grid: { top: 50, right: 70, bottom: 80, left: 70 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(92,200,224,0.1)' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params.map(p => {
            const v = Number(p.value);
            const formatted = p.seriesName === 'Days on Market' ? fmt.days(v) : fmt.integer(v);
            return `${dot(p.color)}${p.seriesName}: <strong>${formatted}</strong>`;
          });
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: {
        bottom: 20, left: 'center',
        textStyle: T.legend,
        data: [
          { name: 'House',          icon: 'rect' },
          { name: 'Unit',           icon: 'rect' },
          { name: 'Days on Market', icon: 'rect' },
        ],
      },
      xAxis: {
        type: 'category',
        data: D.years.map(String),
        axisLabel: Object.assign({}, T.axis, { fontSize: 11 }),
        axisLine: { lineStyle: { color: T.colors.axisLine } },
        axisTick: { alignWithLabel: true },
      },
      yAxis: [
        {
          /* Auto-scaled — Sydney's 20k cap doesn't fit smaller-stock
             regions. */
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: fmt.intK }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'House | Unit',
          nameLocation: 'middle', nameGap: 50, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          /* Auto-scaled — DOM ranges differ per region. */
          type: 'value', min: 0,
          axisLabel: T.axis,
          splitLine: { show: false },
          name: 'Days on Market',
          nameLocation: 'middle', nameGap: 40, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      series: [
        { name: 'House', type: 'bar', data: D.house, itemStyle: { color: '#5cc8e0' }, barGap: '10%', barCategoryGap: '35%' },
        { name: 'Unit',  type: 'bar', data: D.unit,  itemStyle: { color: '#bcc3c8' } },
        {
          name: 'Days on Market', type: 'line',
          yAxisIndex: 1, symbol: 'none',
          lineStyle: { color: T.colors.house, width: 2 },
          itemStyle: { color: T.colors.house },
          data: D.dom,
        },
      ],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
