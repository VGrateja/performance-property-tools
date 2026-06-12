/* ════════════════════════════════════════════════════════════════════
   shared/report-cache.js — report-data snapshot cache (window.PPReportCache)
   ────────────────────────────────────────────────────────────────────
   The reports' chart data comes from Google Apps Script web apps that
   cold-start at 10-25 s each. The data only changes once a month, so we
   keep a copy in Supabase (table report_data_cache, one row per `source`)
   and read THAT on load — see migration 040. This module owns the cache
   read/write plus the GLOBAL refresh used by every report's dev/admin
   "Save data" button: one click refreshes EVERY feed (the four regional
   clusters + national + commercial), so it only has to be pressed once.

   Reads are open to any signed-in user; writes require a writer (dev/admin)
   — enforced by RLS on report_data_cache (a non-writer's upsert is rejected
   even if they trigger this from the console).

   NOTE: the feed URLs below are the single list used for the global refresh.
   They are duplicated in each report's own page code (online-reports.html
   REPORTS_DATA_URLS; national/commercial REPORT_DATA_URL) which still owns
   its live-fetch fallback — keep the two in sync if a feed URL ever changes.
   These Apps Script web apps are public GETs (not secrets), same as before.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var TABLE = 'report_data_cache';

  /* Every report feed, keyed by its snapshot `source`. The four cluster
     URLs back the 35 regional reports; national/commercial are the
     research reports. */
  var FEEDS = {
    capital:    'https://script.google.com/macros/s/AKfycbwCpEAXvYXh0Jrm46DfgaIA-iDM5dsF0XKK9z55JNALbkoM-OqyKm8DAyAeNanTYC_N/exec',
    qld:        'https://script.google.com/macros/s/AKfycbwEkGUCmJL1svxkxoiiKFeGvn7OVA0PNSsRAtB7wEESdmKmwpKqrsFuKoz9ASL_3DE/exec',
    nsw:        'https://script.google.com/macros/s/AKfycbzWkMzOZWBK-jYT2tqE3XvECux_-eYbYU-d_cY3s6nDDOEFcmLSmqznLOCjiqf_BF4/exec',
    vicwatas:   'https://script.google.com/macros/s/AKfycbzEZzKiKojm1sh-ABhiUTwPxmLBsPHk4rCY6u7NQw9W94GUONJq9ffqaPYVrDEgu7uG/exec',
    national:   'https://script.google.com/macros/s/AKfycbxTYz5pzmKvpHLwYLLjJo68prVjQWNYA5WXc-iR8QQZiho-kez-M_i0Ci1vXLGSxnmsGQ/exec',
    commercial: 'https://script.google.com/macros/s/AKfycbzToEKHw7bxEBNgxnPNC5hn70p2H18Extzxq_e1DMgGTXQi72sPN_2U0ahn9JB-Nco/exec',
  };

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

  /* Fetch straight from a feed (the slow cold-start path), bypassing the
     snapshot. Aborts after timeoutMs (default 45 s) so a hung feed can't
     wedge the refresh. Heavy feeds (qld/nsw) can take a while to assemble
     server-side, hence the generous default. */
  async function fetchLive(source, timeoutMs) {
    var url = FEEDS[source];
    if (!url) return null;
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, timeoutMs || 45000);
    try {
      var res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(to); }
  }

  /* GLOBAL refresh — fetch EVERY feed fresh from Google and upsert each
     into Supabase. One click covers all reports (regionals + national +
     commercial). opts.onProgress(done, total, source, ok) fires per feed.
     Returns { ok, updated:[...sources], failed:[...'source (reason)'] }.

     SEQUENTIAL, not parallel: Google Apps Script queues concurrent calls
     from the same account, so firing all six at once starved the heaviest
     feeds (qld/nsw) and they hit the abort timer while waiting. One at a
     time — with one retry — gives each feed its own clean window. */
  async function updateAllSnapshots(opts) {
    opts = opts || {};
    var sources = Object.keys(FEEDS).filter(function (s) { return FEEDS[s]; });
    var total = sources.length, done = 0, updated = [], failed = [];
    for (var i = 0; i < sources.length; i++) {
      var source = sources[i];
      var ok = false, reason = '';
      for (var attempt = 1; attempt <= 2 && !ok; attempt++) {
        try {
          /* Pause before the retry so a cold-started / momentarily-slow feed
             can recover, and give the retry a longer window. The heavy feeds
             (qld/nsw) assemble a lot server-side and can take >45s, so the
             first window is 60s and the retry 90s. */
          if (attempt > 1) await new Promise(function (r) { setTimeout(r, 2000); });
          var json = await fetchLive(source, attempt === 1 ? 60000 : 90000);
          if (!json) throw new Error('empty feed');
          await writeSnapshot(source, json);
          updated.push(source);
          ok = true;
        } catch (e) {
          if (e && e.name === 'AbortError') reason = 'timed out (feed too slow)';
          else reason = (e && e.message) ? e.message : String(e);
          console.warn('[report-cache] update failed for', source, '(attempt ' + attempt + '):', reason);
        }
      }
      if (!ok) failed.push(source + ' (' + (reason || 'failed') + ')');
      done += 1;
      if (opts.onProgress) { try { opts.onProgress(done, total, source, ok); } catch (_) {} }
    }
    return { ok: failed.length === 0, updated: updated, failed: failed };
  }

  window.PPReportCache = {
    TABLE: TABLE,
    FEEDS: FEEDS,
    readSnapshot: readSnapshot,
    writeSnapshot: writeSnapshot,
    fetchLive: fetchLive,
    updateAllSnapshots: updateAllSnapshots,
  };
})();
