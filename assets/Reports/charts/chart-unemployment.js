/* ─────────────────────────────────────────────────────────────────────
   Chart: Unemployment Rate (2 lines + 1 bar overlay)
   ---------------------------------------------------------------------
   Mount: <div data-chart="unemployment"></div>
   Data:  region.unemploymentRate { years[], sydney[], nsw[], houseYoy[] }
   Layout: Sydney + NSW unemployment lines on left axis,
           House YoY % bars on right axis.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { tooltipBase, dot, attachResize, standardLegend, staircaseYearAxis } = NS;

  NS.register('unemployment', function (el, data) {
    const D = data.unemploymentRate;
    /* Region-specific labels for the two unemployment lines. Falls
       back to the active region's name + state via NS.regionLabels()
       so non-Sydney regions display correctly even on first paint
       (when their data is still Sydney's static baseline). */
    const RL = NS.regionLabels();
    const regionLabel = D.regionLabel || RL.region;
    const stateLabel  = D.stateLabel  || RL.state;
    /* Detect each unemployment series independently. Some regions
       (Canberra/ACT) don't have Metro unemployment AND may also
       lack State unemployment — chart should render whatever lines
       have data, or zero lines if neither does (bars + their axis
       still render).

       Canberra hard-block: ACT genuinely has no Metro Unemployment
       column. If stale data (e.g. Sydney's static baseline still
       cached in PPA_REGION_DATA) leaks Sydney metro values into
       D.sydney, force-skip the region line so a "Canberra" series
       never appears. The State line (D.nsw) renders normally with
       the "ACT" label. */
    const hasAny = (arr) => (arr || []).some(v => v != null && isFinite(Number(v)));
    const isCanberra = (typeof ACTIVE_REGION !== 'undefined' && ACTIVE_REGION === 'canberra')
      || (new URLSearchParams(location.search).get('region') === 'canberra');
    const hasRegionLine = !isCanberra && hasAny(D.sydney);
    const hasStateLine  = hasAny(D.nsw);

    const lineLegend = [];
    if (hasRegionLine) lineLegend.push({ name: regionLabel });
    if (hasStateLine)  lineLegend.push({ name: stateLabel });

    const yAxisParts = [];
    if (hasRegionLine) yAxisParts.push(regionLabel);
    if (hasStateLine)  yAxisParts.push(stateLabel);
    const yAxisName = yAxisParts.join(' | ');

    /* Colour assignment: when both lines render, region = house cyan
       and state = unit warm. When only one line renders, it always
       takes the focus-region cyan so the chart's visual weight
       stays consistent with other capitals. */
    const soloLine = (hasRegionLine && !hasStateLine) || (!hasRegionLine && hasStateLine);
    const lineSeries = [];
    if (hasRegionLine) {
      lineSeries.push({
        name: regionLabel, type: 'line',
        symbol: 'circle', symbolSize: 7, showSymbol: false,
        emphasis: { scale: false },
        lineStyle: { color: T.colors.house, width: 2 },
        itemStyle: { color: T.colors.house },
        data: D.sydney,
      });
    }
    if (hasStateLine) {
      lineSeries.push({
        name: stateLabel, type: 'line',
        symbol: 'circle', symbolSize: 7, showSymbol: false,
        emphasis: { scale: false },
        lineStyle: { color: soloLine ? T.colors.house : T.colors.unit, width: 2 },
        itemStyle: { color: soloLine ? T.colors.house : T.colors.unit },
        data: D.nsw,
      });
    }

    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 50, right: 60, bottom: 55, left: 65 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(92,200,224,0.1)' } },
        formatter: (params) => {
          const year = params[0].axisValue;
          const lines = params.map(p => `${dot(p.color)}${p.seriesName}: <strong>${Number(p.value).toFixed(2)}%</strong>`);
          return `<div style="font-weight:700;margin-bottom:4px">${year}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        ...lineLegend,
        { name: 'House % Change Year on Year', icon: 'rect' },
      ]),
      xAxis: staircaseYearAxis(D.years, { boundaryGap: true }),
      yAxis: [
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: yAxisName,
          nameLocation: 'middle', nameGap: 50, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          type: 'value',
          axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
          splitLine: { show: false },
          name: 'House % Change Year on Year',
          nameLocation: 'middle', nameGap: 45, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      series: [
        { name: 'House % Change Year on Year', type: 'bar', yAxisIndex: 1, data: D.houseYoy,
          itemStyle: { color: T.colors.houseBar }, barCategoryGap: '40%' },
        ...lineSeries,
      ],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
