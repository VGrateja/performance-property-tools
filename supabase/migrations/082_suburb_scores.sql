-- ===========================================================================
-- 082_suburb_scores.sql — Suburb Scoring (Vault tool, tools/suburb-scoring.html)
--
-- Replaces the Looker Studio "Suburbs Scoring Interface" (Google-Sheets-fed).
-- One row per market+kind snapshot: key '<market_slug>-<h|u>' (rdp_regions
-- slugs — melbourne-h, sydney-u, …), payload jsonb =
--   { benchmark:{…GREATER row}, rows:[{suburb,lga,isLga,yield,lt,quality,
--     topPrice,runway,rec,rent0,rent,price0,price,cagrRent,cagrPrice,
--     scoreRent,scorePrice,scoreValue,adjValue,dom,demand}…],
--     scoringRef:[{band,adj,applied}] }
-- 26 rows today (13 markets × house/unit, ~6,000 suburb/LGA rows inside the
-- payloads). Data lands via the in-tool dev/admin drop-zone (the monthly
-- market workbooks; parser = shared/suburb-scoring-parse.js) or the seed
-- script. Mart convention like region_dashboard (049): computed_at/_by set by
-- the writer, NO touch_updated_at trigger (so no updated_by gotcha).
-- RLS: any authenticated user reads; writers (dev/admin) write. Which staff
-- SEE the tool is a hub-groups matter (081) — tool key 'suburb-scoring'.
-- ===========================================================================

create table if not exists public.suburb_scores (
  key          text         primary key,
  market_slug  text         not null,
  kind         text         not null check (kind in ('h','u')),
  label        text         not null,
  payload      jsonb        not null default '{}'::jsonb,
  source_month text,
  computed_at  timestamptz  not null default now(),
  computed_by  uuid         references auth.users (id)
);

create index if not exists suburb_scores_market_idx on public.suburb_scores (market_slug);

alter table public.suburb_scores enable row level security;

drop policy if exists "suburb_scores_sel" on public.suburb_scores;
drop policy if exists "suburb_scores_ins" on public.suburb_scores;
drop policy if exists "suburb_scores_upd" on public.suburb_scores;
drop policy if exists "suburb_scores_del" on public.suburb_scores;

create policy "suburb_scores_sel" on public.suburb_scores
  for select to authenticated using (true);

create policy "suburb_scores_ins" on public.suburb_scores
  for insert to authenticated with check (public.is_writer());

create policy "suburb_scores_upd" on public.suburb_scores
  for update to authenticated
  using (public.is_writer()) with check (public.is_writer());

create policy "suburb_scores_del" on public.suburb_scores
  for delete to authenticated using (public.is_writer());

-- The tool key for the groups system: give assigned Admins the tool out of
-- the box (Van ticks other groups in the panel; unassigned admins/dev see
-- everything regardless). No company_baseline change — Vault tool.
update public.hub_groups
   set tools = tools || '["suburb-scoring"]'::jsonb
 where key = 'admins'
   and not (tools ? 'suburb-scoring');
