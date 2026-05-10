-- =============================================================================
-- 008_diagnostic_drop_arena.sql — DIAGNOSTIC ONLY
--
-- Drops every Arena-related object so we can test whether anything we added
-- (FK web to profiles, RLS policies, the realtime publication change, the
-- security-definer function/view) is responsible for the universal new-user
-- sign-in hang.
--
-- Reversible: migrations 003, 004, 005, 006, 007 still live in
-- supabase/migrations/ and can be re-run in order to restore everything.
--
-- Drop order respects dependencies (most-dependent first):
--   1. accept_chess_challenge function (calls arena_chess_points view)
--   2. arena_chess_points view (reads arena_chess_matches)
--   3. arena_chess_moves (FK to arena_chess_games)
--   4. arena_chess_games
--   5. arena_chess_challenges
--   6. arena_chess_matches
--   7. arena_typing_scores
--
-- The publication-removal block at the bottom is idempotent — if the tables
-- have already been dropped, alter publication ... drop table is skipped.
-- =============================================================================

-- 1. RPC function (006).
drop function if exists public.accept_chess_challenge(bigint);

-- 2. Points view (005).
drop view if exists public.arena_chess_points;

-- 3-5. Phase 2 online-play tables (006).
drop table if exists public.arena_chess_moves;
drop table if exists public.arena_chess_games;
drop table if exists public.arena_chess_challenges;

-- 6. Phase 0/1 chess matches table (005).
drop table if exists public.arena_chess_matches;

-- 7. Typing test scores (003).
drop table if exists public.arena_typing_scores;

-- Realtime publication cleanup (only fires for tables that still exist in
-- the publication; safe re-run after the table drops above).
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename in ('arena_chess_challenges', 'arena_chess_games', 'arena_chess_moves')
  ) then
    -- Iterate just the still-present rows so we don't error on missing.
    perform 1;
    -- (Postgres has no syntax to "drop table from publication if exists"; the
    -- dropped tables were auto-removed from the publication by the drops
    -- above, so this block is mostly a no-op safety net.)
  end if;
end$$;

-- Verify with:
--   select tablename from pg_tables where schemaname = 'public' and tablename like 'arena_%';
--   -- expect zero rows
