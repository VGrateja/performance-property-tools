-- =============================================================================
-- 028_online_reports_storage_lockdown.sql — Lock down rendered reports
--
-- Migration 017 set the `online-reports` bucket to public so anon
-- consumers could fetch PDFs directly. Migration 027 then dropped the
-- broad SELECT policy on storage.objects to clean up a linter warning
-- (the public bucket flag was enough; the policy was redundant).
--
-- Now the bucket is being flipped to private so anyone with a stale URL
-- can no longer fetch reports. We need:
--   1. The bucket to be private (handled in the Supabase dashboard:
--      Storage → online-reports → uncheck "Public bucket").
--   2. A SELECT policy that lets AUTHENTICATED users read via signed
--      URLs (the hub will switch to createSignedUrl). Anon traffic
--      stays locked out.
--
-- Write policies from migration 017 stay in place — admins (is_writer)
-- can still upload/update/delete, and the GitHub Actions renderer keeps
-- working because the service-role key bypasses RLS.
--
-- Run order: after 027.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Read policy — authenticated only. No anon access. The hub client signs
-- in before requesting signed URLs, so anonymous traffic (which is the
-- threat model we just closed) can no longer access the bucket.
-- ---------------------------------------------------------------------------
drop policy if exists "authenticated read online-reports" on storage.objects;
create policy "authenticated read online-reports"
  on storage.objects for select to authenticated
  using (bucket_id = 'online-reports');
