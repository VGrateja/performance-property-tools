/* ─────────────────────────────────────────────────────────────────────
   Chart: House v Unit Price Comparison
   ---------------------------------------------------------------------
   Mount: <div data-chart="house-v-unit-price"></div>
   Data:  region.housePriceComparison { years[], house[], unit[],
          pct[], longTermAvg }
   Layout: House+Unit bars on left axis ($), Pct-of-house line on right
           axis (%) with a Long-Term Average dashed reference line.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, attachResize, standardLegend,
          staircaseYearAxis, longTermAverage, niceAxis, niceAxisRange } = NS;

  /* Walk every value across the given series arrays once, returning
     the {min, max} pair. Null-safe; feeds both niceAxis (bars: tight
     top, baseline 0) and niceAxisRange (line: tight top AND tight
     bottom so the line fills the plot height). */
  function seriesRange(arrs) {
    let min = Infinity, max = -Infinity;
    arrs.forEach(a => (a || []).forEach(v => {
      const n = Number(v);
      if (!isFinite(n)) return;
      if (n < min) min = n;
      if (n > max) max = n;
    }));
    return {
      min: min === Infinity ? 0 : min,
      max: max === -Infinity ? 0 : max,
    };
  }

  NS.register('house-v-unit-price', function (el, data) {
    const D = data.housePriceComparison;
    /* Bar axis: standard niceAxis from 0 → tight top. Sydney's $1.55M
       data → max $1.75M with $250k ticks; smaller / larger regions
       auto-pick. */
    const barAxis = niceAxis(seriesRange([D.house, D.unit]).max);
    /* Pct-of-house line: clip BOTH ends so the line spans the plot
       vertically alongside the bars (otherwise the line floats high
       in early years where unit/house ratios are stable). Sydney's
       ~50-110% range → min 40%, max 110%. Other regions auto-pick:
       Darwin's lower ratios produce a different tight window. */
    const pctR    = seriesRange([D.pct]);
    const lineAxis = niceAxisRange(pctR.min, pctR.max);
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 50, right: 60, bottom: 55, left: 65 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(92,200,224,0.1)' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params.map(p => {
            const v = Number(p.value);
            const f = p.seriesName === 'Percentage of House Price'
              ? v.toFixed(1) + '%'
              : fmt.money(v);
            return `${dot(p.color)}${p.seriesName}: <strong>${f}</strong>`;
          });
          /* Long-Term Average reference (same on every hover, but
             surfaces the dashed line's value so the reader can read
             each year against the trend). */
          if (D.longTermAvg != null) {
            lines.push(`${dot(T.colors.house)}Long-Term Average: <strong>${Number(D.longTermAvg).toFixed(1)}%</strong>`);
          }
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'Median House Price',         icon: 'rect' },
        { name: 'Median Unit Price',          icon: 'rect' },
        { name: 'Percentage of House Price'   },
      ]),
      xAxis: staircaseYearAxis(D.years, { boundaryGap: true }),
      yAxis: [
        {
          /* niceAxis matched to the bar series' max — Sydney's $1.55M
             tops at $1.75M with $250k intervals, smaller / larger
             regions auto-pick their own tight clean step. */
          type: 'value', min: 0,
          max: barAxis.max, interval: barAxis.interval,
          axisLabel: Object.assign({}, T.axis, { formatter: fmt.moneyAxis }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'Median House Price | Median Unit Price',
          nameLocation: 'middle', nameGap: 50, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          /* Pct-of-house (line) axis: clipped on BOTH ends via
             niceAxisRange. Sydney's ~50-110% data renders as min 40,
             max 110, so the line spans the full plot height instead
             of floating above the bars at low-priced early years. */
          type: 'value',
          min: lineAxis.min, max: lineAxis.max, interval: lineAxis.interval,
          axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
          splitLine: { show: false },
          name: 'Percentage of House Price',
          nameLocation: 'middle', nameGap: 40, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      series: [
        { name: 'Median House Price', type: 'bar', data: D.house,
          itemStyle: { color: T.colors.houseBar }, barGap: '10%', barCategoryGap: '35%' },
        { name: 'Median Unit Price',  type: 'bar', data: D.unit,
          itemStyle: { color: T.colors.unitBar } },
        {
          name: 'Percentage of House Price', type: 'line', yAxisIndex: 1,
          symbol: 'circle', symbolSize: 8, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.house, width: 2 },
          itemStyle: { color: T.colors.house },
          data: D.pct,
          markLine: {
            symbol: 'none', silent: true,
            data: [longTermAverage(D.longTermAvg, 'Long-Term Average')],
          },
        },
      ],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
