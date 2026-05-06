/* ─────────────────────────────────────────────────────────────────────
   Chart: Change in Population (yearly %, three lines)
   ---------------------------------------------------------------------
   Mount:   <div data-chart="change-in-population"></div>
   Data:    region.changeInPopulation { years[], sydney[], nsw[], national[] }
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, attachResize, standardLegend,
          staircaseYearAxis, longTermAverage } = NS;

  /* Mean of a numeric array, ignoring null/NaN. */
  function avg(arr) {
    const xs = arr.filter(v => v != null && isFinite(v));
    return xs.reduce((s, v) => s + v, 0) / xs.length;
  }

  NS.register('change-in-population', function (el, data) {
    const D = data.changeInPopulation;
    /* Region-specific labels — D.regionLabel/stateLabel are populated
       by mapLiveToRegion when live data has flowed in. Before that
       (first paint, or when live fetch hasn't completed for non-Sydney
       regions), the data is Sydney's static baseline — so we fall
       back to NS.regionLabels() which reads ACTIVE_REGION +
       REGION_MANIFEST directly. Charts label themselves correctly per
       region from the very first paint regardless of live-data state. */
    const RL = NS.regionLabels();
    const regionLabel = D.regionLabel || RL.region;
    const stateLabel  = D.stateLabel  || RL.state;
    /* For capital cities the 3rd series is "National"; for regional
       reports it's the peer capital (e.g. Mackay → Brisbane). The
       mapper sends thirdLabel; fall back to "National" to preserve
       legacy capital-cities behaviour. */
    const thirdLabel  = D.thirdLabel  || 'National';
    /* Long-term average of the focus-region (metro) series — drawn
       as a dashed reference line and surfaced in the tooltip so the
       reader can compare each year against the long-run growth rate. */
    const ltAvg = avg(D.sydney);

    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 50, right: 25, bottom: 55, left: 60 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const seriesNames = [regionLabel, stateLabel, thirdLabel];
          const lines = params
            .filter(p => seriesNames.indexOf(p.seriesName) !== -1)
            .map(p => `${dot(p.color)}${p.seriesName}: <strong>${fmt.pct(p.value)}</strong>`);
          if (isFinite(ltAvg)) {
            lines.push(`${dot(T.colors.house)}Long-Term Average (${regionLabel}): <strong>${fmt.pctShort(ltAvg)}</strong>`);
          }
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: regionLabel },
        { name: stateLabel  },
        { name: thirdLabel  },
      ]),
      xAxis: staircaseYearAxis(D.years),
      yAxis: {
        type: 'value',
        axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
        splitLine: { lineStyle: { color: T.colors.grid } },
        name: `${regionLabel} | ${stateLabel} | ${thirdLabel}`,
        nameLocation: 'middle', nameGap: 45, nameRotate: 90,
        nameTextStyle: T.axisName,
      },
      series: [
        Object.assign(line(regionLabel, D.sydney, T.colors.house), {
          markLine: {
            symbol: 'none', silent: true,
            data: [longTermAverage(
              ltAvg,
              `Long-Term Average (${regionLabel}) ${fmt.pctShort(ltAvg)}`
            )],
          },
        }),
        line(stateLabel, D.nsw,      T.colors.unit),
        line(thirdLabel, D.national, T.colors.houseBar),
      ],
    });
    attachResize(chart);
    return chart;
  });

  function line(name, data, color) {
    return {
      name, type: 'line', smooth: false,
      symbol: 'circle', symbolSize: 8, showSymbol: false,
      emphasis: { scale: false },
      lineStyle: { color, width: 2 },
      itemStyle: { color },
      data,
    };
  }
})(window.PpaCharts);
