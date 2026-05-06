/* ─────────────────────────────────────────────────────────────────────
   Chart: Retail Turnover Growth (Turnover + Median House Price + crisis)
   ---------------------------------------------------------------------
   Mount: <div data-chart="retail-turnover"></div>
   Data:  region.retailTurnover { years[], turnover[], housePrice[] }
          region.crises[] (shared)
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, attachResize, standardLegend,
          staircaseYearAxis, crisisMarkLines } = NS;

  NS.register('retail-turnover', function (el, data) {
    const D = data.retailTurnover;
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
      grid: { top: 30, right: 60, bottom: 55, left: 65 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params.map(p => {
            const v = Number(p.value);
            const f = p.seriesName === 'Median House Price'
              ? fmt.money(v) : fmtCount(v);
            return `${dot(p.color)}${p.seriesName}: <strong>${f}</strong>`;
          });
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'Retail Turnover'   },
        { name: 'Median House Price' },
      ]),
      xAxis: staircaseYearAxis(D.years),
      yAxis: [
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: fmtCount }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'Retail Turnover',
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
          name: 'Retail Turnover', type: 'line',
          symbol: 'circle', symbolSize: 8, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.house, width: 2 },
          itemStyle: { color: T.colors.house },
          data: D.turnover,
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
