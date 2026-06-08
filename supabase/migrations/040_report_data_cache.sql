-- =============================================================================
-- 040_report_data_cache.sql
--
-- Snapshot cache for report chart DATA. The online reports (and the
-- presentation embed) fetch their numbers from Google Apps Script web apps,
-- which cold-start at 10-25 s per cluster — the bulk of the 1-2 min load time
-- (regional reports fetch TWO clusters). The underlying data only changes once
-- a month, so instead of phoning Google on every view we keep a copy here and
-- read THAT on load. Off-stage (a dev/admin button, later a monthly job) the
-- copy is refreshed from Google; on-stage every viewer reads this fast table.
--
-- One row per feed, keyed by `source`:
--   online-reports clusters → 'capital' | 'qld' | 'nsw' | 'vicwatas'
--   (research reports later  → 'national' | 'commercial')
-- `data` holds the raw feed JSON exactly as the Apps Script returned it, so the
-- existing client mappers (mapLiveToRegion etc.) work unchanged.
--
-- RLS mirrors reports_state: any authenticated user can READ; only writers
-- (dev/admin, via public.is_writer()) can WRITE. The anon key in the browser
-- can't write because is_writer() is false for non-writers.
--
-- Run order: after 001_init.sql (needs public.is_writer()). Re-runnable.
-- =============================================================================

create table if not exists public.report_data_cache (
  source     text primary key,
  data       jsonb       not null,
  updated_at timestamptz not null default now()
);

comment on table public.report_data_cache is
  'Monthly snapshot of each report feed''s chart data (keyed by source/cluster) so reports + presentations load fast instead of waiting on Apps Script. Refreshed by a dev/admin button or a scheduled job.';

alter table public.report_data_cache enable row level security;

-- READ: any authenticated user (same as reports_state).
drop policy if exists "report_data_cache_select" on public.report_data_cache;
create policy "report_data_cache_select" on public.report_data_cache
  for select to authenticated
  using (true);

-- WRITE: writers only (dev/admin). INSERT + UPDATE both need a WITH CHECK.
drop policy if exists "report_data_cache_insert" on public.report_data_cache;
create policy "report_data_cache_insert" on public.report_data_cache
  for insert to authenticated
  with check (public.is_writer());

drop policy if exists "report_data_cache_update" on public.report_data_cache;
create policy "report_data_cache_update" on public.report_data_cache
  for update to authenticated
  using (public.is_writer())
  with check (public.is_writer());

grant select, insert, update on public.report_data_cache to authenticated;
