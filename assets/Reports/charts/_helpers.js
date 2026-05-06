/* ─────────────────────────────────────────────────────────────────────
   PPA Online Reports — Chart helpers + module registry
   ---------------------------------------------------------------------
   Shared utilities that every chart module depends on:
     - fmt: number formatters ($/%, k/m, days, integer)
     - tooltipBase: standard dark tooltip styling
     - staircaseYearAxis: anti-overlap year ticks (odd years drop a line)
     - crisisMarkLines / crisisMarkAreas: shared recession overlays
     - toolbox: per-chart save-png + zoom (off by default; opt in via opts)
     - attachResize: keep charts responsive to window changes
     - register / renderAll: tiny chart registry
         <div data-chart="median-price"></div>
         PpaCharts.register('median-price', (el, data) => {...})
         PpaCharts.renderAll(window.PPA_REGION_DATA.sydney)

   Loads after _theme.js. Add new helpers here, not in chart modules.
   ───────────────────────────────────────────────────────────────────── */
window.PpaCharts = window.PpaCharts || {};

(function (NS) {
  const T = NS.theme;

  /* ── Number formatters ── */
  NS.fmt = {
    money:     v => v >= 1e6 ? '$' + (v/1e6).toFixed(2).replace(/\.?0+$/,'') + 'M'
                              : '$' + Math.round(v/1000).toLocaleString() + 'K',
    moneyAxis: v => v === 0 ? '0'
                            : v >= 1e6 ? (v/1e6).toFixed(1).replace(/\.0$/,'') + 'm'
                                       : (v/1000).toFixed(0) + 'k',
    pct:       v => (v >= 0 ? '' : '') + Number(v).toFixed(2) + '%',
    pctShort:  v => Number(v).toFixed(1) + '%',
    intK:      v => v >= 1000 ? (v/1000).toFixed(0) + 'k' : v,
    integer:   v => Number(v).toLocaleString(),
    days:      v => v + ' days',
  };

  /* ── Standard top-left horizontal legend ──
        Anchored to the plot's left edge (matches grid.left=60 used by
        every horizontal-axis chart) and sized so swatches read clearly.
        New chart modules should call this with their `data` array
        instead of hand-writing legend coords — keeps every chart
        visually consistent.

        For donut/pie charts where 15+ legend items can't fit on one
        horizontal row, see `verticalLegendLeft` instead. */
  NS.standardLegend = (data, opts) => Object.assign({
    top: 4, left: 60, orient: 'horizontal',
    itemGap: 28, itemWidth: 22, itemHeight: 12,
    textStyle: T.legend,
    data: data,
  }, opts || {});

  /* ── Vertical legend pinned to the plot's right edge ──
        Donut/pie convention. Matches the Sydney PDF: donut on the
        LEFT, 19-item legend stack on the RIGHT. Pair with a chart
        whose centre sits on the left (e.g. series.center:
        ['30%', '52%']). Bigger swatch + text than the line-chart
        legend so the panel doesn't feel hollow next to the donut. */
  NS.verticalLegendRight = (data, opts) => Object.assign({
    top: 'middle', right: 30, orient: 'vertical',
    itemGap: 7, itemWidth: 14, itemHeight: 14,
    textStyle: Object.assign({}, T.legend, { fontSize: 13 }),
    data: data,
  }, opts || {});

  /* ── Vertical legend pinned to the plot's left edge ──
        Mirror of verticalLegendRight; rarely used, but kept so a chart
        type that genuinely belongs on the right (e.g. RTL contexts)
        can still anchor its legend left without redefining it. */
  NS.verticalLegendLeft = (data, opts) => Object.assign({
    top: 'middle', left: 30, orient: 'vertical',
    itemGap: 7, itemWidth: 14, itemHeight: 14,
    textStyle: Object.assign({}, T.legend, { fontSize: 13 }),
    data: data,
  }, opts || {});

  /* ── Standard dark tooltip (merge in trigger / formatter as needed) ── */
  NS.tooltipBase = (extra) => Object.assign({
    backgroundColor: 'rgba(15,25,34,0.95)',
    borderColor: '#2a3a48',
    textStyle: { color: '#fff', fontFamily: T.fonts.chart, fontSize: 12 },
    padding: [6, 10],
  }, extra || {});

  /* ── Tooltip swatch dot HTML ── */
  NS.dot = (color) =>
    `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin-right:6px"></span>`;

  /* ── Staircase year axis: anti-overlap by dropping odd years a line.
        Matches the Looker PDF's render of long-history charts.

        boundaryGap:false is the default — line series start flush
        against the left y-axis and end flush against the right one,
        which is what every line-only chart wants.

        For charts that draw BARS (or bars + lines on the same axis),
        pass `{ boundaryGap: true }` in opts. That gives each end of the
        plot a half-category of padding, so the first and last bar
        groups don't touch the y-axis labels and any y=0 markLine
        carries slightly past the first/last bar to the axes. ── */
  NS.staircaseYearAxis = (years, opts) => Object.assign({
    type: 'category',
    data: years.map(String),
    axisLabel: Object.assign({}, T.axis, {
      interval: 0,
      formatter: (v, i) => (i % 2 === 0) ? v : '\n' + v,
      lineHeight: 14,
    }),
    axisLine: { lineStyle: { color: T.colors.axisLine } },
    axisTick: { alignWithLabel: true, lineStyle: { color: T.colors.axisLine } },
    boundaryGap: false,
  }, opts || {});

  /* ── Crisis overlay (dashed red marklines + label boxes) ──
        Label is a horizontal red rounded badge anchored INSIDE the
        plot at the top of each vertical dashed line — like a flag on
        a pole, matching the Sydney PDF.

        Three settings together pin the badge's TOP-LEFT corner to the
        top of the line so the badge hangs down-and-right inside the
        plot:
          - `position: 'end'`        → anchor at top of vertical line
          - `align: 'left'`          → label's LEFT edge at anchor
          - `verticalAlign: 'top'`   → label's TOP edge at anchor
        `rotate: 0` is also required because ECharts otherwise rotates
        markLine labels along the line direction (vertical for our
        crisis lines). `distance: 4` slips the badge a few pixels down
        from the very top edge so it doesn't visually touch the plot's
        top border. */
  NS.crisisMarkLines = (crises) => (crises || []).map(c => ({
    xAxis: String(c.year),
    lineStyle: { color: T.colors.crisis, type: 'dashed', width: 1.5 },
    label: {
      show: true, position: 'end', rotate: 0, distance: 4,
      align: 'left', verticalAlign: 'top',
      formatter: c.label,
      backgroundColor: T.colors.crisisBg, color: '#fff',
      padding: [3, 7, 3, 7], borderRadius: 3,
      fontSize: 10, fontWeight: 700, fontFamily: T.fonts.chart,
    },
  }));

  /* ── Growth / Correction band fills ──
        If the host page has registered a user-bands hook
        (window.PPA_GET_USER_BANDS), use whatever it returns; otherwise
        fall back to the bands carried in the region data file. This is
        what ties the in-page "Bands" modal to every chart that draws
        reference bands without each chart needing its own plumbing. */
  NS.crisisMarkAreas = (bands) => {
    const list = (typeof window.PPA_GET_USER_BANDS === 'function')
      ? window.PPA_GET_USER_BANDS()
      : (bands || []);
    return list.map(b => ([
      { xAxis: String(b.from), itemStyle: { color: b.type === 'growth' ? T.colors.growthBand : T.colors.correctBand } },
      { xAxis: String(b.to) },
    ]));
  };

  /* ── Nice y-axis bounds (max + interval together) ──
        Given the observed data max, returns `{ max, interval }` such
        that:
          - `max` is the next multiple of a "nice" interval ABOVE the
            data, so the bars / line top out near the axis ceiling.
          - `interval` is one of the standard "nice" steps
            (1, 2, 2.5, 5 × power of 10) chosen so ~targetTicks fit
            between 0 and max — ticks land on round numbers all the
            way up, no squeezed final tick.

        Why both at once: ECharts will pick its own interval if you
        only give it a tight `max`, and that interval may not divide
        evenly into the new top. Pre-computing the pair guarantees
        even tick spacing.

        Example (targetTicks=7):
          niceAxis(168)     → { max: 175,     interval: 25 }
          niceAxis(1_550_000) → { max: 1_750_000, interval: 250_000 }
          niceAxis(0.6e6)   → { max: 600_000, interval: 100_000 }
          niceAxis(50)      → { max: 50,      interval: 10 }

        Use case: dual-axis bar+line charts where we want the line and
        bar tops to BOTH reach near the plot top while keeping the
        axis labels clean. Pass in the max of the relevant series.
        ── */
  NS.niceAxis = (dataMax, targetTicks) => {
    const t = targetTicks || 7;
    const m = Number(dataMax);
    if (!isFinite(m) || m <= 0) return { max: 1, interval: 0.2 };
    const raw = m / t;
    const exponent = Math.floor(Math.log10(raw));
    const fraction = raw / Math.pow(10, exponent);
    let nice;
    if (fraction <= 1)        nice = 1;
    else if (fraction <= 2)   nice = 2;
    else if (fraction <= 2.5) nice = 2.5;
    else if (fraction <= 5)   nice = 5;
    else                      nice = 10;
    const interval = nice * Math.pow(10, exponent);
    const max = Math.ceil(m / interval) * interval;
    return { max, interval };
  };

  /* ── Nice y-axis range with both ends clipped ──
        Like niceAxis(dataMax), but also clips the BOTTOM of the axis
        to the next multiple of `lowStep` below `dataMin` so the
        series fills the plot vertically rather than starting halfway
        up. Used on charts where a value series sits well above zero
        and we want it to share visual space with another series
        (e.g. line over bars in the Region v Peer chart).

        Example (default lowStep=10, targetTicks=7):
          niceAxisRange(115, 168) → { min: 110, max: 170, interval: 10 }
          niceAxisRange(100, 100) → { min:  90, max: 100, interval: 2  }
          niceAxisRange( 80, 130) → { min:  70, max: 130, interval: 10 }

        Rules:
          - `min` = largest multiple of `lowStep` strictly below dataMin
            (so dataMin=110 with step 10 → min=100, dataMin=118 → 110).
          - `max` = `min` + interval × N, smallest N such that
            max ≥ dataMax. Interval picked from 1/2/2.5/5 × power of 10
            so ticks land on round numbers.

        Targets ~7 ticks total. ── */
  NS.niceAxisRange = (dataMin, dataMax, targetTicks, lowStep) => {
    const t  = targetTicks || 7;
    const ls = lowStep    || 10;
    const lo = Number(dataMin);
    const hi = Number(dataMax);
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) {
      return { min: 0, max: hi || 1, interval: (hi || 1) / (t - 1) };
    }
    /* Subtract a small epsilon so an exact multiple of lowStep still
       drops one step (dataMin=110 → min=100, leaving breathing room). */
    const niceMin = Math.floor((lo - 1e-6) / ls) * ls;
    const range = hi - niceMin;
    const raw = range / (t - 1);
    const exponent = Math.floor(Math.log10(raw));
    const fraction = raw / Math.pow(10, exponent);
    let nice;
    if (fraction <= 1)        nice = 1;
    else if (fraction <= 2)   nice = 2;
    else if (fraction <= 2.5) nice = 2.5;
    else if (fraction <= 5)   nice = 5;
    else                      nice = 10;
    const interval = nice * Math.pow(10, exponent);
    const max = niceMin + Math.ceil(range / interval) * interval;
    return { min: niceMin, max, interval };
  };

  /* ── Long-term-average horizontal reference line ── */
  NS.longTermAverage = (value, label) => ({
    yAxis: value,
    lineStyle: { color: T.colors.longTerm, type: 'dashed', width: 1 },
    label: {
      show: true, position: 'insideStartTop',
      formatter: label || `Long-Term Average (${NS.fmt.pctShort(value)})`,
      color: T.colors.text, fontFamily: T.fonts.chart,
      fontSize: 10, fontStyle: 'italic', fontWeight: 600,
    },
  });

  /* ── Optional toolbox (save-PNG + invisible mouse-wheel zoom).
        Chart modules opt-in by spreading this into their option. ── */
  NS.toolbox = (extra) => Object.assign({
    show: true,
    right: 30, top: 8,
    feature: {
      saveAsImage: { title: 'Save PNG', name: 'ppa-chart', backgroundColor: '#eaf9fb', pixelRatio: 2 },
      restore:     { title: 'Reset' },
    },
    iconStyle: { borderColor: '#5a6878' },
    emphasis:  { iconStyle: { borderColor: '#3fb6d0' } },
  }, extra || {});

  /* ── Invisible (mousewheel) zoom for long-history charts. No visible
        slider, so PDF/print export stays clean. ── */
  NS.insideZoom = (xAxisIndex) => ([
    { type: 'inside', xAxisIndex: xAxisIndex || 0, throttle: 50, zoomOnMouseWheel: 'shift', moveOnMouseMove: false },
  ]);

  /* ── Window-resize binding ── */
  NS.attachResize = (chart) => {
    const fn = () => chart.resize();
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  };

  /* ── Module registry ──
        register('median-price', (el, data, opts) => echarts.init(el)...)
        renderAll(data) walks every <div data-chart="..."> and dispatches. */
  NS.registry = NS.registry || {};
  NS.register = (name, renderFn) => { NS.registry[name] = renderFn; };

  NS.renderAll = (data, opts) => {
    document.querySelectorAll('[data-chart]').forEach(el => {
      const name = el.dataset.chart;
      const fn = NS.registry[name];
      if (!fn) {
        console.warn('[PpaCharts] No renderer registered for', name);
        return;
      }
      try {
        fn(el, data, Object.assign({}, opts || {}, el.dataset));
      } catch (err) {
        console.error('[PpaCharts] Render failed for', name, err);
      }
    });
  };

  /* ── Get region data (?region=sydney URL param, default sydney) ── */
  NS.getRegionData = () => {
    const region = new URLSearchParams(location.search).get('region') || 'sydney';
    const all = window.PPA_REGION_DATA || {};
    return { region, data: all[region] || all.sydney };
  };

  /* ── Active-region display labels (region / state / peer) ──
        Reads ACTIVE_REGION + REGION_MANIFEST from the host page so
        charts can label themselves with the CURRENT region's name
        even when their data object came from Sydney's static baseline
        (i.e. before liveBoot's mapped data has flowed in for non-
        Sydney regions). Falls back to Sydney/NSW/Melbourne when the
        manifest is missing — matches the old hardcoded defaults.

        Note on globals: ACTIVE_REGION (let) and REGION_MANIFEST
        (const) are declared at the top level of online-reports.html
        — they ARE accessible by name from this chart helper because
        non-module scripts share a single script-level scope, but
        they are NOT attached to `window` (only `var` is). So we
        reference them directly with a `typeof ... !== 'undefined'`
        guard rather than via window.* . ── */
  NS.regionLabels = function () {
    const urlSlug  = new URLSearchParams(location.search).get('region');
    const slug     = (typeof ACTIVE_REGION !== 'undefined' && ACTIVE_REGION)
                    || urlSlug
                    || 'sydney';
    const M = (typeof REGION_MANIFEST !== 'undefined') ? REGION_MANIFEST : {};
    const manifest = M[slug] || {};
    const peerSlug = manifest.peer || 'melbourne';
    const peer     = M[peerSlug]   || {};
    return {
      region: manifest.name  || 'Sydney',
      state:  manifest.state || 'NSW',
      peer:   peer.name      || 'Melbourne',
    };
  };
})(window.PpaCharts);
