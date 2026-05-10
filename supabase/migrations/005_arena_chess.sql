-- =============================================================================
-- 005_arena_chess.sql — Arena chess (Phase 0: manual result logging)
--
-- Phase 0 captures match results entered by the office (no realtime board yet)
-- so the points ladder + leaderboard can start populating with OTB games while
-- Phase 1+ (embedded board, hot-seat → online) is being built.
--
-- Points use a standard ELO formula computed client-side and stored on the
-- match row as before/after snapshots so we never have to recompute history
-- when the formula evolves. Everyone starts at 1000; a player is "provisional"
-- until they have 10 ranked games on record.
--
-- RLS:
--   - Authenticated users can SELECT every row (the leaderboard is open to
--     everyone in the office, mirroring the typing scoreboard pattern).
--   - Authenticated users can INSERT only rows where they are the recorder
--     (created_by_user_id = auth.uid()). They can log a match between any two
--     players, but they can't impersonate someone else as the recorder.
--   - Writers (admins) can DELETE — useful for clearing a bogus / spammy row.
--     Regular users can't delete rows so the leaderboard stays honest.
--
-- Run order: after 004_*.sql.
-- =============================================================================

create table if not exists public.arena_chess_matches (
  id                  bigserial    primary key,
  -- Denormalised player identity. We keep names/emails on the row so the
  -- leaderboard can render even when the profiles RLS would hide a peer's
  -- row from a non-writer reader (same trick as arena_typing_scores). Names
  -- are snapshotted at insert time — the ladder is a historical record.
  white_email         text         not null,
  black_email         text         not null,
  white_name          text,
  black_name          text,
  result              text         not null check (result in ('1-0', '0-1', '1/2-1/2')),
  -- Termination types come from the standard PGN tagset plus 'manual' for
  -- back-fill entries logged from OTB / non-tracked play. Add new values
  -- in lockstep with the UI and this constraint.
  termination         text         not null check (termination in (
                                       'mate', 'resign', 'draw', 'timeout',
                                       'abort', 'agreement', 'manual')),
  -- Casual matches are recorded for history but DON'T move points (the
  -- arena_chess_points view filters on this flag).
  ranked              boolean      not null default true,
  time_control        text         not null default 'untimed',
  -- Before/after snapshots: redundant with delta but lets the UI show
  -- "1018 (+18)" without recomputing rolling history per row, and
  -- guarantees the ladder is reproducible from the table alone.
  white_pts_before    int          not null,
  black_pts_before    int          not null,
  white_pts_after     int          not null,
  black_pts_after     int          not null,
  -- Optional PGN — Phase 0 leaves this null since results are entered
  -- manually. Phase 1+ (embedded board) will populate it from chess.js.
  pgn                 text,
  -- Recorder identity. RLS requires created_by_user_id = auth.uid() so
  -- nobody can backfill matches in someone else's name.
  created_by_user_id  uuid         not null references public.profiles(id) on delete cascade,
  created_by_email    text         not null,
  started_at          timestamptz,
  ended_at            timestamptz  not null default now(),
  created_at          timestamptz  not null default now(),
  -- Sanity guard: can't play yourself.
  constraint arena_chess_distinct_players check (lower(white_email) <> lower(black_email))
);

-- Per-player history: latest matches for "vandolf's recent games" lookups.
create index if not exists arena_chess_matches_white_idx
  on public.arena_chess_matches (lower(white_email), ended_at desc);
create index if not exists arena_chess_matches_black_idx
  on public.arena_chess_matches (lower(black_email), ended_at desc);
-- Leaderboard / news-feed scans: most recent ranked games.
create index if not exists arena_chess_matches_ranked_idx
  on public.arena_chess_matches (ranked, ended_at desc);

alter table public.arena_chess_matches enable row level security;

drop policy if exists "authenticated read arena chess matches" on public.arena_chess_matches;
drop policy if exists "users insert own arena chess matches"   on public.arena_chess_matches;
drop policy if exists "writers delete arena chess matches"     on public.arena_chess_matches;

create policy "authenticated read arena chess matches"
  on public.arena_chess_matches for select to authenticated using (true);

create policy "users insert own arena chess matches"
  on public.arena_chess_matches for insert to authenticated
  with check (created_by_user_id = auth.uid());

create policy "writers delete arena chess matches"
  on public.arena_chess_matches for delete to authenticated
  using (public.is_writer());

-- =============================================================================
-- arena_chess_points — current ranked rating per player.
--
-- Walks the ranked match history and pulls each player's most recent
-- *_pts_after as their current rating. Players who haven't played yet
-- aren't returned by this view — the UI defaults their starting rating
-- to 1000. `provisional` flags the first ten ranked games so the
-- leaderboard can mark unsettled scores with a "?" badge.
-- =============================================================================

create or replace view public.arena_chess_points as
  with appearances as (
    select
      lower(white_email) as email,
      white_name         as name,
      white_pts_after    as points,
      ended_at,
      ranked
    from public.arena_chess_matches
    union all
    select
      lower(black_email),
      black_name,
      black_pts_after,
      ended_at,
      ranked
    from public.arena_chess_matches
  ),
  ranked_only as (
    select * from appearances where ranked = true
  ),
  latest as (
    select distinct on (email)
      email, name, points, ended_at
    from ranked_only
    order by email, ended_at desc
  ),
  game_counts as (
    select email, count(*)::int as games
    from ranked_only
    group by email
  )
  select
    l.email,
    l.name,
    l.points,
    gc.games,
    (gc.games < 10) as provisional,
    l.ended_at as last_played
  from latest l
  join game_counts gc using (email);
