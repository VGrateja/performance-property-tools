-- ============================================================================
-- Migration 071 — give the 'leads' tier full write access in Performance
-- Scorecards ONLY.
--
-- Business ask: Leads should have the SAME rights as dev/admin inside the
-- Scorecards tool (add/edit roster, rate KPIs & behaviours, amend locked
-- months, edit config) — but NOWHERE else. Global is_writer() must stay
-- dev/admin (leads is a non-writer everywhere else; RLS on every other tool
-- is unchanged).
--
-- Mechanism: a scorecard-scoped predicate scorecard_can_write() =
-- is_writer() OR current_tier() = 'leads'. The scorecard write policies (066)
-- and scorecard_unsign() are repointed from is_writer() → scorecard_can_write().
-- Nothing global changes, so this cannot widen write access on any other table.
--
-- NOT changed: scorecard_sign() — a signature is always tied to the account
-- actually assigned to that role (no proxy signatures, including dev/admin),
-- so it stays keyed on auth.uid() == the assigned account. Read policies are
-- unchanged (writers already read everything; the scorecard read predicate
-- uses is_writer() which excludes leads, so leads read via the same
-- can-write path — widen the read policies too so a lead sees all rows).
--
-- Requires 066 (scorecards schema + policies) and 068 (leads CHECK).
-- ============================================================================

-- scorecard-scoped writer: dev/admin (global writers) plus leads
create or replace function public.scorecard_can_write() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.is_writer() or public.current_tier() = 'leads', false);
$$;

revoke execute on function public.scorecard_can_write() from public, anon;
grant  execute on function public.scorecard_can_write() to authenticated;

-- ── roster: writers manage; leads now count as writers. Read widened so a
--    lead sees the whole roster (not just rows they're assigned to). ────────
drop policy if exists "scorecard emp read"   on public.scorecard_employees;
drop policy if exists "scorecard emp write"  on public.scorecard_employees;
create policy "scorecard emp read"  on public.scorecard_employees for select to authenticated
  using (public.scorecard_can_write()
         or auth.uid() in (employee_user_id, manager_user_id, pc_user_id));
create policy "scorecard emp write" on public.scorecard_employees for all to authenticated
  using (public.scorecard_can_write()) with check (public.scorecard_can_write());

-- ── config: any participant reads; writers (now incl. leads) manage ────────
drop policy if exists "scorecard cfg write" on public.scorecard_config;
create policy "scorecard cfg write" on public.scorecard_config for all to authenticated
  using (public.scorecard_can_write()) with check (public.scorecard_can_write());

-- ── monthly scorecards: writers + the three assigned accounts; leads write
--    like dev/admin, including amending fully-signed months ───────────────
drop policy if exists "scorecards read"   on public.scorecards;
drop policy if exists "scorecards insert" on public.scorecards;
drop policy if exists "scorecards update" on public.scorecards;
drop policy if exists "scorecards delete" on public.scorecards;
create policy "scorecards read"   on public.scorecards for select to authenticated
  using (public.scorecard_can_write() or public.scorecard_role_uid(employee_id));
create policy "scorecards insert" on public.scorecards for insert to authenticated
  with check (public.scorecard_can_write() or public.scorecard_role_uid(employee_id));
create policy "scorecards update" on public.scorecards for update to authenticated
  using ((public.scorecard_can_write() or public.scorecard_role_uid(employee_id))
         and (public.scorecard_can_write() or not public.scorecard_fully_signed(signoffs)));
create policy "scorecards delete" on public.scorecards for delete to authenticated
  using (public.scorecard_can_write());

-- ── reviews: same shape ────────────────────────────────────────────────────
drop policy if exists "screviews read"   on public.scorecard_reviews;
drop policy if exists "screviews insert" on public.scorecard_reviews;
drop policy if exists "screviews update" on public.scorecard_reviews;
drop policy if exists "screviews delete" on public.scorecard_reviews;
create policy "screviews read"   on public.scorecard_reviews for select to authenticated
  using (public.scorecard_can_write() or public.scorecard_role_uid(employee_id));
create policy "screviews insert" on public.scorecard_reviews for insert to authenticated
  with check (public.scorecard_can_write() or public.scorecard_role_uid(employee_id));
create policy "screviews update" on public.scorecard_reviews for update to authenticated
  using ((public.scorecard_can_write() or public.scorecard_role_uid(employee_id))
         and (public.scorecard_can_write() or not public.scorecard_fully_signed(signoffs)));
create policy "screviews delete" on public.scorecard_reviews for delete to authenticated
  using (public.scorecard_can_write());

-- ── unsign: writers can clear signatures to amend a locked row; leads too ──
create or replace function public.scorecard_unsign(p_kind text, p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.scorecard_can_write() then raise exception 'writers only'; end if;
  if p_kind = 'month' then
    update public.scorecards set signoffs = '{}'::jsonb, updated_at = now(), updated_by = auth.uid() where id = p_id;
  elsif p_kind in ('mid', 'annual') then
    update public.scorecard_reviews set signoffs = '{}'::jsonb, updated_at = now(), updated_by = auth.uid() where id = p_id;
  else
    raise exception 'invalid kind %', p_kind;
  end if;
end;
$$;
