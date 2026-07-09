-- ============================================================================
-- Migration 073 — Scorecards are private: you only see a card you're linked to
--
-- Performance reviews are sensitive. New rule: a user sees a scorecard ONLY if
-- their account is one of the three linked roles on that employee row
-- (employee / AU manager / P&C). The one exception is dev (Vandolf) — full
-- oversight for administration + testing.
--
-- Before this: the scorecard read policies were `scorecard_can_write() OR
-- scorecard_role_uid(...)`, so every writer tier (dev/admin/leads, migration
-- 071) could read EVERY card. That over-exposed admin & leads. This migration
-- drops scorecard_can_write() from the READ paths and gates them on
-- `current_tier()='dev' OR <linked>` instead.
--
-- Writers (dev/admin/leads) keep their ADMIN powers — create/edit the roster,
-- edit config, link accounts — because those still run through
-- scorecard_can_write() on the write policies and the Manage RPCs. But the
-- Manage roster list needs to see every employee even though the new read
-- policy hides non-linked rows, so a SECURITY DEFINER RPC
-- (scorecard_roster_admin) returns the full roster to writers only.
--
-- IMPORTANT: the old scorecard_employees write policy was `for all`, which also
-- granted SELECT to any writer — that would defeat the read restriction (OR'd
-- permissive policies). So the roster policy is split into explicit
-- insert/update/delete, leaving SELECT solely to the new read policy.
--
-- Requires 066 (schema + role/fully-signed helpers) and 071 (scorecard_can_write).
-- ============================================================================

-- ── roster (scorecard_employees) ──────────────────────────────────────────
-- SELECT: dev sees all; everyone else only rows they're linked to.
-- Writes stay writer-gated but are split out so they DON'T re-grant SELECT.
drop policy if exists "scorecard emp read"    on public.scorecard_employees;
drop policy if exists "scorecard emp write"   on public.scorecard_employees;
drop policy if exists "scorecard emp insert"  on public.scorecard_employees;
drop policy if exists "scorecard emp update"  on public.scorecard_employees;
drop policy if exists "scorecard emp delete"  on public.scorecard_employees;
create policy "scorecard emp read" on public.scorecard_employees for select to authenticated
  using (public.current_tier() = 'dev'
         or auth.uid() in (employee_user_id, manager_user_id, pc_user_id));
create policy "scorecard emp insert" on public.scorecard_employees for insert to authenticated
  with check (public.scorecard_can_write());
create policy "scorecard emp update" on public.scorecard_employees for update to authenticated
  using (public.scorecard_can_write()) with check (public.scorecard_can_write());
create policy "scorecard emp delete" on public.scorecard_employees for delete to authenticated
  using (public.scorecard_can_write());

-- ── monthly scorecards ─────────────────────────────────────────────────────
-- read/insert/update limited to dev or the three linked accounts; a linked
-- role edits until the card is fully signed (dev may still amend). delete stays
-- writer-only (admin cleanup; the employee-delete cascade handles the rest).
drop policy if exists "scorecards read"   on public.scorecards;
drop policy if exists "scorecards insert" on public.scorecards;
drop policy if exists "scorecards update" on public.scorecards;
drop policy if exists "scorecards delete" on public.scorecards;
create policy "scorecards read"   on public.scorecards for select to authenticated
  using (public.current_tier() = 'dev' or public.scorecard_role_uid(employee_id));
create policy "scorecards insert" on public.scorecards for insert to authenticated
  with check (public.current_tier() = 'dev' or public.scorecard_role_uid(employee_id));
create policy "scorecards update" on public.scorecards for update to authenticated
  using ((public.current_tier() = 'dev' or public.scorecard_role_uid(employee_id))
         and (public.current_tier() = 'dev' or not public.scorecard_fully_signed(signoffs)))
  with check (public.current_tier() = 'dev' or public.scorecard_role_uid(employee_id));
create policy "scorecards delete" on public.scorecards for delete to authenticated
  using (public.scorecard_can_write());

-- ── mid-year + annual reviews: same shape ──────────────────────────────────
drop policy if exists "screviews read"   on public.scorecard_reviews;
drop policy if exists "screviews insert" on public.scorecard_reviews;
drop policy if exists "screviews update" on public.scorecard_reviews;
drop policy if exists "screviews delete" on public.scorecard_reviews;
create policy "screviews read"   on public.scorecard_reviews for select to authenticated
  using (public.current_tier() = 'dev' or public.scorecard_role_uid(employee_id));
create policy "screviews insert" on public.scorecard_reviews for insert to authenticated
  with check (public.current_tier() = 'dev' or public.scorecard_role_uid(employee_id));
create policy "screviews update" on public.scorecard_reviews for update to authenticated
  using ((public.current_tier() = 'dev' or public.scorecard_role_uid(employee_id))
         and (public.current_tier() = 'dev' or not public.scorecard_fully_signed(signoffs)))
  with check (public.current_tier() = 'dev' or public.scorecard_role_uid(employee_id));
create policy "screviews delete" on public.scorecard_reviews for delete to authenticated
  using (public.scorecard_can_write());

-- ── Manage roster list — full roster for writers (bypasses the read policy) ─
-- The Manage modal needs every employee for the FY; the read policy above now
-- hides non-linked rows even from writers, so serve the admin list via a
-- SECURITY DEFINER RPC gated on scorecard_can_write().
create or replace function public.scorecard_roster_admin(p_fy int)
returns setof public.scorecard_employees
language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.scorecard_employees
   where public.scorecard_can_write() and fy = p_fy
   order by name;
$$;

revoke execute on function public.scorecard_roster_admin(int) from public, anon;
grant  execute on function public.scorecard_roster_admin(int) to authenticated;
