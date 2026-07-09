-- ============================================================================
-- Migration 070 — auto-assign the 'leads' tier by email (Marilou)
--
-- 069 removed Marilou from the admin list and tried to set her row to 'leads',
-- but she has no profile yet (never signed in), so that UPDATE was a no-op and
-- she is NOT a lead. Unlike admin, 'leads' had no auto-assign path, so she
-- would sign up as plain 'company'.
--
-- This adds an is_leads_email list to handle_new_user (checked AFTER admin,
-- BEFORE the generic company default) so listed staff land on 'leads' the
-- moment they first sign in — same mechanism as is_admin_email. Also re-runs
-- the in-place update in case she has since registered.
--
-- Requires 068 (leads CHECK constraint) — already applied (069 depended on it).
-- Same handle_new_user body as 069 plus the leads branch, keeping the 026
-- search_path hardening.
-- ============================================================================

create or replace function public.handle_new_user() returns trigger
set search_path = public, pg_temp
as $$
declare
  email_lc       text    := lower(new.email);
  is_admin_email boolean := email_lc in (
    'saskia@performanceproperty.com.au',
    'shaene@performanceproperty.com.au',
    'vandolf@performanceproperty.com.au',
    'paul@performanceproperty.com.au'
  );
  is_leads_email boolean := email_lc in (
    'marilou@performanceproperty.com.au'
  );
  is_pp_email    boolean := email_lc like '%@performanceproperty.com.au';
  meta_role      text    := coalesce(new.raw_user_meta_data->>'role', 'client');
  meta_first     text    := new.raw_user_meta_data->>'first_name';
  resolved_tier   text;
  resolved_status text;
begin
  if is_admin_email then
    resolved_tier   := 'admin';
    resolved_status := 'active';
  elsif is_leads_email then
    resolved_tier   := 'leads';
    resolved_status := 'active';
  elsif is_pp_email then
    resolved_tier   := 'company';
    resolved_status := 'active';
  elsif meta_role = 'guest' then
    resolved_tier   := 'guest';
    resolved_status := 'active';
  else
    resolved_tier   := 'client';
    resolved_status := 'pending';
  end if;

  insert into public.profiles (id, email, full_name, tier, status)
  values (
    new.id,
    email_lc,
    nullif(meta_first, ''),
    resolved_tier,
    resolved_status
  )
  on conflict (id) do nothing;

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- already registered? move her to leads in place (no-op otherwise)
update public.profiles
   set tier = 'leads', status = 'active'
 where lower(email) = 'marilou@performanceproperty.com.au'
   and tier is distinct from 'leads';
