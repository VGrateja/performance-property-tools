/* ============================================================================
 * Performance Property — auth-gate for tool pages
 *
 * Loaded by every /tools/*.html page BEFORE the tool's own content renders.
 * If the user isn't logged in (no Supabase session in localStorage), we
 * redirect back to the hub login page.
 *
 * This is a UX gate, not a security boundary — even if someone bypasses it
 * client-side, every DB read/write is RLS-policed in Postgres. The real
 * boundary is supabase/migrations/001_init.sql.
 *
 * Loading order on a tool page (before this file):
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="../shared/supabase-client.js"></script>
 *   <script src="../shared/auth.js"></script>      ← hydrates sessionStorage
 *   <script src="../shared/auth-gate.js"></script> ← checks + applies restrictions
 *
 * ─────────────────────────────────────────────────────────────────────────── */

(function ppAuthGate() {
  'use strict';

  /* The supabase-client.js wrapper persists sessions in localStorage under
     the custom key 'pp-sb-auth'. We peek at it synchronously so we can
     redirect before paint, without waiting on the JS SDK to initialise. */
  let signedIn = false;
  try {
    const raw = localStorage.getItem('pp-sb-auth');
    if (raw) {
      const data = JSON.parse(raw);
      /* supabase-js v2 stores a session object with an access_token. If
         the token is expired the SDK will refresh it on first call —
         here we only need to know "did the user sign in at some point".
         An expired+un-refreshable token will fail the next DB call and
         trigger a sign-out via auth.js's onAuthStateChange handler. */
      if (data && (data.access_token || (data.currentSession && data.currentSession.access_token))) {
        signedIn = true;
      }
    }
  } catch (e) { /* malformed storage → treat as signed-out */ }

  if (!signedIn) {
    const path = window.location.pathname.replace(/[^/]+$/, '');
    const parts = path.split('/').filter(Boolean);
    const up = parts[parts.length - 1] === 'tools' ? '../' : './';
    window.location.replace(up);
    throw new Error('auth-gate: not signed in, redirecting…');
  }

  /* Apply tier-based UI restrictions once auth.js has hydrated session
     storage from the Supabase session. auth.js calls
     applyAccessRestrictions itself on hydrate, but tool pages may render
     before that — re-running it here is a no-op safety net. */
  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else { fn(); }
  }

  onReady(function () {
    try {
      if (typeof applyAccessRestrictions === 'function') applyAccessRestrictions();
    } catch (e) { console.warn('applyAccessRestrictions failed:', e); }
  });

  /* ── GROUP deep-link gate (081, "hidden means hidden") ────────────────────
     If this tool page isn't in the signed-in staff member's group, bounce
     back to the hub. Visibility-only + FAIL-OPEN by design: RLS already
     protects the data, so any doubt (no registry, resolver error, tool page
     unknown, dev/admin/external mode) means "let it load".
     • exportMode/lite requests skip entirely — the monthly pdf-renderer
       (company tier, no team) deep-links every report with those params.
     • Async on purpose: the page may paint briefly before bouncing; that is
       accepted (the alternative — blocking paint on a network fetch — is
       worse, and the data was never exposed either way). */
  onReady(function () {
    try {
      const q = new URLSearchParams(window.location.search);
      if (q.get('exportMode') === '1' || q.get('lite') === '1') return;
      const REG = window.PP_TOOL_REGISTRY;
      if (!REG || typeof REG.keysForFile !== 'function') return;
      const basename = (window.location.pathname.split('/').pop() || '').toLowerCase();
      const keys = REG.keysForFile(basename);
      if (!keys.length) return;                      /* unregistered page → allow */
      const decide = function (st) {
        if (!st || st.mode !== 'set' || !st.keys) return;   /* all/external/unresolved → allow */
        const ok = keys.some(function (k) { return st.keys.has(k); });
        if (!ok) {
          const path = window.location.pathname.replace(/[^/]+$/, '');
          const parts = path.split('/').filter(Boolean);
          window.location.replace(parts[parts.length - 1] === 'tools' ? '../' : './');
        }
      };
      const cached = (typeof window.ppAllowedState === 'function') && window.ppAllowedState();
      if (cached) { decide(cached); return; }
      if (typeof window.ppResolveAllowedTools === 'function') {
        window.ppResolveAllowedTools().then(decide).catch(function () {});
      }
    } catch (e) { /* fail open */ }
  });
})();
