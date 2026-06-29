-- =============================================================================
-- 058_forge_national_only.sql
-- "National Only" data point for Data Forge — the National Online Report's
-- national-level series, gathered into one card. Single jsonb row (id='latest'),
-- assembled by scripts/ingest-national-only.mjs from several sources:
--   • Value of Work Done (public/private) ........ ABS CWD (API)
--   • Govt Debt-to-GDP (Australia) ............... IMF DataMapper GGXWDG_NGDP (API, gross)
--   • Household debt-to-income ................... RBA E2 series BHFDDIT (API)
--   • Nominal GDP & debt-to-GDP by country ....... IMF DataMapper NGDPD + GGXWDG_NGDP (API)
--   • Cash Rate .................................. RBA (already in rdp_raw_series)
--   • Federal Budget (underlying cash balance) ... Treasury Budget papers (SEEDED — no API)
--   • Household composition by type .............. ABS Census (SEEDED — 5-yearly)
-- Isolated, writer-only write — same pattern as forge_industry / forge_arrears.
-- =============================================================================

create table if not exists forge_national_only (
  id          text primary key default 'latest',
  data        jsonb not null,
  uploaded_at timestamptz default now(),
  uploaded_by text,
  updated_at  timestamptz default now()
);

alter table forge_national_only enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'forge_national_only' and policyname = 'forge_national_only_read') then
    create policy forge_national_only_read on forge_national_only for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'forge_national_only' and policyname = 'forge_national_only_write') then
    create policy forge_national_only_write on forge_national_only for all to authenticated using (is_writer()) with check (is_writer());
  end if;
end $$;
