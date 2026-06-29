-- =============================================================================
-- 055_forge_industry.sql
-- Industry Value Added (ANZSIC divisions, $ per region) for the Data Forge
-- "Industry" view. There is NO ABS API for this — it's gathered manually from
-- REMPLAN economy profiles (and economy.id where still available) and uploaded
-- as a spreadsheet (industries-as-rows × region-columns, $ value added). The
-- view shows each region's % composition.
--
-- Single row (id='latest'), jsonb payload:
--   { industries: [<division names, in order>],
--     regions: { <slug>: { label, values:{<industry>:<$>}, total } } }
-- Each upload MERGES the regions it contains into the store. Isolated,
-- writer-only write — same pattern as forge_cotality (054).
-- =============================================================================

create table if not exists forge_industry (
  id          text primary key default 'latest',
  data        jsonb not null,
  uploaded_at timestamptz default now(),
  uploaded_by text,
  updated_at  timestamptz default now()
);

alter table forge_industry enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'forge_industry' and policyname = 'forge_industry_read') then
    create policy forge_industry_read on forge_industry for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'forge_industry' and policyname = 'forge_industry_write') then
    create policy forge_industry_write on forge_industry for all to authenticated using (is_writer()) with check (is_writer());
  end if;
end $$;
