-- =============================================================================
-- 056_forge_population_pyramid.sql
-- Population Pyramid (population counts by 5-year age group per region) for the
-- Data Forge "Population Pyramid" view. HYBRID source:
--   • National + 8 states + 8 capital cities (GCCSA) come from the ABS Data API
--     (ERP_ASGS2021, age × sex, persons) via scripts/ingest-abs-pop-pyramid.mjs
--     (src:'api') — auto-refreshable, current vintage.
--   • The 28 regional cities (LGA-level age data is NOT in the ABS API) are
--     uploaded from the Data Dump "PopPyramid" sheet (src:'upload').
-- The two writers own disjoint region keys and MERGE into the one store.
--
-- Single row (id='latest'), jsonb payload:
--   { ageGroups: ['0-04','05-09', … ,'85 and over'],            -- 18 groups
--     regions: { <slug>: { label, src:'api'|'upload',
--                          total:[<count per age group>], year } } }
-- The view shows each region's age distribution as a % of its population vs its
-- comparator (capitals → National, regionals → State). Isolated, writer-only
-- write — same pattern as forge_industry (055) / forge_cotality (054).
-- =============================================================================

create table if not exists forge_population_pyramid (
  id          text primary key default 'latest',
  data        jsonb not null,
  uploaded_at timestamptz default now(),
  uploaded_by text,
  updated_at  timestamptz default now()
);

alter table forge_population_pyramid enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'forge_population_pyramid' and policyname = 'forge_population_pyramid_read') then
    create policy forge_population_pyramid_read on forge_population_pyramid for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'forge_population_pyramid' and policyname = 'forge_population_pyramid_write') then
    create policy forge_population_pyramid_write on forge_population_pyramid for all to authenticated using (is_writer()) with check (is_writer());
  end if;
end $$;
