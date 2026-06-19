-- =============================================================================
-- 048_pm_tenant_applications.sql — storage for the Tenant Application Summary
-- tool (Property Management).
--
-- A PM staffer captures a tenant's rental-application details and generates a
-- branded, owner-ready summary. The captured data is sensitive tenant PII
-- (names, ages, income, rental history), so access is locked to INTERNAL STAFF
-- only via is_staff() (dev / admin / company). Clients, guests, and anon can
-- never read or write it — even though the in-page anon key is public, RLS
-- enforces this at the database.
--
-- payload (jsonb) holds the full captured record:
--   { property, appliedRent, commencement, children, pet, notes,
--     applicants: [ { name, age, income, history, reason }, ... ] }
-- `property` and `applicant_label` are denormalised columns so the saved-list
-- can render without parsing every payload.
--
-- Run order: after 009_cadence.sql (defines is_staff()).
-- =============================================================================

create table if not exists public.pm_tenant_applications (
  id              uuid        primary key default gen_random_uuid(),
  created_by      uuid        references public.profiles(id) on delete set null,
  property        text,
  applicant_label text,
  payload         jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists pm_tenant_applications_created_idx
  on public.pm_tenant_applications (created_at desc);

alter table public.pm_tenant_applications enable row level security;

-- The authenticated role needs table privileges for the Data API; RLS below
-- still gates which rows are visible. anon gets nothing.
grant select, insert, update, delete on public.pm_tenant_applications to authenticated;

drop policy if exists "staff read pm applications"   on public.pm_tenant_applications;
drop policy if exists "staff insert pm applications" on public.pm_tenant_applications;
drop policy if exists "staff update pm applications" on public.pm_tenant_applications;
drop policy if exists "staff delete pm applications" on public.pm_tenant_applications;

-- Read: internal staff only (never client / guest / anon).
create policy "staff read pm applications"
  on public.pm_tenant_applications for select to authenticated
  using (public.is_staff());

-- Insert: staff, and the row must be stamped with the creator's id.
create policy "staff insert pm applications"
  on public.pm_tenant_applications for insert to authenticated
  with check (public.is_staff() and created_by = auth.uid());

-- Update: any staffer (collaborative PM tool). Needs both USING + WITH CHECK.
create policy "staff update pm applications"
  on public.pm_tenant_applications for update to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- Delete: any staffer.
create policy "staff delete pm applications"
  on public.pm_tenant_applications for delete to authenticated
  using (public.is_staff());

-- Keep updated_at fresh on edit.
create or replace function public.pm_tenant_applications_touch()
  returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pm_tenant_applications_touch on public.pm_tenant_applications;
create trigger pm_tenant_applications_touch
  before update on public.pm_tenant_applications
  for each row execute function public.pm_tenant_applications_touch();
