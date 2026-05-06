/* ─────────────────────────────────────────────────────────────────────
   Chart: New Households v Housing (2 bars + Vacancy Rate line)
   ---------------------------------------------------------------------
   Mount: <div data-chart="new-households-v-housing"></div>
   Data:  region.newHouseholdsVHousing { years[], newHouseholds[],
          buildingApprovals[], vacancy[] }
   Notes: New Households can go negative (Covid year). Y-axis spans
          both directions on the left axis.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { tooltipBase, dot, attachResize, standardLegend } = NS;

  NS.register('new-households-v-housing', function (el, data) {
    const D = data.newHouseholdsVHousing;
    /* Count formatter: always 2 decimal places. ≥1000 → "N.NNk"
       (5500 → "5.50k", -5500 → "-5.50k"); <1000 → "N.NN" with
       thousand-separators (500 → "500.00"). Per user: don't round
       to integer; show "decimals to .00 only". */
    const fmtOpts = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    const fmtCount = (v) => {
      const n = Number(v);
      if (!isFinite(n)) return '';
      return Math.abs(n) >= 1000
        ? (n / 1000).toLocaleString(undefined, fmtOpts) + 'k'
        : n.toLocaleString(undefined, fmtOpts);
    };
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 50, right: 60, bottom: 50, left: 70 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(92,200,224,0.1)' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params.map(p => {
            const v = Number(p.value);
            const f = p.seriesName === 'Vacancy Rate'
              ? v.toLocaleString(undefined, fmtOpts) + '%'
              : fmtCount(v);
            return `${dot(p.color)}${p.seriesName}: <strong>${f}</strong>`;
          });
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'New Households',     icon: 'rect' },
        { name: 'Building Approvals', icon: 'rect' },
        { name: 'Vacancy Rate' },
      ]),
      xAxis: {
        type: 'category', data: D.years.map(String),
        axisLabel: Object.assign({}, T.axis, { fontSize: 11 }),
        axisLine: { lineStyle: { color: T.colors.axisLine } },
        axisTick: { alignWithLabel: true },
      },
      yAxis: [
        {
          type: 'value',
          axisLabel: Object.assign({}, T.axis, { formatter: fmtCount }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'New Households | Building Approvals',
          nameLocation: 'middle', nameGap: 55, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          /* Auto-scaled — vacancy ranges differ per region. */
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
          splitLine: { show: false },
          name: 'Vacancy Rate',
          nameLocation: 'middle', nameGap: 35, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      series: [
        { name: 'New Households', type: 'bar', data: D.newHouseholds,
          itemStyle: { color: T.colors.houseBar }, barGap: '10%', barCategoryGap: '40%' },
        { name: 'Building Approvals', type: 'bar', data: D.buildingApprovals,
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
