/* ─────────────────────────────────────────────────────────────────────
   Chart: NSW Lending vs Median Price (4 lines, dual axis, monthly)
   ---------------------------------------------------------------------
   Mount: <div data-chart="lending-vs-price"></div>
   Data:  region.lendingVsPrice { months, investor, ownerOcc,
          medianHouse, medianUnit }
   Layout: Lending lines on left axis, Median price lines on right.
   ───────────────────────────────────────────────────────────────────── */
(function (NS) {
  const T = NS.theme;
  const { fmt, tooltipBase, dot, attachResize, standardLegend } = NS;

  /* Tooltip label uses the full "Mon YYYY" form — gives the user
     month-level context on hover even though the axis only shows
     quarterly ticks. */
  function monthLabel(s) {
    const [y, m] = s.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
  }

  /* Compact "Mon YY" format used for the visible axis labels —
     short enough to fit a label every 6 months across 22 years. */
  function shortMonthLabel(s) {
    const [y, m] = s.split('-').map(Number);
    const mon = new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'short' });
    return mon + ' ' + String(y).slice(-2);
  }

  NS.register('lending-vs-price', function (el, data) {
    const D = data.lendingVsPrice;
    const labelEvery = 6; /* one label every 6 months → Jan + Jul */
    const tickEvery  = 3; /* a tick mark every quarter */
    const lastIdx    = D.months.length - 1; /* always pin the last data point */
    /* Lending values now arrive from the mapper already in MILLIONS
       display (Sydney $5.5b → 5500, Darwin $162.3m → 162.3). Render
       as plain numbers — no $ prefix, no unit suffix — matching the
       Looker reference (Darwin ticks: 0/20/40/.../160).

       Once the value reaches 1,000+ (i.e. >= $1b in lending), append
       a "k" so "5,000" reads as "5k" and "5,500" reads as "5.5k".
       Below 1,000 the value renders plain (Darwin "162.3"). No
       rounding so the precise value carries through (5,523.456
       reads as "5.523456k"). */
    const fmtLending = v => {
      const n = Number(v);
      if (!isFinite(n)) return '';
      return n >= 1000
        ? (n / 1000).toLocaleString() + 'k'
        : n.toLocaleString();
    };
    const lendingAxisFmt = fmtLending;
    const lendingTipFmt  = fmtLending;
    const chart = echarts.init(el, null, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 50, right: 65, bottom: 60, left: 60 },
      tooltip: tooltipBase({
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#6a7a88', type: 'dashed' } },
        formatter: (params) => {
          const lines = params.map(p => {
            const v = Number(p.value);
            const isPrice = p.seriesName.indexOf('Median') === 0;
            const f = isPrice ? fmt.money(v) : lendingTipFmt(v);
            return `${dot(p.color)}${p.seriesName}: <strong>${f}</strong>`;
          });
          return `<div style="font-weight:700;margin-bottom:4px">${monthLabel(params[0].axisValue)}</div>${lines.join('<br/>')}`;
        },
      }),
      legend: standardLegend([
        { name: 'Investor'           },
        { name: 'Owner Occupier'     },
        { name: 'Median House Price' },
        { name: 'Median Unit Price'  },
      ]),
      xAxis: {
        type: 'category',
        data: D.months,
        axisLabel: Object.assign({}, T.axis, {
          /* `interval: 0` + formatter that returns '' for non-eligible
             indices renders every Jan/Jul label AND the very last
             data point, with no risk of ECharts auto-hiding a label
             whose neighbour is being force-shown. See
             chart-mortgage-arrears.js for the full rationale. */
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
      yAxis: [
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: lendingAxisFmt }),
          splitLine: { lineStyle: { color: T.colors.grid } },
          name: 'Investor | Owner Occupier',
          nameLocation: 'middle', nameGap: 45, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
        {
          type: 'value', min: 0,
          axisLabel: Object.assign({}, T.axis, { formatter: fmt.moneyAxis }),
          splitLine: { show: false },
          name: 'Median House Price | Median Unit Price',
          nameLocation: 'middle', nameGap: 50, nameRotate: 90,
          nameTextStyle: T.axisName,
        },
      ],
      series: [
        line('Investor',           D.investor,    T.colors.house, 0),
        line('Owner Occupier',     D.ownerOcc,    T.colors.unit,  0),
        line('Median House Price', D.medianHouse, T.colors.houseBar, 1),
        line('Median Unit Price',  D.medianUnit,  '#a4adb6',         1),
      ],
    });
    attachResize(chart);
    return chart;
  });

  function line(name, data, color, axisIndex) {
    return {
      name, type: 'line', smooth: 0.2,
      yAxisIndex: axisIndex,
      symbol: 'circle', symbolSize: 7, showSymbol: false,
      emphasis: { scale: false },
      lineStyle: { color, width: 1.8 },
      itemStyle: { color },
      data,
    };
  }
})(window.PpaCharts);
