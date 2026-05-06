/* ─────────────────────────────────────────────────────────────────────
   Chart: Median Price (long-history line + crisis overlays)
   ---------------------------------------------------------------------
   Mount:   <div data-chart="median-price"></div>
   Data:    region.medianPrice {years[], house[], unit[]}
            region.crises[]    {year, label, ...}
            region.bands[]     {from, to, type:'growth'|'correct'}
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, staircaseYearAxis,
          crisisMarkLines, crisisMarkAreas, attachResize, insideZoom } = NS;

  NS.register('median-price', function (el, data) {
    const D = data.medianPrice;
    const chart = echarts.init(el);
    chart.setOption({
      animation: false,
      grid: { top: 30, right: 70, bottom: 160, left: 70 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params
            .filter(p => p.seriesName === 'Median House Price' || p.seriesName === 'Median Unit Price')
            .map(p => `${dot(p.color)}${p.seriesName}: <strong>${fmt.money(p.value)}</strong>`);
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: {
        top: 8, left: 'center',
        textStyle: T.legend, itemWidth: 18, itemHeight: 3,
        data: [
          { name: 'Median House Price', icon: 'rect' },
          { name: 'Median Unit Price',  icon: 'rect' },
          { name: 'Growth Period',      icon: 'rect' },
          { name: 'Correction Period',  icon: 'rect' },
        ],
      },
      xAxis: staircaseYearAxis(D.years),
      yAxis: {
        /* Auto-scaled — region prices vary widely (Sydney $1.55M,
           Darwin ~$600k). Let ECharts pick a round max from data. */
        type: 'value', min: 0,
        axisLabel: Object.assign({}, T.axis, { formatter: fmt.moneyAxis }),
        splitLine: { lineStyle: { color: T.colors.grid } },
        name: 'Median House Price | Median Unit Price',
        nameLocation: 'middle', nameGap: 55, nameRotate: 90,
        nameTextStyle: T.axisName,
      },
      dataZoom: insideZoom(),
      series: [
        /* Two empty series purely so the legend renders the band swatches. */
        { name: 'Growth Period',     type: 'line', data: [], itemStyle: { color: 'rgba(125,200,215,0.7)' } },
        { name: 'Correction Period', type: 'line', data: [], itemStyle: { color: 'rgba(160,170,180,0.7)' } },
        {
          name: 'Median House Price', type: 'line', symbol: 'none',
          lineStyle: { color: T.colors.house, width: 2 },
          itemStyle: { color: T.colors.house },
          data: D.house,
          markLine: { symbol: 'none', silent: true, data: crisisMarkLines(data.crises) },
          markArea: { silent: true, data: crisisMarkAreas(data.bands) },
        },
        {
          name: 'Median Unit Price', type: 'line', symbol: 'none',
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
