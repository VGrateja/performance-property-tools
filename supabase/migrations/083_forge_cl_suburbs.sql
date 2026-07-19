-- ===========================================================================
-- 083_forge_cl_suburbs.sql — national suburb-level Market Trends store
--
-- Recorded month-by-month from the SAME monthly Cotality/CoreLogic Market
-- Trends .xlsx Van already drops on the Data Forge Cotality card (box ①) —
-- the drop now ALSO extracts all three sheets nationally:
--   Market Trends (Suburbs)        ~30k rows/month  (level='suburb')
--   Market Trends (LGA)            ~1k rows/month   (level='lga')
--   Market Trends (CapitalCities)  ~17 rows/month   (level='capital')
-- ~28 curated metrics per row (medians 12/6/3m, changes, 5/10/20yr CAGRs,
-- percentiles, AVM, stock/listings, DOM, vendor discount, asking rent + rent
-- changes, yields, hold period) keyed by header NAME in the browser parser
-- (data-forge.html CL_SUB_MAP), so column re-ordering never breaks it.
--
-- month = derived from the file's own "Month end" column (Excel serial →
-- YYYY-MM, the 1899-12-30 + round rule). UPSERT-ONLY month-versioned history
-- (preserve-old-data): each drop adds/refreshes its month, never deletes.
-- This is the Forge source feeding Suburb Scoring (Phase-2 engine) and
-- Suburb Selection Data — their own drop-zones retire once cut over.
-- name_key disambiguates duplicate suburb names via postcode.
-- ===========================================================================

create table if not exists public.forge_cl_suburbs (
  month     text  not null,                          -- 'YYYY-MM' from the file's Month end
  level     text  not null check (level in ('suburb','lga','capital')),
  ptype     text  not null check (ptype in ('H','U')),
  state     text  not null,
  name_key  text  not null,                          -- UPPER(name) + '|' + postcode for suburbs
  name      text  not null,
  postcode  text,
  lga       text,                                    -- suburbs only: parent LGA name
  metrics   jsonb not null default '{}'::jsonb,
  uploaded_at timestamptz not null default now(),
  uploaded_by text,
  primary key (month, level, ptype, state, name_key)
);

create index if not exists forge_cl_suburbs_month_idx on public.forge_cl_suburbs (month);
create index if not exists forge_cl_suburbs_lookup_idx on public.forge_cl_suburbs (level, state, ptype);

alter table public.forge_cl_suburbs enable row level security;

drop policy if exists "forge_cl_suburbs_sel" on public.forge_cl_suburbs;
drop policy if exists "forge_cl_suburbs_ins" on public.forge_cl_suburbs;
drop policy if exists "forge_cl_suburbs_upd" on public.forge_cl_suburbs;
drop policy if exists "forge_cl_suburbs_del" on public.forge_cl_suburbs;

create policy "forge_cl_suburbs_sel" on public.forge_cl_suburbs
  for select to authenticated using (true);
create policy "forge_cl_suburbs_ins" on public.forge_cl_suburbs
  for insert to authenticated with check (public.is_writer());
create policy "forge_cl_suburbs_upd" on public.forge_cl_suburbs
  for update to authenticated
  using (public.is_writer()) with check (public.is_writer());
create policy "forge_cl_suburbs_del" on public.forge_cl_suburbs
  for delete to authenticated using (public.is_writer());
