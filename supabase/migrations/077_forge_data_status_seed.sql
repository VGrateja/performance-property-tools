-- =============================================================================
-- 077_forge_data_status_seed.sql
-- Seed a forge_data_status row for EVERY data_key the pipeline writes, so each
-- one always has a home for health + the "no new data" checked_at stamp (076)
-- even before its first monitored run. Without a row, a point that has never
-- run (or a brand-new key) is simply invisible to the Data Forge status UI and
-- the watchdog — a silent gap instead of a red mark. Real runs overwrite these
-- values; the seed only guarantees the row exists ("on conflict do nothing").
-- Keys/labels/sources mirror what the ingest scripts + workflows upsert today.
-- 053 already seeded 'population' and 'cotality'; monthly-price and the other
-- manual stores carry their freshness on the store row, but the manual points
-- listed at the bottom get status rows so checked_at has somewhere to live.
--
-- NOTE: seeded rows are NOT never-run detection — they carry status 'ok' with
-- last_ok_at NULL, and updated_at is pinned to epoch so the freshness chip
-- shows the honest "stale/no date" state until a real run stamps it (a
-- default-now() updated_at would render never-run points as "current · 0d"
-- for 40 days). The row's job is to exist, for checked_at + error rollups.
-- =============================================================================

-- The old JSA error path recorded under 'internet_vacancies' — no writer of
-- that key remains, so a leftover error row would block the readiness gate
-- forever with nothing able to clear it. Remove it if present.
delete from forge_data_status where data_key = 'internet_vacancies';

insert into forge_data_status (data_key, label, source, status, message, updated_at)
values
  -- ABS ingests (scripts/ingest-abs-*.mjs)
  ('approvals',            'Building Approvals',              'ABS Building Approvals (BA_GCCSA + BA_LGA), Original', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('business',             'Business Investment',             'ABS Private New Capital Expenditure (CAPEX)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('fhb',                  'FHB Dwellings Financed',          'ABS Lending Indicators (LEND_HOUSING)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('inflation',            'Inflation Rate',                  'ABS Consumer Price Index (6401.0)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('lending',              'Lending — Owner Occupier',        'ABS Lending Indicators (LEND_HOUSING)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('investor',             'Lending — Investors',             'ABS Lending Indicators (LEND_HOUSING)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('income',               'Income Data',                     'ABS Average Weekly Earnings (AWE)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('mineral_exploration',  'Mineral Exploration',             'ABS Data API (MIN_EXP — cat 8412.0, Original)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('population',           'Population Data',                 'ABS Data API (ERP_Q / ASGS2021 / ERP_LGA)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('population_pyramid',   'Population Pyramid',              'ABS Data API: ERP_ASGS2021 (national/states/capitals, latest ERP) + C21_G04_LGA (28 regionals, 2021 Census)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('natural_increase',     'Natural Increase',                'ABS National, State & Territory Population (ERP_COMP_Q)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('nim',                  'Net Internal Migration (NIM)',    'ABS National, State & Territory Population (ERP_COMP_Q)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('nom',                  'Net Overseas Migration (NOM)',    'ABS National, State & Territory Population (ERP_COMP_Q)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('retail',               'Retail Turnover',                 'ABS Monthly Household Spending Indicator — Table 19 (5682.0)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('unemployment',         'Unemployment & Underemployment',  'ABS Labour Force (LF/LF_UNDER API + 6291002 GCCSA + MRM1 SA4), Original', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('national_vacancies',   'National Job Vacancies',          'ABS Job Vacancies (6354.0) + JSA IVI', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  -- JSA / FRED / National-Only ingests
  ('job_creation_index',   'Job Creation Index',              'Jobs & Skills Australia — Internet Vacancy Index', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('iron_ore_price',       'Iron Ore Price',                  'FRED PIORECRUSDM (IMF Global price of Iron Ore)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('national_only',        'National Only',                   'ABS CWD + IMF DataMapper + RBA + seeded (Budget/Census)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  -- Commercial-report series (scripts/ingest-abs-commercial.mjs + ingest-rba-commercial.mjs + ingest-rba-rates.mjs)
  ('retail_trade',            'Retail Trade (monthly)',            'ABS Retail Trade 8501.0 (A3348582J: total, current prices, original)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('building_approvals_total','Building Approvals (state totals)', 'ABS Building Approvals BA_GCCSA (Total Residential, by state)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('corporate_bond_yield',    'Corporate Bond Yield',              'RBA F3 (non-financial A-rated 10yr)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('govt_bond_yield',         'Govt Bond Yield (10yr)',            'RBA F2 (Australian Government 10yr bond, daily→month-end; 2013+)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('term_deposit_1y',         'Term Deposit Rate (1yr)',           'RBA F4 (Banks term deposit $10k 1yr)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('cash_rate',               'Cash Rate',                         'RBA cash rate target', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  ('bank_rate',               'Bank Rate',                         'RBA F6 (FLRHOFVA + 0.5pp)', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01'),
  -- Pipeline verdict rows (GitHub workflows)
  ('pipeline_gather',      'GATHER pipeline',    'forge-ingests.yml', 'ok', 'Seeded — awaiting first recorded pipeline run.', '1970-01-01'),
  ('pipeline_publish',     'PUBLISH pipeline',   'forge-publish.yml', 'ok', 'Seeded — awaiting first recorded pipeline run.', '1970-01-01'),
  ('pipeline_watchdog',    'Pipeline watchdog',  'forge-watchdog.yml', 'ok', 'Seeded — awaiting first recorded pipeline run.', '1970-01-01'),
  -- Manual points with no automated ingest (checked_at still needs a row)
  ('arrears',              'Mortgage Arrears',                'S&P SPIN upload', 'ok', 'Manual upload — no automated fetch.', '1970-01-01'),
  ('industry',             'Industry Value Added',            'REMPLAN uploads', 'ok', 'Manual upload — no automated fetch.', '1970-01-01'),
  ('commercial',           'Commercial Report',               'Looker seed + in-Forge edits', 'ok', 'Manual upload — no automated fetch.', '1970-01-01'),
  ('commodity_prices',     'Commodity Prices',                'marketindex seed', 'ok', 'Manual upload — no automated fetch.', '1970-01-01'),
  ('demand_inputs',        'Demand Score Dashboard Data',     'manual + SQM', 'ok', 'Seeded — not yet run via the monitored path.', '1970-01-01')
on conflict (data_key) do nothing;
