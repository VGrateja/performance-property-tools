-- 113_presentation_deck_lock.sql
--
-- Lock a presentation so it can't be deleted by accident (Van 2026-08-21).
--
-- WHY A COLUMN AND NOT A PAYLOAD FLAG: the obvious place was
-- payload.deck.locked, but setting that from the deck LIST means read the whole
-- payload, edit it, write it back — and a payload round-trip from a stale read
-- is exactly how overlays get clobbered when the same deck is open elsewhere.
-- A boolean column is an atomic single-field update that can't touch slides.
--
-- WHY IT ALSO CHANGES RLS: a UI-only lock stops the × in the picker and nothing
-- else — a stray script, an old tab, or a future code path would still delete
-- the row. The two DELETE policies now both require the deck to be unlocked, so
-- the guarantee holds at the database. BOTH had to change: policies are
-- permissive and OR together, so leaving one alone would leave the door open.
--
--   before: owner_id = auth.uid() OR (visibility='company' AND is_writer())
--           (dev|admin) AND created_by = auth.uid()
--   after:  the same, AND the deck is not locked
--
-- Unlocking is an UPDATE, and everyone who can delete a deck can already update
-- it, so nobody can lock themselves out of their own deck.

alter table public.presentation_decks
  add column if not exists locked boolean not null default false;

comment on column public.presentation_decks.locked is
  'Deletion guard. While true, RLS refuses DELETE — unlock first (an UPDATE).';

drop policy if exists "delete own or company decks" on public.presentation_decks;
create policy "delete own or company decks"
  on public.presentation_decks for delete
  using (
    coalesce(locked, false) = false
    and (
      owner_id = (select auth.uid())
      or (visibility = 'company' and public.is_writer())
    )
  );

drop policy if exists "staff deletes own-created decks" on public.presentation_decks;
create policy "staff deletes own-created decks"
  on public.presentation_decks for delete
  using (
    coalesce(locked, false) = false
    and public.current_tier() = any (array['dev', 'admin'])
    and created_by = (select auth.uid())
  );
