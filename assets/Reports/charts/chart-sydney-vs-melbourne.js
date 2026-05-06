/* ─────────────────────────────────────────────────────────────────────
   Chart: Sydney vs Melbourne House Median Price (2 bars + diff line + LT avg)
   ---------------------------------------------------------------------
   Mount: <div data-chart="sydney-vs-melbourne"></div>
   Data:  region.sydneyVsMelbourne { years[], sydneyHouse[],
          melbourneHouse[], difference[], longTermAvg }
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, attachResize, standardLegend,
          staircaseYearAxis, longTermAverage, niceAxis, niceAxisRange } = NS;

  /* Walk every value across the given series arrays once, returning
     the {min, max} pair. Null-safe and used to feed both niceAxis
     (bars: tight top, baseline 0) and niceAxisRange (line: tight top
     AND tight bottom so the line fills the plot height). */
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

  NS.register('sydney-vs-melbourne', function (el, data) {
    const D = data.sydneyVsMelbourne;
    /* Region + peer labels for the bar / axis-name text. Falls back
       to NS.regionLabels() (which reads ACTIVE_REGION + REGION_MANIFEST
       directly) so non-Sydney regions display correctly even on
       first paint when their data object is still Sydney's static
       baseline. REGION_MANIFEST.peer drives the peer label —
       Sydney→Melbourne; everyone-else→Sydney; QLD regional→Brisbane. */
    const RL = NS.regionLabels();
    const regionLabel = D.regionLabel || RL.region;
    const peerLabel   = D.peerLabel   || RL.peer;
    const regionSeriesName = `${regionLabel} Median House`;
    const peerSeriesName   = `${peerLabel} Median House`;
    /* Bar axis: standard niceAxis from 0 → tight top. Sydney's $1.55M
       data → max $1.75M with $250k ticks, smaller regions auto-pick. */
    const barAxis = niceAxis(seriesRange([D.sydneyHouse, D.melbourneHouse]).max);
    /* Difference axis: clip BOTH ends so the line fills the plot
       height and visually overlaps with the bars across all years
       (otherwise the line floats high above tiny early-year bars).
       niceAxisRange picks `min` = next 10% below dataMin (115% data
       → 110%; 100% data → 90%) and `max` = next clean step above
       dataMax (168% → 170%). */
    const diffR = seriesRange([D.difference]);
    const lineAxis = niceAxisRange(diffR.min, diffR.max);
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
            const f = p.seriesName === 'Difference'
              ? v.toFixed(0) + '%' : fmt.money(v);
            return `${dot(p.color)}${p.seriesName}: <strong>${f}</strong>`;
          });
          /* Long-Term Average — surfaces the dashed reference line's
             value alongside the per-year difference so the reader can
             see how each year compares to the long-run trend. */
          if (D.longTermAvg != null) {
            lines.push(`${dot(T.colors.house)}Long-Term Average: <strong>${Number(D.longTermAvg).toFixed(0)}%</strong>`);
          }
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: regionSeriesName, icon: 'rect' },
        { name: peerSeriesName,   icon: 'rect' },
        { name: 'Difference' },
      ]),
      xAxis: staircaseYearAxis(D.years, { boundaryGap: true }),
      yAxis: [
        {
          /* Difference (line) axis: clipped on BOTH ends via
             niceAxisRange. Sydney's 115-168% data renders as
             min=110, max=170, interval=10 → ticks 110/120/.../170,
             so the line spans the full plot height instead of
             floating above the bars. */
          type: 'value',
          min: lineAxis.min, max: lineAxis.max, interval: lineAxis.interval,
          axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'Difference',
          nameLocation: 'middle', nameGap: 50, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          /* Bar axis: prices, baseline 0 + tight top via niceAxis.
             Sydney's $1.55M data → max $1.75M, $250k ticks. */
          type: 'value', min: 0,
          max: barAxis.max, interval: barAxis.interval,
          axisLabel: Object.assign({}, T.axis, { formatter: fmt.moneyAxis }),
          splitLine: { show: false },
          name: `${regionSeriesName} | ${peerSeriesName}`,
          nameLocation: 'middle', nameGap: 45, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      series: [
        { name: regionSeriesName, type: 'bar', yAxisIndex: 1, data: D.sydneyHouse,
          itemStyle: { color: T.colors.houseBar }, barGap: '10%', barCategoryGap: '40%' },
        { name: peerSeriesName,   type: 'bar', yAxisIndex: 1, data: D.melbourneHouse,
          itemStyle: { color: T.colors.unitBar } },
        {
          name: 'Difference', type: 'line', yAxisIndex: 0,
          symbol: 'circle', symbolSize: 8, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.house, width: 2 },
          itemStyle: { color: T.colors.house },
          data: D.difference,
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
