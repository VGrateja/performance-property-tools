-- 102_investment_reports.sql
--
-- Investment Reports (tools/investment-reports.html): the example-IR library —
-- real settled purchases advisors can pull up as case studies, replacing the
-- hand-maintained "Research & Case Study Links" Google Sheet. One-time seed
-- via scratch/seed-investment-reports.mjs (source = 'seed-2026-08'); the hub
-- and the sheet are deliberately NOT synced — the sheet retires once the tool
-- is polished (Van, 2026-08-18).
--
-- WHY A TABLE AND NOT REPO DATA: rows are real property addresses + purchase
-- prices; the Pages repo is public, so records live behind auth only (same
-- confidentiality model as books / reports_state).
--
-- Governance (Van's call 2026-08-18): any internal staff member can ADD an
-- example — that is what fixes the coverage gaps the sheet documents
-- ("No up to date examples — Email …"). Writers (dev/admin) curate: edit
-- anything, change status, hard-delete. Creators may edit their own rows.

create table public.investment_reports (
  id           uuid primary key default gen_random_uuid(),
  domain       text not null default 'residential'
               check (domain in ('residential','commercial','wholesale')),
  market_slug  text,            -- hub-style slug ('melbourne', 'sunshine-coast', …)
  market_label text not null,   -- display label ('Melbourne', 'Sunshine Coast')
  segment      text not null,   -- house | unit | villa_townhouse | unit_block |
                                -- industrial | medical | office | retail | other | resource
  strategy     text check (strategy in ('foundation','trading')),  -- null = n/a
  budget       numeric,         -- purchase price (or a template's budget band)
  title        text,            -- display title; residential/commercial default to the address
  address      text,
  suburb       text,
  state        text,
  lga          text,
  sold_date    date,            -- month precision is enough — the UI shows "Mon YYYY"
  link_url     text,            -- master file (Google Sheet / Drive PDF)
  notes        text,            -- deal logic / why it's a good example — NEVER client names
  metrics      jsonb not null default '{}'::jsonb,  -- optional {net_yield_pct, gross_yield_pct, discount_pct, …}
  status       text not null default 'current'
               check (status in ('current','stale','retired')),
  source       text not null default 'manual',      -- 'seed-2026-08' = the one-time CSV import
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id) default auth.uid(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id)       -- touch_updated_at fills it (the 041 gotcha)
);

create index investment_reports_browse_idx
  on public.investment_reports (status, market_slug, segment);

drop trigger if exists trg_investment_reports_updated_at on public.investment_reports;
create trigger trg_investment_reports_updated_at
  before update on public.investment_reports
  for each row execute function public.touch_updated_at();

alter table public.investment_reports enable row level security;

-- read: every signed-in user — the hub's GROUP gating decides who sees the
-- tool at all (registry key 'investment-reports'); rows are internal-only data
create policy "ir_read" on public.investment_reports
  for select to authenticated using (true);

-- add: any INTERNAL tier (advisors contribute their own examples; client/guest
-- are dormant externals). created_by must be the caller — the column default
-- supplies it, so clients simply omit the field.
create policy "ir_insert" on public.investment_reports
  for insert to authenticated
  with check (public.current_tier() in ('dev','admin','company')
              and created_by = auth.uid());

-- edit: writers anywhere; everyone else only the rows they created
create policy "ir_update" on public.investment_reports
  for update to authenticated
  using  (public.is_writer() or created_by = auth.uid())
  with check (public.is_writer() or created_by = auth.uid());

-- hard delete: writers only (staff "retire" via status instead)
create policy "ir_delete" on public.investment_reports
  for delete to authenticated using (public.is_writer());
