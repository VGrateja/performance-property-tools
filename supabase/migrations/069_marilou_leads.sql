-- ============================================================================
-- Migration 069 — move marilou@performanceproperty.com.au to the 'leads' tier
--
-- 067 had added Marilou to the admin auto-assign list. She is a Lead now, so:
--   (a) remove her from is_admin_email in handle_new_user — otherwise the
--       trigger's definition of "who is admin" still includes her, and a
--       future signup would re-create her as admin. 'leads' is assigned
--       manually (like 'dev'), never by the trigger.
--   (b) upgrade her existing profile row in place to tier='leads'.
--
-- REQUIRES migration 068 (adds 'leads' to the profiles.tier CHECK constraint)
-- to be applied FIRST, or the UPDATE below violates the constraint.
--
-- Same handle_new_user body as 067 minus Marilou, keeping the 026 search_path
-- hardening. (Her friendly name stays in ADMIN_NAMES in shared/auth.js — that
-- map is a cosmetic greeting lookup, not an access gate.)
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

-- already registered? move her to leads in place (no-op otherwise)
update public.profiles
   set tier = 'leads', status = 'active'
 where lower(email) = 'marilou@performanceproperty.com.au'
   and tier is distinct from 'leads';
