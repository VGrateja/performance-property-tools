/* ============================================================================
   shared/tool-registry.js — the hub TOOL registry + group-visibility helpers
   ----------------------------------------------------------------------------
   Single source of truth for "what tools exist" in the staff-GROUPS system
   (migration 081: hub_groups + profiles.team). Groups are VISIBILITY-ONLY —
   write rights stay on `tier` (is_writer() etc.) and no existing RLS changes.

   • TOOLS: stable key → { sec, file(s), label }. `sec` matches the hub dock's
     .dicon[data-sec]. Keys are referenced by index.html APPS entries, the hub
     search palette, hub_groups.tools arrays, and auth-gate's deep-link check.
   • DEFAULT_BASELINE / DEFAULT_LEADS_EXTRA: the pre-migration fallback —
     MUST stay in lockstep with the 081 seed rows (company_baseline / leads).
     Once 081 is applied these constants are inert (the DB rows win).
   • ppToolAllowed(key) / ppSectionAllowed(sec): sync reads of the resolved
     allowed-state (window.ppAllowedState from shared/auth.js). Fail OPEN to
     the legacy tier gates whenever the state is missing — pre-resolution,
     pre-migration, externals — so the hub can never lock everyone out.

   Deliberately unregistered: the "Users Presentations" card (dev/admin
   oversight view — its existing CSS gate keeps governing; unregistered tools
   fail open here). Report-region deep links ride the 'online-reports' key.
   ============================================================================ */
(function () {
  'use strict';

  var TOOLS = {
    /* analytics */
    'clock':            { sec: 'analytics', file: 'property-clock.html',         label: 'National Property Clock' },
    'runway-demand':    { sec: 'analytics', file: 'runway-demand.html',          label: 'Runway v Demand Score' },
    /* vault */
    'runway-workbook':  { sec: 'vault',     file: 'runway-workbook.html',        label: 'Runway Workbook' },
    'vr-projection':    { sec: 'vault',     file: 'vr-projection.html',          label: 'Vacancy Rate Projection' },
    'forge':            { sec: 'vault',     file: 'data-forge.html',             label: 'Data Forge' },
    'data-extractor':   { sec: 'vault',     file: 'data-extractor.html',         label: 'Data Extractor' },
    'traffic-lights':   { sec: 'vault',     file: 'traffic-lights.html',         label: 'Traffic Lights' },
    'demand-score':     { sec: 'vault',     file: 'demand-score.html',           label: 'Demand Score Dashboard' },
    'market-compare':   { sec: 'vault',     file: 'market-compare.html',         label: 'Market Compare' },
    'bs-slides':        { sec: 'vault',     file: 'buying-selling-slides.html',  label: 'Buying/Selling Slides' },
    'suburb-data':      { sec: 'vault',     file: 'suburb-selection-data.html',  label: 'Suburb Selection Data' },
    'suburb-scoring':   { sec: 'vault',     file: 'suburb-scoring.html',         label: 'Suburb Scoring' },
    /* dev-only since 2026-08-19 (rebuilt as the Research Pipeline board):
       no hub card — a dev floating button + modal, like usage-analytics.
       devOnly keeps it out of the Groups panel; the page gates itself. */
    'data-map':         { sec: 'vault',     file: 'data-architecture.html',      label: 'Research Pipeline', devOnly: true },
    'reports-lite':     { sec: 'vault',     file: 'online-reports.html',         label: 'Lite Online Reports' },
    'lite-links':       { sec: 'vault',     file: 'lite-report-links.html',      label: 'Lite Report Links' },
    'results':          { sec: 'vault',     file: 'results.html',                label: 'Results' },
    'bookshelf':        { sec: 'vault',     file: 'bookshelf.html',              label: 'Bookshelf' },
    'investment-reports':{ sec: 'vault',    file: 'investment-reports.html',     label: 'IR Library' },
    'ir-builder':       { sec: 'vault',     file: 'ir-builder.html',             label: 'IR Builder' },
    /* dev-only telemetry dashboard — deliberately in NO group and NOT in
       DEFAULT_BASELINE: auth-gate bounces company/assigned-admin deep-links
       because the key is never in their allowed set; the page itself and
       RLS (mig 094) turn away unassigned admins.
       `devOnly` hides it from the Groups panel's tick list: groups CANNOT
       grant it (the page gate + RLS both demand dev tier), so offering the
       checkbox would imply access that ticking it can never produce. */
    'usage-analytics':  { sec: 'vault',     file: 'usage-analytics.html',        label: 'Usage Analytics', devOnly: true },
    /* pm */
    'cadence':          { sec: 'pm',        file: 'cadence.html',                label: 'Cadence' },
    'tenant-summary':   { sec: 'pm',        file: 'tenant-summary.html',         label: 'Tenant Application Summary' },
    /* arena ('arena' = the arcade landing page itself) */
    'arena':            { sec: 'arena',     file: 'arena.html',                  label: 'Performance Arena' },
    'arena-typing':     { sec: 'arena',     file: 'arena-typing.html',           label: 'Typing Test' },
    'arena-chess':      { sec: 'arena',     file: 'arena-chess.html',            label: 'Chess' },
    'arena-scrabble':   { sec: 'arena',     file: 'arena-scrabble.html',         label: 'Scrabble' },
    'arena-skribbl':    { sec: 'arena',     file: 'arena-skribbl.html',          label: 'Skribbl' },
    /* docs */
    'documents':        { sec: 'docs',      file: 'whitepapers-strategies.html', label: 'Documents' },
    'online-reports':   { sec: 'docs',      file: 'online-reports.html',         label: 'Online Reports' },
    'research-reports': { sec: 'docs',      files: ['national-report.html', 'commercial-report.html'], label: 'Research Reports (National + Commercial)' },
    /* present */
    'present-new':      { sec: 'present',   file: 'presentation.html',           label: 'Create a Presentation' },
    'present-company':  { sec: 'present',   file: 'presentation.html',           label: 'Company Presentations' },
    'present-mine':     { sec: 'present',   file: 'presentation.html',           label: 'My Presentations' },
    'present-library':  { sec: 'present',   file: 'presentations-library.html',  label: 'Presentations Library' },
    /* Curated Buying/Selling decks — the SAME file as the 'bs-slides' Vault
       master, holding a second key on purpose: 'bs-slides' = every region +
       curation controls, 'bs-slides-curated' = only the published set. Ticking
       just this key gives a group the curated card without the master, and the
       tool forces the filtered view for that user however they reach the URL. */
    'bs-slides-curated':{ sec: 'present',   file: 'buying-selling-slides.html',  label: 'Buying/Selling Slide (curated)' },
    /* people */
    'scorecards':       { sec: 'people',    file: 'scorecards.html',             label: 'Performance Scorecards' }
  };

  /* Pre-migration fallback = EXACTLY today's company-tier-visible hub.
     LOCKSTEP: mirror of the 081 company_baseline seed — change both or none. */
  /* 'results' moved to the Vault 2026-07-28 and OUT of the staff default —
     it is dev/admin (+ ticked groups) only, like every other Vault tool.
     'runway-workbook' + 'vr-projection' followed the same path 2026-08-24
     (Van removed both from the company_baseline group, then moved them into
     the Vault), so they leave this list too — otherwise a pre-resolution hub
     would still offer staff two tools they can no longer open. */
  var DEFAULT_BASELINE = ['clock', 'runway-demand',
    'documents', 'online-reports', 'research-reports',
    'present-new', 'present-company', 'present-mine', 'present-library',
    'arena', 'arena-typing', 'arena-chess', 'arena-scrabble', 'arena-skribbl'];
  var DEFAULT_LEADS_EXTRA = ['scorecards'];   /* lockstep with the 081 'leads' seed */

  /* every registry key whose file matches a basename (a file can carry
     several keys — e.g. online-reports.html is 'online-reports' + 'reports-lite') */
  function keysForFile(basename) {
    var out = [];
    for (var k in TOOLS) {
      var t = TOOLS[k];
      if (t.file === basename || (t.files && t.files.indexOf(basename) >= 0)) out.push(k);
    }
    return out;
  }

  window.PP_TOOL_REGISTRY = {
    TOOLS: TOOLS,
    DEFAULT_BASELINE: DEFAULT_BASELINE,
    DEFAULT_LEADS_EXTRA: DEFAULT_LEADS_EXTRA,
    keysForFile: keysForFile
  };

  /* ── sync visibility reads (state resolved by shared/auth.js) ─────────── */

  /* Is this tool key visible to the current user?  Unknown/unregistered keys
     and missing state fail OPEN — the legacy tier CSS/JS gates keep governing. */
  window.ppToolAllowed = function (key) {
    var st = (typeof window.ppAllowedState === 'function') && window.ppAllowedState();
    if (!key || !st || st.mode === 'all' || st.mode === 'external') return true;
    if (!TOOLS[key]) return true;                    /* unregistered → legacy gates */
    return !!st.keys && st.keys.has(key);
  };

  /* Is a dock section visible?  With no resolved state (or externals) this
     reproduces TODAY'S gates exactly (_hubIsStaff/_hubIsLeadsPlus mirror), so
     the pre-resolution hub is pixel-identical to the current one. */
  window.ppSectionAllowed = function (sec) {
    var st = (typeof window.ppAllowedState === 'function') && window.ppAllowedState();
    if (!st || st.mode === 'external') {
      var l = (typeof window.getAccessLevel === 'function') ? window.getAccessLevel() : '';
      if (sec === 'pm' || sec === 'vault') return l === 'dev' || l === 'admin';
      if (sec === 'people') return l === 'dev' || l === 'admin' || l === 'leads';
      return true;
    }
    if (st.mode === 'all') return true;
    for (var k in TOOLS) { if (TOOLS[k].sec === sec && st.keys && st.keys.has(k)) return true; }
    return false;
  };
})();
