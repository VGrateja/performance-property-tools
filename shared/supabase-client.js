/* ============================================================================
 * Supabase client wrapper.
 *
 * Loaded on every page that talks to the database (login + every tool).
 * Exposes the client as window.sb so legacy plain-JS code can call it
 * without ES-module imports — matches the rest of this project's style.
 *
 * The PUBLISHABLE key below is intentionally in-page. It's safe in the
 * browser; security comes from Row-Level Security policies on each table
 * (see supabase/migrations/001_init.sql). Treat it like the JSONBin
 * write tokens that already live in the legacy Netlify build — visible
 * but harmless because the DB enforces the real boundary.
 *
 * Loading order on every page that uses this:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="../shared/supabase-client.js"></script>
 *   ... your code that uses window.sb ...
 *
 * The CDN script exposes the library as window.supabase (with a lowercase
 * `s`); we read window.supabase.createClient and stash the resulting
 * instance on window.sb to avoid the name collision.
 * ========================================================================== */

(function () {
  'use strict';

  const SUPABASE_URL = 'https://cannojsxduvlewimwoxa.supabase.co';
  /* Switched from the new "publishable" key (sb_publishable_…) back to
     the legacy anon JWT. The publishable-key format appears to break
     specific supabase-js v2 codepaths — fresh sign-ins hung
     indefinitely on getSession(), signInWithPassword response handling,
     and PostgREST body reads. The legacy anon key is a standard JWT
     and is the path the library was originally built around. Same
     project, same RLS — just a key format the client handles
     correctly. */
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhbm5vanN4ZHV2bGV3aW13b3hhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwMzQ4MzQsImV4cCI6MjA5MzYxMDgzNH0.BQNkOTZHgmTEP1jONfRxD1-Db2rLgdIt82zbAsPxb0s';

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error(
      'Supabase JS library not loaded. Add this BEFORE supabase-client.js:\n' +
      '  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>'
    );
    return;
  }

  /* No-op replacement for supabase-js's internal navigator.locks
     wrapper. The default lock implementation (`navigatorLock` in
     gotrue-js) has a well-documented deadlock when a previous auth
     operation orphans a Web Lock: every subsequent auth call queues
     behind the dead lock and hangs forever, even though the network
     request succeeds with 200. Symptoms match
     https://github.com/supabase/supabase-js/issues/2013,
     https://github.com/orgs/supabase/discussions/36044, and
     https://github.com/supabase/supabase-js/issues/2111 — and our
     full investigation in docs/BUG.md.
     Passing this no-op via auth.lock disables the Web Locks
     coordination entirely. We lose protection against concurrent
     auth operations across tabs, but for a single-user tool that's
     a fine tradeoff to avoid the deadlock. */
  const noOpLock = async (_name, _acquireTimeout, fn) => fn();

  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      /* Persist the auth session across reloads + tabs. localStorage is
         shared per-origin so opening a new tab keeps the user signed in. */
      persistSession: true,
      /* autoRefreshToken DISABLED — see docs/BUG.md.
         Sandbox-project investigation showed the new-user sign-in freeze
         is in supabase-js's auto-refresh / auto-rehydrate code path,
         not (only) the profile fetch. The freeze fires even when no
         sign-in flow runs at all — supabase-js auto-rehydrates a
         stored session on init and the resulting refresh-token call
         hangs in the same chunked-response way the profile fetch did.
         Disabling autoRefreshToken eliminates that path. Tradeoff:
         tokens are valid 1 hour from issue; after that users sign in
         again. Acceptable for an internal tool, and far better than
         the freeze. */
      autoRefreshToken: false,
      storage: window.localStorage,
      /* Custom key so we don't collide with anything else on localStorage. */
      storageKey: 'pp-sb-auth',
      /* On magic-link / OTP redirects, Supabase parses the URL hash for
         tokens. Detect on every page so deep links can land logged-in. */
      detectSessionInUrl: true,
      /* Replace the Web Locks-based lock with a no-op — see the
         block comment above. */
      lock: noOpLock,
    },
  });

  /* Convenience: who's logged in + what tier? Cached per page-load.
     getCurrentProfile() reads from public.profiles using auth.uid().
     Useful for tier gating in tool pages (replaces shared/auth.js
     getAccessLevel). */
  let _profileCache = null;
  let _profilePromise = null;

  window.sbCurrentProfile = async function () {
    if (_profileCache) return _profileCache;
    if (_profilePromise) return _profilePromise;
    _profilePromise = (async () => {
      const { data: sess } = await window.sb.auth.getSession();
      if (!sess || !sess.session) return null;
      const { data, error } = await window.sb
        .from('profiles')
        .select('id, email, full_name, tier, status')
        .eq('id', sess.session.user.id)
        .single();
      if (error) {
        console.warn('sbCurrentProfile: profile lookup failed', error);
        return null;
      }
      _profileCache = data;
      return data;
    })();
    return _profilePromise;
  };

  /* Invalidate the profile cache after sign-in / sign-out events so
     tier gating reflects the current session immediately. */
  window.sb.auth.onAuthStateChange((event, _session) => {
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
      _profileCache = null;
      _profilePromise = null;
    }
  });
})();
