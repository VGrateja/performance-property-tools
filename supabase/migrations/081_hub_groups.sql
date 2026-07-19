-- ===========================================================================
-- 081_hub_groups.sql — staff GROUPS (teams): visibility-only tool grouping
--
-- Groups control WHICH TOOLS a staff member SEES on the hub (cards + dock +
-- search + deep links). They change NO rights: is_writer() stays dev/admin,
-- leads' Scorecards write (071) is untouched, and every existing table's RLS
-- is unchanged. `tier` remains the RIGHTS axis; `team` is a pure-VISIBILITY
-- axis applied to tier='company' users (tier='leads' maps to the 'leads'
-- group row; dev/admin see everything; client/guest unchanged).
--
-- Client resolution (shared/auth.js ppResolveAllowedTools):
--   allowed = union(company_baseline.tools, group.tools)
--   dev/admin → all · leads → baseline ∪ leads row · company → baseline ∪
--   team row (team null = baseline only) · client/guest → legacy gating.
--
-- Tool keys live in shared/tool-registry.js (PP_TOOL_REGISTRY.TOOLS) — the
-- company_baseline seed below MUST stay in lockstep with DEFAULT_BASELINE
-- there (that constant is the pre-migration fallback; inert once this is
-- applied).
--
-- GOTCHA honoured: touch_updated_at() sets NEW.updated_by, so the column
-- must exist or every UPDATE fails (see 041's bugfix).
-- ===========================================================================

-- ── the groups table ───────────────────────────────────────────────────────
create table if not exists public.hub_groups (
  key         text         primary key,
  name        text         not null,
  tools       jsonb        not null default '[]'::jsonb,   -- array of tool keys (shared/tool-registry.js)
  sort        int          not null default 100,
  updated_at  timestamptz  not null default now(),
  updated_by  uuid         references public.profiles(id)
);

drop trigger if exists trg_hub_groups_updated_at on public.hub_groups;
create trigger trg_hub_groups_updated_at
  before update on public.hub_groups
  for each row execute function public.touch_updated_at();

alter table public.hub_groups enable row level security;

drop policy if exists "authenticated read hub_groups" on public.hub_groups;
drop policy if exists "dev insert hub_groups"         on public.hub_groups;
drop policy if exists "dev update hub_groups"         on public.hub_groups;
drop policy if exists "dev delete hub_groups"         on public.hub_groups;

create policy "authenticated read hub_groups"
  on public.hub_groups for select to authenticated
  using ( true );

create policy "dev insert hub_groups"
  on public.hub_groups for insert to authenticated
  with check ( public.current_tier() = 'dev' );

create policy "dev update hub_groups"
  on public.hub_groups for update to authenticated
  using ( public.current_tier() = 'dev' )
  with check ( public.current_tier() = 'dev' );

create policy "dev delete hub_groups"
  on public.hub_groups for delete to authenticated
  using ( public.current_tier() = 'dev' );

-- ── profiles.team (null = unassigned → company baseline only) ──────────────
alter table public.profiles
  add column if not exists team text references public.hub_groups(key) on delete set null;

-- ── seed rows ────────────────────────────────────────────────────────────--
-- on conflict do nothing → re-running this migration never clobbers edits
-- made in the hub's Groups panel.
-- company_baseline = EXACTLY today's company-tier-visible hub toolset
-- (Scorecards is NOT here: company can't reach the People section today —
-- it lives in the 'leads' row).
-- 'admins' seeds with EVERY tool key (an unassigned admin sees everything
-- anyway; the row exists so Van can trim what assigned admins see).
-- 'leads' auto-applies to unassigned tier='leads' users (back-compat) and is
-- also assignable like any group.
insert into public.hub_groups (key, name, tools, sort) values
  ('company_baseline','Company Baseline',
   '["clock","runway-demand","runway-workbook","vr-projection","results","documents","online-reports","research-reports","present-new","present-company","present-mine","present-library","arena","arena-typing","arena-chess","arena-scrabble"]'::jsonb, 0),
  ('admins',       'Admins',
   '["clock","runway-demand","runway-workbook","vr-projection","results","forge","traffic-lights","demand-score","market-compare","bs-slides","suburb-data","data-map","reports-lite","lite-links","cadence","tenant-summary","arena","arena-typing","arena-chess","arena-scrabble","documents","online-reports","research-reports","present-new","present-company","present-mine","present-library","scorecards"]'::jsonb, 5),
  ('leads',        'Leads',                    '["scorecards"]'::jsonb,               10),
  ('au_advisors',  'Australian Advisors',      '[]'::jsonb,                           20),
  ('au_staff',     'Australian Staffs',        '[]'::jsonb,                           30),
  ('pre_dd_team',  'Pre Due Diligence Team',   '[]'::jsonb,                           40),
  ('pm_team',      'Property Management Team', '["cadence","tenant-summary"]'::jsonb, 50),
  ('ea_team',      'Executive Assistant Team', '[]'::jsonb,                           60),
  ('trust_team',   'Trust Account Team',       '[]'::jsonb,                           70),
  ('finance_team', 'Finance Team',             '[]'::jsonb,                           80),
  ('it_team',      'IT Team',                  '[]'::jsonb,                           90)
on conflict (key) do nothing;

-- ── assignment RPC — dev-only, SECURITY DEFINER (071/072 idiom) ────────────
create or replace function public.set_user_team(target_user uuid, new_team text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.current_tier() is distinct from 'dev' then
    raise exception 'set_user_team: dev only';
  end if;
  if new_team is not null
     and not exists (select 1 from public.hub_groups g where g.key = new_team) then
    raise exception 'set_user_team: unknown group %', new_team;
  end if;
  update public.profiles set team = new_team where id = target_user;
end;
$$;

revoke execute on function public.set_user_team(uuid, text) from public, anon;
grant  execute on function public.set_user_team(uuid, text) to authenticated;

-- ── OPTIONAL HARDENING — delete this block for strictly-zero behavior change
-- Closes a PRE-EXISTING hole: 026's merged "update profiles" policy lets any
-- authenticated user UPDATE their OWN row INCLUDING `tier` (self-escalation
-- to dev flips is_writer()). 079's comment ("never hand them write access to
-- their profile row, where tier lives") shows that was unintended. `team`
-- rides the same table, so guard both:
--   • tier/status changes need is_writer()  (admins keep approve/reject —
--     the only app-code profile updates are ppApproveUser/ppRejectUser)
--   • team changes need dev                 (the Groups panel / RPC path)
--   • auth.uid() null (dashboard SQL editor / service role) bypasses.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then return new; end if;
  if (new.tier is distinct from old.tier or new.status is distinct from old.status)
     and not public.is_writer() then
    raise exception 'profiles: tier/status changes require a writer';
  end if;
  if new.team is distinct from old.team
     and public.current_tier() is distinct from 'dev' then
    raise exception 'profiles: team changes are dev-only';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_profile_privileges on public.profiles;
create trigger trg_guard_profile_privileges
  before update on public.profiles
  for each row execute function public.guard_profile_privileges();
