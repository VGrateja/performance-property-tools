-- ===========================================================================
-- 042_report_sources.sql
--
-- Shared "Source Library" for the Online Reports tools. A source citation
-- (e.g. "Source: CoreLogic, ABS") is defined ONCE here with a stable id +
-- friendly label; text overlays in any region reference it by id and render
-- the shared text, so editing a source updates every report that uses it.
--
-- Overlays still store their own per-region position + styling (in
-- reports_state); only the TEXT is shared via this table. dev/admin edit
-- (is_writer), everyone reads — same posture as report editing itself.
-- ===========================================================================

create table if not exists public.report_sources (
  id          uuid         primary key default gen_random_uuid(),
  label       text         not null default '',   -- human label, e.g. "CoreLogic — Median Price"
  text        text         not null default '',   -- the rendered citation (supports {year} tokens)
  created_at  timestamptz  not null default now(),
  updated_at  timestamptz  not null default now(),
  -- REQUIRED: the shared touch_updated_at() trigger sets NEW.updated_by on
  -- UPDATE, so the column must exist (or UPDATEs fail "record new has no
  -- field updated_by"). Same as presentations_state / presentation_decks.
  updated_by  uuid         references public.profiles(id)
);

drop trigger if exists trg_report_sources_updated_at on public.report_sources;
create trigger trg_report_sources_updated_at
  before update on public.report_sources
  for each row execute function public.touch_updated_at();

alter table public.report_sources enable row level security;

drop policy if exists "read report_sources"           on public.report_sources;
drop policy if exists "writers insert report_sources"  on public.report_sources;
drop policy if exists "writers update report_sources"  on public.report_sources;
drop policy if exists "writers delete report_sources"  on public.report_sources;

create policy "read report_sources"
  on public.report_sources for select to authenticated using (true);
create policy "writers insert report_sources"
  on public.report_sources for insert to authenticated with check (public.is_writer());
create policy "writers update report_sources"
  on public.report_sources for update to authenticated using (public.is_writer()) with check (public.is_writer());
create policy "writers delete report_sources"
  on public.report_sources for delete to authenticated using (public.is_writer());
