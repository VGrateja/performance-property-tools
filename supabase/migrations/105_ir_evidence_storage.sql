-- ===========================================================================
-- 105_ir_evidence_storage.sql
--
-- Private storage bucket for IR Builder DD EVIDENCE (Phase B): the
-- screenshots / PDFs the DD team currently staples into the 59-page DD pack
-- by hand. Each Preliminary-DD check can carry attachments; the BA sees them
-- inline in the Review window, and the DD pack can assemble summary +
-- evidence automatically later (Phase E+).
--
--   • READ  : the acquisition circle only (ir_can_write() — dev/admin or a
--             tool_roles 'ir-builder' grant), via short-lived signed URLs.
--   • WRITE : same circle. Paths: <ir_file_id>/<check-slug>/<ts>-<name>.
--
-- Mirrors the storage pattern of 028/029/062.
-- ===========================================================================

insert into storage.buckets (id, name, public)
values ('ir-evidence', 'ir-evidence', false)
on conflict (id) do update set public = excluded.public;

drop policy if exists "ir-evidence read"   on storage.objects;
drop policy if exists "ir-evidence insert" on storage.objects;
drop policy if exists "ir-evidence update" on storage.objects;
drop policy if exists "ir-evidence delete" on storage.objects;

create policy "ir-evidence read"
  on storage.objects for select to authenticated
  using ( bucket_id = 'ir-evidence' and public.ir_can_write() );

create policy "ir-evidence insert"
  on storage.objects for insert to authenticated
  with check ( bucket_id = 'ir-evidence' and public.ir_can_write() );

create policy "ir-evidence update"
  on storage.objects for update to authenticated
  using      ( bucket_id = 'ir-evidence' and public.ir_can_write() )
  with check ( bucket_id = 'ir-evidence' and public.ir_can_write() );

create policy "ir-evidence delete"
  on storage.objects for delete to authenticated
  using ( bucket_id = 'ir-evidence' and public.ir_can_write() );
