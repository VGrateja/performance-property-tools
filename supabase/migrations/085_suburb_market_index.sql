-- 085_suburb_market_index.sql
-- Lightweight suburb→market index for the Suburb Scoring lobby search.
-- One row per market with the full list of its suburb names (union of house +
-- unit rows), so the lobby can narrow the market tiles by LGA *or* suburb
-- without loading every market's full payload. It's a VIEW over suburb_scores,
-- so it auto-reflects any recompute/re-seed — no backfill or maintenance.
create or replace view public.suburb_market_index
  with (security_invoker = on) as
select
  x.market_slug,
  min(x.label)                              as label,
  array_agg(distinct x.suburb order by x.suburb) as suburbs
from (
  select s.market_slug, s.label, r->>'suburb' as suburb
  from public.suburb_scores s,
       lateral jsonb_array_elements(s.payload->'rows') r
  where coalesce(r->>'suburb','') <> ''
) x
group by x.market_slug;

grant select on public.suburb_market_index to anon, authenticated;
