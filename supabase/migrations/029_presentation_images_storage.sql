-- =============================================================================
-- 029_presentation_images_storage.sql — Image storage for the Presentation tool
--
-- The Presentation tool used to inline every pasted/uploaded image into the
-- shared presentation_state.payload JSONB row as a base64 data URL. That
-- worked for a couple of small decks but did not scale: each image was
-- 200 KB - 1 MB, the payload bloated past Supabase's REST body cap, and
-- saves started silently failing. This bucket holds the image files
-- separately so the JSONB row only stores ~80-byte path references.
--
-- Path layout the client writes:
--   {deckId}/{overlayId}.{ext}
--   e.g.  user-mote70ib-0t97/i1717245123456.png
--
-- Security model — mirrors migration 028 (online-reports lockdown):
--   - Bucket is PRIVATE. The dashboard flag must also be set:
--     Storage → presentation-images → "Public bucket" UNCHECKED.
--   - SELECT for authenticated users so signed URLs minted by the client
--     work. Anon traffic cannot read.
--   - INSERT / UPDATE / DELETE gated by is_writer() so only Tier 0 (dev)
--     and Tier 1 (admin) can populate or prune. This matches who can
--     write to presentation_state.payload itself; non-writers still see
--     the images via SELECT.
--
-- Run order: after 028. Idempotent — re-running replaces policies cleanly.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Bucket — private (public flag must also be off in the dashboard). public
-- here defaults to false on insert, but we set it explicitly so re-running
-- this migration after a manual toggle puts the flag back where we want.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
  values ('presentation-images', 'presentation-images', false)
on conflict (id) do update set public = false;


-- ---------------------------------------------------------------------------
-- Read policy — authenticated only. The client requests short-lived signed
-- URLs (createSignedUrl) for each image; anon traffic has no path in.
-- ---------------------------------------------------------------------------
drop policy if exists "authenticated read presentation-images" on storage.objects;
create policy "authenticated read presentation-images"
  on storage.objects for select to authenticated
  using (bucket_id = 'presentation-images');


-- ---------------------------------------------------------------------------
-- Write policies — admins (Tier 0/1) only. is_writer() is the same gate
-- used everywhere else for upsert / delete operations.
-- ---------------------------------------------------------------------------
drop policy if exists "writers upload presentation-images" on storage.objects;
create policy "writers upload presentation-images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'presentation-images' and public.is_writer());

drop policy if exists "writers update presentation-images" on storage.objects;
create policy "writers update presentation-images"
  on storage.objects for update to authenticated
  using (bucket_id = 'presentation-images' and public.is_writer())
  with check (bucket_id = 'presentation-images' and public.is_writer());

drop policy if exists "writers delete presentation-images" on storage.objects;
create policy "writers delete presentation-images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'presentation-images' and public.is_writer());
