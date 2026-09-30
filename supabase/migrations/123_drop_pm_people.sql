-- 123_drop_pm_people.sql — the retired PM (Cadence, Tenant Application Summary) and
-- People & Culture (Performance Scorecards) tools leave the database.
--
-- The three tools left the hub on 2026-08-24 (index.html, registry, cron, Edge
-- Functions); the pages and data were kept until Van asked for the complete
-- deletion on 2026-09-30. Rows were exported to a local, gitignored backup first
-- (scratch/retired-pm-people-backup-2026-09-30/ — tenant PII, keep local).
--
-- Kept on purpose: public.is_staff() — created by 009 but used by runway_snapshots
-- (015) and other policies. is_team_lead() was Cadence-only and goes.
-- Re-runnable: everything is "if exists".

begin;

-- ── tables (cascade drops their policies, triggers, indexes and publication membership) ──
drop table if exists public.cadence_card_history   cascade;
drop table if exists public.cadence_assignees      cascade;
drop table if exists public.cadence_cards          cascade;
drop table if exists public.cadence_boards         cascade;
drop table if exists public.scorecard_notify_log   cascade;
drop table if exists public.scorecard_reviews      cascade;
drop table if exists public.scorecards             cascade;
drop table if exists public.scorecard_employees    cascade;
drop table if exists public.scorecard_config       cascade;
drop table if exists public.pm_tenant_applications cascade;

-- ── functions (every overload, whatever the signature) ──
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'touch_cadence_boards', 'touch_cadence_cards', 'log_cadence_card_change', 'is_team_lead',
        'pm_tenant_applications_touch',
        'scorecard_fully_signed', 'scorecard_role_uid', 'scorecard_sign', 'scorecard_unsign',
        'scorecard_can_write', 'scorecard_link_accounts', 'scorecard_roster_admin'
      )
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

-- ── access rows that still name the retired tool keys ──
update public.hub_groups
   set tools = (tools - 'cadence') - 'tenant-summary' - 'scorecards'
 where tools ?| array['cadence', 'tenant-summary', 'scorecards'];

delete from public.tool_roles where tool_key in ('cadence', 'tenant-summary', 'scorecards');

commit;
