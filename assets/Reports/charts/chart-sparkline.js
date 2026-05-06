/* ─────────────────────────────────────────────────────────────────────
   Chart: Sparkline (small-multiples used on the At-a-Glance page)
   ---------------------------------------------------------------------
   Mount:   <div data-chart="sparkline" data-key="population"></div>
            <div data-chart="sparkline" data-key="houses.medianPrice"></div>
   Data:    region.atGlance / region.houses / region.units (resolved by
            dotted data-key path).
   Opts:    data-color="#5cc8e0" (optional accent)
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { tooltipBase, attachResize } = NS;

  function resolve(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  }

  NS.register('sparkline', function (el, data, opts) {
    const path = opts.key || '';
    const node = resolve(data, path);
    if (!node || !Array.isArray(node.spark)) {
      console.warn('[sparkline] no data for', path);
      return null;
    }
    const series = node.spark;
    const color  = opts.color || '#5cc8e0';

    const chart = echarts.init(el);
    chart.setOption({
      animation: false,
      grid: { top: 2, right: 2, bottom: 2, left: 2 },
      xAxis: {
        type: 'category', show: false, boundaryGap: false,
        data: series.map((_, i) => 'Point ' + (i + 1)),
      },
      yAxis: { type: 'value', show: false },
      tooltip: tooltipBase({
        trigger: 'axis', padding: [4, 8],
        textStyle: { color: '#fff', fontFamily: T.fonts.chart, fontSize: 11 },
        formatter: (params) => {
          const p = params[0];
          const v = Number(p.value);
          const fmt = isFinite(v)
            ? (Math.abs(v) >= 1000 ? v.toLocaleString() : v.toString())
            : p.value;
          return `<span style="opacity:0.7;font-size:10px">${p.axisValue}</span> <strong>${fmt}</strong>`;
        },
        axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed', width: 1 } },
      }),
      series: [{
        type: 'line', data: series, symbol: 'none', smooth: true,
        lineStyle: { color, width: 1.5 },
      }],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
