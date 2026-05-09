-- =============================================================================
-- 003_arena.sql — Performance Property Arena
--
-- The Arena hosts staff entertainment games. First game: a monkeytype-style
-- typing test. Each completed run inserts one row here; the page pulls
-- per-user history (own scores) and the leaderboard (top scores per mode +
-- word list). Schema is per-row (not the single-row JSONB pattern used by
-- clock_state / presentation_state) because we want indexed leaderboard
-- queries and per-user history out of the box.
--
-- RLS:
--   - Authenticated users can SELECT every row (so the leaderboard works
--     for everyone — same UX intent as a public scoreboard).
--   - Authenticated users can INSERT only rows where user_id = auth.uid()
--     (so nobody can pad someone else's stats).
--   - Writers (dev/admin) can DELETE — useful for clearing a bad / spammy
--     entry. Regular users can't delete their own rows on purpose; the
--     leaderboard is more interesting if everyone's stuck with their honest
--     best, not just their cherry-picked top run.
--
-- Run order: after 002_*.sql.
-- =============================================================================

create table if not exists public.arena_typing_scores (
  id              bigserial    primary key,
  user_id         uuid         not null references public.profiles(id) on delete cascade,
  -- Denormalised display fields — copied from the user's session/profile
  -- at insert time so the leaderboard can render player names without
  -- joining public.profiles. The profiles RLS only lets non-writers read
  -- their OWN row, so a tier-2/3/4 reader joining the table would see
  -- nulls for everyone else's name. Keeping a snapshot also matches the
  -- "scores are immutable historical records" mental model — your name
  -- on the board reflects who you were when you typed it.
  player_email    text         not null,
  player_name     text,
  wpm             int          not null check (wpm         between 0 and 400),
  raw_wpm         int                   check (raw_wpm     between 0 and 600),
  accuracy        numeric(5,2) not null check (accuracy    between 0 and 100),
  consistency     numeric(5,2)          check (consistency between 0 and 100),
  -- mode_seconds + word_list are bounded sets in the UI — locking them
  -- at the DB level prevents a crafted client from polluting leaderboard
  -- groupings with junk modes. Add new values to both the UI and this
  -- check constraint together.
  mode_seconds    int          not null check (mode_seconds in (15, 30, 60)),
  word_list       text         not null check (word_list   in ('english', 'real-estate', 'code')),
  chars_correct   int                   check (chars_correct   >= 0),
  chars_incorrect int                   check (chars_incorrect >= 0),
  duration_ms     int                   check (duration_ms     >= 0),
  completed_at    timestamptz  not null default now(),
  created_at      timestamptz  not null default now()
);

-- Per-user history lookups (recent runs, best WPM by user).
create index if not exists arena_typing_scores_user_idx
  on public.arena_typing_scores (user_id, completed_at desc);

-- Leaderboard lookups: top WPM filtered by mode + word_list. Ordering on
-- (mode_seconds, word_list, wpm desc) lets a single index cover the common
-- "top 10 for 30s English" query without re-sorting.
create index if not exists arena_typing_scores_leaderboard_idx
  on public.arena_typing_scores (mode_seconds, word_list, wpm desc);

alter table public.arena_typing_scores enable row level security;

drop policy if exists "authenticated read arena scores"  on public.arena_typing_scores;
drop policy if exists "users insert own arena scores"    on public.arena_typing_scores;
drop policy if exists "writers delete arena scores"      on public.arena_typing_scores;

create policy "authenticated read arena scores"
  on public.arena_typing_scores for select to authenticated using (true);

create policy "users insert own arena scores"
  on public.arena_typing_scores for insert to authenticated
  with check (user_id = auth.uid());

create policy "writers delete arena scores"
  on public.arena_typing_scores for delete to authenticated
  using (public.is_writer());
