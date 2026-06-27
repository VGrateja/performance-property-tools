-- =============================================================================
-- 052_runway_config.sql
--
-- Config store for the runway calculator, lifted out of the Runway Workbook
-- Google Sheet so the runway can be computed entirely from the DB (and the
-- sheet retired). Small key-value table:
--   'rates'        -> { current:{cash,variable_base,apra,rate}, forecast:{cash,margin,apra,rate} }
--   'wage_growth'  -> { regional, capital, years }
--   'ai_ceiling'   -> { "<region>": { h, u } }   per-region affordability ceilings
--
-- Part of the isolated rdp_* namespace. RLS: authenticated read; writers write.
-- Run after 050. Re-runnable.
-- =============================================================================
create table if not exists public.rdp_runway_config (
  key        text primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  updated_by uuid        references auth.users
);
comment on table public.rdp_runway_config is
  'Runway calculator config (rates / wage-growth / per-region AI ceilings), lifted from the Runway Workbook so runway is DB-native and the sheet can be retired.';

alter table public.rdp_runway_config enable row level security;

drop policy if exists "rdp_runway_config_sel" on public.rdp_runway_config;
create policy "rdp_runway_config_sel" on public.rdp_runway_config for select to authenticated using (true);
drop policy if exists "rdp_runway_config_ins" on public.rdp_runway_config;
create policy "rdp_runway_config_ins" on public.rdp_runway_config for insert to authenticated with check (public.is_writer());
drop policy if exists "rdp_runway_config_upd" on public.rdp_runway_config;
create policy "rdp_runway_config_upd" on public.rdp_runway_config for update to authenticated using (public.is_writer()) with check (public.is_writer());

grant select, insert, update on public.rdp_runway_config to authenticated;
