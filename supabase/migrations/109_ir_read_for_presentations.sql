-- =============================================================================
-- 109_ir_read_for_presentations.sql — staff-wide READ on IR files + evidence
--
-- The presentation builder's "IR Samples" feature lets any advisor insert an
-- investment case-study slide built from an ir_files row (and copy its cover
-- photo out of ir-evidence into presentation-images). Advisors aren't in the
-- IR Builder circle, and ir_files/ir-evidence reads were gated on
-- ir_can_write() (mig 104/105) — so the picker would come back empty for
-- exactly the people it's for.
--
-- Reads widen to all authenticated staff — consistent with the rest of the
-- hub (001 pattern: any authenticated user reads, writers write) and with
-- investment_reports, which every staffer can already read. WRITES ARE
-- UNTOUCHED: ir_files_rw / the ir-evidence insert/update/delete policies
-- still require ir_can_write(). Policies are OR'd, so both migrations'
-- policies coexist; nothing is dropped.
--
-- Run order: after 108_*.sql.
-- =============================================================================

create policy "ir_files_read_all" on public.ir_files
  for select to authenticated using (true);

create policy "ir-evidence read all"
  on storage.objects for select to authenticated
  using (bucket_id = 'ir-evidence');
