/* ─────────────────────────────────────────────────────────────────────
   Chart: Population Pyramid (Sydney vs National grouped horizontal bar)
   ---------------------------------------------------------------------
   Mount:   <div data-chart="population-pyramid"></div>
   Data:    region.populationPyramid {ageGroups[], sydney:{male,female},
            national:{male,female}}
   Notes:   Despite the name, the Sydney reference PDF renders this as a
            grouped horizontal bar chart comparing the region against
            the national distribution — NOT a mirrored male/female
            pyramid. Male and female values are summed per age group
            into a single Sydney total and a single National total.
            The male/female split lives in the data file in case a
            future chart variant needs it.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { tooltipBase, dot, attachResize, standardLegend } = NS;

  NS.register('population-pyramid', function (el, data) {
    const D = data.populationPyramid;
    /* Region-specific label for the focus-region bar. Falls back to
       the active region's name via NS.regionLabels() so non-Sydney
       regions display correctly even on first paint (when their data
       is still Sydney's static baseline). */
    const RL = NS.regionLabels();
    const regionLabel = D.regionLabel || RL.region;
    /* Capital reports compare against National; regional reports
       compare LGA-vs-State (no National column in regional sheets).
       The mapper sends compareLabel; fall back to "National" to
       preserve legacy capital-cities behaviour. */
    const compareLabel = D.compareLabel || 'National';
    /* Total = male + female. Round to one decimal so the tooltip values
       don't reveal the floating-point imprecision of the addition. */
    const total = (m, f) => m.map((v, i) => +(v + f[i]).toFixed(2));
    const sydneyTotal   = total(D.sydney.male,   D.sydney.female);
    const nationalTotal = total(D.national.male, D.national.female);

    /* Loose y-axis upper bound: round the tallest bar up to the next
       whole percent so labels stay tidy across regions. */
    const maxValue = Math.max.apply(null, sydneyTotal.concat(nationalTotal));
    const xMax = Math.ceil(maxValue / 1) * 1 + 1;

    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      /* Wider left margin so the longest age-group label
         ("85 and over") doesn't crowd the bars. */
      grid: { top: 50, right: 50, bottom: 50, left: 90 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params) => {
          const age = params[0].axisValue;
          const lines = params.map(p =>
            `${dot(p.color)}${p.seriesName}: <strong>${Number(p.value).toFixed(1)}%</strong>`);
          return `<div style="font-weight:700;margin-bottom:4px">Age ${age}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: regionLabel,  icon: 'rect' },
        { name: compareLabel, icon: 'rect' },
      ]),
      xAxis: {
        type: 'value',
        axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
        splitLine: { lineStyle: { color: T.colors.grid } },
        min: 0, max: xMax, interval: 1,
      },
      yAxis: {
        type: 'category',
        data: D.ageGroups,
        axisLabel: Object.assign({}, T.axis, { fontSize: 11 }),
        axisLine: { lineStyle: { color: T.colors.axisLine } },
        axisTick: { show: false },
      },
      series: [
        {
          /* Focus-region bar = cyan, matching every other bar/line
             that represents the focal region. */
          name: regionLabel, type: 'bar',
          itemStyle: { color: T.colors.houseBar, borderRadius: [0, 2, 2, 0] },
          barCategoryGap: '25%', barGap: '0%',
          data: sydneyTotal,
        },
        {
          /* Comparison bar = cool gray (National for capitals, State
             for regionals). Paired with the cyan focal bar. */
          name: compareLabel, type: 'bar',
          itemStyle: { color: T.colors.unitBar, borderRadius: [0, 2, 2, 0] },
          data: nationalTotal,
        },
      ],
    });
    attachResize(chart);
    return chart;
  });
})(window.PpaCharts);
