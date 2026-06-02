/* ============================================================================
 * shared/error-reporter.js
 *
 * Captures uncaught errors + unhandled promise rejections and logs them to
 * public.client_errors (migration 031) so breakage surfaces proactively
 * instead of waiting for a user to report it. This is a no-build static
 * site with ~one maintainer; this is the closest thing to monitoring.
 *
 * Loading order (every page that talks to the DB):
 *   <script src=".../@supabase/supabase-js@2"></script>
 *   <script src="../shared/supabase-client.js"></script>   ← creates window.sb
 *   <script src="../shared/error-reporter.js"></script>    ← this file
 *
 * Design guarantees:
 *   • NEVER throws. Every path is wrapped — a broken reporter must not
 *     cascade into the page it's monitoring.
 *   • Bounded volume. Dedupes identical errors per page-load and caps total
 *     reports (MAX_REPORTS), so a render loop can't flood the table.
 *   • Auth-gated by design. Inserts require a Supabase session (RLS:
 *     user_id = auth.uid()). No session → drop silently (login-page
 *     pre-auth errors aren't captured; tool pages are gated behind auth
 *     anyway so JS only runs once signed in).
 *   • No user input captured — only the error message/stack/location.
 * ========================================================================== */

(function () {
  'use strict';

  var MAX_REPORTS = 10;     // hard cap per page-load
  var STACK_MAX   = 4000;   // truncate long stacks before storing
  var seen = {};            // signature -> true (per-load dedupe)
  var sent = 0;
  var queue = [];
  var flushing = false;

  function toolName() {
    try {
      var p = String(location.pathname).replace(/\/+$/, '');
      var f = p.substring(p.lastIndexOf('/') + 1) || 'index.html';
      return f.replace(/\.html$/i, '') || 'index';
    } catch (e) { return ''; }
  }

  function clip(s, n) {
    if (s == null) return '';
    s = String(s);
    return s.length > n ? s.slice(0, n) : s;
  }

  function buildRow(d) {
    return {
      tool:       toolName(),
      url:        clip((location.pathname || '') + (location.search || ''), 1000),
      message:    clip(d.message, 2000),
      source:     clip(d.source, 1000),
      lineno:     (typeof d.lineno === 'number') ? d.lineno : null,
      colno:      (typeof d.colno  === 'number') ? d.colno  : null,
      stack:      clip(d.stack, STACK_MAX),
      user_agent: clip((navigator && navigator.userAgent) || '', 1000)
    };
  }

  function flush() {
    if (flushing) return;
    if (!window.sb || !window.sb.auth || !queue.length) return;
    flushing = true;
    Promise.resolve()
      .then(function () { return window.sb.auth.getSession(); })
      .then(function (res) {
        var sess = res && res.data && res.data.session;
        if (!sess) { queue.length = 0; return; }  // not signed in → drop
        var uid = sess.user && sess.user.id;
        var email = '', tier = '';
        try { email = sessionStorage.getItem('pp_user_email') || (sess.user && sess.user.email) || ''; } catch (e) {}
        try { tier  = sessionStorage.getItem('pp_auth_level') || ''; } catch (e) {}
        var batch = queue.splice(0, queue.length).map(function (row) {
          row.user_id = uid; row.email = email; row.tier = tier;
          return row;
        });
        return window.sb.from('client_errors').insert(batch);
      })
      .catch(function () { /* swallow — never surface a reporter failure */ })
      .then(function () { flushing = false; });
  }

  function report(d) {
    try {
      if (sent >= MAX_REPORTS) return;
      var sig = (d.message || '') + '|' + (d.source || '') + '|' + (d.lineno || '');
      if (seen[sig]) return;
      seen[sig] = true;
      sent++;
      queue.push(buildRow(d));
      flush();
    } catch (e) { /* swallow */ }
  }

  window.addEventListener('error', function (e) {
    /* Resource-load failures (img/script 404) reach this handler with no
       .error and an empty message — ignore them; we only want real script
       exceptions. */
    if (!e || (!e.error && !e.message)) return;
    report({
      message: e.message || (e.error && e.error.message) || 'Error',
      source:  e.filename || '',
      lineno:  e.lineno,
      colno:   e.colno,
      stack:   e.error && e.error.stack
    });
  });

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var msg;
    try { msg = (r && (r.message || (typeof r === 'string' ? r : JSON.stringify(r)))) || 'Unhandled promise rejection'; }
    catch (_) { msg = 'Unhandled promise rejection'; }
    report({ message: msg, source: '', stack: r && r.stack });
  });

  /* Late flush: errors thrown before window.sb's session resolved get
     retried once the page has settled. */
  window.addEventListener('load', function () { setTimeout(flush, 1500); });
})();
