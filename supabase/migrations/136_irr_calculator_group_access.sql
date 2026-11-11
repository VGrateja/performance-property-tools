-- 136: the IRR Calculator opens to everyone who can see it (Van, 2026-11-11:
-- "all who can see that tool will have the same access as us admins ... they
-- can view/edit everything in IRR calcu tool").
--
-- Until now irr_calculator_can_write() was dev/admin or an 'irr-calculator'
-- editor grant, and every policy on irr_book / irr_log / irr_config uses it,
-- READS included (131). The Pre-DD team could open the tool through their
-- hub group but the database handed them an empty register and no sold check.
--
-- Now it also says yes to an internal staff member whose hub group (or the
-- company baseline every staff member gets) includes the 'irr-calculator'
-- tool: the same set the hub uses to show the tool (auth.js
-- ppResolveAllowedTools = union(company_baseline, their group)). Ticking the
-- tool into a group in the Groups panel is now the whole grant; unticking it
-- takes it away. The policies are unchanged — they already call this.
--
-- irr_config (the sold-check sheet's /exec address, a capability) widens with
-- it, deliberately: the sold check needs it, and these are the people who run it.
--
-- Apply with: supabase db query --linked -f supabase/migrations/136_irr_calculator_group_access.sql

create or replace function public.irr_calculator_can_write() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    public.is_writer()
    or public.has_tool_role('irr-calculator', 'editor')
    or exists (
      select 1
      from public.profiles p
      join public.hub_groups g on g.key = p.team or g.key = 'company_baseline'
      where p.id = auth.uid()
        and p.tier in ('dev', 'admin', 'company', 'leads')
        and g.tools ? 'irr-calculator'
    ),
    false);
$$;
