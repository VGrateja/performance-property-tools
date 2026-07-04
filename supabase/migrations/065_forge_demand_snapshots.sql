-- =============================================================================
-- 065_forge_demand_snapshots.sql
-- Versioned snapshots of the Demand Score output (Runway + Demand Score per
-- region, house & unit) for the prev-vs-current comparison / manager-approval
-- gate before the numbers flow to the Runway v Demand tool.
--
-- One row per version (e.g. '2026-06' = June). data jsonb:
--   { houses: { <slug>: { ds, rw } }, units: { <slug>: { ds, rw } } }
-- Isolated, writer-only write — same pattern as the other forge_* stores.
-- =============================================================================

create table if not exists forge_demand_snapshots (
  version     text primary key,
  label       text,
  data        jsonb not null,
  captured_at timestamptz default now(),
  captured_by text
);

alter table forge_demand_snapshots enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'forge_demand_snapshots' and policyname = 'forge_demand_snapshots_read') then
    create policy forge_demand_snapshots_read on forge_demand_snapshots for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'forge_demand_snapshots' and policyname = 'forge_demand_snapshots_write') then
    create policy forge_demand_snapshots_write on forge_demand_snapshots for all to authenticated using (is_writer()) with check (is_writer());
  end if;
end $$;
