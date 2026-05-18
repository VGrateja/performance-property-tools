-- =============================================================================
-- 027_supabase_linter_fixes_round2.sql — Second-pass linter cleanup
--
-- After migration 026 we still have 25 warnings. Two of them are easy to
-- knock out:
--
--   1. anon_security_definer_function_executable on the four RLS helpers
--      (current_tier / is_writer / is_staff / is_team_lead).
--      Migration 026 did `REVOKE EXECUTE FROM anon`, but those functions
--      were originally created without explicit GRANTs — Postgres's
--      default is `EXECUTE TO PUBLIC`, which leaks effective access back
--      to anon. The clean fix is `REVOKE FROM PUBLIC` + explicit
--      `GRANT TO authenticated`.
--
--   2. public_bucket_allows_listing on the `online-reports` bucket.
--      Verified the consumer pages don't call `storage.list()` — the
--      only caller is scripts/render-reports.mjs which uses the service-
--      role key (RLS-bypass). Public bucket URLs still work for direct
--      fetches without the SELECT policy.
--
-- Remaining after this migration:
--   • 19 authenticated_security_definer_function_executable — by design
--     (game RPCs + RLS helpers; authenticated MUST be able to call them).
--   • 1 auth_leaked_password_protection — toggle in the dashboard:
--     Authentication → Sign In / Sign Up → "Prevent use of compromised
--     passwords". Not a SQL setting.
--
-- Run order: after 026_*.sql.
-- =============================================================================

-- ─── A. RLS helpers — strip the PUBLIC default, grant authenticated explicitly.
revoke execute on function public.current_tier()      from public;
grant  execute on function public.current_tier()      to authenticated;

revoke execute on function public.is_writer()         from public;
grant  execute on function public.is_writer()         to authenticated;

revoke execute on function public.is_staff()          from public;
grant  execute on function public.is_staff()          to authenticated;

revoke execute on function public.is_team_lead()      from public;
grant  execute on function public.is_team_lead()      to authenticated;


-- ─── B. Drop the broad SELECT policy on the online-reports bucket.
-- The bucket stays public — anyone with a URL can still GET an object
-- directly. They just can no longer enumerate the bucket contents via
-- storage.objects. The GitHub Actions renderer uses the service-role
-- key which bypasses RLS, so its retention/cleanup `.list()` call
-- isn't affected.
drop policy if exists "public read online-reports" on storage.objects;
