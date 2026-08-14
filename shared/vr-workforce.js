/* =============================================================================
   vr-workforce.js — INFRASTRUCTURE WORKFORCE MODIFIER: loader, not data.

   THE NUMBERS ARE NOT IN THIS FILE, AND MUST NOT BE PUT BACK. This repo is
   PUBLIC and the workforce figures are internal research. They live in
   public.vr_workforce (migration 100), behind auth like everything else.
   This module only knows how to fetch them.

   What they are: extra PEOPLE expected in a market from major-project
   workforces, in forecast year 1 and year 2, compiled by hand each quarter and
   covering only the markets with material project pipelines. They convert to
   households at the region's average size, exactly like any other incoming
   people. A market with no row disables the workforce toggle rather than
   applying a silent zero.

   NOT A DOUBLE COUNT. The source workbook's IM tab holds G = E + WF; the
   pipeline stores column E, the WF-free base, so these ADD to it. Anyone
   re-wiring the IM feed must keep pulling column E — pulling the combined
   column and adding this would count the workforce twice.

   The 1.0 multiplier is an OPEN ASSUMPTION: no local-hire, FIFO or
   camp-accommodation discount. Calibration path: QGSO non-resident population.

   TO UPDATE (quarterly): edit public.vr_workforce. Not a code change any more.

   Usage — always await load() before reading:
     await VrWorkforce.load(window.sb);        // browser
     await VrWorkforce.load(sb, payloadsById); // node, with a fallback source
     VrWorkforce.forRegion('mackay')  ->  { y1, y2 } | null
   ============================================================================= */
(function (root) {
  'use strict';

  let TABLE = null;                 // null until loaded — never a silent {}
  let REVIEWED = null;
  let SOURCE = 'unloaded';

  /* Fetch from public.vr_workforce. If that table isn't there yet (migration
     100 not applied), fall back to the wf figures already embedded per region
     in rdp_vr_forecast.payload.demand — the same numbers, written by
     build-vr-demand.mjs, so the tool keeps working either way and still reads
     nothing from the repo. */
  async function load(sb, payloads) {
    if (TABLE) return TABLE;
    TABLE = {};
    try {
      const { data, error } = await sb.from('vr_workforce').select('region_slug,y1,y2,reviewed');
      if (!error && data && data.length) {
        for (const r of data) TABLE[r.region_slug] = { y1: +r.y1, y2: +r.y2 };
        REVIEWED = data[0].reviewed || null;
        SOURCE = 'vr_workforce';
        return TABLE;
      }
    } catch (e) { /* fall through to the payload fallback */ }

    try {
      let rows = payloads;
      if (!rows) {
        const { data } = await sb.from('rdp_vr_forecast').select('region_slug,payload');
        rows = data || [];
      }
      for (const r of rows) {
        const d = r.payload && r.payload.demand;
        // V2, not V1: V1 repeats year 1 wholesale and sets its wf2 equal to
        // wf1, so only V2 carries the real year-2 figure.
        const src = (d && d.v2) || (d && d.v1);
        if (src && src.wf1) TABLE[r.region_slug] = { y1: +src.wf1, y2: +src.wf2 };
      }
      SOURCE = Object.keys(TABLE).length ? 'rdp_vr_forecast (fallback — apply migration 100)' : 'none';
    } catch (e) { SOURCE = 'none'; }
    return TABLE;
  }

  const forRegion = slug => (TABLE && TABLE[slug]) || null;
  const markets = () => Object.keys(TABLE || {});
  const reviewed = () => REVIEWED;
  const source = () => SOURCE;
  const loaded = () => TABLE != null;

  root.VrWorkforce = { load, forRegion, markets, reviewed, source, loaded };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
