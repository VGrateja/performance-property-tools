-- =============================================================================
-- 047_arena_chess_abandon_stale.sql — auto-abandon stale (idle) chess games
--
-- An online chess game stays status='active' FOREVER if neither player
-- resigns or finishes it (e.g. someone closes the tab mid-game). Those ghost
-- games linger indefinitely in the lobby's "Spectate" list and in both
-- players' "Resume your game" callout — e.g. a game showing active for 17h.
--
-- This adds a cleanup RPC that flips long-idle active games to 'abandoned'.
-- "Idle" = no activity (no move made, and the game itself started) for longer
-- than p_idle_minutes. The arena-chess client calls it once on lobby boot;
-- an optional pg_cron schedule (bottom, commented) runs it server-side too.
--
-- A spectator's browser CANNOT do this itself: the "participants update"
-- RLS policy on arena_chess_games only lets the two players write their own
-- row. Hence a SECURITY DEFINER function — but it is tightly bounded:
--   • EXECUTE granted to `authenticated` only (anon cannot call it).
--   • p_idle_minutes is floored at 60, so it can NEVER abandon a fresh or
--     genuinely-live game — only ones idle for at least an hour.
--   • Abandoned games are not written to arena_chess_matches, and the
--     leaderboard (arena_chess_points) reads matches only, so abandoning a
--     ghost game never changes anyone's rating. It just clears the ghost.
--
-- Run order: after 006_arena_chess_online.sql.
-- =============================================================================

create or replace function public.abandon_stale_chess_games(p_idle_minutes int default 180)
  returns int
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  -- Floor at 60 minutes: a caller (or a bad arg) can never reach in and kill
  -- a game that is merely a few minutes between moves.
  v_minutes int := greatest(coalesce(p_idle_minutes, 180), 60);
  v_count   int;
begin
  with stale as (
    select g.id
    from public.arena_chess_games g
    where g.status = 'active'
      and greatest(
            g.started_at,
            coalesce(
              (select max(m.made_at) from public.arena_chess_moves m where m.game_id = g.id),
              g.started_at
            )
          ) < now() - make_interval(mins => v_minutes)
  )
  update public.arena_chess_games g
     set status   = 'abandoned',
         ended_at = now()
    from stale
   where g.id = stale.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- anon must not be able to call it; authenticated users (and pg_cron, which
-- runs as a superuser and bypasses these grants) can.
revoke all on function public.abandon_stale_chess_games(int) from public;
grant execute on function public.abandon_stale_chess_games(int) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- OPTIONAL — run the sweep server-side on a schedule, so ghosts are cleared
-- even when nobody opens the chess lobby. Requires the pg_cron extension
-- (enable once: Supabase dashboard → Database → Extensions → enable "pg_cron"),
-- then run this once in the SQL editor:
--
--   select cron.schedule(
--     'abandon-stale-chess',
--     '*/15 * * * *',
--     $$ select public.abandon_stale_chess_games(180); $$
--   );
--
-- To change the idle window later, unschedule + reschedule, or just rely on
-- the client-side boot call (which passes the default 180 = 3 hours).
-- ─────────────────────────────────────────────────────────────────────────────
