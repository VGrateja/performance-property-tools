-- =============================================================================
-- 053_forge_data_status.sql
-- Health/status row PER Data Forge data point (one row per data_key, e.g.
-- 'population', 'cotality'). The isolated ingest scripts upsert their last-run
-- health here; the Data Forge UI reads it to show OK / red-warning marks and
-- (later) drives the failure email. Isolated, like the rest of the rdp_* store.
-- =============================================================================

create table if not exists forge_data_status (
  data_key     text primary key,           -- 'population', 'cotality', ...
  label        text not null,              -- display name, e.g. 'Population Data'
  source       text,                       -- where it comes from, e.g. 'ABS Data API'
  status       text not null default 'ok', -- 'ok' | 'error' | 'stale'
  message      text,                       -- human-readable detail / failure reason
  row_count    integer,                    -- rows written on last successful run
  region_count integer,                    -- regions resolved on last run
  latest_year  integer,                    -- most recent data year seen
  last_run_at  timestamptz,                -- last time the path ran (ok or error)
  last_ok_at   timestamptz,                -- last time it succeeded
  updated_at   timestamptz default now()
);

alter table forge_data_status enable row level security;

-- any authenticated user may read the status; only writers (dev/admin) may write.
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'forge_data_status' and policyname = 'forge_status_read') then
    create policy forge_status_read on forge_data_status for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'forge_data_status' and policyname = 'forge_status_write') then
    create policy forge_status_write on forge_data_status for all to authenticated using (is_writer()) with check (is_writer());
  end if;
end $$;

-- seed the two data points we have today (status defaults to 'ok' until a run reports otherwise)
insert into forge_data_status (data_key, label, source, status, message)
values
  ('population', 'Population Data', 'ABS Data API', 'ok', 'Not yet run via the monitored path.'),
  ('cotality',   'Cotality Data',   'CoreLogic / Cotality (.xlsx upload)', 'ok', 'Manual upload — no automated fetch.')
on conflict (data_key) do nothing;
