-- ===========================================================================
-- 107_ir_builder_group_access.sql
--
-- Van's call 2026-08-19: "all who can VIEW the tool can EDIT it — I control
-- who can view." IR Builder access collapses to ONE axis: hub GROUP
-- visibility (the Groups panel tick for 'ir-builder'). Per-person tool_roles
-- grants keep working as an extra path (useful for a one-off outside any
-- group), but are no longer required.
--
-- ir_can_write() is the single predicate behind EVERY IR Builder policy
-- (ir_files / ir_dd_rules / ir_grading_rubric / ir_config / ir_files_audit
-- read / the ir-evidence bucket / ir-library writes) — replacing the function
-- updates the whole permission surface in one move.
-- ===========================================================================

create or replace function public.ir_can_write() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_writer()
      or public.has_tool_role('ir-builder')
      or exists (
        select 1
          from public.profiles p
          join public.hub_groups g on g.key = p.team
         where p.id = auth.uid()
           and g.tools ? 'ir-builder'
      );
$$;

revoke execute on function public.ir_can_write() from public, anon;
grant  execute on function public.ir_can_write() to authenticated;
