/* ════════════════════════════════════════════════════════════════════
   shared/report-cache.js — report-data snapshot cache (window.PPReportCache)
   ────────────────────────────────────────────────────────────────────
   The snapshot cache (table report_data_cache, one row per `source` — see
   migration 040). Since the Forge cutover the reports read Data Forge by
   DEFAULT and the snapshot is the FALLBACK copy: it is WRITTEN from Forge
   by each report's dev/admin "Save data" button and by the PUBLISH
   workflow's scripts/refresh-snapshots-from-forge.mjs; the presentation
   embeds still read it.

   Reads are open to any signed-in user; writes require a writer (dev/admin)
   — enforced by RLS on report_data_cache (a non-writer's upsert is rejected
   even if they trigger this from the console).

   The Google Apps Script legacy leg — the feed URLs, fetchLive() and
   updateAllSnapshots() — was retired 2026-07-30 along with the ?src=live /
   ?src=legacy hatch in the three report tools. This module is now snapshot-only:
   two functions, no network beyond Supabase.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var TABLE = 'report_data_cache';

  /* Read a stored snapshot. Returns the feed JSON, or null if none stored
     yet / on error (callers fall back to the live feed). */
  async function readSnapshot(source) {
    try {
      if (!window.sb) return null;
      var res = await window.sb.from(TABLE).select('data').eq('source', source).maybeSingle();
      if (res.error) throw res.error;
      return (res.data && res.data.data) ? res.data.data : null;
    } catch (e) {
      console.warn('[report-cache] snapshot read failed for', source, e && e.message || e);
      return null;
    }
  }

  /* Upsert a snapshot. Throws on error (writer-only, RLS-enforced). */
  async function writeSnapshot(source, json) {
    if (!window.sb) throw new Error('Supabase client not loaded');
    var res = await window.sb.from(TABLE).upsert(
      { source: source, data: json, updated_at: new Date().toISOString() },
      { onConflict: 'source' }
    );
    if (res.error) throw res.error;
  }

  /* fetchLive() and updateAllSnapshots() lived here until 2026-07-30, both
     reading the Apps Script feeds directly. Both are gone with the legacy leg:
     since the Forge cutover the snapshots this module reads are WRITTEN FROM
     FORGE (the reports' Save-data buttons and the PUBLISH workflow's
     scripts/refresh-snapshots-from-forge.mjs), so a live Google fetch could
     only ever have fired if Forge failed AND no snapshot existed — which cannot
     happen once a month's publish has run. updateAllSnapshots had no callers at
     all and was already refusing to run without an explicit override flag.

     The Apps Script Web Apps stay deployed and their source stays in
     scripts/apps-script-*.js: nothing reads them now, but undeploying them is a
     separate decision. */


  window.PPReportCache = {
    TABLE: TABLE,
    readSnapshot: readSnapshot,
    writeSnapshot: writeSnapshot,
  };
})();
