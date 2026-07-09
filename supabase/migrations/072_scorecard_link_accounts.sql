-- ============================================================================
-- Migration 072 — roster "linked account" picker for scorecard writers
--
-- Problem: the ⚙ Manage → roster account dropdown reads public.profiles
-- directly. profiles RLS (026) only lets a non-writer read their OWN row, so a
-- 'leads' user (a scorecard writer via 071, but NOT a global is_writer) sees
-- only their own email in the picker and can't link manager/P&C/employee
-- accounts.
--
-- Fix WITHOUT widening the global profiles read policy: a SECURITY DEFINER RPC
-- that returns the linkable account list, but only to a scorecard writer
-- (scorecard_can_write() = dev/admin/leads). Everyone else gets zero rows.
-- Keeps the profiles surface tool-scoped — leads still can't read all profiles
-- anywhere else. The tool calls this instead of selecting profiles directly.
--
-- Requires 071 (scorecard_can_write).
-- ============================================================================

create or replace function public.scorecard_link_accounts()
returns table (id uuid, email text, full_name text, tier text)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.email, p.full_name, p.tier
    from public.profiles p
   where public.scorecard_can_write()      -- gate: non-writers get no rows
   order by p.email;
$$;

revoke execute on function public.scorecard_link_accounts() from public, anon;
grant  execute on function public.scorecard_link_accounts() to authenticated;
