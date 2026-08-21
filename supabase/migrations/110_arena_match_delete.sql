-- =============================================================================
-- 110_arena_match_delete.sql — dev-only match-history deletion (Scrabble+Chess)
--
-- Van's ask (2026-08-21): remove history rows from inside the tools instead of
-- via Supabase, dev-only, with a password re-entry step. The UI re-checks the
-- password (supabase auth re-sign-in) before calling; THIS layer enforces the
-- real gate — current_tier() = 'dev' — so the anon key alone can never delete.
--
-- Ladder semantics (both games): the points views resolve each player's
-- current points from their LATEST remaining ranked row, so deleting a
-- player's most recent ranked match reverts them to the prior row. The
-- pts_before/after snapshots baked on OTHER rows are historical records and
-- deliberately don't re-flow.
--
-- Run order: after 109_*.sql.
-- =============================================================================

create or replace function public.delete_scrabble_match(p_match_id bigint)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if public.current_tier() <> 'dev' then raise exception 'Developers only'; end if;
  delete from public.arena_scrabble_match_players where match_id = p_match_id;
  delete from public.arena_scrabble_matches where id = p_match_id;
  if not found then raise exception 'Match not found'; end if;
end;
$$;
revoke all on function public.delete_scrabble_match(bigint) from public;
revoke all on function public.delete_scrabble_match(bigint) from anon;
grant execute on function public.delete_scrabble_match(bigint) to authenticated;

create or replace function public.delete_chess_match(p_match_id bigint)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if public.current_tier() <> 'dev' then raise exception 'Developers only'; end if;
  delete from public.arena_chess_matches where id = p_match_id;
  if not found then raise exception 'Match not found'; end if;
end;
$$;
revoke all on function public.delete_chess_match(bigint) from public;
revoke all on function public.delete_chess_match(bigint) from anon;
grant execute on function public.delete_chess_match(bigint) to authenticated;
