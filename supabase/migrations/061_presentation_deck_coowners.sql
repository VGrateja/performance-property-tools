-- ===========================================================================
-- 061_presentation_deck_coowners.sql
--
-- Co-owners (edit-only) for presentation decks + the deck OWNER keeps edit
-- access after a deck is published, while PUBLISH stays dev/admin-only.
--
-- Decisions (user, 2026-07-01):
--   • CO-EDITORS: dev/admin add/remove editors on any deck. A co-editor may
--     EDIT that deck's slides at any visibility — and NOTHING else (no publish,
--     no delete, no reassigning owner, no managing the editor list).
--   • OWNER keeps edit access even once the deck is 'company' (published).
--     Previously company decks were writer-only-editable (041's WITH CHECK
--     "(visibility='private' OR is_writer())" also blocked the owner editing
--     their own published deck).
--   • PUBLISH/UNPUBLISH (changing visibility) and REASSIGNING owner stay
--     dev/admin-only — now enforced by a BEFORE UPDATE trigger (RLS is
--     row-level and can't gate a single column). So owner/co-editor CONTENT
--     edits are allowed on a company deck, but a non-writer can't flip
--     visibility or hand the deck to someone else.
--   • Tier-2 staff still can't self-publish; they ask a dev/admin (informally),
--     who publishes the deck from "Users Presentations". No in-tool request
--     queue (by request).
--
-- Builds on 041 (base table + RLS) / 044-046 (dev+admin see/assign all).
-- ===========================================================================

-- ── co-editor membership ──────────────────────────────────────────────────
create table if not exists public.presentation_deck_editors (
  deck_id  uuid        not null references public.presentation_decks(id) on delete cascade,
  user_id  uuid        not null references public.profiles(id)           on delete cascade,
  added_by uuid        references public.profiles(id),
  added_at timestamptz not null default now(),
  primary key (deck_id, user_id)
);
create index if not exists presentation_deck_editors_user_idx
  on public.presentation_deck_editors (user_id);

alter table public.presentation_deck_editors enable row level security;

drop policy if exists "read my editor rows or staff" on public.presentation_deck_editors;
drop policy if exists "staff insert editors"         on public.presentation_deck_editors;
drop policy if exists "staff delete editors"         on public.presentation_deck_editors;

-- SELECT: I can read my own membership rows (so the client knows which decks I
-- co-edit); dev/admin read every row (to display + manage a deck's editors).
create policy "read my editor rows or staff"
  on public.presentation_deck_editors
  for select to authenticated
  using ( user_id = (select auth.uid()) or public.current_tier() in ('dev','admin') );

-- INSERT / DELETE: dev/admin only — co-owner assignment is staff-controlled.
create policy "staff insert editors"
  on public.presentation_deck_editors
  for insert to authenticated
  with check ( public.current_tier() in ('dev','admin') );

create policy "staff delete editors"
  on public.presentation_deck_editors
  for delete to authenticated
  using ( public.current_tier() in ('dev','admin') );

-- ── decks: a co-editor can READ the decks they edit ───────────────────────
drop policy if exists "read decks I co-edit" on public.presentation_decks;
create policy "read decks I co-edit"
  on public.presentation_decks
  for select to authenticated
  using ( exists ( select 1 from public.presentation_deck_editors e
                   where e.deck_id = presentation_decks.id
                     and e.user_id = (select auth.uid()) ) );

-- ── decks: owner OR co-editor may UPDATE content (publish gate → trigger) ──
-- Replaces 041's "update own or manage company decks": drops the
-- "(visibility='private' OR is_writer())" WITH CHECK (which blocked an owner
-- editing their own company deck), so owners + co-editors can edit a published
-- deck's content. Visibility / owner changes are gated by the trigger below.
drop policy if exists "update own or manage company decks" on public.presentation_decks;
create policy "update own, co-edited, or company decks"
  on public.presentation_decks
  for update to authenticated
  using (
    owner_id = (select auth.uid())
    or exists ( select 1 from public.presentation_deck_editors e
                where e.deck_id = presentation_decks.id and e.user_id = (select auth.uid()) )
    or ( visibility = 'company' and public.is_writer() )
  )
  with check (
    owner_id = (select auth.uid())
    or exists ( select 1 from public.presentation_deck_editors e
                where e.deck_id = presentation_decks.id and e.user_id = (select auth.uid()) )
    or public.is_writer()
  );

-- ── publish/reassign gate: only dev/admin may change visibility or owner_id ──
create or replace function public.presentation_decks_writer_gate()
returns trigger language plpgsql as $$
begin
  if not public.is_writer() then
    if new.visibility is distinct from old.visibility then
      raise exception 'Only dev/admin can publish or unpublish a deck (change its visibility).';
    end if;
    if new.owner_id is distinct from old.owner_id then
      raise exception 'Only dev/admin can reassign a deck''s owner.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_presentation_decks_writer_gate on public.presentation_decks;
create trigger trg_presentation_decks_writer_gate
  before update on public.presentation_decks
  for each row execute function public.presentation_decks_writer_gate();

-- Verify with:
--   select polname, cmd from pg_policies where tablename in
--     ('presentation_decks','presentation_deck_editors');
