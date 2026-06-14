-- ===========================================================================
-- 044_presentation_decks_dev_assign.sql
--
-- Dev-tier management of ALL presentation decks, powering the builder's new
-- "Users Presentations" view (tools/presentation.html): the platform owner
-- (tier 'dev') can SEE every deck and ASSIGN a deck to another user.
--
-- Assigning = transferring ownership: the dev sets a deck's owner_id to the
-- target user, so the deck moves out of the dev's "My Presentations" into the
-- dev-only "Users Presentations" group (tagged with the new owner) and shows up
-- in that user's own "My Presentations".
--
-- Two new PERMISSIVE, dev-only policies layered ON TOP of the existing
-- owner/company policies from 041. Permissive policies are OR'd, so:
--   - non-dev access is completely unchanged (a 'company' advisor still sees
--     only their own decks + company decks);
--   - the dev additionally sees every row and may update any row.
--
-- The UPDATE policy is REQUIRED for assignment: the per-owner policy from 041
-- ("update own or manage company decks") forbids reassigning owner_id (its
-- WITH CHECK ties owner_id to auth.uid()). The dev policy permits the owner_id
-- change. The client only sends owner_id on the explicit assign action; normal
-- deck saves never touch it.
--
-- Note (intentional, by request): dev-read-all surfaces other users' PRIVATE
-- decks to the dev. This is the platform owner's admin capability — gated
-- strictly to tier 'dev' via current_tier() (SECURITY DEFINER, defined in
-- 001_init.sql). No new access is granted to admin/company/client/guest.
-- ===========================================================================

alter table public.presentation_decks enable row level security;

drop policy if exists "dev reads all decks"   on public.presentation_decks;
drop policy if exists "dev updates any deck"   on public.presentation_decks;

-- SELECT: the dev sees every deck (own, company, and other users' private
-- decks) so the "Users Presentations" group can list decks owned by others.
create policy "dev reads all decks"
  on public.presentation_decks
  for select to authenticated
  using ( public.current_tier() = 'dev' );

-- UPDATE: the dev may update any deck, including reassigning owner_id (the
-- assign action) and flipping visibility. WITH CHECK mirrors USING so the
-- post-update row is unrestricted for the dev.
create policy "dev updates any deck"
  on public.presentation_decks
  for update to authenticated
  using ( public.current_tier() = 'dev' )
  with check ( public.current_tier() = 'dev' );

-- Verify with (as the dev):
--   select id, owner_id, title, visibility from public.presentation_decks;
--   select polname, cmd from pg_policies where tablename = 'presentation_decks';
