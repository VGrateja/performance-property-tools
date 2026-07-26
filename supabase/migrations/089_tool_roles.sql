-- ============================================================================
-- Migration 089 — ROLES axis (per-tool permissions) + retire the 'leads' tier
--
-- The access model becomes two clean axes (Van, 2026-07-25):
--   GROUPS (hub_groups + profiles.team, mig 081) — ACCESS: which tools you see.
--   ROLES  (this migration)                      — PERMISSION: edit vs view.
--     • Default role comes from tier: dev/admin = Editor, company = Viewer
--       (DB strings unchanged — only the display language changes).
--     • public.tool_roles holds PER-TOOL exceptions: "this user is an Editor
--       inside this one tool" — scoped write without minting a global admin.
--
-- The 'leads' tier was exactly one such exception bolted on as a tier
-- (Vault/PM visibility = a groups job + Scorecards write via 071's
-- scorecard_can_write()). This migration:
--   A) creates tool_roles + RLS (read: own rows or writers; write: dev only)
--   B) creates has_tool_role(tool, role) — the generic RLS building block
--   C) repoints scorecard_can_write() at it (every 066/071/072 policy and
--      scorecard_unsign() follow automatically — no policy changes needed)
--   D) grants Marilou scorecards:editor (exact same power she has today)
--   E) removes the 'leads' auto-assign branch from handle_new_user
--   F) flips marilou + test to tier='company' (their teams already carry the
--      visibility: marilou team='leads' → baseline+scorecards, test='admins')
--
-- NOT changed: the profiles.tier CHECK still lists 'leads' (harmless, nothing
-- assigns it now); mig 080's results_state read policy mentions 'leads'
-- (harmless — company covers the flipped users); client/guest stay dormant.
-- ============================================================================

-- ── A) per-tool role grants ────────────────────────────────────────────────
create table if not exists public.tool_roles (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  tool_key   text        not null,          -- PP_TOOL_REGISTRY key ('scorecards', 'results', …)
  role       text        not null default 'editor' check (role in ('editor')),
  granted_at timestamptz not null default now(),
  granted_by uuid        references auth.users (id),
  primary key (user_id, tool_key)
);

alter table public.tool_roles enable row level security;

drop policy if exists "tool_roles_sel" on public.tool_roles;
drop policy if exists "tool_roles_ins" on public.tool_roles;
drop policy if exists "tool_roles_upd" on public.tool_roles;
drop policy if exists "tool_roles_del" on public.tool_roles;

-- you can always see your own grants; writers (dev/admin) see the roster
create policy "tool_roles_sel" on public.tool_roles
  for select to authenticated
  using (user_id = auth.uid() or public.is_writer());

-- rights management stays dev-only (matches set_user_team)
create policy "tool_roles_ins" on public.tool_roles
  for insert to authenticated with check (public.current_tier() = 'dev');

create policy "tool_roles_upd" on public.tool_roles
  for update to authenticated
  using (public.current_tier() = 'dev') with check (public.current_tier() = 'dev');

create policy "tool_roles_del" on public.tool_roles
  for delete to authenticated using (public.current_tier() = 'dev');

-- ── B) the generic per-tool permission check ───────────────────────────────
create or replace function public.has_tool_role(p_tool text, p_role text default 'editor')
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.tool_roles
     where user_id = auth.uid() and tool_key = p_tool and role = p_role
  );
$$;

revoke execute on function public.has_tool_role(text, text) from public, anon;
grant  execute on function public.has_tool_role(text, text) to authenticated;

-- ── C) scorecards: tier check → role check (policies untouched) ────────────
create or replace function public.scorecard_can_write() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.is_writer() or public.has_tool_role('scorecards', 'editor'), false);
$$;

-- ── D) Marilou keeps her exact Scorecards power as a role grant ─────────────
insert into public.tool_roles (user_id, tool_key, role, granted_by)
select p.id, 'scorecards', 'editor',
       (select id from public.profiles where email = 'vandolf@performanceproperty.com.au')
  from public.profiles p
 where p.email = 'marilou@performanceproperty.com.au'
on conflict (user_id, tool_key) do nothing;

-- ── E) stop auto-assigning 'leads' on (re)signup ────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
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
$$;

-- ── F) retire 'leads': both members become company (teams already correct —
--       marilou team='leads' (baseline+scorecards), test team='admins') ─────
update public.profiles
   set tier = 'company'
 where tier = 'leads'
   and email in ('marilou@performanceproperty.com.au', 'test@performanceproperty.com.au');
