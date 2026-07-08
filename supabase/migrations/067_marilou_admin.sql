-- ============================================================================
-- Migration 067 — add marilou@performanceproperty.com.au to the admin list
--
-- Same handle_new_user body as 002 with one email added, and keeps the
-- search_path hardening from 026 (CREATE OR REPLACE would otherwise drop
-- the ALTER FUNCTION ... SET search_path applied there). Also upgrades
-- her profile row in place in case she registered before this ran.
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
    'paul@performanceproperty.com.au',
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

-- already registered? upgrade in place (no-op otherwise)
update public.profiles
   set tier = 'admin', status = 'active'
 where lower(email) = 'marilou@performanceproperty.com.au'
   and tier is distinct from 'admin';
