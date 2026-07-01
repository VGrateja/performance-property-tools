/* ════════════════════════════════════════════════════════════════════
   shared/forge-commercial-adapter.js  —  window.ForgeCommercialAdapter

   Reshapes the forge_commercial store into the Commercial report's feed
   shape so the unchanged chart code renders it. Used only when the report
   is opened with ?src=forge.

   Store shape:  { tabs: { <tab>: { name, columns:{ <col>:[vals] }, headers } }, _meta }
   Feed shape:   { _meta, tabs: { <tab>: { <col>:[vals] } } }

   So: out.tabs[<tab>] = store.tabs[<tab>].columns. Three store tab names
   were truncated to ~30 chars at seed time — restore the full feed names
   the report reads. The feed's "checklist" tab is a sheet-status meta tab
   (no chart) and is intentionally not in the store.
   ════════════════════════════════════════════════════════════════════ */
(function (root) {
  var RENAME = {
    'copy-of-building-price-indices': 'copy-of-building-price-indices-data',
    'individuals-who-accessed-gp-dat': 'individuals-who-accessed-gp-data',
    'pop-accessing-health-services': 'pop-accessing-health-services-data',
  };
  function forgeCommercialToFeed(store) {
    var data = (store && store.data && store.data.tabs) ? store.data : store;  // accept the DB row or the jsonb
    var tabs = (data && data.tabs) || {};
    var out = {
      _meta: { generated: (data._meta && (data._meta.seeded || data._meta.generated)) || null, source: 'forge_commercial', tabCount: 0 },
      tabs: {},
    };
    for (var t in tabs) {
      if (!Object.prototype.hasOwnProperty.call(tabs, t)) continue;
      var name = RENAME[t] || t;
      out.tabs[name] = (tabs[t] && tabs[t].columns) || {};
    }
    out._meta.tabCount = Object.keys(out.tabs).length;
    return out;
  }
  root.ForgeCommercialAdapter = { forgeCommercialToFeed: forgeCommercialToFeed };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
