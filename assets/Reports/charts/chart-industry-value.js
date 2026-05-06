/* ─────────────────────────────────────────────────────────────────────
   Chart: Industry Value Added (donut)
   ---------------------------------------------------------------------
   Mount:   <div data-chart="industry-value"></div>
   Data:    region.industry [{v: number, n: name}]
            Colours come from theme.palette18 in declaration order.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { tooltipBase, dot, attachResize } = NS;

  NS.register('industry-value', function (el, data) {
    const items = data.industry.map((d, i) => ({
      value: d.v, name: d.n,
      itemStyle: { color: d.c || T.palette18[i % T.palette18.length] },
    }));

    const chart = echarts.init(el);
    chart.setOption({
      animation: false,
      tooltip: tooltipBase({
        trigger: 'item',
        formatter: (p) => `${dot(p.color)}<strong>${p.name}</strong><br/>${p.value}% of Industry Value Added`,
      }),
      legend: {
        orient: 'vertical',
        right: 30, top: 'middle',
        textStyle: Object.assign({}, T.legend, { fontSize: 11 }),
        itemWidth: 10, itemHeight: 10, itemGap: 6,
      },
      series: [{
        type: 'pie',
        radius: ['40%', '74%'],
        center: ['32%', '50%'],
        avoidLabelOverlap: true,
        label: {
          show: true, position: 'inside',
          /* Hide labels on small slices (<2%) — matches the PDF. */
          formatter: p => p.value >= 2 ? p.value + '%' : '',
          fontFamily: T.fonts.chart, fontSize: 12,
          color: '#ffffff', fontWeight: 600,
        },
        labelLine: { show: false },
        data: items,
      }],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
