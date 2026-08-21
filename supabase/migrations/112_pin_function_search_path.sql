-- 112_pin_function_search_path.sql
--
-- Clears the last Supabase lint "function_search_path_mutable" warnings.
--
-- A function that does not pin search_path resolves unqualified names against
-- whatever the CALLER's search_path says, so anyone able to create an object in
-- a schema on that path could shadow a table or function the body references.
--
-- WHAT THE LIVE DATABASE ACTUALLY SAYS (supabase db advisors, 2026-08-21):
-- five functions are unpinned, and every one of them is SECURITY INVOKER:
--
--   scorecard_fully_signed, skribbl_norm, skribbl_hint, skribbl_close,
--   presentation_decks_writer_gate
--
-- An earlier pass over the migration FILES suggested ten SECURITY DEFINER
-- functions were unpinned (current_tier, is_writer, is_staff, is_team_lead,
-- touch_updated_at, touch_cadence_boards, touch_cadence_cards,
-- log_cadence_card_change, snapshot_reports_state, restore_reports_state).
-- That was wrong: production pinned them at some point after those files were
-- written — by hand, so no migration records it — and the advisor confirms all
-- SECURITY DEFINER functions are now pinned. Reading the files is not the same
-- as reading the database.
--
-- Invoker-rights functions run with the caller's own privileges, so an unpinned
-- search_path is far less dangerous here than it would be on a definer
-- function. This is tidy-up that clears the advisor, not a hole being closed.
-- All five are simple helpers over public objects (text normalisers, a jsonb
-- sign-off check, a writer-gate trigger), so none of them depends on the
-- caller's search_path to find anything.
--
-- The loop covers BOTH definer and invoker functions in public, so it also
-- catches anything created by hand outside migrations, and re-running it is a
-- no-op once everything is pinned. pg_temp goes last per Postgres guidance so a
-- caller's temp schema cannot shadow anything.

do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.prokind = 'f'                               -- plain functions only
      and not exists (
        select 1
        from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
        where cfg like 'search_path=%'
      )
  loop
    execute format('alter function %s set search_path = public, pg_temp', r.sig);
    raise notice 'pinned search_path on %', r.sig;
    n := n + 1;
  end loop;
  raise notice 'pinned % function(s)', n;
end $$;
