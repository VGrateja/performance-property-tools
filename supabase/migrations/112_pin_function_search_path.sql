-- 112_pin_function_search_path.sql
--
-- Hardening from the 2026-08-21 security sweep: Supabase lint
-- "function_search_path_mutable".
--
-- 75 of our functions are SECURITY DEFINER — they run with the definer's
-- rights, not the caller's. Ten of them never pin search_path, so the schemas
-- they resolve unqualified names against are whatever the CALLER's search_path
-- says. Anyone able to create an object in a schema on that path could shadow a
-- table or function the body references and have it run with definer rights.
--
-- Ordinary roles should not be able to create objects in public on a modern
-- Postgres, so this is defence in depth rather than an open door. It is worth
-- doing anyway because the unpinned ten include is_writer() and current_tier()
-- — the two functions nearly every RLS policy in this project calls.
--
-- Found unpinned (2026-08-21): current_tier, is_writer, is_staff, is_team_lead,
-- touch_updated_at, touch_cadence_boards, touch_cadence_cards,
-- log_cadence_card_change, snapshot_reports_state, restore_reports_state.
--
-- Rather than list signatures (easy to get wrong, and overloads would be
-- missed), pin every SECURITY DEFINER function in public that lacks the
-- setting. That also catches anything created by hand outside migrations, and
-- makes the file idempotent: a second run finds nothing left to do.
--
-- pg_temp is included last per Postgres guidance, so a caller's temp schema is
-- searched last and cannot shadow anything.

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
      and p.prosecdef                                   -- SECURITY DEFINER only
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
