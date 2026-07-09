-- ============================================================================
-- Migration 074 — Manage roster respects card privacy (fix leak from 073)
--
-- 073 locked the dashboard down (a user only sees cards they're linked to; dev
-- sees all), but the ⚙ Manage → Roster list reads through
-- scorecard_roster_admin(), a SECURITY DEFINER RPC that returned the FULL FY
-- roster to ANY writer. So a lead/admin who is NOT linked to a card could still
-- see it (and open it via Edit) in Manage — the exact thing the privacy rule
-- is meant to prevent.
--
-- Narrow the RPC to match the read model:
--   • still writer-only overall (scorecard_can_write) — Manage is dev/admin/leads
--   • dev sees every card
--   • admin/leads see ONLY cards they're linked to (employee / manager / P&C)
--
-- This mirrors the base-table read policy from 073 (dev OR linked), just served
-- through the definer RPC the Manage list already calls, so no client change is
-- needed. Requires 071 (scorecard_can_write) + 073 (roster RPC).
-- ============================================================================

create or replace function public.scorecard_roster_admin(p_fy int)
returns setof public.scorecard_employees
language sql stable security definer set search_path = public, pg_temp as $$
  select e.*
    from public.scorecard_employees e
   where e.fy = p_fy
     and public.scorecard_can_write()
     and (public.current_tier() = 'dev'
          or auth.uid() in (e.employee_user_id, e.manager_user_id, e.pc_user_id))
   order by e.name;
$$;
