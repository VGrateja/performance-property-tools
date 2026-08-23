-- 114_presentation_pdf_cache.sql
--
-- Pre-rendered deck PDFs, so a Download is instant instead of a ~1-minute
-- live export (Van 2026-08-23). One object per deck, and the deck's own
-- updated_at is ENCODED IN THE PATH:
--
--     <deck row uuid>/<updated_at with every non-digit stripped>.pdf
--
-- That makes freshness a pure existence check — the client asks for exactly
-- the path matching the deck it is showing; any edit bumps updated_at, the
-- path stops existing, and the client falls back to a live export. No
-- metadata table, nothing to drift, and a stale cache can never be served.
--
-- Writers of the cache:
--   • the deck's EDITORS, from the browser (export-through: a live export's
--     bytes are uploaded right after the download, so the very next person
--     is instant without waiting for the nightly render)
--   • the GitHub Actions renderer, via the service role (bypasses RLS)
--
-- Readers: anyone who can SEE the deck row. The policy's subquery runs as
-- the requesting user, so presentation_decks' own RLS decides — company
-- decks for all staff, private decks only for their owner/co-editors/admins.
-- A viewer can therefore download the cached PDF of any deck they can open,
-- and nothing more.

insert into storage.buckets (id, name, public)
values ('presentation-pdfs', 'presentation-pdfs', false)
on conflict (id) do nothing;

drop policy if exists "deck pdfs readable with the deck" on storage.objects;
create policy "deck pdfs readable with the deck"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'presentation-pdfs'
    and exists (
      select 1 from public.presentation_decks d
      where d.id::text = split_part(name, '/', 1)
    )
  );

-- The three write verbs share one predicate: the caller can EDIT that deck.
-- Mirrors _deckIsEditable / the deck UPDATE policies: the owner, a global
-- writer (dev/admin), or a mig-061 co-editor.

drop policy if exists "deck pdfs written by deck editors" on storage.objects;
create policy "deck pdfs written by deck editors"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'presentation-pdfs'
    and exists (
      select 1 from public.presentation_decks d
      where d.id::text = split_part(name, '/', 1)
        and (d.owner_id = (select auth.uid())
             or public.is_writer()
             or exists (select 1 from public.presentation_deck_editors e
                        where e.deck_id = d.id and e.user_id = (select auth.uid())))
    )
  );

drop policy if exists "deck pdfs updated by deck editors" on storage.objects;
create policy "deck pdfs updated by deck editors"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'presentation-pdfs'
    and exists (
      select 1 from public.presentation_decks d
      where d.id::text = split_part(name, '/', 1)
        and (d.owner_id = (select auth.uid())
             or public.is_writer()
             or exists (select 1 from public.presentation_deck_editors e
                        where e.deck_id = d.id and e.user_id = (select auth.uid())))
    )
  );

drop policy if exists "deck pdfs deleted by deck editors" on storage.objects;
create policy "deck pdfs deleted by deck editors"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'presentation-pdfs'
    and exists (
      select 1 from public.presentation_decks d
      where d.id::text = split_part(name, '/', 1)
        and (d.owner_id = (select auth.uid())
             or public.is_writer()
             or exists (select 1 from public.presentation_deck_editors e
                        where e.deck_id = d.id and e.user_id = (select auth.uid())))
    )
  );
