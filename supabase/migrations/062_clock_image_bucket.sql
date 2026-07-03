-- ===========================================================================
-- 062_clock_image_bucket.sql
--
-- Public storage bucket for the National Property Clock snapshot JPG.
--
-- The Clock tool (property-clock.html) uploads a fresh capture on every Save
-- (same html2canvas capture as its JPEG download) to a FIXED path
-- 'national-clock.jpg' (upsert/overwrite). Presentations embed it as an
-- auto-updating image via a plain PUBLIC url + a ?v= cache-buster read from
-- clock_state.payload.clockImageUpdatedAt — so every deck shows the latest
-- clock and it renders correctly in PDF/JPG deck exports (the old live iframe
-- embed did not).
--
--   • READ  : public (the clock is client-facing; shown in presentations).
--   • WRITE : dev/admin only (is_writer()) — matches who can Save the clock.
--
-- Mirrors the storage pattern of 028 (online-reports) / 029 (presentation-images)
-- but PUBLIC-read instead of signed, since there's nothing sensitive here.
-- ===========================================================================

insert into storage.buckets (id, name, public)
values ('clock-image', 'clock-image', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "clock-image public read"  on storage.objects;
drop policy if exists "clock-image writer insert" on storage.objects;
drop policy if exists "clock-image writer update" on storage.objects;
drop policy if exists "clock-image writer delete" on storage.objects;

create policy "clock-image public read"
  on storage.objects for select
  using ( bucket_id = 'clock-image' );

create policy "clock-image writer insert"
  on storage.objects for insert to authenticated
  with check ( bucket_id = 'clock-image' and public.is_writer() );

create policy "clock-image writer update"
  on storage.objects for update to authenticated
  using      ( bucket_id = 'clock-image' and public.is_writer() )
  with check ( bucket_id = 'clock-image' and public.is_writer() );

create policy "clock-image writer delete"
  on storage.objects for delete to authenticated
  using ( bucket_id = 'clock-image' and public.is_writer() );
