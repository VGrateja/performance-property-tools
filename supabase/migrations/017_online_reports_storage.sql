-- =============================================================================
-- 017_online_reports_storage.sql — Pre-built Online Report PDFs storage
--
-- Backs the "GitHub Actions renders monthly, users download instantly"
-- flow built in May 2026. Without this bucket, every Download click runs
-- html2canvas + jsPDF in-browser (~30s+ per report). With it, the page
-- just fetches a static PDF from public storage.
--
-- Path layout the renderer writes:
--   {YYYY-MM}/{region-slug}.pdf           e.g.  2026-06/sydney.pdf
--   {YYYY-MM}/lite/{region-slug}.pdf      e.g.  2026-06/lite/sydney.pdf
--
-- Two-month retention is enforced by the renderer (scripts/render-
-- reports.mjs) — at the tail of every successful run it lists folder
-- prefixes and deletes anything older than current month - 1.
--
-- Security model:
--   - public = true on the bucket so Netlify consumers (no Supabase
--     auth) can fetch the PDFs directly via the public URL. This
--     mirrors the existing online-reports security posture — the
--     reports themselves are visible to anyone who can reach the
--     page, so storing the PDF behind auth would be a step BACKWARDS
--     in convenience without adding protection over what the in-page
--     exporter already produces.
--   - INSERT / UPDATE / DELETE are gated by is_writer() so only
--     Tier 0 (dev) and Tier 1 (admin) can populate the bucket or
--     prune old months. The GitHub Actions renderer uses the
--     service-role key which bypasses RLS entirely, but the policies
--     stay in place so a leaked anon key can't corrupt the cache.
--
-- Run order: after 016_cadence_team_lead.sql. Idempotent — re-running
-- replaces the bucket flag + policies cleanly.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Bucket — public read, controlled write.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
  values ('online-reports', 'online-reports', true)
on conflict (id) do update set public = true;


-- ---------------------------------------------------------------------------
-- Read policy — anyone. Mirrors the existing report-page accessibility:
-- whoever can land on the page can already see the live data, so handing
-- them the PDF version is the same disclosure with faster delivery.
-- ---------------------------------------------------------------------------
drop policy if exists "public read online-reports" on storage.objects;
create policy "public read online-reports"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'online-reports');


-- ---------------------------------------------------------------------------
-- Write policies — admins (Tier 0/1) only. is_writer() is the same gate
-- the rest of the app uses for upsert operations (see migration 001).
-- The GitHub Actions renderer bypasses these via the service-role key.
-- ---------------------------------------------------------------------------
drop policy if exists "writers upload online-reports" on storage.objects;
create policy "writers upload online-reports"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'online-reports' and public.is_writer());

drop policy if exists "writers update online-reports" on storage.objects;
create policy "writers update online-reports"
  on storage.objects for update to authenticated
  using (bucket_id = 'online-reports' and public.is_writer())
  with check (bucket_id = 'online-reports' and public.is_writer());

drop policy if exists "writers delete online-reports" on storage.objects;
create policy "writers delete online-reports"
  on storage.objects for delete to authenticated
  using (bucket_id = 'online-reports' and public.is_writer());
