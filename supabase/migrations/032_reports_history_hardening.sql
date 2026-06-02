-- ============================================================================
-- Performance Property — harden the 030 history functions
-- Migration target: Supabase Postgres (project cannojsxduvlewimwoxa)
--
-- Addresses the security-advisor findings on the functions added in 030:
--   • function_search_path_mutable — pin search_path so a caller can't
--     hijack object resolution. Both functions already fully-qualify their
--     public.* references, so an empty search_path is safe (built-in
--     types/functions still resolve via pg_catalog).
--   • anon/role-executable SECURITY DEFINER — snapshot_reports_state is a
--     TRIGGER function; it must never be callable via /rest/v1/rpc. Revoke
--     EXECUTE from everyone (trigger firing does NOT require EXECUTE, so the
--     trigger keeps working). restore_reports_state stays callable by
--     authenticated only (it gates on is_writer() internally) — that
--     remaining advisor note is intentional, matching every other RPC here.
--
-- Idempotent — safe to re-run.
-- ============================================================================

alter function public.snapshot_reports_state()                set search_path = '';
alter function public.restore_reports_state(text, bigint)     set search_path = '';

-- Trigger function: not meant to be RPC-callable by anyone. Trigger
-- invocation is unaffected by EXECUTE privileges.
revoke all on function public.snapshot_reports_state() from public, anon, authenticated;

-- Restore RPC: signed-in users only; the is_writer() gate inside the
-- function is the real authority boundary.
revoke all   on function public.restore_reports_state(text, bigint) from public, anon;
grant execute on function public.restore_reports_state(text, bigint) to authenticated;
