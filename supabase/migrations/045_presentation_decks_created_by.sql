-- ===========================================================================
-- 045_presentation_decks_created_by.sql
--
-- Track the ORIGINAL creator of a deck, distinct from owner_id (which the dev
-- can reassign via mig 044). This lets the builder offer the dev a Delete
-- option ONLY for decks the dev created — even after assigning them to a
-- teammate — and never for decks a user created themselves.
--
--   owner_id    = current owner (changes on assign)
--   created_by  = who first created the deck (immutable in practice)
-- ===========================================================================

alter table public.presentation_decks
  add column if not exists created_by uuid references public.profiles(id);

-- New rows default to the inserting user. Backfill existing rows to their
-- current owner — the best available signal for who created them (the dev's
-- own decks → dev; a user's private deck → that user, so the dev can't delete
-- it).
alter table public.presentation_decks
  alter column created_by set default auth.uid();

update public.presentation_decks
  set created_by = owner_id
  where created_by is null;

-- DELETE: the dev may delete decks THEY created, regardless of who currently
-- owns them (e.g. a deck the dev built then assigned out). Layered on top of
-- 041's owner/company delete policy (permissive = OR). Crucially this does NOT
-- let the dev delete a deck created by someone else.
drop policy if exists "dev deletes own-created decks" on public.presentation_decks;
create policy "dev deletes own-created decks"
  on public.presentation_decks
  for delete to authenticated
  using ( public.current_tier() = 'dev' and created_by = (select auth.uid()) );

-- Verify with:
--   select id, owner_id, created_by, visibility from public.presentation_decks;
