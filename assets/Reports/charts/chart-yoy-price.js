/* ─────────────────────────────────────────────────────────────────────
   Chart: Year-on-Year Price Movement (% change line + recession overlays)
   ---------------------------------------------------------------------
   Mount:   <div data-chart="yoy-price"></div>
   Data:    Derived from region.medianPrice (no extra data file needed).
            Years where the prior-year value is missing become null.
   Notes:   Adds a Long-Term Average dashed line (mean of house YoY).
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, staircaseYearAxis,
          crisisMarkLines, crisisMarkAreas, longTermAverage,
          attachResize, insideZoom } = NS;

  /* Build a YoY % series from a price array. First point is null. */
  function yoy(values) {
    return values.map((v, i) => i === 0 ? null : ((v - values[i-1]) / values[i-1]) * 100);
  }
  function avg(arr) {
    const xs = arr.filter(v => v != null && isFinite(v));
    return xs.reduce((s, v) => s + v, 0) / xs.length;
  }

  NS.register('yoy-price', function (el, data) {
    const D = data.medianPrice;
    /* Clip the chart's view of medianPrice to start at year 1980 (per
       region — find the first year >= 1980 in this region's series).
       The shared medianPrice mapping might extend further back if the
       sheet has earlier price data, but the YoY chart's intended view
       starts at 1980. Slicing here keeps the Median Price page
       (which uses the same data) untouched. */
    const startIdx = D.years.findIndex(y => Number(y) >= 1980);
    const sliceFrom = startIdx > 0 ? startIdx : 0;
    const years = D.years.slice(sliceFrom);
    const house = D.house.slice(sliceFrom);
    const unit  = D.unit.slice(sliceFrom);
    const houseYoy = yoy(house);
    const unitYoy  = yoy(unit);
    const ltAvgHouse = avg(houseYoy);

    /* Auto-scale the y-axis to whatever the data actually does (some
       regions have one-off spikes that get clipped at a fixed cap),
       then nudge the cap up to the next 10%. */
    const dataMax = Math.max.apply(null, houseYoy.concat(unitYoy).filter(v => v != null && isFinite(v)));
    const dataMin = Math.min.apply(null, houseYoy.concat(unitYoy).filter(v => v != null && isFinite(v)));
    const yMax = Math.ceil(Math.max(dataMax, 30) / 10) * 10;
    const yMin = Math.floor(Math.min(dataMin, -10) / 10) * 10;

    /* SVG renderer keeps text crisp at any zoom and produces a vector
       PDF on print — same path the inline Median Price chart uses. */
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      /* Tight margins matching the inline Median Price chart — plot
         fills nearly the full white panel; just enough breathing room
         for the legend at top (crisis badges now sit INSIDE the
         plot, no longer reserving space above), staircased year
         labels at bottom, and the y-axis name + ticks on the left. */
      grid: { top: 30, right: 25, bottom: 55, left: 60 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params
            .filter(p => p.value != null && p.seriesName.includes('Year on Year'))
            .map(p => `${dot(p.color)}${p.seriesName}: <strong>${fmt.pct(p.value)}</strong>`);
          /* Long-Term Average reference value (same on every hover —
             the value doesn't change with the cursor year, but
             surfacing it next to the per-year YoY lets the reader
             read each year against the trend without scanning to the
             markLine). */
          lines.push(`${dot(T.colors.house)}Long-Term Average (House): <strong>${fmt.pct(ltAvgHouse)}</strong>`);
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: {
        /* Line series omit `icon` so ECharts renders the actual series
           marker (a horizontal line — each line series sets
           symbol:'none' so there's no dot). Band entries keep `rect`
           so they look like filled colour blocks. */
        top: 4, left: 60, orient: 'horizontal',
        itemGap: 28, itemWidth: 22, itemHeight: 12,
        textStyle: T.legend,
        data: [
          { name: 'House % Change Year on Year' },
          { name: 'Unit % Change Year on Year'  },
          { name: 'Growth Period',     icon: 'rect' },
          { name: 'Correction Period', icon: 'rect' },
        ],
      },
      xAxis: staircaseYearAxis(years),
      yAxis: {
        type: 'value', min: yMin, max: yMax, interval: 10,
        axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
        splitLine: { lineStyle: { color: T.colors.grid } },
        name: 'House % Change Year on Year | Unit % Change Year on Year',
        nameLocation: 'middle', nameGap: 45, nameRotate: 90,
        nameTextStyle: T.axisName,
      },
      series: [
        /* Dummy series so the legend has growth/correction swatches.
           Their itemStyle drives the legend fill — point it at the same
           theme tokens the markArea uses so they can never drift. */
        { name: 'Growth Period',     type: 'line', data: [], itemStyle: { color: T.colors.growthBand   } },
        { name: 'Correction Period', type: 'line', data: [], itemStyle: { color: T.colors.correctBand  } },
        {
          name: 'House % Change Year on Year', type: 'line', connectNulls: false,
          /* Circle defined per point but hidden by default; ECharts
             "snaps" it on at the year under the cursor through the
             axis tooltip pointer — that's the small hover indicator. */
          symbol: 'circle', symbolSize: 8, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.house, width: 2 },
          itemStyle: { color: T.colors.house },
          data: houseYoy,
          markLine: {
            symbol: 'none', silent: true,
            data: crisisMarkLines(data.crises).concat([
              longTermAverage(ltAvgHouse, `Long-Term Average (House) ${fmt.pctShort(ltAvgHouse)}`),
            ]),
          },
          markArea: { silent: true, data: crisisMarkAreas(data.bands) },
        },
        {
          name: 'Unit % Change Year on Year', type: 'line', connectNulls: false,
          symbol: 'circle', symbolSize: 8, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: T.colors.unit, width: 2 },
          itemStyle: { color: T.colors.unit },
          data: unitYoy,
        },
      ],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
