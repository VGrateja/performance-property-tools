-- ============================================================================
-- 099 — Buyer Agent staff group (Van, 2026-08-10)
--
-- New team row for the Groups & Tools panel. Sort 25 places it with the
-- client-facing teams (right after Australian Advisors). Tools start EMPTY:
-- members see the company baseline until Van ticks tools in the panel —
-- same as every team added since 081 (hub_groups.tools jsonb of registry
-- keys, shared/tool-registry.js).
-- ============================================================================

insert into public.hub_groups (key, name, tools, sort)
values ('buyer_agent', 'Buyer Agent', '[]'::jsonb, 25)
on conflict (key) do nothing;
