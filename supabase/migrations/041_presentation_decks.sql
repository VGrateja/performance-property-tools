-- ===========================================================================
-- 041_presentation_decks.sql
--
-- Per-deck storage for the slide-deck builder (tools/presentation.html),
-- replacing the single shared blob in public.presentation_state (id=1) that
-- holds EVERY deck and is writable only by dev/admin (is_writer()).
--
-- Why: advisors (tier 'company') need to create + save their OWN presentations
-- ("My Presentations"), privately, without (a) being blocked by the writers-
-- only gate or (b) clobbering each other / the company set in one shared row.
-- One row per deck with owner_id + visibility makes that safe via RLS.
--
-- Visibility model (decisions, 2026-06-10):
--   - 'private' deck → visible only to its owner ("My Presentations").
--   - 'company' deck → visible to every authenticated user ("Performance
--     Property Presentations"). PUBLISHING to company (creating/flipping a
--     deck to visibility='company') is restricted to writers (dev/admin).
--   - Advisors VIEW company decks but cannot edit them in place — the tool
--     offers "Duplicate to My Presentations" instead; RLS enforces it.
--
-- The deck payload is self-contained per row: { deck, overlays, slideBgs,
-- activeTheme, themes } — the builder slices the old shared maps (keyed by
-- deckId) into each row when it migrates the existing decks (done in JS on
-- first dev/admin load, NOT here, because the deckId-keyed split isn't a clean
-- SQL unpack). Existing decks migrate in as visibility='company'.
--
-- NOTE: public.presentation_state (singular, 001) and presentations_state
-- (plural, 002 — the Library) are left untouched. presentation_state stays as
-- the legacy source the JS one-time migration reads from.
-- ===========================================================================

create table if not exists public.presentation_decks (
  id          uuid         primary key default gen_random_uuid(),
  owner_id    uuid         not null references public.profiles(id) on delete cascade,
  title       text         not null default 'Untitled presentation',
  payload     jsonb        not null default '{}'::jsonb,
  visibility  text         not null default 'private' check (visibility in ('private','company')),
  created_at  timestamptz  not null default now(),
  updated_at  timestamptz  not null default now(),
  -- REQUIRED: the shared touch_updated_at() trigger sets NEW.updated_by =
  -- auth.uid() on every UPDATE, so the column must exist or UPDATEs fail with
  -- "record new has no field updated_by" (INSERTs are fine — trigger is
  -- BEFORE UPDATE only). Matches presentations_state (002).
  updated_by  uuid         references public.profiles(id)
);

-- List "My Presentations" newest-first; surface the company set cheaply.
create index if not exists presentation_decks_owner_idx
  on public.presentation_decks (owner_id, updated_at desc);
create index if not exists presentation_decks_company_idx
  on public.presentation_decks (updated_at desc)
  where visibility = 'company';

-- updated_at auto-touch, matching the other state tables (touch_updated_at
-- is defined in 001_init.sql).
drop trigger if exists trg_presentation_decks_updated_at on public.presentation_decks;
create trigger trg_presentation_decks_updated_at
  before update on public.presentation_decks
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
alter table public.presentation_decks enable row level security;

drop policy if exists "read own or company decks"            on public.presentation_decks;
drop policy if exists "insert own decks"                     on public.presentation_decks;
drop policy if exists "update own or manage company decks"   on public.presentation_decks;
drop policy if exists "delete own or company decks"          on public.presentation_decks;

-- SELECT: my own decks (any visibility) + every company deck. Other users'
-- private decks are never returned (true isolation — advisor decks can carry
-- client-specific content).
create policy "read own or company decks"
  on public.presentation_decks
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    or visibility = 'company'
  );

-- INSERT: I can only create rows I own; publishing straight to 'company'
-- requires writer (dev/admin). Advisors can therefore only insert PRIVATE
-- decks.
create policy "insert own decks"
  on public.presentation_decks
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and ( visibility = 'private' or public.is_writer() )
  );

-- UPDATE: I can edit decks I own; writers can additionally manage company
-- decks. WITH CHECK also bars a non-writer from flipping their deck to
-- 'company' (publish gate) or reassigning owner_id away. (UPDATE needs both
-- USING + WITH CHECK and a SELECT policy — the read policy above covers it.)
create policy "update own or manage company decks"
  on public.presentation_decks
  for update to authenticated
  using (
    owner_id = (select auth.uid())
    or ( visibility = 'company' and public.is_writer() )
  )
  with check (
    ( owner_id = (select auth.uid())
      or ( visibility = 'company' and public.is_writer() ) )
    and ( visibility = 'private' or public.is_writer() )
  );

-- DELETE: owners delete their own decks; writers delete company decks.
create policy "delete own or company decks"
  on public.presentation_decks
  for delete to authenticated
  using (
    owner_id = (select auth.uid())
    or ( visibility = 'company' and public.is_writer() )
  );

-- Verify with:
--   select id, owner_id, title, visibility, updated_at
--     from public.presentation_decks order by updated_at desc;
