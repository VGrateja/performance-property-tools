-- =============================================================================
-- 049_region_dashboards.sql
--
-- Backing store for the "Regional Dashboards" machine in Data Forge — the
-- in-house replacement for the 37 per-region "Suburb Selection" Google Sheets
-- (advisor dashboards). DELIBERATELY ISOLATED from the online-report tables
-- (reports_state / report_data_cache): nothing here is read by the live reports
-- or the monthly PDF renderer, so this can be built and populated without any
-- risk to existing tools.
--
-- Two tables, one row per region (keyed by a region slug, e.g. 'adelaide-sa'):
--
--   region_dashboard_reference — the SEEDED reference data, extracted once from
--     each region's workbook: { config, selection:{lgas,suburbs}, price:[...] }.
--     `price` is the slim historical median+growth series since 1983. This is
--     the "fixed, editable" data the user described; it does NOT come from the
--     monthly CoreLogic drop.
--
--   region_dashboard — the COMPUTED dashboard output (LGA + suburb rows) produced
--     when the monthly national CoreLogic file is dropped into Data Forge and run
--     through the verified calculator. `source_month` records which feed it came
--     from. This is what an advisor view reads.
--
-- RLS mirrors report_data_cache: any authenticated user READS; only writers
-- (dev/admin, via public.is_writer()) WRITE. The anon key can't write.
--
-- Run order: after 001_init.sql (needs public.is_writer()). Re-runnable.
-- =============================================================================

create table if not exists public.region_dashboard_reference (
  region     text primary key,
  label      text,
  reference  jsonb       not null,
  updated_at timestamptz not null default now(),
  updated_by uuid        references auth.users
);

comment on table public.region_dashboard_reference is
  'Seeded, editable reference data per region (config + suburb/LGA selection + slim historical price series). Source for the Regional Dashboards calculator; isolated from the online reports.';

create table if not exists public.region_dashboard (
  region       text primary key,
  label        text,
  data         jsonb       not null,
  source_month text,
  computed_at  timestamptz not null default now(),
  computed_by  uuid        references auth.users
);

comment on table public.region_dashboard is
  'Computed advisor dashboard per region (LGA + suburb rows), produced from the monthly CoreLogic drop via the Data Forge calculator. Replaces the per-region Google Sheets; isolated from the online reports.';

alter table public.region_dashboard_reference enable row level security;
alter table public.region_dashboard           enable row level security;

-- READ: any authenticated user.
drop policy if exists "region_dashboard_reference_select" on public.region_dashboard_reference;
create policy "region_dashboard_reference_select" on public.region_dashboard_reference
  for select to authenticated using (true);

drop policy if exists "region_dashboard_select" on public.region_dashboard;
create policy "region_dashboard_select" on public.region_dashboard
  for select to authenticated using (true);

-- WRITE: writers only (dev/admin). INSERT + UPDATE both need WITH CHECK.
drop policy if exists "region_dashboard_reference_insert" on public.region_dashboard_reference;
create policy "region_dashboard_reference_insert" on public.region_dashboard_reference
  for insert to authenticated with check (public.is_writer());

drop policy if exists "region_dashboard_reference_update" on public.region_dashboard_reference;
create policy "region_dashboard_reference_update" on public.region_dashboard_reference
  for update to authenticated using (public.is_writer()) with check (public.is_writer());

drop policy if exists "region_dashboard_insert" on public.region_dashboard;
create policy "region_dashboard_insert" on public.region_dashboard
  for insert to authenticated with check (public.is_writer());

drop policy if exists "region_dashboard_update" on public.region_dashboard;
create policy "region_dashboard_update" on public.region_dashboard
  for update to authenticated using (public.is_writer()) with check (public.is_writer());

grant select, insert, update on public.region_dashboard_reference to authenticated;
grant select, insert, update on public.region_dashboard           to authenticated;
