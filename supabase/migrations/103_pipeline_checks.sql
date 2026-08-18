-- 103_pipeline_checks.sql
--
-- Research Pipeline tracker (tools/data-architecture.html, rebuilt 2026-08-19
-- as the dev-only monthly-cycle board): most steps are auto-detected from
-- rdp_runs / forge_data_status / the stores themselves, but the human steps
-- ("gather reviewed", "reports spot-checked", quarterly/yearly chores) need a
-- manual tick. One row per monthly cycle ('YYYY-MM') + one rolling 'periodic'
-- row for quarter/year-keyed ticks (infra:2026-Q3, pca:2026-08, ai:2026, …).
--
-- Dev-only both ways: the tool itself is dev-only (like usage-analytics), and
-- nothing else reads this table.

create table public.pipeline_checks (
  cycle      text primary key,                    -- 'YYYY-MM' | 'periodic'
  ticks      jsonb not null default '{}'::jsonb,  -- { key: {done:true, at:iso} }
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)       -- touch_updated_at fills it
);

drop trigger if exists trg_pipeline_checks_updated_at on public.pipeline_checks;
create trigger trg_pipeline_checks_updated_at
  before update on public.pipeline_checks
  for each row execute function public.touch_updated_at();

alter table public.pipeline_checks enable row level security;

create policy "pipeline_checks_dev" on public.pipeline_checks
  for all to authenticated
  using (public.current_tier() = 'dev')
  with check (public.current_tier() = 'dev');
