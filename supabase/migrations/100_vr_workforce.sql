-- =============================================================================
-- 100 — Infrastructure workforce modifier (VR Projection)
--
-- The ONE input in the vacancy-rate model with no automated feed: extra people
-- expected in a market from major-project workforces, compiled by hand each
-- quarter and covering only the markets with material project pipelines.
--
-- It lived in shared/vr-workforce.js, but THIS REPO IS PUBLIC and these are
-- internal research figures. Moving them here keeps the numbers behind auth
-- while the code stays open. The rules that consume them are still in the repo;
-- only the values move.
--
-- Read: any authenticated user (the tool needs it to render the toggle).
-- Write: is_writer() — dev/admin, the standard mart idiom.
--
-- NOT A DOUBLE COUNT. The source workbook's IM tab holds G = E + WF; the
-- pipeline stores column E, the WF-free base, so these ADD to it. Anyone
-- re-wiring the IM feed must keep pulling column E — pulling the combined
-- column and adding this table would count the workforce twice.
--
-- The 1.0 multiplier is an OPEN ASSUMPTION: no local-hire, FIFO or
-- camp-accommodation discount is applied, so every project worker is treated
-- as a new resident forming a household at the region's average size.
-- Calibration path: QGSO non-resident population data.
-- =============================================================================

create table if not exists public.vr_workforce (
  region_slug text        primary key,          -- rdp_regions slug, e.g. 'mackay'
  y1          numeric     not null,             -- extra people, forecast year 1
  y2          numeric     not null,             -- extra people, forecast year 2
  note        text,                             -- optional: which projects drive it
  reviewed    text        not null,             -- human review stamp, e.g. 'August 2026'
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

alter table public.vr_workforce enable row level security;

drop policy if exists vr_workforce_read on public.vr_workforce;
create policy vr_workforce_read on public.vr_workforce
  for select to authenticated using (true);

drop policy if exists vr_workforce_write on public.vr_workforce;
create policy vr_workforce_write on public.vr_workforce
  for all to authenticated using (public.is_writer()) with check (public.is_writer());

comment on table public.vr_workforce is
  'Infrastructure workforce modifier for the VR Projection model. Manual, quarterly. Extra PEOPLE (not households) added to internal migration; converted to households at the region average size by the consumer. A market with no row disables the workforce toggle rather than applying a silent zero.';
