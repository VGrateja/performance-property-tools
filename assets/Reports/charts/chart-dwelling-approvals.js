/* ─────────────────────────────────────────────────────────────────────
   Chart: Dwelling Approvals (3 grouped bars + Population change line)
   ---------------------------------------------------------------------
   Mount: <div data-chart="dwelling-approvals"></div>
   Data:  region.dwellingApprovals { years[], house[], units[],
          total[], popChange[] }
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, attachResize, standardLegend } = NS;

  NS.register('dwelling-approvals', function (el, data) {
    const D = data.dwellingApprovals;
    /* Count formatter: always 2 decimal places. ≥1000 → "N.NNk"
       (5500 → "5.50k", 5523.456 → "5.52k"); <1000 → "N.NN" with
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
      grid: { top: 50, right: 60, bottom: 50, left: 65 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(92,200,224,0.1)' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params.map(p => {
            const v = Number(p.value);
            const f = p.seriesName === 'Population change'
              ? v.toLocaleString(undefined, fmtOpts) + '%'
              : fmtCount(v);
            return `${dot(p.color)}${p.seriesName}: <strong>${f}</strong>`;
          });
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'House',  icon: 'rect' },
        { name: 'Units',  icon: 'rect' },
        { name: 'Total',  icon: 'rect' },
        { name: 'Population change' },
      ]),
      xAxis: {
        type: 'category', data: D.years.map(String),
        axisLabel: Object.assign({}, T.axis, { fontSize: 11 }),
        axisLine: { lineStyle: { color: T.colors.axisLine } },
        axisTick: { alignWithLabel: true },
      },
      yAxis: [
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: fmtCount }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'House | Units | Total',
          nameLocation: 'middle', nameGap: 50, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          type: 'value',
          axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
          splitLine: { show: false },
          name: 'Population change',
          nameLocation: 'middle', nameGap: 35, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      series: [
        { name: 'House', type: 'bar', data: D.house,
          itemStyle: { color: T.colors.houseBar }, barGap: '10%', barCategoryGap: '40%' },
        { name: 'Units', type: 'bar', data: D.units,
          itemStyle: { color: T.colors.unitBar } },
        { name: 'Total', type: 'bar', data: D.total,
          itemStyle: { color: '#f4c842' } },
        {
          name: 'Population change', type: 'line', yAxisIndex: 1,
          symbol: 'circle', symbolSize: 8, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.house, width: 2 },
          itemStyle: { color: T.colors.house },
          data: D.popChange,
        },
      ],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
