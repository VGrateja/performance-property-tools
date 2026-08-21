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

   HOW IT WORKS — two paths, and the second is the important one:

   1. Two charts (f12 Vacancy v Rent, house_unit House v Unit) are built HERE.
      They need nothing but the report feed, so the tool delegates to this module
      for them and there is no second copy of those options anywhere.
      scratch/_bss-golden.mjs proved that move byte-identical (48/48 captures).

   2. Everything else is read off the TOOL ITSELF, loaded in an offscreen
      same-origin iframe. Hand-moving 21 more renderers plus their loaders (rate
      series, CL rents, consumer confidence, underutilisation, stagnation
      periods, population projections, sensitivity, rankings, replacement cost)
      would be a ~2000-line refactor of a manager-approved tool, and every moved
      line is a chance to change a chart nobody asked to change. Reading the
      tool's real render instead means the two CANNOT drift.

   The tool's render() lays out every page at once — .bss-slide[data-key] inside
   #bssStack — mounts each chart, then paints the AUTHORED OVERLAYS from
   reports_state. That last part matters: most pages carry authored content
   (Market Positions Clock is 5 overlays, the Sensitivity and traffic-light pages
   1-6 each), so a page is only complete when read from the tool's own DOM.

   A page comes back as one of two things:
     • {echarts} — a live chart option, which the builder wraps in deck chrome
       and keeps editable
     • {image}   — a photograph of the tool's real page, placed FULL BLEED with
       no deck chrome, since an authored page already has its own title and logo

   Per-region availability comes from the tool's built DECK, so its onlyIf gates
   (VIC-only rental bonds, the 4-region infrastructure page, replacement cost
   where research exists) apply for free.
   =========================================================================== */
(function () {
  'use strict';

  /* ─── the Buying/Selling tool, borrowed in a hidden frame ───
     Moving all 23 chart renderers plus their loaders (rate series, CL rents,
     consumer confidence, underutilisation, stagnation periods, population
     projections, sensitivity, rankings, replacement cost) out of
     buying-selling-slides.html would be a ~2000-line refactor of a
     manager-approved tool, and every hand-moved line is a chance to change a
     chart nobody asked to change.

     The tool is SAME ORIGIN, so instead we load it in an offscreen iframe and
     call its own SLIDE_DEFS render/mount into a detached host. What comes back
     is the tool's actual chart — not a copy of it — so the two cannot drift, and
     per-region availability comes from the tool's own built DECK (its onlyIf
     gates already applied). Measured: frame ready ~200ms, first option ~1.1s,
     and the frame is reused for every pick in the same region+mode.

     A chart yields an ECharts option (vector, live, editable in the deck). The
     handful of slides that are bespoke DOM rather than a chart — traffic lights,
     At a Glance, Major Infrastructure Projects — have no option to read, so they
     are captured as an image instead. One code path handles both: read an option
     if there is one, else capture. */
  const FRAMES = {};            /* 'slug|mode' -> { el, win, ready } */
  const FRAME_TIMEOUT_MS = 60000;

  function frameKey(ctx) { return (ctx.slug || '') + '|' + (ctx.mode || 'sell'); }

  async function toolFrame(ctx) {
    const k = frameKey(ctx);
    if (FRAMES[k] && FRAMES[k].ready) return FRAMES[k].win;
    if (FRAMES[k] && FRAMES[k].pending) return FRAMES[k].pending;
    const rec = FRAMES[k] = { ready: false };
    rec.pending = (async () => {
      const el = document.createElement('iframe');
      el.setAttribute('aria-hidden', 'true');
      el.setAttribute('tabindex', '-1');
      el.style.cssText = 'position:fixed;left:-10000px;top:0;width:1400px;height:900px;border:0;visibility:hidden';
      /* the tool lives beside us in tools/, so a bare filename resolves */
      el.src = 'buying-selling-slides.html?region=' + encodeURIComponent(ctx.slug || '') +
               '&mode=' + encodeURIComponent(ctx.mode === 'buy' ? 'buy' : 'sell');
      document.body.appendChild(el);
      const win = await new Promise(res => {
        let done = false;
        el.onload = () => { if (!done) { done = true; res(el.contentWindow); } };
        setTimeout(() => { if (!done) { done = true; res(null); } }, FRAME_TIMEOUT_MS);
      });
      if (!win) { el.remove(); delete FRAMES[k]; return null; }
      /* wait for the tool's chart layer AND its built deck */
      const t0 = Date.now();
      for (;;) {
        let ok = false;
        try {
          /* SLIDE_DEFS and DECK are declared const/let, so they are NOT
             window properties — only the frame's own eval sees them. */
          ok = !!win.eval('(function(){ try { return !!(typeof SLIDE_DEFS !== "undefined" && Array.isArray(SLIDE_DEFS) && SLIDE_DEFS.length'
            + ' && typeof DECK !== "undefined" && Array.isArray(DECK) && DECK.length'
            + ' && window.echarts && window.ForgeReportAdapter && window.PpaCharts && window.PpaCharts.registry); } catch (e) { return false; } })()');
        } catch (e) { el.remove(); delete FRAMES[k]; return null; }   /* shouldn't happen: same origin */
        if (ok) break;
        if (Date.now() - t0 > FRAME_TIMEOUT_MS) { el.remove(); delete FRAMES[k]; return null; }
        await new Promise(r => setTimeout(r, 200));
      }
      rec.el = el; rec.win = win; rec.ready = true;
      return win;
    })();
    return rec.pending;
  }

  /* Render one of the tool's slides into a detached host inside the frame and
     hand back whichever representation exists: an ECharts option, or a captured
     image for the bespoke-DOM slides. */
  /* Read a page off the tool. Every page is already rendered in the frame with
     its authored overlays, so this reads the REAL slide rather than re-rendering
     a copy: a chart page hands back its live ECharts option (vector, editable in
     the deck), and anything else is photographed. */
  async function fromTool(key, ctx, want) {
    const win = await toolFrame(ctx);
    if (!win) return null;
    const el = slideEl(win, key);
    if (!el) return null;
    if (want !== 'image') {
      /* charts mount on a double-rAF; wait briefly, then give up and photograph.
         Several pages LOOK like charts but are DOM (Vacancy Rate Projection,
         Replacement Cost, both Sensitivity tables), so there is nothing to wait
         for on those. */
      const deadline = Date.now() + 9000;
      while (Date.now() < deadline) {
        try {
          for (const d of [el, ...el.querySelectorAll('div')]) {
            const inst = win.echarts.getInstanceByDom(d);
            if (inst) { const opt = inst.getOption(); if (opt) return { echarts: opt }; }
          }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 200));
      }
    }
    return await captureEl(win, el);
  }

  /* The tool's render() lays out EVERY page at once into #bssStack as
     .bss-slidewrap > .bss-scale > .bss-slide[data-key], mounts each one's chart,
     then paints the authored overlays. go(i) only scrolls to one.

     So there is nothing to navigate: the page we want is already on screen in
     the frame, complete with its overlays. Pick it by key. (Selecting
     '.bss-slide' without the key was the bug behind every capture coming back as
     the deck's first page.) */
  function slideEl(win, key) {
    try { return win.document.querySelector('.bss-slide[data-key="' + String(key).replace(/"/g, '') + '"]'); }
    catch (e) { return null; }
  }
  async function captureEl(win, el) {
    if (!win.html2canvas && typeof win._pdfLibs === 'function') { try { await win._pdfLibs(); } catch (e) {} }
    if (!win.html2canvas || !el) return null;
    try {
      /* same element and the same settings the tool uses for its own PDF export:
         explicit 1280x720 because html2canvas ignores the ancestor .bss-scale
         transform */
      const canvas = await win.html2canvas(el, { scale: 2, useCORS: true, logging: false,
        backgroundColor: '#ffffff', width: 1280, height: 720, windowWidth: 1280, windowHeight: 720 });
      return { image: canvas.toDataURL('image/png'), fullBleed: true };
    } catch (e) { return null; }
  }
  async function captureFromTool(key, ctx) {
    const win = await toolFrame(ctx);
    if (!win) return null;
    const el = slideEl(win, key);
    if (!el) return null;
    /* charts mount on a double-rAF during render(); give a late-loading one a
       moment before photographing the page */
    await new Promise(r => setTimeout(r, 1200));
    return await captureEl(win, el);
  }

  /* Which slides the tool actually builds for this region+mode — its own DECK,
     so onlyIf gates (VIC-only rental bonds and house-price expectations, the
     4-region infrastructure page, replacement cost where research exists) are
     already applied and the library can't offer a page the tool would drop. */
  async function toolDeck(ctx) {
    const win = await toolFrame(ctx);
    if (!win) return null;
    try { return (win.eval('DECK') || []).map(d => ({ key: d.key, title: d.t })); }
    catch (e) { return null; }
  }

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

  /* Every remaining page of the Buying/Selling deck, by kind. Anything not
     listed here and not in SLIDES above falls through to 'chart', which is the
     right default — the deck is mostly charts.

       capture — bespoke DOM with no chart to read (traffic lights, At a Glance,
                 Major Infrastructure Projects). Comes back as an image.
       title   — the tool's author-your-own templates: it renders them blank and
                 Van adds overlays. The formatted version is chrome + title, so a
                 deck gets a properly dressed slide to type onto.
     f2 (clock), demand_h (embed) and the three dividers are handled above. */
  const KINDS = {
    tl_before: 'capture', tl_best: 'capture', tl_revisit: 'capture',
    glance: 'capture', infra_projects: 'capture',
    /* Coverpage is NOT offered: a deck already gets its own cover slide, and
       Van removed this one to avoid two (2026-08-21). Market Positions Clock is
       a capture, not a blank template — its content is authored overlays. */
    f1: 'capture',
  };
  /* pages the library deliberately does not offer */
  const SKIP = { f0: true };
  function kindOf(key) {
    const s = byKey(key);
    if (s) return s.kind;
    return KINDS[key] || 'chart';
  }
  const byKey = k => SLIDES.find(s => s.key === k) || null;

  /* Build one slide's ECharts option for a region. Two charts are built natively
     here (they need nothing but the report feed, so there is no reason to boot a
     frame for them); every other chart comes from the tool itself. Either way
     there is exactly ONE definition of each chart — never two.
     Returns null when the region has no data — callers show their own empty state. */
  async function option(key, ctx) {
    const slide = byKey(key);
    if (slide && slide.derive) {
      const raw = await regionFeed((ctx || {}).slug);
      if (!raw) return null;
      let D = null;
      try { D = slide.derive(raw, ctx || {}); } catch (e) { D = null; }
      if (!D) return null;
      try { return slide.option(D, ctx || {}); } catch (e) { return null; }
    }
    const got = await fromTool(key, ctx || {}, 'option');
    return (got && got.echarts) ? got.echarts : null;
  }

  /* What the presentation builder actually needs: whichever representation this
     page has. A chart comes back as {echarts} (live and editable in the deck);
     a DOM page comes back as {image}. */
  async function build(key, ctx) {
    const slide = byKey(key);
    if (slide && slide.derive) {
      const o = await option(key, ctx);
      return o ? { echarts: o } : null;
    }
    return await fromTool(key, ctx || {}, 'option');
  }

  window.PP_BSS = {
    version: 1,
    /* the natively-built slides (no frame needed) */
    slides: function () { return SLIDES.map(s => ({ key: s.key, kind: s.kind, title: s.title })); },
    /* EVERY page the Buying/Selling tool builds for this region + purpose, in
       the tool's own deck order, with its own titles. Async because it reads the
       tool's built DECK from the hidden frame — which is what makes per-region
       gating exact (a non-VIC deck genuinely has no rental-bonds page, so the
       library doesn't offer one). Falls back to the natively-built slides if the
       frame can't load, so the library degrades rather than emptying. */
    slidesFor: async function (ctx) {
      const deck = await toolDeck(ctx || {});
      if (!deck || !deck.length) return SLIDES.map(s => ({ key: s.key, kind: s.kind, title: s.title }));
      return deck.filter(d => !SKIP[d.key]).map(d => {
        const own = byKey(d.key);
        return { key: d.key, kind: kindOf(d.key), title: (own && own.title) || d.title || d.key };
      });
    },
    kindOf: kindOf,
    /* bespoke-DOM slides (traffic lights, At a Glance, Infrastructure): a PNG of
       the tool's own render, to sit inside the deck's chrome */
    capture: async function (key, ctx) {
      const got = await captureFromTool(key, ctx || {});
      return got || null;   /* { image, fullBleed } */
    },
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
    /* what the presentation builder stores on a slide: {echarts} for a chart,
       {image} for a page that is DOM rather than a chart */
    chartSpec: build,
    ready: async function () { await loadCurated(); },
    /* exposed for the tool, which already has its own copies of these */
    _alignCols: alignCols,
    _regionFeed: regionFeed,
  };
})();
