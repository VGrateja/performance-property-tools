-- ============================================================
-- 066 — Performance Scorecards (Vault tool: tools/scorecards.html)
-- Digitises the monthly KPI scorecard workbook (per-employee FY
-- Jul→Jun): monthly KPI + behaviour ratings, weighted score,
-- mid-year + annual reviews, and click-to-sign 3-party sign-off
-- (AU line manager · P&C manager · employee), each signature
-- recorded against the signed-in account via SECURITY DEFINER RPC.
--
-- Access model (RLS):
--   · dev/admin (is_writer)      → full read/write on everything
--   · assigned manager / P&C /
--     employee accounts          → read their employee's rows;
--                                  update ratings until fully signed
--   · everyone else              → nothing
-- Field-level who-edits-what (manager rates KPIs, employee
-- self-assesses, P&C rates behaviours) is enforced by the tool UI;
-- signature authenticity is enforced HERE (scorecard_sign checks
-- auth.uid() against the assigned account).
-- ============================================================

-- ── Roster: one row per employee per financial year ──────────
create table if not exists public.scorecard_employees (
  id               uuid primary key default gen_random_uuid(),
  fy               int  not null,                 -- 2026 = FY Jul 2026 – Jun 2027
  name             text not null,
  position         text not null default '',
  manager_name     text not null default '',      -- display names (shown on the card
  pc_name          text not null default '',      --   even when no account is linked)
  employee_user_id uuid references auth.users (id) on delete set null,
  manager_user_id  uuid references auth.users (id) on delete set null,
  pc_user_id       uuid references auth.users (id) on delete set null,
  kpis             jsonb not null default '[]',   -- [{measure, target}] — per-employee, per-FY
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (fy, name)
);

-- ── Global config (weights, rating bands, company behaviours) ─
create table if not exists public.scorecard_config (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- ── Monthly scorecards ────────────────────────────────────────
create table if not exists public.scorecards (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.scorecard_employees (id) on delete cascade,
  ym          text not null,                      -- '2026-07'
  data        jsonb not null default '{}',        -- {kpis:[{actual,achieved,notes}], behaviours:[{self,achieved,notes}], comments}
  signoffs    jsonb not null default '{}',        -- {manager:{uid,name,at}, pc:{…}, employee:{…}}
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  unique (employee_id, ym)
);

-- ── Mid-year + annual reviews ─────────────────────────────────
create table if not exists public.scorecard_reviews (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.scorecard_employees (id) on delete cascade,
  kind        text not null check (kind in ('mid', 'annual')),
  data        jsonb not null default '{}',        -- review text fields + concern/PIP/salary flags
  signoffs    jsonb not null default '{}',
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  unique (employee_id, kind)
);

alter table public.scorecard_employees enable row level security;
alter table public.scorecard_config    enable row level security;
alter table public.scorecards          enable row level security;
alter table public.scorecard_reviews   enable row level security;

-- uid is one of the three assigned accounts on an employee row
create or replace function public.scorecard_role_uid(emp_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.scorecard_employees e
    where e.id = emp_id
      and auth.uid() in (e.employee_user_id, e.manager_user_id, e.pc_user_id)
  );
$$;

-- a scorecard/review row is locked once all three parties have signed
create or replace function public.scorecard_fully_signed(s jsonb) returns boolean
language sql immutable as $$
  select (s ? 'manager') and (s ? 'pc') and (s ? 'employee');
$$;

-- roster: participants read their own row; writers manage
drop policy if exists "scorecard emp read"   on public.scorecard_employees;
drop policy if exists "scorecard emp write"  on public.scorecard_employees;
create policy "scorecard emp read"  on public.scorecard_employees for select to authenticated
  using (public.is_writer()
         or auth.uid() in (employee_user_id, manager_user_id, pc_user_id));
create policy "scorecard emp write" on public.scorecard_employees for all to authenticated
  using (public.is_writer()) with check (public.is_writer());

-- config: any participant can read; writers manage
drop policy if exists "scorecard cfg read"  on public.scorecard_config;
drop policy if exists "scorecard cfg write" on public.scorecard_config;
create policy "scorecard cfg read"  on public.scorecard_config for select to authenticated using (true);
create policy "scorecard cfg write" on public.scorecard_config for all to authenticated
  using (public.is_writer()) with check (public.is_writer());

-- monthly scorecards: writers + the three assigned accounts; rating
-- edits stop once fully signed (writers may still amend)
drop policy if exists "scorecards read"   on public.scorecards;
drop policy if exists "scorecards insert" on public.scorecards;
drop policy if exists "scorecards update" on public.scorecards;
drop policy if exists "scorecards delete" on public.scorecards;
create policy "scorecards read"   on public.scorecards for select to authenticated
  using (public.is_writer() or public.scorecard_role_uid(employee_id));
create policy "scorecards insert" on public.scorecards for insert to authenticated
  with check (public.is_writer() or public.scorecard_role_uid(employee_id));
create policy "scorecards update" on public.scorecards for update to authenticated
  using ((public.is_writer() or public.scorecard_role_uid(employee_id))
         and (public.is_writer() or not public.scorecard_fully_signed(signoffs)));
create policy "scorecards delete" on public.scorecards for delete to authenticated
  using (public.is_writer());

-- reviews: same shape
drop policy if exists "screviews read"   on public.scorecard_reviews;
drop policy if exists "screviews insert" on public.scorecard_reviews;
drop policy if exists "screviews update" on public.scorecard_reviews;
drop policy if exists "screviews delete" on public.scorecard_reviews;
create policy "screviews read"   on public.scorecard_reviews for select to authenticated
  using (public.is_writer() or public.scorecard_role_uid(employee_id));
create policy "screviews insert" on public.scorecard_reviews for insert to authenticated
  with check (public.is_writer() or public.scorecard_role_uid(employee_id));
create policy "screviews update" on public.scorecard_reviews for update to authenticated
  using ((public.is_writer() or public.scorecard_role_uid(employee_id))
         and (public.is_writer() or not public.scorecard_fully_signed(signoffs)));
create policy "screviews delete" on public.scorecard_reviews for delete to authenticated
  using (public.is_writer());

-- ── Sign-off RPC — the ONLY way a signature is written ────────
-- Requires the caller to be signed in as the account assigned to
-- that role on the employee row (no proxy signatures, including
-- dev/admin). Stamps {uid, name, at} into signoffs->role.
create or replace function public.scorecard_sign(p_kind text, p_id uuid, p_role text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_emp   uuid;
  v_sign  jsonb;
  v_want  uuid;
  v_name  text;
begin
  if p_role not in ('manager', 'pc', 'employee') then
    raise exception 'invalid role %', p_role;
  end if;
  if p_kind = 'month' then
    select employee_id, signoffs into v_emp, v_sign from public.scorecards where id = p_id;
  elsif p_kind in ('mid', 'annual') then
    select employee_id, signoffs into v_emp, v_sign from public.scorecard_reviews where id = p_id;
  else
    raise exception 'invalid kind %', p_kind;
  end if;
  if v_emp is null then raise exception 'row not found'; end if;

  select case p_role when 'manager' then manager_user_id
                     when 'pc'      then pc_user_id
                     else                employee_user_id end
    into v_want from public.scorecard_employees where id = v_emp;
  if v_want is null then
    raise exception 'no account linked for the % role — link one in the roster first', p_role;
  end if;
  if auth.uid() is distinct from v_want then
    raise exception 'you are not signed in as the % for this scorecard', p_role;
  end if;

  select coalesce(nullif(full_name, ''), email) into v_name from public.profiles where id = auth.uid();
  v_sign := coalesce(v_sign, '{}'::jsonb)
            || jsonb_build_object(p_role, jsonb_build_object('uid', auth.uid(), 'name', v_name, 'at', now()));

  if p_kind = 'month' then
    update public.scorecards set signoffs = v_sign, updated_at = now(), updated_by = auth.uid() where id = p_id;
  else
    update public.scorecard_reviews set signoffs = v_sign, updated_at = now(), updated_by = auth.uid() where id = p_id;
  end if;
  return v_sign;
end;
$$;

-- writers can clear signatures (e.g. to amend a locked month)
create or replace function public.scorecard_unsign(p_kind text, p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_writer() then raise exception 'writers only'; end if;
  if p_kind = 'month' then
    update public.scorecards set signoffs = '{}'::jsonb, updated_at = now(), updated_by = auth.uid() where id = p_id;
  elsif p_kind in ('mid', 'annual') then
    update public.scorecard_reviews set signoffs = '{}'::jsonb, updated_at = now(), updated_by = auth.uid() where id = p_id;
  else
    raise exception 'invalid kind %', p_kind;
  end if;
end;
$$;

grant execute on function public.scorecard_sign(text, uuid, text) to authenticated;
grant execute on function public.scorecard_unsign(text, uuid)     to authenticated;

-- ── Default config (weights + bands from the workbook; the bands
--    are editable in the tool, matching the margin notes that they
--    may move to 90/70) ──────────────────────────────────────────
insert into public.scorecard_config (id, data) values (1, '{
  "weights": { "kpi": 0.7, "beh": 0.3 },
  "bands": [
    { "min": 85, "label": "Exceeds Expectations",      "short": "Exceeds",    "level": 4, "color": "#34d399" },
    { "min": 65, "label": "Meets Expectations",        "short": "Meets",      "level": 3, "color": "#22d3ee" },
    { "min": 40, "label": "Developing",                "short": "Developing", "level": 2, "color": "#f59e0b" },
    { "min": 0,  "label": "Does Not Meet Expectations","short": "Below",      "level": 1, "color": "#fb7185" }
  ],
  "behaviours": [
    { "measure": "Consistently demonstrates behaviours aligned with Performance Property''s Culture Statement.", "target": "Always" },
    { "measure": "Ensure meticulous record-keeping and file management across all platforms, ensuring 0% breach of compliance obligations.", "target": "Always" },
    { "measure": "Acknowledge, understand, and abide by all company policies, procedures and guidelines.", "target": "Always" }
  ]
}'::jsonb)
on conflict (id) do nothing;
