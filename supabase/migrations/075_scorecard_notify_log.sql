-- ============================================================================
-- Migration 075 — scorecard reminder de-dupe log
--
-- The monthly scorecard reminder job (scripts/scorecard-reminders.mjs, run by
-- the scorecard-reminders GitHub Actions workflow) emails each party when their
-- section is still incomplete:
--   • Employee  — 3rd (first) + 5th midday (final)
--   • P&C       — 8th (first) + 10th midday (final)
--   • AU Manager— 13th (first) + 15th midday (final)
-- (all AEST/AEDT). This table records what has already been sent so a party is
-- never emailed twice for the same month/role/phase — the cron runs several
-- times across the send window (to survive GitHub's timing drift + AU DST), so
-- idempotency is essential.
--
-- Keyed on employee_id (the roster row), not scorecards.id, because a scorecard
-- row may not exist yet when the first reminder fires (nothing filled).
--
-- Written ONLY by the service-role reminder job; not read/written by the tool.
-- ============================================================================

create table if not exists public.scorecard_notify_log (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.scorecard_employees (id) on delete cascade,
  ym          text not null,                                   -- '2026-07'
  role        text not null check (role in ('employee', 'pc', 'manager')),
  phase       text not null check (phase in ('first', 'final')),
  sent_at     timestamptz not null default now(),
  unique (employee_id, ym, role, phase)
);

create index if not exists scorecard_notify_log_ym_idx on public.scorecard_notify_log (ym);

alter table public.scorecard_notify_log enable row level security;

-- No policies: the reminder job uses the service-role key (bypasses RLS). No
-- client/tool code touches this table, so authenticated users get nothing —
-- fail-closed. (A writer read policy can be added later if you want to inspect
-- it from a tool; not needed for the job to work.)
