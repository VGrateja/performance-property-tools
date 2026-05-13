-- =============================================================================
-- 015_runway_snapshots.sql — Snapshot save/load for Runway Workbook
--
-- Stores a point-in-time capture of the Workbook state (scenario params +
-- current data tables). Shared team-wide per user spec — every staff user
-- can see every snapshot. Used to freeze a scenario when presenting research
-- or to compare two market states side-by-side.
--
-- Schema choices:
--   - params jsonb : the 9 scenario inputs (cashRate, bankVar, apra, …).
--   - tables jsonb : { houses, units, wageHouses, wageUnits } — the four
--                    seed arrays at snapshot time, so a snapshot is fully
--                    self-contained (loadable even after a region is added
--                    or a price changes upstream).
--   - notes        : optional user note ("Q1 baseline before RBA cut").
--
-- RLS: staff read all snapshots (shared), staff insert their own, writers
-- (dev/admin) can delete any. No update — snapshots are immutable.
--
-- Run order: after 014_cadence_card_scoping.sql. Idempotent.
-- =============================================================================

create table if not exists public.runway_snapshots (
  id                uuid          primary key default gen_random_uuid(),
  name              text          not null,
  notes             text,
  params            jsonb         not null default '{}'::jsonb,
  tables            jsonb         not null default '{}'::jsonb,
  source_file       text,                                   -- the CoreLogic file name the prices came from
  created_at        timestamptz   not null default now(),
  created_by        uuid          references public.profiles(id),
  created_by_email  text
);

create index if not exists runway_snapshots_created_idx
  on public.runway_snapshots (created_at desc);

create index if not exists runway_snapshots_creator_idx
  on public.runway_snapshots (created_by_email);

-- ---------------------------------------------------------------------------
-- RLS — shared read across staff, anyone can create, only writers delete.
-- ---------------------------------------------------------------------------
alter table public.runway_snapshots enable row level security;

drop policy if exists "staff read runway snapshots"   on public.runway_snapshots;
drop policy if exists "staff insert runway snapshots" on public.runway_snapshots;
drop policy if exists "writers delete runway snapshots" on public.runway_snapshots;

create policy "staff read runway snapshots" on public.runway_snapshots
  for select to authenticated using (public.is_staff());

create policy "staff insert runway snapshots" on public.runway_snapshots
  for insert to authenticated with check (public.is_staff());

create policy "writers delete runway snapshots" on public.runway_snapshots
  for delete to authenticated using (public.is_writer());

-- No UPDATE policy — snapshots are immutable. Edit by saving a new one.
