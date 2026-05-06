/* ─────────────────────────────────────────────────────────────────────
   Chart: Dwelling Sales (4 lines, dual axis)
   ---------------------------------------------------------------------
   Mount: <div data-chart="dwelling-sales"></div>
   Data:  region.dwellingSales { years[], house[], units[],
          medianHouse[], medianUnit[] }
   Layout: Sales counts on left axis, Median prices on right axis.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, attachResize, standardLegend, staircaseYearAxis } = NS;

  NS.register('dwelling-sales', function (el, data) {
    const D = data.dwellingSales;
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
      grid: { top: 50, right: 60, bottom: 55, left: 65 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params.map(p => {
            const v = Number(p.value);
            const isPrice = p.seriesName.indexOf('Median') === 0;
            const f = isPrice ? fmt.money(v) : fmtCount(v);
            return `${dot(p.color)}${p.seriesName}: <strong>${f}</strong>`;
          });
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'House'              },
        { name: 'Units'              },
        { name: 'Median House Price' },
        { name: 'Median Unit Price'  },
      ]),
      xAxis: staircaseYearAxis(D.years),
      yAxis: [
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: fmtCount }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'House | Units',
          nameLocation: 'middle', nameGap: 50, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: fmt.moneyAxis }),
          splitLine: { show: false },
          name: 'Median House Price | Median Unit Price',
          nameLocation: 'middle', nameGap: 45, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      series: [
        line('House',              D.house,       T.colors.house,    0),
        line('Units',              D.units,       T.colors.unit,     0),
        line('Median House Price', D.medianHouse, T.colors.houseBar, 1),
        line('Median Unit Price',  D.medianUnit,  '#a4adb6',         1),
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
