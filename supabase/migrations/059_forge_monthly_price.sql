-- =============================================================================
-- 059_forge_monthly_price.sql
-- Monthly median price (house + unit) per region for the Data Forge "Monthly
-- Median Price" card. CoreLogic publishes a current 3-month median; the
-- reports plot a monthly history. That monthly history isn't in the ABS/CoreLogic
-- snapshot Forge already holds, so it's:
--   • seeded once from the 4 "Data - Online Reports" cluster sheets
--     (scripts/seed-monthly-price.mjs), then
--   • appended each month when the CoreLogic .xlsx is dropped in the Cotality
--     card (the importer writes that month's median into this store).
--
-- Single row (id='latest'), jsonb:
--   { regions: { <slug>: { label, months:[YYYY-MM-01], h:[…], u:[…] } } }
-- Isolated, writer-only write — same pattern as forge_cotality.
-- =============================================================================

create table if not exists forge_monthly_price (
  id          text primary key default 'latest',
  data        jsonb not null,
  uploaded_at timestamptz default now(),
  uploaded_by text,
  updated_at  timestamptz default now()
);

alter table forge_monthly_price enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'forge_monthly_price' and policyname = 'forge_monthly_price_read') then
    create policy forge_monthly_price_read on forge_monthly_price for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'forge_monthly_price' and policyname = 'forge_monthly_price_write') then
    create policy forge_monthly_price_write on forge_monthly_price for all to authenticated using (is_writer()) with check (is_writer());
  end if;
end $$;
