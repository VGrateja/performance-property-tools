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
  /* Legacy anon JWT (role=anon, iss=supabase) rather than the newer
     publishable key format. Kept after the freeze investigation —
     see docs/BUG.md. */
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhbm5vanN4ZHV2bGV3aW13b3hhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwMzQ4MzQsImV4cCI6MjA5MzYxMDgzNH0.BQNkOTZHgmTEP1jONfRxD1-Db2rLgdIt82zbAsPxb0s';

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error(
      'Supabase JS library not loaded. Add this BEFORE supabase-client.js:\n' +
      '  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>'
    );
    return;
  }

  /* Pull Clerk's session JWT for every Supabase request via the
     accessToken callback (supabase-js v2.45+). Supabase's third-party
     auth integration (configured in Supabase Dashboard → Auth → Third
     Party Auth) verifies Clerk-signed JWTs against Clerk's JWKS, so
     RLS sees the user identified by the JWT claims. Falls back to the
     anon key when no Clerk session exists.
     We await window.ppClerkReady so that supabase-js queries fired
     immediately on page load wait for Clerk to finish initialising —
     otherwise they'd race past the Clerk CDN load and fire as
     anonymous, returning empty results from RLS-gated tables. */
  async function getClerkAccessToken() {
    try {
      if (window.ppClerkReady) await window.ppClerkReady;
      if (!window.Clerk || !window.Clerk.session) return null;
      return await window.Clerk.session.getToken();
    } catch (e) {
      return null;
    }
  }

  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    /* Supabase auth.* methods are unused now (Clerk handles auth). Disable
       persistSession + detectSessionInUrl so supabase-js doesn't try to
       parse / write its own session — Clerk owns the session entirely. */
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    accessToken: getClerkAccessToken,
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

  /* No onAuthStateChange — supabase-js disables auth.* methods when
     accessToken is configured. Cache invalidation now happens when
     Clerk's listener fires (see index.html's bootClerkAuth IIFE). */
})();
