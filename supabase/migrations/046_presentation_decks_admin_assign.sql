-- ===========================================================================
-- 046_presentation_decks_admin_assign.sql
--
-- Widen the "Users Presentations" management capability from tier 'dev' to
-- tier 'dev' OR 'admin' (the two staff/writer tiers). Admins now get the same
-- builder view the dev had: SEE every deck (incl. other users' private decks),
-- ASSIGN a deck to another user (reassign owner_id), and DELETE a deck they
-- themselves created.
--
-- This replaces the three dev-only policies from 044/045 with dev-OR-admin
-- equivalents. Non-staff access (company/client/guest) is completely unchanged
-- — they still only ever see their own + company decks via the 041 policies.
--
-- Gating still uses current_tier() (SECURITY DEFINER, 001_init.sql), so it
-- can't be spoofed from the client. 'admin' = Saskia / Shaene / Paul /
-- D.Robbins per the access-tier table; matches is_writer() membership.
--
-- Note (intentional, by request): this surfaces other users' PRIVATE decks to
-- admins, exactly as it already did for the dev. No access is granted to
-- company/client/guest.
-- ===========================================================================

alter table public.presentation_decks enable row level security;

-- Drop the dev-only policies (044/045) AND any prior run of these new names.
drop policy if exists "dev reads all decks"            on public.presentation_decks;
drop policy if exists "dev updates any deck"            on public.presentation_decks;
drop policy if exists "dev deletes own-created decks"   on public.presentation_decks;
drop policy if exists "staff reads all decks"           on public.presentation_decks;
drop policy if exists "staff updates any deck"          on public.presentation_decks;
drop policy if exists "staff deletes own-created decks"  on public.presentation_decks;

-- SELECT: dev/admin see every deck (own, company, and other users' private
-- decks) so the "Users Presentations" group can list decks owned by others.
create policy "staff reads all decks"
  on public.presentation_decks
  for select to authenticated
  using ( public.current_tier() in ('dev','admin') );

-- UPDATE: dev/admin may update any deck, including reassigning owner_id (the
-- assign action) and flipping visibility. WITH CHECK mirrors USING so the
-- post-update row is unrestricted for staff.
create policy "staff updates any deck"
  on public.presentation_decks
  for update to authenticated
  using ( public.current_tier() in ('dev','admin') )
  with check ( public.current_tier() in ('dev','admin') );

-- DELETE: dev/admin may delete decks THEY created, regardless of who currently
-- owns them (e.g. a deck they built then assigned out). Layered on top of 041's
-- owner/company delete policy (permissive = OR). Crucially this does NOT let
-- them delete a deck created by someone else.
create policy "staff deletes own-created decks"
  on public.presentation_decks
  for delete to authenticated
  using ( public.current_tier() in ('dev','admin') and created_by = (select auth.uid()) );

-- Verify with:
--   select polname, cmd from pg_policies where tablename = 'presentation_decks';
