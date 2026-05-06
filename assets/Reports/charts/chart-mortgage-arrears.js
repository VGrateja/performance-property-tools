/* ─────────────────────────────────────────────────────────────────────
   Chart: Mortgage Arrears (monthly %, NSW vs National)
   ---------------------------------------------------------------------
   Mount:   <div data-chart="mortgage-arrears"></div>
   Data:    region.mortgageArrears { months[YYYY-MM], nsw[], national[] }
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { tooltipBase, dot, attachResize, standardLegend } = NS;

  /* Tooltip uses the full "Mon YYYY" form so hover gives a clear
     month-level read even though the axis only shows quarterly ticks. */
  function monthLabel(s) {
    const [y, m] = s.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
  }

  /* Compact "Mon YY" form for the visible axis labels — short enough
     to fit a label every 6 months across the Jan 2010 → Oct 2025
     monthly range (~32 labels). `month: 'short'` resolves to the
     3-letter form on en-AU ("Jul", not "July"). */
  function shortMonthLabel(s) {
    const [y, m] = s.split('-').map(Number);
    const mon = new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'short' });
    return mon + ' ' + String(y).slice(-2);
  }

  NS.register('mortgage-arrears', function (el, data) {
    const D = data.mortgageArrears;
    /* State-specific label for the State arrears line (e.g. "WA"
       for Perth, "VIC" for Melbourne). Falls back to the active
       region's state via NS.regionLabels() so non-Sydney regions
       display correctly even on first paint (when their data is
       still Sydney's static baseline). */
    const RL = NS.regionLabels();
    const stateLabel = D.stateLabel || RL.state;
    const labelEvery = 6; /* one label every 6 months → Jan + Jul */
    const tickEvery  = 3; /* a tick mark every quarter */
    const lastIdx    = D.months.length - 1; /* always pin the last data point (e.g. Oct 2025) */
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 50, right: 25, bottom: 65, left: 60 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
        formatter: (params) => {
          const lines = params.map(p =>
            `${dot(p.color)}${p.seriesName}: <strong>${Number(p.value).toFixed(2)}%</strong>`);
          return `<div style="font-weight:700;margin-bottom:4px">${monthLabel(params[0].axisValue)}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: stateLabel },
        { name: 'National' },
      ]),
      xAxis: {
        type: 'category',
        data: D.months,
        axisLabel: Object.assign({}, T.axis, {
          /* Show every Jan/Jul label AND the very last data point
             (e.g. Oct 2025), even when the last point sits next to a
             Jan/Jul (Oct is just 3 months from Jul 2025).

             Implementation note: we DON'T use `showMaxLabel: true`
             here. That setting forces the rightmost label, but as a
             side effect ECharts actively HIDES the previous label
             when the two would overlap — and `hideOverlap: false`
             does NOT disable this path (the neighbour-hide is part
             of showMaxLabel's own logic, not the generic overlap
             detection).

             Instead: `interval: 0` makes every position eligible
             and the formatter returns '' for indices we don't want
             to display. Empty-string labels have zero rendered
             width, so they can't overlap or be auto-hidden. The
             wanted labels (Jan, Jul, last) are the only ones with
             visible text, and ECharts renders all three regardless
             of how close they sit to each other. */
          interval: 0,
          hideOverlap: false,
          formatter: (s, i) =>
            (i % labelEvery === 0 || i === lastIdx) ? shortMonthLabel(s) : '',
          rotate: 35,
          margin: 10,
        }),
        axisLine: { lineStyle: { color: T.colors.axisLine } },
        axisTick: {
          alignWithLabel: true,
          /* Quarter-tick rhythm: a visible mark every 3 months, plus
             the last data point so the final tick lines up with the
             always-shown last label. */
          interval: (i) => i % tickEvery === 0 || i === lastIdx,
          lineStyle: { color: T.colors.axisLine },
        },
        boundaryGap: false,
      },
      yAxis: {
        type: 'value',
        min: 0,
        axisLabel: Object.assign({}, T.axis, { formatter: v => v + '%' }),
        splitLine: { lineStyle: { color: T.colors.grid } },
        name: `${stateLabel} | National`,
        nameLocation: 'middle', nameGap: 45, nameRotate: 90,
        nameTextStyle: T.axisName,
      },
      series: [
        line(stateLabel, D.nsw,      T.colors.unit),
        line('National', D.national, T.colors.house),
      ],
    });
    attachResize(chart);
    return chart;
  });

  function line(name, data, color) {
    return {
      name, type: 'line', smooth: 0.2,
      symbol: 'circle', symbolSize: 7, showSymbol: false,
      emphasis: { scale: false },
      lineStyle: { color, width: 1.8 },
      itemStyle: { color },
      data,
    };
  }
})(window.PpaCharts);
