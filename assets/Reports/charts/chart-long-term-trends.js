/* ─────────────────────────────────────────────────────────────────────
   Chart: Long-Term Trends (grouped bar, multiple time horizons)
   ---------------------------------------------------------------------
   Mount:   <div data-chart="long-term-trends"></div>
   Data:    region.longTermTrends {horizons[], house[], unit[]}
   Notes:   Displays compound annual growth rate at LT/10y/7y/5y/3y for
            houses vs units side-by-side. Bars are labelled with their
            value so the page reads at a glance even without hover.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, attachResize, standardLegend } = NS;

  NS.register('long-term-trends', function (el, data) {
    const D = data.longTermTrends;
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      /* Tighter margins matching the rest of the chart pages. */
      grid: { top: 50, right: 50, bottom: 50, left: 60 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(92,200,224,0.1)' } },
        formatter: (params) => {
          const horizon = params[0].axisValue;
          const lines = params.map(p => `${dot(p.color)}${p.seriesName}: <strong>${fmt.pctShort(p.value)}</strong>`);
          return `<div style="font-weight:700;margin-bottom:4px">${horizon}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'House', icon: 'rect' },
        { name: 'Unit',  icon: 'rect' },
      ]),
      xAxis: {
        type: 'category',
        data: D.horizons,
        axisLabel: Object.assign({}, T.axis, { fontSize: 12, fontWeight: 600 }),
        axisLine: { lineStyle: { color: T.colors.axisLine } },
        axisTick: { alignWithLabel: true },
      },
      yAxis: {
        /* No `min: 0` — CAGR can go negative for regions in a
           protracted downturn (Darwin's 10yr / LT trend has hit
           -0.3% historically). ECharts auto-scales to fit the data,
           so positive-only regions still get a 0 baseline naturally
           while the bar for a negative value renders downward. */
        type: 'value',
        axisLabel: Object.assign({}, T.axis, { formatter: v => v.toFixed(2) + '%' }),
        splitLine: { lineStyle: { color: T.colors.grid } },
      },
      series: [
        {
          /* Bar colours match the Stock vs DoM bars (cyan / gray) so
             every bar chart in the report shares one palette — the
             dark-navy / orange pair stays reserved for line charts. */
          name: 'House', type: 'bar',
          itemStyle: { color: T.colors.houseBar, borderRadius: [3, 3, 0, 0] },
          barCategoryGap: '40%',
          data: D.house,
          label: {
            show: true, position: 'top',
            formatter: p => fmt.pctShort(p.value),
            color: T.colors.text, fontFamily: T.fonts.chart, fontSize: 11, fontWeight: 600,
          },
        },
        {
          name: 'Unit', type: 'bar',
          itemStyle: { color: T.colors.unitBar, borderRadius: [3, 3, 0, 0] },
          data: D.unit,
          label: {
            show: true, position: 'top',
            formatter: p => fmt.pctShort(p.value),
            color: T.colors.text, fontFamily: T.fonts.chart, fontSize: 11, fontWeight: 600,
          },
        },
      ],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
