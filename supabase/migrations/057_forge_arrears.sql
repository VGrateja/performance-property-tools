-- =============================================================================
-- 057_forge_arrears.sql
-- Mortgage Arrears (monthly %, National + 8 states) for the Data Forge
-- "Mortgage Arrears" view. Source = S&P Global Ratings RMBS SPIN arrears index
-- (Australia, including non-capital-market issuance). There is NO API — S&P
-- publishes SPIN as a monthly PDF/spreadsheet on its ratings portal
-- (subscription), so this is a MANUAL upload (the Data Dump "Arrears" sheet),
-- same pattern as forge_cotality / forge_industry.
--
-- Single row (id='latest'), jsonb payload:
--   { months: ['2004-01', …],                                   -- monthly
--     regions: { <slug>: { label, values:[<arrears %>, …] } } }  -- national + st-*
-- Each upload replaces the series. Isolated, writer-only write.
-- =============================================================================

create table if not exists forge_arrears (
  id          text primary key default 'latest',
  data        jsonb not null,
  uploaded_at timestamptz default now(),
  uploaded_by text,
  updated_at  timestamptz default now()
);

alter table forge_arrears enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'forge_arrears' and policyname = 'forge_arrears_read') then
    create policy forge_arrears_read on forge_arrears for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'forge_arrears' and policyname = 'forge_arrears_write') then
    create policy forge_arrears_write on forge_arrears for all to authenticated using (is_writer()) with check (is_writer());
  end if;
end $$;
