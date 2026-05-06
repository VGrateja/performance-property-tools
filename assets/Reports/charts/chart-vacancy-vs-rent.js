/* ─────────────────────────────────────────────────────────────────────
   Chart: Vacancy Rate vs Rent (Rent House/Unit bars + Vacancy line)
   ---------------------------------------------------------------------
   Mount:   <div data-chart="vacancy-vs-rent"></div>
   Data:    region.vacancyVsRent { years[], rentHouse[], rentUnit[],
            vacancy[] }
   Notes:   Dual y-axis combo. Rents on the left axis, vacancy % on the
            right (line). Same convention as Stock vs DoM.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { tooltipBase, dot, attachResize, standardLegend, staircaseYearAxis } = NS;

  NS.register('vacancy-vs-rent', function (el, data) {
    const D = data.vacancyVsRent;
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 50, right: 60, bottom: 50, left: 65 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(92,200,224,0.1)' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params.map(p => {
            const v = Number(p.value);
            const fmt = p.seriesName === 'Vacancy Rate'
              ? v.toFixed(1) + '%'
              : '$' + v.toLocaleString();
            return `${dot(p.color)}${p.seriesName}: <strong>${fmt}</strong>`;
          });
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'Rent House',   icon: 'rect' },
        { name: 'Rent Unit',    icon: 'rect' },
        { name: 'Vacancy Rate' },
      ]),
      /* Staircased year axis (odd-indexed years drop down a line) so
         the labels don't overlap, matching Population Change and the
         other long-history yearly charts. boundaryGap:true keeps the
         rent bars from butting against the y-axis. */
      xAxis: staircaseYearAxis(D.years, { boundaryGap: true }),
      yAxis: [
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: v => '$' + v }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'Rent House | Rent Unit',
          nameLocation: 'middle', nameGap: 50, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          /* Auto-scaled — Sydney's 0-6% range doesn't fit regions
             where vacancy spikes higher (e.g. Darwin in mining
             downturns). */
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
          splitLine: { show: false },
          name: 'Vacancy Rate',
          nameLocation: 'middle', nameGap: 35, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      series: [
        { name: 'Rent House', type: 'bar', data: D.rentHouse,
          itemStyle: { color: T.colors.houseBar }, barGap: '10%', barCategoryGap: '35%' },
        { name: 'Rent Unit',  type: 'bar', data: D.rentUnit,
          itemStyle: { color: T.colors.unitBar } },
        {
          name: 'Vacancy Rate', type: 'line', yAxisIndex: 1,
          symbol: 'circle', symbolSize: 8, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.house, width: 2 },
          itemStyle: { color: T.colors.house },
          data: D.vacancy,
        },
      ],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
