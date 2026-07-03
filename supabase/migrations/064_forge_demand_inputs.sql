-- =============================================================================
-- 064_forge_demand_inputs.sql
-- Manual inputs for the Demand Score dashboard that aren't elsewhere in Forge.
--
-- The Demand Score engine (tools/demand-score.html) needs 5 raw inputs per
-- region. Population + DOM already live in Forge (DOM = Cotality). The rest have
-- NO server-side API — realestate.com.au is Kasada bot-blocked, and SQM vacancy
-- + rents are subscription — so they're captured by hand in the "Demand Score
-- Dashboard Data" Data Forge card (or via the one-click bookmarklet).
--
-- Single row (id='latest'), jsonb payload:
--   { month: 'YYYY-MM',
--     regions: { <slug>: { listings_h, listings_u,          -- REA counts
--                          vr, rent_h, rent_u,               -- SQM (added later)
--                          listings_h_at, listings_u_at, ... -- per-value stamps
--                        } } }
-- Isolated, writer-only write — same pattern as forge_arrears (057).
-- =============================================================================

create table if not exists forge_demand_inputs (
  id          text primary key default 'latest',
  data        jsonb not null,
  uploaded_at timestamptz default now(),
  uploaded_by text,
  updated_at  timestamptz default now()
);

alter table forge_demand_inputs enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'forge_demand_inputs' and policyname = 'forge_demand_inputs_read') then
    create policy forge_demand_inputs_read on forge_demand_inputs for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'forge_demand_inputs' and policyname = 'forge_demand_inputs_write') then
    create policy forge_demand_inputs_write on forge_demand_inputs for all to authenticated using (is_writer()) with check (is_writer());
  end if;
end $$;
