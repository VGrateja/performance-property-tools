/* ===========================================================================
   shared/bss-slides.js — Buying/Selling slide content (window.PP_BSS)

   ONE source of truth for the charts on the Buying/Selling slides, shared by:
     • tools/buying-selling-slides.html — the tool itself, which mounts them
       into its own slide chrome
     • tools/presentation.html — the Buying/Selling Library, which wraps them in
       the DECK's chrome (_fmtChrome) so an imported slide matches the rest of
       the presentation instead of the tool it came from

   WHY SHARED AND NOT COPIED: the alternative was re-implementing these charts
   inside the presentation builder. Two copies of a manager-approved chart drift
   the moment either is touched, and Van compares pixel-for-pixel. Extracting
   follows the same pattern as shared/report-edit.js, which was pulled out of the
   regional report tool so the research reports could reuse it.

   THE SEAM: every renderer in the B/S tool has the same shape —
       load the feed → derive a small D → build an ECharts option → mount it.
   Only the middle two steps are worth sharing; mounting is host-specific (the
   tool mounts into .bss-chart, the builder into a chart overlay). So this module
   owns the loaders and the option builders, and returns a plain ECharts option.
   Callers do their own mounting.

   The option objects below are moved VERBATIM from buying-selling-slides.html,
   comments included, so the tool renders byte-identically after delegating.
   scratch/_bss-golden.mjs captures every option per region before and after and
   diffs them — that is the proof, not an assumption.

   COVERAGE: charts are being moved incrementally, each proven by the golden
   diff. Slides not yet moved simply don't appear in the library, so a partial
   extraction is never a broken one. Not yet moved (they need loaders beyond the
   report feed — rate series, CL rents, consumer confidence, underutilisation,
   stagnation periods, population projections, traffic lights, glance, infra):
   median_combined, yield_rate, stub_cci, stub_underutil, f13, pop_move,
   vr_proj, tl_before, tl_best, glance, infra_projects, demand_h, f2, f6,
   stub_dwellings, stub_bonds, stub_hpei, stub_jobads, stub_busfin.
   =========================================================================== */
(function () {
  'use strict';

  /* ─── shared data layer ─── */
  const FEED = {};              /* slug -> rdp_report_feed payload | null */
  let CURATED = null;           /* { sell:[], buy:[] } | null until loaded */

  /* Verbatim from the tool (_orAlignCols): walk a year column plus N value
     columns and keep only the rows that qualify. 'strict' keeps a year only
     when EVERY value is present; 'loose' keeps it when at least one is. */
  function alignCols(keyCol, valCols, opts) {
    opts = opts || {}; const mode = opts.mode || 'strict';
    const kp = k => { const n = parseInt(k, 10); return Number.isFinite(n) ? n : null; };
    const kc = keyCol || []; const keys = [], cols = valCols.map(() => []);
    for (let i = 0; i < kc.length; i++) {
      const k = kp(kc[i]); if (k == null || k === '') continue;
      const vals = valCols.map(vc => { const v = (vc || [])[i]; if (v === '' || v == null || (typeof v === 'number' && isNaN(v))) return null; return Number(v); });
      const present = vals.filter(v => v != null).length;
      if (present === 0) continue;
      if (mode === 'strict' && present < valCols.length) continue;
      keys.push(k); vals.forEach((v, j) => cols[j].push(v));
    }
    return { keys, cols };
  }

  /* rdp_report_feed payload for a region, cached per page like the tool's
     getFeed(). Null means "no report data in Forge for this region yet". */
  async function feedPayload(slug) {
    if (FEED[slug] !== undefined) return FEED[slug];
    try {
      const { data } = await window.sb.from('rdp_report_feed').select('payload').eq('region_slug', slug).maybeSingle();
      FEED[slug] = (data && data.payload) || null;
    } catch (e) { FEED[slug] = null; }
    return FEED[slug];
  }

  /* the adapter output (the same shape the online reports consume) */
  async function regionFeed(slug) {
    const payload = await feedPayload(slug);
    if (!payload || !window.ForgeReportAdapter) return null;
    try { return window.ForgeReportAdapter.forgeRegionToFeed(payload, slug); }
    catch (e) { return null; }
  }

  /* Which regions the B/S tool offers per purpose — read from the same
     reports_state row the tool reads ('bss-visibility'), so the library can
     never list a region the tool itself would not show. */
  async function loadCurated() {
    if (CURATED) return CURATED;
    try {
      const { data } = await window.sb.from('reports_state').select('payload').eq('region', 'bss-visibility').maybeSingle();
      const p = (data && data.payload) || null;
      CURATED = { sell: (p && Array.isArray(p.sell)) ? p.sell : [], buy: (p && Array.isArray(p.buy)) ? p.buy : [] };
    } catch (e) { CURATED = { sell: [], buy: [] }; }
    return CURATED;
  }

  /* The report's own axis helpers (assets/Reports/charts/_helpers.js). Both
     hosts load that file, but fall back rather than throw if one ever doesn't —
     the fallbacks are the ladders these charts used before. */
  const niceAxis = (max, fb) => (window.PpaCharts && window.PpaCharts.niceAxis)
    ? window.PpaCharts.niceAxis(max) : fb;
  const niceAxisRange = (min, max, fb) => (window.PpaCharts && window.PpaCharts.niceAxisRange)
    ? window.PpaCharts.niceAxisRange(min, max) : fb;

  /* ─── house_unit — "House v Unit" ───
     House + Unit medians as bars on the $ axis, with the unit-as-%-of-house
     line on the right axis. BOTH axes come from the report's helpers so this
     draws the same ladder as Online Reports p15 (Van 2026-08-21). */
  function deriveHouseUnit(raw) {
    const a = alignCols(raw.year, [raw.medianHousePrice, raw.medianUnitPrice], { mode: 'strict' });
    if (!a.keys.length) return null;
    const h = a.cols[0].map(Math.round), u = a.cols[1].map(Math.round);
    const diff = h.map((v, i) => v ? Math.round(u[i] / v * 1000) / 10 : null);
    return { years: a.keys, h, u, diff };
  }
  function optionHouseUnit(D) {
    const dvals = D.diff.filter(v => v != null);
    const avg = Math.round(dvals.reduce((a, b) => a + b, 0) / dvals.length * 10) / 10;
    const money = v => '$' + Number(v).toLocaleString();
    /* null-safe max, matching chart-house-v-unit-price.js's module-local
       seriesRange() (it isn't exported, so the semantics are reproduced). */
    const vmax = arrs => { let m = -Infinity; arrs.forEach(a => (a || []).forEach(v => { const n = Number(v); if (v != null && isFinite(n) && n > m) m = n; })); return m; };
    const pMax = vmax([D.h, D.u]);
    const step = [50000, 100000, 200000, 250000, 500000].find(s => pMax / s <= 10) || 500000;
    const barAxis = niceAxis(pMax, { max: Math.ceil(pMax / step) * step, interval: step });
    const lineAxis = niceAxisRange(Math.min.apply(null, dvals), Math.max.apply(null, dvals),
      { min: 0, max: Math.max(100, Math.ceil(Math.max.apply(null, dvals) / 20) * 20), interval: 20 });
    return { backgroundColor: 'transparent', animation: false,
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true,
        formatter: params => '<b>' + params[0].axisValue + '</b><br>' + params.map(p => p.marker + p.seriesName + ': <b>' + (p.seriesName.indexOf('%') >= 0 ? (p.value == null ? '—' : p.value + '%') : money(p.value)) + '</b>').join('<br>') },
      legend: { top: 2, left: 'center', itemWidth: 9, itemHeight: 9, itemGap: 14, textStyle: { fontSize: 9, color: '#222' },
        data: [{ name: 'MHP', icon: 'rect' }, { name: 'MUP', icon: 'rect' }, { name: '% Difference H v U', icon: 'circle' }, { name: '% Diff Average', icon: 'rect' }] },
      grid: { left: 70, right: 52, top: 40, bottom: 46 },
      xAxis: { type: 'category', data: D.years, axisLabel: { color: '#444', fontSize: 8.5, interval: 0, rotate: 90 }, axisTick: { alignWithLabel: true }, axisLine: { lineStyle: { color: '#999' } } },
      yAxis: [
        { type: 'value', min: 0, max: barAxis.max, interval: barAxis.interval, axisLabel: { color: '#444', fontSize: 9, formatter: money }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.10)' } } },
        { type: 'value', min: lineAxis.min, max: lineAxis.max, interval: lineAxis.interval, axisLabel: { color: '#444', fontSize: 9, formatter: v => v + '%' }, splitLine: { show: false } }],
      series: [
        { name: 'MHP', type: 'bar', data: D.h, itemStyle: { color: '#00A0B4' }, barGap: '10%', barCategoryGap: '40%' },
        { name: 'MUP', type: 'bar', data: D.u, itemStyle: { color: '#c6c6c6' } },
        { name: '% Difference H v U', type: 'line', yAxisIndex: 1, data: D.diff, smooth: true, showSymbol: false, symbol: 'circle', symbolSize: 1, lineStyle: { color: '#171B24', width: 2.4 }, itemStyle: { color: '#171B24' } },
        { name: '% Diff Average', type: 'line', yAxisIndex: 1, data: D.years.map(() => avg), showSymbol: false, lineStyle: { color: '#E72347', width: 2, type: 'dashed' }, itemStyle: { color: '#E72347' } }] };
  }

  /* ─── f12 — "Vacancy v Rent" ───
     Rent House / Rent Unit bars on the right $ axis with $ labels, vacancy-rate
     line on the LEFT % axis (the sample deck swaps the axes vs the old module).

     VR SOURCE NOTE (verified 2026-07-17): the feed's vacancyRate = rdp metric
     'vacancy_rate' whose source tag reads 'sqm' — a LEGACY LABEL from the old
     Google-Sheet block header. Its recent values come from Van's monthly
     COTALITY upload (forge_cotality 'rentvacancy' → sync-cotality-medians). So
     this chart is already Cotality — do NOT "fix" it to corelogic/
     vacancy_rate_h (that's the older data-dump vintage). */
  function deriveVacRent(raw) {
    const a = alignCols(raw.year, [raw.medianRentHouse, raw.medianRentUnit, raw.vacancyRate], { mode: 'strict' });
    if (!a.keys.length) return null;
    let D = { years: a.keys, house: a.cols[0].map(v => Math.round(v)), unit: a.cols[1].map(v => Math.round(v)), vr: a.cols[2].map(v => Math.round(v * 1e4) / 100) };
    /* Head-trim: SQM's first datapoints are tiny-sample junk in BOTH directions
       (2004-05 spikes of 12-37% across ~30 regions; Sydney 2002-03 = 0.03%/
       0.25% — raw mart rows, not an adapter bug). Drop leading years until two
       consecutive plausible (0.5%-8%) values; genuine mid-series extremes
       (Gladstone/Mackay mining bust ~9%, 2021+ sub-0.5% tight markets) sit
       later so they survive. Mart cleaned 2026-07-19 (scratch/clean-vr-junk.mjs)
       — this guard stays as insurance against future junk ingests. */
    const ok = x => x >= 0.5 && x <= 8; let i0 = 0;
    while (i0 < D.vr.length - 1 && !(ok(D.vr[i0]) && ok(D.vr[i0 + 1]))) i0++;
    if (i0 > 0 && i0 < D.vr.length - 1) D = { years: D.years.slice(i0), house: D.house.slice(i0), unit: D.unit.slice(i0), vr: D.vr.slice(i0) };
    return D;
  }
  function optionVacRent(D) {
    const dollars = v => '$' + Number(v).toLocaleString();
    const rMax = Math.max.apply(null, D.house.concat(D.unit));
    const rStep = [50, 100, 200, 250, 500].find(s => rMax / s <= 9) || 500;
    const rTop = Math.ceil((rMax * 1.08) / rStep) * rStep;   /* headroom so bar labels clear the frame */
    /* dynamic tick step — a fixed 0.25% smears the axis into dozens of labels
       whenever the data peaks high */
    const vMax = Math.max.apply(null, D.vr);
    let vStep = 5, vTop = Math.ceil((vMax * 1.15) / 5) * 5;
    for (const s of [0.25, 0.5, 1, 2, 2.5, 5]) { const t = Math.ceil((vMax * 1.15) / s) * s; if (t / s <= 12) { vStep = s; vTop = t; break; } }
    return { backgroundColor: 'transparent', animation: false,
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true,
        formatter: params => { return '<b>' + params[0].axisValue + '</b><br>' + params.map(p => p.marker + p.seriesName + ': <b>' + (p.seriesType === 'line' ? (p.value == null ? '—' : Number(p.value).toFixed(2) + '%') : dollars(p.value)) + '</b>').join('<br>'); } },
      legend: { top: 2, left: 'center', itemWidth: 9, itemHeight: 9, itemGap: 14, textStyle: { fontSize: 9, color: '#222' },
        data: [{ name: 'Rent House', icon: 'rect' }, { name: 'Rent Unit', icon: 'rect' }, { name: 'Vacancy Rate', icon: 'circle' }] },
      grid: { left: 64, right: 64, top: 44, bottom: 46 },
      xAxis: { type: 'category', data: D.years, axisLabel: { color: '#444', fontSize: 8.5, interval: 0, rotate: 90 }, axisTick: { alignWithLabel: true }, axisLine: { lineStyle: { color: '#999' } } },
      yAxis: [
        { type: 'value', min: 0, max: vTop, interval: vStep, axisLabel: { color: '#444', fontSize: 9, formatter: v => v.toFixed(2) + '%' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.10)' } },
          name: 'Vacancy Rate', nameLocation: 'middle', nameGap: 50, nameRotate: 90, nameTextStyle: { color: '#444', fontSize: 10 } },
        { type: 'value', min: 0, max: rTop, interval: rStep, axisLabel: { color: '#444', fontSize: 9, formatter: dollars }, splitLine: { show: false },
          name: 'Rent House | Rent Unit', nameLocation: 'middle', nameGap: 48, nameRotate: 90, nameTextStyle: { color: '#444', fontSize: 10 } }],
      series: [
        { name: 'Rent House', type: 'bar', yAxisIndex: 1, data: D.house, itemStyle: { color: '#171B24' }, barGap: '10%', barCategoryGap: '35%',
          label: { show: true, position: 'top', fontSize: 8, color: '#333', formatter: p => dollars(p.value) } },
        { name: 'Rent Unit', type: 'bar', yAxisIndex: 1, data: D.unit, itemStyle: { color: '#c6c6c6' },
          label: { show: true, position: 'top', fontSize: 8, color: '#555', formatter: p => dollars(p.value) } },
        { name: 'Vacancy Rate', type: 'line', yAxisIndex: 0, data: D.vr, smooth: true, symbol: 'circle', symbolSize: 1,   /* labels attach to symbols — keep invisible 1px dots */
          lineStyle: { color: '#00A0B4', width: 3 }, itemStyle: { color: '#00A0B4' },
          label: { show: true, position: 'top', fontSize: 8, color: '#333', textBorderColor: '#fff', textBorderWidth: 2, formatter: p => (p.value == null ? '' : Number(p.value).toFixed(2) + '%') } }] };
  }

  /* ─── registry ───
     `title` is the label shown in the library and used as the imported slide's
     heading; it matches the B/S tool's own SLIDE_DEFS title so a deck and the
     tool call the same page the same thing. */
  const SLIDES = [
    /* kind:'chart' — an ECharts option the caller mounts. */
    { key: 'f12',        kind: 'chart', title: 'Vacancy v Rent', derive: deriveVacRent,   option: optionVacRent },
    { key: 'house_unit', kind: 'chart', title: 'House v Unit',   derive: deriveHouseUnit, option: optionHouseUnit },

    /* The three below aren't charts, so there is no option to build — the module
       just declares WHAT the slide is and the caller builds the overlays its own
       way (the B/S tool mounts DOM; the presentation builder makes native
       overlays). That keeps the seam honest: shared = what the slide is,
       host-specific = how it's realised.

       These exist as formatted slides because the builder could already insert a
       clock and an embed manually, but neither arrived with the deck's chrome —
       Van 2026-08-21: "that insert is not formatted right away. So better create
       a formatted one to make their life easier." */
    { key: 'f2',       kind: 'clock',   title: 'Property Clock' },
    { key: 'demand_h', kind: 'embed',   title: 'Demand vs Runway',
      /* wage-growth basis follows the purpose: Buying = 5yr, Selling = 1yr,
         exactly as the B/S tool builds this iframe. */
      embed: function (ctx) {
        return { src: 'runway-demand.html?embed=1&view=house&wg=' + (((ctx || {}).mode === 'buy') ? 5 : 1),
                 title: 'Runway v Demand', baseW: 1136, baseH: 754 };
      } },
    /* Dividers carry a single word on the dark section background. The picker
       label keeps the tool's "(divider)" suffix so it is obvious what it is;
       `word` is what lands on the slide. */
    { key: 'div_demand', kind: 'divider', title: 'DEMAND (divider)',     word: 'DEMAND' },
    { key: 'div_value',  kind: 'divider', title: 'VALUE (divider)',      word: 'VALUE' },
    { key: 'div_conf',   kind: 'divider', title: 'CONFIDENCE (divider)', word: 'CONFIDENCE' },
  ];
  const byKey = k => SLIDES.find(s => s.key === k) || null;

  /* Build one slide's ECharts option for a region. Returns null when the region
     has no data for it — callers show their own empty state. */
  async function option(key, ctx) {
    const slide = byKey(key);
    if (!slide) return null;
    const raw = await regionFeed((ctx || {}).slug);
    if (!raw) return null;
    let D = null;
    try { D = slide.derive(raw, ctx || {}); } catch (e) { D = null; }
    if (!D) return null;
    try { return slide.option(D, ctx || {}); } catch (e) { return null; }
  }

  window.PP_BSS = {
    version: 1,
    /* every slide this module can currently build */
    slides: function () { return SLIDES.map(s => ({ key: s.key, kind: s.kind, title: s.title })); },
    /* per-region list. Region-specific gating (the tool's onlyIf) arrives with
       the slides that need it; for now every moved slide is region-agnostic. */
    slidesFor: function (ctx) { return SLIDES.map(s => ({ key: s.key, kind: s.kind, title: s.title })); },
    /* the non-chart slides' parameters: word for a divider, iframe src for an
       embed. Returns null for chart slides, which use chartSpec instead. */
    meta: function (key, ctx) {
      const s = byKey(key);
      if (!s) return null;
      if (s.kind === 'divider') return { kind: 'divider', word: s.word, title: s.title };
      if (s.kind === 'embed') return Object.assign({ kind: 'embed' }, s.embed(ctx || {}));
      if (s.kind === 'clock') return { kind: 'clock', title: s.title };
      return null;
    },
    /* slugs the B/S tool curates for this purpose ('buy' | 'sell') */
    curatedSlugs: async function (mode) {
      const c = await loadCurated();
      return (c && c[mode === 'buy' ? 'buy' : 'sell']) || [];
    },
    option: option,
    /* what the presentation builder stores on a chart overlay */
    chartSpec: async function (key, ctx) {
      const o = await option(key, ctx);
      return o ? { echarts: o } : null;
    },
    ready: async function () { await loadCurated(); },
    /* exposed for the tool, which already has its own copies of these */
    _alignCols: alignCols,
    _regionFeed: regionFeed,
  };
})();
