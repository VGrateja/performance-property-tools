-- ===========================================================================
-- 043_arena_scrabble_rack_counts.sql
--
-- Count-only accessor for opponents' rack sizes. The seated Scrabble UI shows
-- each opponent's rack face-down; to render the RIGHT number of tiles (which
-- drops below 7 only in the end-game) it needs each player's rack LENGTH —
-- never the letters.
--
-- arena_scrabble_racks RLS is own-row-only (a player can read only their own
-- rack), so a plain query can't see opponents' counts. This function is
-- SECURITY DEFINER to read across rows, but it returns ONLY char_length(rack)
-- (never the letters), is auth-guarded in the body, and EXECUTE is restricted
-- to the authenticated role (revoked from public + anon).
-- ===========================================================================

create or replace function public.get_scrabble_rack_counts(p_game_id uuid)
returns table(seat int, n int)
language sql
stable
security definer
set search_path = public
as $$
  select gp.seat,
         coalesce(char_length(r.rack), 0)::int as n
  from public.arena_scrabble_game_players gp
  left join public.arena_scrabble_racks r
    on r.game_id = gp.game_id and r.player_user_id = gp.user_id
  where gp.game_id = p_game_id
    and (select auth.uid()) is not null   -- authenticated callers only
$$;

revoke all on function public.get_scrabble_rack_counts(uuid) from public, anon;
grant execute on function public.get_scrabble_rack_counts(uuid) to authenticated;
