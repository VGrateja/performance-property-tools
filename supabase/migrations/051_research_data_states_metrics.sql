-- =============================================================================
-- 051_research_data_states_metrics.sql
--
-- Dimension top-up for the P1 ingestion: adds STATE-level region rows (the
-- macro / income / population data is reported at national, state AND city
-- level) plus the extra metric vocabulary the ingestion emits (CLRent vacancy
-- by H/U, Approvals dwelling commencements, underemployment).
--
-- Pure idempotent inserts into the tables from migration 050 — no DDL, no RLS
-- changes. rdp_raw_series does NOT FK to these, so ingestion works without it;
-- this just keeps the dimension tables complete. Run after 050. Re-runnable.
-- =============================================================================

insert into public.rdp_regions (slug, name, state, cluster, sort) values
  ('st-nsw','New South Wales','NSW','state',100),
  ('st-vic','Victoria','VIC','state',101),
  ('st-qld','Queensland','QLD','state',102),
  ('st-wa','Western Australia','WA','state',103),
  ('st-sa','South Australia','SA','state',104),
  ('st-tas','Tasmania','TAS','state',105),
  ('st-nt','Northern Territory','NT','state',106),
  ('st-act','Australian Capital Territory','ACT','state',107)
on conflict (slug) do nothing;

insert into public.rdp_metrics (code, label, unit, category, property_type) values
  ('vacancy_rate_h','Vacancy Rate — House','pct','rent','H'),
  ('vacancy_rate_u','Vacancy Rate — Unit','pct','rent','U'),
  ('commenced_h','Dwelling Commencements — House','count','supply','H'),
  ('commenced_u','Dwelling Commencements — Unit','count','supply','U'),
  ('underemployment','Underemployment Rate','pct','economy',null)
on conflict (code) do nothing;
