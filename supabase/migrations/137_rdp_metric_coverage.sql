-- 137_rdp_metric_coverage.sql
-- Per-market coverage of the market-level data points, for the Data Extractor:
-- one row per (region, metric) in rdp_raw_series, with the frequencies it is
-- recorded at and its period span.
--
-- Why: rdp_metric_catalog (086) says how MANY regions a metric covers, not
-- WHICH. So the Extractor offered all ~170 data points for any market, and a
-- user could tick a national-only series (cash rate), a port or a JLL precinct
-- series against Ballarat and get an empty column. Reading this view for the
-- markets a user has picked, the tool only offers what those markets have.
--
-- A VIEW, so it follows the data with no upkeep. security_invoker keeps
-- rdp_raw_series' own RLS (authenticated read) in charge of the rows.
create or replace view public.rdp_metric_coverage
  with (security_invoker = on) as
select
  r.region_slug,
  r.metric,
  array_agg(distinct r.freq) as freqs,
  min(r.period)              as first_period,
  max(r.period)              as last_period,
  count(*)                   as points
from public.rdp_raw_series r
group by r.region_slug, r.metric;

-- New objects in public get no Data API grants by default (Supabase, 2026-10-30).
grant select on public.rdp_metric_coverage to authenticated;
