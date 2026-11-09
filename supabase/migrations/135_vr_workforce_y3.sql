-- =============================================================================
-- 135 — Infrastructure workforce, a third forecast year (Population Forecast)
--
-- public.vr_workforce (migration 100) holds y1 (FY2025-26) and y2 (FY2026-27).
-- The Population Forecast tool runs to FY2028-29 and reads y3 for FY2027-28
-- when the column exists; until then it leaves that year's workforce out.
--
-- Nullable: a market with no figure for the year stays NULL, which the tool
-- reads as "no workforce". The VR Projection selects region_slug,y1,y2 by
-- name, so it is unaffected.
--
-- NO NUMBERS HERE. This repo is public and the figures are internal research
-- (see 100); the values are written to the table directly, behind auth.
-- Existing grants and RLS (read: authenticated; write: is_writer()) cover the
-- new column.
-- =============================================================================

alter table public.vr_workforce add column if not exists y3 numeric;

comment on column public.vr_workforce.y3 is
  'extra people, forecast year 3 (FY2027-28); NULL = no figure';
