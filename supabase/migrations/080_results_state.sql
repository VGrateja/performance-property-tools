-- ===========================================================================
-- 080_results_state.sql
--
-- Cloud persistence for the Results tool (tools/results.html): the Results
-- Publications library + the monthly Appraisal Hub. One row per store key:
--   'publications' → the publications array
--   'appraisals'   → { months: { 'YYYY-MM': { label, columns, rows,
--                      masterLink, sheetName } } }
--
-- Whole-payload rows on purpose: the tool's store seam saves whole objects,
-- and the Richard→Ian workflow is light + sequential, so last-write-wins per
-- key is acceptable. Split per-month rows later if concurrent editing bites.
--
-- RLS: staff read (dev/admin/leads/company); dev/admin/company write —
-- the advisors who run this workflow are company tier. Client/guest: nothing.
-- GOTCHA honoured: touch_updated_at() sets NEW.updated_by, so the column
-- must exist or every UPDATE fails (see 041's bugfix).
-- ===========================================================================

create table if not exists public.results_state (
  key         text         primary key,
  payload     jsonb        not null default '{}'::jsonb,
  updated_at  timestamptz  not null default now(),
  updated_by  uuid         references public.profiles(id)
);

drop trigger if exists trg_results_state_updated_at on public.results_state;
create trigger trg_results_state_updated_at
  before update on public.results_state
  for each row execute function public.touch_updated_at();

alter table public.results_state enable row level security;

drop policy if exists "staff read results_state"   on public.results_state;
drop policy if exists "staff insert results_state" on public.results_state;
drop policy if exists "staff update results_state" on public.results_state;
drop policy if exists "staff delete results_state" on public.results_state;

create policy "staff read results_state"
  on public.results_state for select to authenticated
  using ( public.current_tier() in ('dev','admin','leads','company') );

create policy "staff insert results_state"
  on public.results_state for insert to authenticated
  with check ( public.current_tier() in ('dev','admin','company') );

create policy "staff update results_state"
  on public.results_state for update to authenticated
  using ( public.current_tier() in ('dev','admin','company') )
  with check ( public.current_tier() in ('dev','admin','company') );

create policy "staff delete results_state"
  on public.results_state for delete to authenticated
  using ( public.current_tier() in ('dev','admin','company') );
