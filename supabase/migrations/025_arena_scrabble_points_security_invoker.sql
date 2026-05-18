-- =============================================================================
-- 025_arena_scrabble_points_security_invoker.sql
--
-- Supabase's database linter flags views defined with the implicit
-- SECURITY DEFINER behaviour because they enforce the *creator's* RLS
-- context rather than the querying user's. Switch arena_scrabble_points
-- to SECURITY INVOKER so its row visibility is governed by the user's
-- own RLS policies on arena_scrabble_matches + arena_scrabble_match_players
-- (both of which are already authenticated-read by design — same posture
-- as the chess equivalent, fixed in migration 007).
--
-- Run order: after 024_*.sql.
-- =============================================================================

drop view if exists public.arena_scrabble_points;

create view public.arena_scrabble_points
  with (security_invoker = true)
as
  with appearances as (
    select lower(mp.email) as email,
           mp.name          as name,
           mp.pts_after     as points,
           m.ended_at       as ended_at,
           m.ranked         as ranked
    from public.arena_scrabble_match_players mp
    join public.arena_scrabble_matches m on m.id = mp.match_id
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
