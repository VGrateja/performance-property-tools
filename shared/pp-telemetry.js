/* ═══════════════════════════════════════════════════════════════════════
   pp-telemetry.js — anonymous-to-staff, dev-readable usage telemetry.

   Loaded on every signed-in page (hub + tools) AFTER supabase-client.js
   and auth.js. Feeds the dev-only Usage Analytics tool via the
   pp_track_usage RPC (migration 094): one row per (tab-session, tool,
   AEST day), incremented by small beats — never a row per event.

   Engagement model (GA4-style "engaged time"):
     a second counts only while the tab is VISIBLE and the user gave any
     input in the last 60s — or 5 minutes while something is fullscreen,
     because a presenter talking over a slide is engaged without touching
     anything. Idle/background tabs send nothing at all.

   Where it stays silent:
     · not signed in (no session → RPC would no-op anyway; we don't call)
     · inside ANY iframe (report PDF/export/embed frames load full pages)
     · exportMode=1 / embed=1 (the Puppeteer PDF renderer's path — its
       service account must never pollute usage data)
   Every entry point is try/caught: telemetry must never break a tool.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  try {
    if (window.top !== window) return;                       /* iframes */
    var q;
    try { q = new URLSearchParams(location.search); } catch (e) { q = null; }
    if (q && (q.get('exportMode') === '1' || q.get('embed') === '1')) return;
    if (!window.sb || !window.sb.auth) return;               /* no client on page */

    /* ── identity of THIS tab ── */
    var SID = null;
    try {
      SID = sessionStorage.getItem('pp_tel_sid');
      if (!SID) {
        SID = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
            : 'tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem('pp_tel_sid', SID);
      }
    } catch (e) { SID = 'tab-' + Date.now().toString(36); }

    /* ── which tool is this page? filename sans .html; the hub is 'hub' ── */
    var path = location.pathname || '/';
    var file = path.split('/').pop() || '';
    var TOOL = file.replace(/\.html?$/i, '');
    if (!TOOL || TOOL === 'index') TOOL = 'hub';

    /* light context: whitelisted params only (region slugs, modes — no ids) */
    var CTX = '';
    try {
      var keep = ['region', 'cluster', 'mode', 'view', 'market', 'markets', 'curated', 'pair'];
      var parts = [];
      keep.forEach(function (k) {
        var v = q && q.get(k);
        if (v) parts.push(k + '=' + String(v).slice(0, 40));
      });
      CTX = parts.join('&').slice(0, 160);
    } catch (e) {}

    /* ── device meta (first beat only) ── */
    function deviceMeta() {
      var ua = navigator.userAgent || '';
      var br = /Edg\//.test(ua) ? 'Edge'
             : /OPR\//.test(ua) ? 'Opera'
             : /Firefox\//.test(ua) ? 'Firefox'
             : /Chrome\//.test(ua) ? 'Chrome'
             : /Safari\//.test(ua) ? 'Safari' : 'Other';
      var os = /Windows/.test(ua) ? 'Windows'
             : /Mac OS X/.test(ua) ? (/iPhone|iPad/.test(ua) ? 'iOS' : 'macOS')
             : /iPhone|iPad/.test(ua) ? 'iOS'
             : /Android/.test(ua) ? 'Android'
             : /Linux/.test(ua) ? 'Linux' : 'Other';
      var meta = {
        br: br, os: os,
        vw: Math.round(window.innerWidth || 0),  vh: Math.round(window.innerHeight || 0),
        sw: Math.round((screen && screen.width)  || 0),
        sh: Math.round((screen && screen.height) || 0)
      };
      /* page-load ms (nav start → DOM interactive) — clamped so a tab
         restored from sleep can't report an hour-long "load" */
      try {
        var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
        var lm = nav ? Math.round(nav.domInteractive) : 0;
        if (lm > 0 && lm < 120000) meta.lm = lm;
      } catch (e) {}
      return meta;
    }

    /* ── engagement accounting ── */
    var lastActivity = Date.now();
    var pendingSecs  = 0;        /* engaged seconds not yet flushed */
    var pendingViews = 1;        /* this page load = 1 open */
    var sentMeta     = false;
    var token        = null;     /* cached access token for the pagehide beat */

    function activityWindowMs() {
      try { if (document.fullscreenElement) return 300000; } catch (e) {}
      return 60000;
    }
    function bump() { lastActivity = Date.now(); }
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
      try { window.addEventListener(ev, bump, { passive: true, capture: true }); } catch (e) {}
    });
    /* mousemove fires constantly — throttle it to one bump per 5s */
    var lastMove = 0;
    try {
      window.addEventListener('mousemove', function () {
        var t = Date.now();
        if (t - lastMove > 5000) { lastMove = t; lastActivity = t; }
      }, { passive: true, capture: true });
    } catch (e) {}

    var TICK = 5;                /* seconds per accounting tick */
    setInterval(function () {
      try {
        if (document.visibilityState !== 'visible') return;
        if (Date.now() - lastActivity > activityWindowMs()) return;
        pendingSecs += TICK;
      } catch (e) {}
    }, TICK * 1000);

    /* ── transport ── */
    function payload() {
      var p = {
        p_session: SID, p_tool: TOOL, p_page: path,
        p_secs: pendingSecs, p_views: pendingViews,
        p_ctx: CTX || null,
        p_meta: sentMeta ? null : deviceMeta()
      };
      pendingSecs = 0; pendingViews = 0; sentMeta = true;
      return p;
    }

    function flush() {
      try {
        if (pendingSecs <= 0 && pendingViews <= 0) return;
        var body = payload();
        /* refresh the cached token opportunistically for the pagehide path */
        try {
          window.sb.auth.getSession().then(function (r) {
            token = r && r.data && r.data.session && r.data.session.access_token || token;
          }).catch(function () {});
        } catch (e) {}
        /* supabase-js builders are LAZY — .then() is what fires the request */
        window.sb.rpc('pp_track_usage', body).then(function () {}, function () {});
      } catch (e) {}
    }

    /* final beat when the tab hides/closes — keepalive fetch survives unload */
    function flushBeacon() {
      try {
        if (pendingSecs <= 0 && pendingViews <= 0) return;
        if (!token || !window.sb.supabaseUrl || !window.sb.supabaseKey) { flush(); return; }
        var body = JSON.stringify(payload());
        fetch(window.sb.supabaseUrl + '/rest/v1/rpc/pp_track_usage', {
          method: 'POST', keepalive: true,
          headers: {
            'Content-Type': 'application/json',
            'apikey': window.sb.supabaseKey,
            'Authorization': 'Bearer ' + token
          },
          body: body
        }).catch(function () {});
      } catch (e) {}
    }

    try {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flushBeacon();
      });
      window.addEventListener('pagehide', flushBeacon);
    } catch (e) {}

    /* ── one-shot event beats on pseudo tool keys ('present:<tool>',
       'export:<tool>') — same table, same RPC; the dashboard splits the
       prefixed keys out of the leaderboard/engaged-time and counts them as
       their own KPIs. Fire-and-forget, never before the session exists. ── */
    function tag(prefix) {
      try {
        if (!token) return;                       /* pre-auth: drop silently */
        window.sb.rpc('pp_track_usage', {
          p_session: SID, p_tool: prefix + ':' + TOOL, p_page: path,
          p_secs: 0, p_views: 1, p_ctx: CTX || null, p_meta: null
        }).then(function () {}, function () {});
      } catch (e) {}
    }
    window.PP_TRACK = { tag: tag };

    /* entering fullscreen ≈ presenting (B/S Present, presentation deck,
       Market Compare present all go fullscreen) — count entries only */
    try {
      document.addEventListener('fullscreenchange', function () {
        if (document.fullscreenElement) tag('present');
      });
    } catch (e) {}

    /* ── boot: wait for a signed-in session, then open with the first beat ── */
    var bootTries = 0;
    (function waitForSession() {
      try {
        window.sb.auth.getSession().then(function (r) {
          var s = r && r.data && r.data.session;
          if (s && s.access_token) {
            token = s.access_token;
            flush();                                   /* views:1 + meta */
            setInterval(flush, 60000);                 /* engaged-time beats */
          } else if (++bootTries < 10) {
            setTimeout(waitForSession, 1500);          /* auth may still be restoring */
          }
        }).catch(function () {
          if (++bootTries < 10) setTimeout(waitForSession, 1500);
        });
      } catch (e) {}
    })();
  } catch (e) { /* telemetry must never break a page */ }
})();
