-- 116_clock_image_private.sql
--
-- The last public Storage bucket goes private (parked at the 2026-08-21
-- security sweep, cleared by Van 2026-08-23). The National Property Clock
-- JPG/PDF were world-readable to anyone holding the URL; every consumer is
-- an authenticated staff page, so there is no reason for public exposure.
--
-- Consumers were switched to signed URLs FIRST (deployed before this runs):
--   • presentation.html  _getClockImageUrl  (clock overlays in decks)
--   • buying-selling-slides.html  clockImageUrl  (the Timing page)
--   • whitepapers-strategies.html  intercepts clicks on the baked public-form
--     PDF link that property-clock stamps into documents_state, and resolves
--     a fresh signed URL — old rows keep working without a data rewrite.
-- Writers (the Property Clock tool's uploads) keep the mig-062 writer
-- policies unchanged.

update storage.buckets set public = false where id = 'clock-image';

-- Public read becomes authenticated read (signed URLs mint against SELECT).
drop policy if exists "clock-image public read" on storage.objects;
drop policy if exists "clock-image authenticated read" on storage.objects;
create policy "clock-image authenticated read"
  on storage.objects for select to authenticated
  using ( bucket_id = 'clock-image' );
