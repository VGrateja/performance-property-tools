-- 093_data_extractor_admins_group.sql
--
-- Data Extractor was never granted to any group. Migration 081 seeded the
-- 'admins' group with every tool key that existed AT THAT TIME, and the tool
-- shipped afterwards without the follow-up grant that 082 established for
-- suburb-scoring. Net effect: `data-extractor` sat in NO group at all.
--
-- Who that actually blocked: the allowed set is union(company_baseline, group
-- tools), and dev + UNASSIGNED admins bypass it (they see everything). So the
-- tool was visible to the dev and to the 2 unassigned admins, but hidden from
-- the 3 admins assigned to team='admins' -- both the hub card AND the
-- deep-link bounce in auth-gate.js.
--
-- No company_baseline change: Data Extractor is a Vault tool. Van ticks any
-- other group in the Groups panel.
--
-- (Sibling keys checked at the same time: `arena-skribbl` and
-- `bs-slides-curated` are already in company_baseline, so assigned admins
-- inherit them through the union -- no grant needed here.)

update public.hub_groups
   set tools = tools || '["data-extractor"]'::jsonb
 where key = 'admins'
   and not (tools ? 'data-extractor');
