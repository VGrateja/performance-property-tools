-- ===========================================================================
-- 084_forge_replacement_cost.sql — Replacement Cost data point (Data Forge)
--
-- The "Discount to Replacement Cost" model from the research team's
-- REPLACEMENT COST TEMPLATE workbooks (one per region, e.g. ADELAIDE):
--   replacement cost = land cost (400sqm × outer-band $/sqm from recent
--   vacant-land sales) + build cost (ABS state avg completed-home cost
--   chained by the quarterly construction cost index, + 5% other costs);
--   compared against the Comparable new-build MHP (recent sales hand-tagged
--   Inferior / Comparable / Superior) → discount/premium to buy established.
--
-- One row per region per data month (upsert-only history, Forge convention —
-- re-saving a month refreshes it, never deletes others). payload jsonb =
--   { land:  { lotSize, band, sales:[{date,suburb,band,sqm,price,url}…],
--              bands:{inner|middle|outer:{n,sqm,price,perSqm,cost}}, cost },
--     build: { state, baseFrom:'2019-20', baseTo:'2023-24', baseCost,
--              chain:[{q:'2024Q1',pct}…], chained, otherPct, other, cost },
--     comps: { sales:[{url,date,price,quality,land,notes}…],
--              avgs:{inferior,comparable,superior}, mhp },
--     summary: { landCost, buildCost, replacementCost, comparableMhp,
--                discount, pctDiscount /* SIGNED (mhp−rc)/rc: negative =
--                established cheaper than rebuilding */, medPrice,
--                medAdjusted }, notes }
-- Data lands via the Replacement Cost card in tools/data-forge.html
-- (RP Data CSV drop / manual entry / filled-workbook ingest).
-- Mart convention like suburb_scores (082): computed_at/_by set by the
-- writer, NO touch_updated_at trigger. RLS: authenticated read, writer write.
-- ===========================================================================

create table if not exists public.forge_replacement_cost (
  region_slug text         not null,
  as_of       text         not null,   -- data month 'YYYY-MM'
  payload     jsonb        not null default '{}'::jsonb,
  computed_at timestamptz  not null default now(),
  computed_by uuid         references auth.users (id),
  primary key (region_slug, as_of)
);

create index if not exists forge_replacement_cost_asof_idx
  on public.forge_replacement_cost (as_of);

alter table public.forge_replacement_cost enable row level security;

drop policy if exists "forge_replacement_cost_sel" on public.forge_replacement_cost;
drop policy if exists "forge_replacement_cost_ins" on public.forge_replacement_cost;
drop policy if exists "forge_replacement_cost_upd" on public.forge_replacement_cost;
drop policy if exists "forge_replacement_cost_del" on public.forge_replacement_cost;

create policy "forge_replacement_cost_sel" on public.forge_replacement_cost
  for select to authenticated using (true);

create policy "forge_replacement_cost_ins" on public.forge_replacement_cost
  for insert to authenticated with check (public.is_writer());

create policy "forge_replacement_cost_upd" on public.forge_replacement_cost
  for update to authenticated
  using (public.is_writer()) with check (public.is_writer());

create policy "forge_replacement_cost_del" on public.forge_replacement_cost
  for delete to authenticated using (public.is_writer());
