-- ===========================================================================
-- 106_ir_library_storage.sql
--
-- Staff-readable storage bucket for PUBLISHED IR report PDFs (IR Builder
-- Phase F): when the acquisition team publishes a finished file as an
-- example IR, the rendered report is captured as a PDF and attached to the
-- Investment Reports library entry (metrics.report_pdf = storage path).
--
-- Why a second bucket: 'ir-evidence' (105) is readable by the acquisition
-- circle only, but the LIBRARY is read by every staff member (advisors show
-- these to prospects) — so published PDFs need authenticated read.
--
--   • READ  : any signed-in staff member (signed URLs from the library tool).
--   • WRITE : the acquisition circle (ir_can_write()).
-- ===========================================================================

insert into storage.buckets (id, name, public)
values ('ir-library', 'ir-library', false)
on conflict (id) do update set public = excluded.public;

drop policy if exists "ir-library read"   on storage.objects;
drop policy if exists "ir-library insert" on storage.objects;
drop policy if exists "ir-library update" on storage.objects;
drop policy if exists "ir-library delete" on storage.objects;

create policy "ir-library read"
  on storage.objects for select to authenticated
  using ( bucket_id = 'ir-library' );

create policy "ir-library insert"
  on storage.objects for insert to authenticated
  with check ( bucket_id = 'ir-library' and public.ir_can_write() );

create policy "ir-library update"
  on storage.objects for update to authenticated
  using      ( bucket_id = 'ir-library' and public.ir_can_write() )
  with check ( bucket_id = 'ir-library' and public.ir_can_write() );

create policy "ir-library delete"
  on storage.objects for delete to authenticated
  using ( bucket_id = 'ir-library' and public.ir_can_write() );
