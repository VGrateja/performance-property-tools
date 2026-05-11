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

  /* Auth migration to Clerk: we no longer check localStorage['pp-sb-auth']
     because supabase-js doesn't manage the session anymore — Clerk does.
     Instead we trust the sessionStorage flag that the hub's Clerk handler
     sets after a successful Clerk sign-in. sessionStorage carries between
     pages in the same tab, so navigating from the hub to a tool keeps the
     signed-in state. If a user opens a tool URL directly without going
     through the hub first (e.g. a bookmark), sessionStorage is empty and
     they get redirected to the hub to sign in. */
  let signedIn = false;
  try {
    if (sessionStorage.getItem('pp_auth') === '1') {
      signedIn = true;
    }
  } catch (e) { /* sessionStorage blocked → treat as signed-out */ }

  if (!signedIn) {
    const path = window.location.pathname.replace(/[^/]+$/, '');
    const parts = path.split('/').filter(Boolean);
    const up = parts[parts.length - 1] === 'tools' ? '../' : './';
    window.location.replace(up + 'index.html');
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
})();
