-- 087_forge_cl_suburbs_namekey_idx.sql
-- After the historical Market Trends backfill, forge_cl_suburbs grew from one
-- month (~30k rows) to 94 months (~2.4M rows). The Data Extractor pulls a
-- suburb's full time series via `where level='suburb' and name_key in (...)`,
-- which had no supporting index → full-table scan. Index name_key so the
-- suburb pull is fast.
create index if not exists forge_cl_suburbs_namekey_idx
  on public.forge_cl_suburbs (name_key);
