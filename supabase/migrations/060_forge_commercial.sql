-- =============================================================================
-- 060_forge_commercial.sql — Data Forge store for the COMMERCIAL report.
--
-- The Commercial report (commercial-report.html) reads every grid tab of the
-- "Commercial Report Data for Looker" workbook. Most of its 17 charts are
-- commercial-specific series Forge has never carried (cap-rate/vacancy, govt &
-- corporate bonds, term deposits, building price indices, freight, health, WFH,
-- e-commerce, risk/return) — and roughly half come from manual / subscription
-- sources (CBRE/Colliers/Savills/Knight Frank, Statista, port authorities,
-- budget papers) with no clean public API.
--
-- So this is a single jsonb snapshot of the report's actual source, keyed by
-- slugified tab → { column: [values] }, exactly the shape the report's feed
-- returns. Seeded by scripts/seed-commercial.mjs from the Looker workbook;
-- individual time-series (PPI, bonds, term deposits, retail, approvals,
-- population) can later be upgraded to clean API refreshes in rdp_raw_series.
--
-- Mirrors forge_national_only: single 'latest' row, authenticated read,
-- is_writer() write. ISOLATED from the live tools.
-- =============================================================================
create table if not exists forge_commercial (
  id          text primary key default 'latest',
  data        jsonb not null,
  uploaded_at timestamptz default now(),
  uploaded_by text,
  updated_at  timestamptz default now()
);

alter table forge_commercial enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'forge_commercial' and policyname = 'forge_commercial_read') then
    create policy forge_commercial_read on forge_commercial for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'forge_commercial' and policyname = 'forge_commercial_write') then
    create policy forge_commercial_write on forge_commercial for all to authenticated using (is_writer()) with check (is_writer());
  end if;
end $$;
