-- 117_ir_files_delete_policy.sql
--
-- Deleting IRs from the Builder (Van 2026-08-23). No DELETE policy existed,
-- so deletion was impossible for everyone. The rule now:
--
--   • a DRAFT (never published)  -> anyone who can write in the Builder
--     (ir_can_write: writers, the ir-builder tool_role, or a team whose
--     hub_groups row ticks 'ir-builder')
--   • a PUBLISHED file           -> the dev tier ONLY. Van is the only dev,
--     and migration 090's lockout guard keeps it that way — the DB refuses
--     to demote the last remaining developer, so "dev" is a durable way to
--     say "Van" without hardcoding a uuid.
--
-- The published stamp is compliance.published (set by doPublish). Deleting a
-- published file does NOT cascade to its investment_reports entry or the PDF
-- in ir-library — those are curated in the IR Library tool.
--
-- Who deleted what is recorded by the mig-104 audit trigger: it fires BEFORE
-- the row disappears and writes a section='deleted' row with the address,
-- auth.uid() and email. The Builder's home screen lists that history.

drop policy if exists "ir_files_delete" on public.ir_files;
create policy "ir_files_delete"
  on public.ir_files for delete to authenticated
  using (
    ((compliance -> 'published') is null and public.ir_can_write())
    or public.current_tier() = 'dev'
  );

-- ── The catch found in testing: mig 104's "ir_files_rw" is FOR ALL, which
-- includes DELETE — and permissive policies OR together, so it silently
-- overrode the rule above (the team could still delete published files).
-- Split it into explicit INSERT + UPDATE with the identical predicate, so
-- DELETE is governed by "ir_files_delete" alone. Reads keep their own
-- ir_files_read_all policy; nothing else changes.

drop policy if exists "ir_files_rw" on public.ir_files;

drop policy if exists "ir_files_insert" on public.ir_files;
create policy "ir_files_insert"
  on public.ir_files for insert to authenticated
  with check (public.ir_can_write());

drop policy if exists "ir_files_update" on public.ir_files;
create policy "ir_files_update"
  on public.ir_files for update to authenticated
  using (public.ir_can_write()) with check (public.ir_can_write());
