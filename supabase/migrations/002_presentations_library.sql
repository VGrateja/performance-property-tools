-- ===========================================================================
-- 002_presentations_library.sql
--
-- New singleton state table for the Presentations Library tool
-- (tools/presentations-library.html). Mirrors the shape and policies of
-- public.documents_state from 001_init.sql — same singleton row pattern
-- (id = 1), same payload shape ({ sections, lastEdited }), same RLS
-- (authenticated read, writer-only update/insert).
--
-- Why a separate table rather than another row in documents_state:
--   - Independent edit timeline: the Documents tool's lastEdited stamp
--     would otherwise overwrite changes the presentations team makes,
--     and vice versa.
--   - Cleaner audit + RLS surface — each library has its own row, the
--     debounced PUT writes against a single id with no key contention.
--
-- Note the table name is presentations_state (plural). The existing
-- public.presentation_state (singular) is unrelated — it backs the slide-
-- deck builder at tools/presentation.html (custom decks, slide overlays,
-- per-slide background images), not a folder/card library.
-- ===========================================================================

create table if not exists public.presentations_state (
  id          int          primary key default 1 check (id = 1),
  payload     jsonb        not null default '{"sections":[]}'::jsonb,
  updated_at  timestamptz  not null default now(),
  updated_by  uuid         references public.profiles(id)
);

-- updated_at + updated_by auto-touch, matching the other state tables.
drop trigger if exists trg_presentations_updated_at on public.presentations_state;
create trigger trg_presentations_updated_at
  before update on public.presentations_state
  for each row execute function public.touch_updated_at();

-- Row-Level Security — same gate as documents_state: any authenticated
-- user can read; only writers (Tier 0/1) can update/insert.
alter table public.presentations_state enable row level security;

drop policy if exists "authenticated read presentations_state" on public.presentations_state;
drop policy if exists "writers update presentations_state"     on public.presentations_state;
drop policy if exists "writers insert presentations_state"     on public.presentations_state;

create policy "authenticated read presentations_state"
  on public.presentations_state
  for select to authenticated
  using (true);

create policy "writers update presentations_state"
  on public.presentations_state
  for update to authenticated
  using (public.is_writer());

create policy "writers insert presentations_state"
  on public.presentations_state
  for insert to authenticated
  with check (public.is_writer());

-- Seed the singleton row so the tool's debounced UPDATE doesn't 404 on
-- first save. Idempotent on re-run.
insert into public.presentations_state (id) values (1) on conflict (id) do nothing;

-- Verify with:
--   select id, payload from public.presentations_state;   -- empty sections
