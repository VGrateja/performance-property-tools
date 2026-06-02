-- ============================================================================
-- Performance Property — client-side error capture
-- Migration target: Supabase Postgres (project cannojsxduvlewimwoxa)
--
-- WHY
--   This is a no-build static site with (near) a single maintainer — when a
--   tool throws in someone's browser, the only signal today is the user
--   telling you. This table receives uncaught errors + unhandled promise
--   rejections from shared/error-reporter.js so breakage surfaces
--   proactively. Volume is bounded at the source (the reporter dedupes per
--   page-load and caps reports), so this stays small.
--
-- HOW TO APPLY
--   Idempotent — safe to re-run. Paste into the Supabase SQL Editor and Run,
--   or apply through tooling. Matches the file-numbered convention (001–030).
-- ============================================================================

create table if not exists public.client_errors (
  id          bigint       generated always as identity primary key,
  created_at  timestamptz  not null default now(),
  user_id     uuid         references public.profiles(id) on delete set null,
  email       text,                       -- denormalised for quick scanning
  tier        text,                       -- access tier at time of error
  tool        text,                       -- which page (e.g. 'online-reports')
  url         text,                       -- location.pathname + search
  message     text,                       -- error message
  source      text,                       -- script URL / filename
  lineno      int,
  colno       int,
  stack       text,                       -- truncated stack (reporter caps length)
  user_agent  text
);

create index if not exists client_errors_created_idx on public.client_errors (created_at desc);
create index if not exists client_errors_tool_idx    on public.client_errors (tool, created_at desc);


-- ---------------------------------------------------------------------------
-- RLS
--   INSERT: any signed-in user may log their OWN errors (user_id must match
--           auth.uid() so rows can't be spoofed under another account).
--           Anonymous/pre-login errors aren't captured — tool pages are
--           gated behind auth anyway, so by the time JS runs there's a
--           session.
--   SELECT: writers (dev/admin) only — this is an ops feed, not user data.
--   No update/delete policies: the log is append-only from the app's side.
--           Admins prune via the SQL editor / service role when needed.
-- ---------------------------------------------------------------------------
alter table public.client_errors enable row level security;

drop policy if exists "users insert own errors"  on public.client_errors;
drop policy if exists "writers read errors"       on public.client_errors;

create policy "users insert own errors"
  on public.client_errors
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "writers read errors"
  on public.client_errors
  for select to authenticated
  using (public.is_writer());


-- Verify with:
--   select created_at, tool, message, email from public.client_errors
--     order by created_at desc limit 50;
