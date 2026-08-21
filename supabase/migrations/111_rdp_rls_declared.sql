-- 111_rdp_rls_declared.sql
--
-- Close a migration-drift gap found in the 2026-08-21 security sweep.
--
-- Ten rdp_* tables are protected in PRODUCTION but no migration ever declared
-- it — RLS was switched on by hand in the dashboard. Live behaviour today
-- (verified by probing PostgREST, not assumed):
--
--   anonymous (published anon key) .... 0 rows from every one of them
--   signed-in staff (any tier) ........ reads ALL rows (Viewer sees 70,752 of
--                                       70,752 in rdp_raw_series)
--   tier company (Viewer) ............. cannot write
--   tier admin AND tier dev ........... can write
--
-- so the effective rule is exactly the house convention: any authenticated
-- user reads, only is_writer() writes. This file writes that down.
--
-- WHY IT MATTERS: rebuild the database from migrations — disaster recovery, a
-- staging clone, a fresh branch — and all ten come back with RLS OFF, which
-- would expose the entire research platform to anyone holding the anon key
-- (it ships in shared/supabase-client.js, in a PUBLIC repo). Nothing changes
-- in production; this only makes the rebuild path match what is already live.
--
-- Safe to re-run. Enabling RLS that is already enabled is a no-op, and each
-- policy is dropped by name before being recreated. Policies created by hand
-- under different names are left alone: they express the same rule, so the
-- permissive OR of the two is unchanged.
--
-- rdp_runway_config is deliberately absent — migration 065 already declares it.

do $$
declare
  t text;
  tables text[] := array[
    'rdp_civ', 'rdp_demand_score', 'rdp_metrics', 'rdp_raw_series', 'rdp_regions',
    'rdp_report_feed', 'rdp_runs', 'rdp_runway', 'rdp_sources', 'rdp_vr_forecast'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is null then
      raise notice 'skipping %, table not present', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_read', t);

    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.is_writer())',
      t || '_insert', t);

    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.is_writer()) with check (public.is_writer())',
      t || '_update', t);

    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.is_writer())',
      t || '_delete', t);
  end loop;
end $$;
