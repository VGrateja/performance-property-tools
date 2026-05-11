/* ============================================================================
 * Clerk client wrapper.
 *
 * Replaces supabase-js auth with Clerk for the sign-in / session layer.
 * Supabase is still our database (PostgREST + RLS); Clerk just issues the
 * JWTs that Supabase verifies via the third-party-auth integration set up
 * in Supabase Dashboard → Auth → Third Party Auth.
 *
 * Why this exists: see docs/BUG.md. supabase-js auth hung on the network
 * stack for any non-org-owner email, intermittently and unfixably from app
 * code. Clerk runs its own auth endpoints on its own infra, completely
 * sidestepping that bug.
 *
 * Loading order on every page that uses Supabase data:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="https://humble-kingfish-89.clerk.accounts.dev/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"></script>
 *   <script src="../shared/clerk-client.js"></script>
 *   <script src="../shared/supabase-client.js"></script>
 *   <script src="../shared/auth.js"></script>
 *
 * After this script runs, window.Clerk is the Clerk instance; you can call
 * window.Clerk.session?.getToken() to get a JWT that Supabase accepts.
 * ========================================================================== */

(function () {
  'use strict';

  const CLERK_PUBLISHABLE_KEY = 'pk_test_aHVtYmxlLWtpbmdmaXNoLTg5LmNsZXJrLmFjY291bnRzLmRldiQ';

  /* Promise that resolves once Clerk has fully loaded. Other scripts that
     need to talk to Clerk should `await window.ppClerkReady` before reading
     window.Clerk.user / .session. */
  let _resolveReady;
  window.ppClerkReady = new Promise((r) => { _resolveReady = r; });

  /* Wait until the Clerk CDN script has put a Clerk constructor on window,
     then initialise. The CDN tag uses `async`, so this script may run
     before Clerk is on window. Poll briefly. */
  function start() {
    if (window.Clerk && typeof window.Clerk.load === 'function') {
      /* New CDN drop pattern: window.Clerk is already an instance, just
         needs .load() called with the publishable key. */
      window.Clerk.load({ publishableKey: CLERK_PUBLISHABLE_KEY })
        .then(() => {
          _resolveReady(window.Clerk);
        })
        .catch((e) => {
          console.error('Clerk.load failed', e);
          _resolveReady(null);
        });
      return;
    }
    if (window.Clerk && window.Clerk.prototype && typeof window.Clerk.prototype.load === 'function') {
      /* Older constructor pattern: instantiate then load. */
      const inst = new window.Clerk(CLERK_PUBLISHABLE_KEY);
      inst.load()
        .then(() => {
          window.Clerk = inst;
          _resolveReady(inst);
        })
        .catch((e) => {
          console.error('Clerk.load failed', e);
          _resolveReady(null);
        });
      return;
    }
    /* Not loaded yet — retry next frame. Bail after a few seconds so the
       page doesn't hang forever if the CDN never loads. */
    if (start._tries === undefined) start._tries = 0;
    start._tries++;
    if (start._tries > 200) {
      console.error('Clerk CDN failed to load after ~10s — check the <script> tag.');
      _resolveReady(null);
      return;
    }
    setTimeout(start, 50);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
