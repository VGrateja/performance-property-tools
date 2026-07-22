-- 086_rdp_metric_catalog.sql
-- Lightweight catalog of the region-level "data points" for the Data Extractor
-- tool: one row per metric in rdp_raw_series, with its friendly label/unit/
-- category (from rdp_metrics where defined) and coverage (region count + period
-- span). A VIEW so it auto-reflects new metrics — no maintenance.
drop view if exists public.rdp_metric_catalog;
create view public.rdp_metric_catalog
  with (security_invoker = on) as
select
  r.metric                       as code,
  m.label,
  m.unit,
  m.category,
  array_agg(distinct r.freq)     as freqs,
  count(distinct r.region_slug)  as regions,
  min(r.period)                  as first_period,
  max(r.period)                  as last_period
from public.rdp_raw_series r
left join public.rdp_metrics m on m.code = r.metric
group by r.metric, m.label, m.unit, m.category;

grant select on public.rdp_metric_catalog to anon, authenticated;
