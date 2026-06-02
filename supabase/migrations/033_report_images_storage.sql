-- =============================================================================
-- 033_report_images_storage.sql — Image storage for report image overlays (#7)
--
-- The report edit engine (shared/report-edit.js — used by online-reports,
-- national-report, commercial-report) used to inline every uploaded image
-- overlay into reports_state.payload as a base64 data URL. Each image is
-- 200 KB - 1 MB, which bloats the per-region JSONB row (and the localStorage
-- cache + every sync/backup that carries it). This bucket holds the image
-- files separately so the payload only stores an ~80-byte path reference.
--
-- Mirrors 029 (presentation-images) exactly — same problem, same shape.
--
-- Path layout the client writes:
--   {regionSlug}/{overlayId}.{ext}
--   e.g.  sydney/ig-mote70ib-0t97.png   (research slugs: national/ , commercial/)
--
-- Security model — mirrors 028/029:
--   - Bucket is PRIVATE (dashboard "Public bucket" must also be UNCHECKED).
--   - SELECT for authenticated users so client-minted signed URLs work; the
--     pdf-renderer service account (authenticated) can read for monthly PDFs.
--   - INSERT / UPDATE / DELETE gated by is_writer() — same gate as
--     reports_state.payload itself. Non-writers still see images via SELECT.
--
-- Run order: after 032. Idempotent — re-running replaces policies cleanly.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Bucket — private. public defaults false on insert; set explicitly so a
-- re-run after a manual toggle puts the flag back.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
  values ('report-images', 'report-images', false)
on conflict (id) do update set public = false;


-- ---------------------------------------------------------------------------
-- Read policy — authenticated only (signed URLs); anon has no path in.
-- ---------------------------------------------------------------------------
drop policy if exists "authenticated read report-images" on storage.objects;
create policy "authenticated read report-images"
  on storage.objects for select to authenticated
  using (bucket_id = 'report-images');


-- ---------------------------------------------------------------------------
-- Write policies — writers (Tier 0/1) only, via is_writer().
-- ---------------------------------------------------------------------------
drop policy if exists "writers upload report-images" on storage.objects;
create policy "writers upload report-images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'report-images' and public.is_writer());

drop policy if exists "writers update report-images" on storage.objects;
create policy "writers update report-images"
  on storage.objects for update to authenticated
  using (bucket_id = 'report-images' and public.is_writer())
  with check (bucket_id = 'report-images' and public.is_writer());

drop policy if exists "writers delete report-images" on storage.objects;
create policy "writers delete report-images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'report-images' and public.is_writer());
