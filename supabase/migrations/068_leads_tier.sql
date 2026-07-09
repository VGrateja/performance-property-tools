-- ============================================================================
-- Migration 068 — add the 'leads' tier
--
-- Introduces a new access tier, 'leads', ranked between 'admin' and 'company'.
-- Leads have the same rights as company/staff (view + download, NO edit) plus
-- reach to the Vault and PM (Cadence) hub pages. That extra reach is enforced
-- CLIENT-SIDE (index.html _hubIsStaff() + CSS tier gates) — there is no
-- data-level difference, so RLS is intentionally unchanged:
--   • is_writer() stays dev/admin — leads CANNOT write to any state table.
--   • leads read the same authenticated-read surface every other tier does.
--
-- The only schema change is widening the profiles.tier CHECK constraint to
-- accept 'leads'. client/guest are kept. The signup trigger (067) is unchanged
-- — 'leads' is assigned manually (like 'dev'), e.g.:
--   update public.profiles set tier = 'leads' where email = '<person>@performanceproperty.com.au';
--
-- The Dev0 / Admin1 / Leads2 / Staff3 / Client4 / Guest5 numbering is a
-- display relabel in shared/auth.js only; the stored tier strings are
-- unchanged ('company' still backs the "Staff" label).
-- ============================================================================

alter table public.profiles drop constraint if exists profiles_tier_check;

alter table public.profiles
  add constraint profiles_tier_check
  check (tier in ('dev', 'admin', 'leads', 'company', 'client', 'guest'));
