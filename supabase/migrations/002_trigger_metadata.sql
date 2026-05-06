-- ============================================================================
-- Migration 002 — smarter handle_new_user trigger
--
-- Replaces the simpler 001 trigger so the profile row created on signup
-- already has the correct tier/status without manual SQL afterward.
--
-- Decision matrix (first match wins):
--   1. email in admin list           → tier='admin',   status='active'
--   2. email ends @performanceproperty.com.au → tier='company', status='active'
--   3. raw_user_meta_data.role = 'guest' → tier='guest',  status='active'
--   4. otherwise                     → tier='client',  status='pending'
--
-- Vandolf still has to upgrade himself to tier='dev' once after first signup
-- (admin and dev share the same UI privileges; dev only adds the tier-switcher).
--
-- The trigger also pulls full_name from raw_user_meta_data.first_name so
-- the registration form's first-name field actually lands somewhere useful.
--
-- Idempotent: CREATE OR REPLACE on the function, drop+create on the trigger.
-- ============================================================================

create or replace function public.handle_new_user() returns trigger as $$
declare
  email_lc       text    := lower(new.email);
  is_admin_email boolean := email_lc in (
    'saskia@performanceproperty.com.au',
    'shaene@performanceproperty.com.au',
    'vandolf@performanceproperty.com.au',
    'paul@performanceproperty.com.au'
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

-- Re-bind the trigger so it picks up the new function body. Safe to re-run.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
