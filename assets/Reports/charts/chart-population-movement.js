/* ─────────────────────────────────────────────────────────────────────
   Chart: Population Movement (3 grouped bars + NSW population line)
   ---------------------------------------------------------------------
   Mount:   <div data-chart="population-movement"></div>
   Data:    region.populationMovement { years[], naturalIncrease[],
            nim[], nom[], nswPopulation[] }
   Notes:   Three migration components side-by-side per year (NIM is
            typically negative for a capital city, so the bar y-axis
            spans both directions). NSW total population overlaid on
            a right-hand axis as a line — the right axis runs 0→10m
            independently of the left's negative range, so the bars'
            bold 0-baseline doesn't have to align with the line axis.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { tooltipBase, dot, attachResize, standardLegend, staircaseYearAxis } = NS;

  /* k-formatter — bar values are stored as thousands of people. */
  function kFmt(v) {
    return (v >= 0 ? '' : '-') + Math.abs(v).toLocaleString() + 'k';
  }

  NS.register('population-movement', function (el, data) {
    const D = data.populationMovement;
    /* State-specific label for the right-axis line (e.g. "WA
       Population" for Perth, "VIC Population" for Melbourne).
       Falls back to the active region's state via NS.regionLabels()
       so non-Sydney regions display correctly even on first paint
       (when their data is still Sydney's static baseline). */
    const RL = NS.regionLabels();
    const stateLabel = D.stateLabel || RL.state;
    const popLineLabel = `${stateLabel} Population`;
    /* Right-axis unit auto-detect — populations span ~250k (NT) to
       ~8m (NSW). Mapper outputs values in millions display, so
       Sydney peaks at ~8 and Darwin peaks at ~0.26. If peak < 1
       (i.e. less than 1m), switch to thousands display ("250k")
       to match the Looker reference; otherwise keep millions
       ("8m"). No rounding so the precise value carries through
       (Darwin 0.257 → "257k", not "260k"). The 0 tick always
       reads as plain "0" regardless of unit. */
    const popValues = (D.nswPopulation || [])
      .filter(v => v != null && isFinite(Number(v)))
      .map(v => Math.abs(Number(v)));
    const popPeak = popValues.length ? Math.max(...popValues) : 0;
    const popInThousands = popPeak < 1;
    const popAxisFmt = popInThousands
      ? (v => v === 0 ? '0' : (Number(v) * 1000).toLocaleString() + 'k')
      : (v => v === 0 ? '0' : Number(v).toLocaleString() + 'm');
    const popTipFmt = popInThousands
      ? (v => (Number(v) * 1000).toLocaleString() + 'k')
      : (v => Number(v).toLocaleString() + 'm');
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      /* Wider left + right margins so the axis titles ("Natural
         Increase | NIM | NOM" and "NSW Population") and their tick
         labels both clear the 1990 / 2025 bar groups. */
      grid: { top: 50, right: 75, bottom: 55, left: 80 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(92,200,224,0.1)' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params.map(p => {
            const f = p.seriesName === popLineLabel ? popTipFmt(p.value) : kFmt(p.value);
            return `${dot(p.color)}${p.seriesName}: <strong>${f}</strong>`;
          });
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'Natural Increase', icon: 'rect' },
        { name: 'NIM',              icon: 'rect' },
        { name: 'NOM',              icon: 'rect' },
        { name: popLineLabel },
      ]),
      /* boundaryGap:true gives half a category of padding at the
         start and end of the plot, so the 1990 and 2025 bar groups
         don't touch the y-axis labels and the y=0 markLine carries
         slightly past the first/last bars to both axes. */
      xAxis: staircaseYearAxis(D.years, { boundaryGap: true }),
      yAxis: [
        {
          type: 'value',
          /* Auto-scaled — migration components vary widely per region.
             Sydney's NIM goes negative (~-46k) and NOM peaks around
             175k post-Covid; smaller regions have much narrower
             ranges. ECharts picks min/max from data and includes 0. */
          axisLabel: Object.assign({}, T.axis, { formatter: kFmt }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'Natural Increase | NIM | NOM',
          nameLocation: 'middle', nameGap: 55, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          type: 'value',
          /* Auto-scaled — state population varies per region (NSW ~8m,
             ACT ~0.5m, NT ~0.25m). The two y-axes share the plot
             rectangle but their zeros do NOT have to align — the
             bars' baseline is the bold markLine at y=0 on the LEFT
             axis only. */
          min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: popAxisFmt }),
          splitLine: { show: false },
          name: popLineLabel,
          nameLocation: 'middle', nameGap: 40, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      series: [
        /* Wider barCategoryGap shrinks each year-group's footprint so
           the bars within each year are slim. A bold horizontal
           markLine at y=0 (matching the reference) anchors the
           positive bars on top and the negative NIM bars below. */
        { name: 'Natural Increase', type: 'bar', data: D.naturalIncrease,
          itemStyle: { color: T.colors.houseBar, borderRadius: [2, 2, 0, 0] },
          barGap: '15%', barCategoryGap: '55%',
          markLine: {
            symbol: 'none', silent: true,
            data: [{
              yAxis: 0,
              lineStyle: { color: '#0a1520', width: 1.5, type: 'solid' },
              label: { show: false },
            }],
          } },
        { name: 'NIM', type: 'bar', data: D.nim,
          itemStyle: { color: '#a4adb6', borderRadius: [2, 2, 0, 0] } },
        /* NOM = warm yellow, matching the reference. */
        { name: 'NOM', type: 'bar', data: D.nom,
          itemStyle: { color: '#f4c842', borderRadius: [2, 2, 0, 0] } },
        {
          name: popLineLabel, type: 'line', yAxisIndex: 1,
          symbol: 'circle', symbolSize: 8, showSymbol: false,
          emphasis: { scale: false },
          lineStyle: { color: '#0a1520', width: 2 },
          itemStyle: { color: '#0a1520' },
          data: D.nswPopulation,
        },
      ],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
