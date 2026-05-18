-- =============================================================================
-- 020_arena_scrabble_settle.sql — Scrabble S8 (endgame settlement)
--
-- One security-definer RPC, `settle_scrabble_game`, closes out an active game
-- and writes the historical match row that drives the leaderboard. Centralised
-- here (not in the client) for three reasons:
--
--   1. Leftover-tile math needs BOTH players' racks. RLS on
--      arena_scrabble_racks hides the opponent's row, so only a
--      security-definer function can read both.
--   2. ELO updates must be atomic with the status flip and the match-row
--      insert, otherwise a refresh mid-flow leaves the ladder in an
--      inconsistent state.
--   3. The "official" Scrabble out-of-tiles rule (winner gets +sum of
--      opponent's leftover tiles, opponent loses their own leftover) is
--      easy to mis-implement client-side and there's no upside to doing
--      it twice.
--
-- Termination kinds:
--   'out_of_tiles' → server verifies bag is empty AND one player has an
--                    empty rack, then applies the leftover bonus/penalty.
--   'six_passes'   → server verifies consecutive_zero_scores ≥ 6. Final
--                    scores are unmodified.
--   'resign'       → caller must be a participant; caller IS the resigner.
--                    Scores unmodified; opponent wins.
--   'agreement'    → caller must be a participant. Scores unmodified; draw.
--
-- ELO (K = 32). Unranked games freeze points (post = pre).
--
-- Run order: after 019_*.sql.
-- =============================================================================

create or replace function public.settle_scrabble_game(
  p_game_id      uuid,
  p_termination  text
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_game           record;
  v_p1_rack        text;
  v_p2_rack        text;
  v_p1_left        int := 0;
  v_p2_left        int := 0;
  v_p1_final       int;
  v_p2_final       int;
  v_result         text;       -- '1-0' / '0-1' / '1/2-1/2'
  v_resigner       int;        -- 1 or 2 (only used for resign)
  v_p1_pts_after   int;
  v_p2_pts_after   int;
  v_s1             float;      -- 1 = p1 wins, 0 = loses, 0.5 = draw
  v_exp1           float;      -- expected score for p1 under ELO
  v_k              float := 32;
  v_n              int;
  v_match_id       bigint;
  v_creator_email  text;
begin
  select * into v_game
  from public.arena_scrabble_games
  where id = p_game_id
  for update;

  if not found then
    raise exception 'Game % not found', p_game_id;
  end if;
  if v_game.status <> 'active' then
    raise exception 'Game is already %; cannot settle again', v_game.status;
  end if;
  if p_termination not in ('out_of_tiles', 'six_passes', 'resign', 'agreement') then
    raise exception 'Unknown termination: %', p_termination;
  end if;

  -- Only participants can resign or agree to a draw.
  if p_termination in ('resign', 'agreement') then
    if auth.uid() not in (v_game.player1_user_id, v_game.player2_user_id) then
      raise exception 'Only participants can resign / agree to a draw';
    end if;
  end if;

  -- Load both racks (RLS bypassed thanks to security definer).
  select rack into v_p1_rack
  from public.arena_scrabble_racks
  where game_id = p_game_id and player_user_id = v_game.player1_user_id;
  select rack into v_p2_rack
  from public.arena_scrabble_racks
  where game_id = p_game_id and player_user_id = v_game.player2_user_id;
  v_p1_rack := coalesce(v_p1_rack, '');
  v_p2_rack := coalesce(v_p2_rack, '');

  -- Compute leftover-tile values for each side.
  for v_n in 1 .. char_length(v_p1_rack) loop
    v_p1_left := v_p1_left + public._scrabble_letter_value(substr(v_p1_rack, v_n, 1));
  end loop;
  for v_n in 1 .. char_length(v_p2_rack) loop
    v_p2_left := v_p2_left + public._scrabble_letter_value(substr(v_p2_rack, v_n, 1));
  end loop;

  v_p1_final := v_game.player1_score;
  v_p2_final := v_game.player2_score;

  case p_termination
    when 'out_of_tiles' then
      if v_game.tiles_in_bag <> 0 then
        raise exception 'Cannot settle out-of-tiles: bag still has % tiles', v_game.tiles_in_bag;
      end if;
      if char_length(v_p1_rack) > 0 and char_length(v_p2_rack) > 0 then
        raise exception 'Cannot settle out-of-tiles: neither rack is empty';
      end if;
      -- Standard Scrabble rule: the player who went out gets the OTHER
      -- player's leftover added to their score; the player still holding
      -- tiles has that same amount deducted from theirs.
      if char_length(v_p1_rack) = 0 then
        v_p1_final := v_p1_final + v_p2_left;
        v_p2_final := v_p2_final - v_p2_left;
      else
        v_p2_final := v_p2_final + v_p1_left;
        v_p1_final := v_p1_final - v_p1_left;
      end if;

    when 'six_passes' then
      if v_game.consecutive_zero_scores < 6 then
        raise exception 'Cannot settle six-passes: only % consecutive zero-score moves recorded',
                        v_game.consecutive_zero_scores;
      end if;
      -- Scores unchanged; whoever has the higher score wins, otherwise draw.

    when 'resign' then
      if auth.uid() = v_game.player1_user_id then v_resigner := 1;
      else                                        v_resigner := 2;
      end if;
      -- Scores unchanged. Result decided below from v_resigner.

    when 'agreement' then
      -- Both players agreed to a draw. Scores unchanged.
      null;
  end case;

  -- Decide result string.
  if p_termination = 'resign' then
    v_result := case v_resigner when 1 then '0-1' else '1-0' end;
  elsif p_termination = 'agreement' then
    v_result := '1/2-1/2';
  else
    if    v_p1_final >  v_p2_final then v_result := '1-0';
    elsif v_p1_final <  v_p2_final then v_result := '0-1';
    else                                 v_result := '1/2-1/2';
    end if;
  end if;

  -- ELO. K = 32 for everyone (incl. provisional — matches the chess
  -- ladder's behaviour). For unranked games we freeze the points by
  -- writing pts_after = pts_before so the leaderboard view ignores them.
  if v_result = '1-0' then v_s1 := 1.0;
  elsif v_result = '0-1' then v_s1 := 0.0;
  else                       v_s1 := 0.5;
  end if;
  v_exp1 := 1.0 / (1.0 + power(10.0, (v_game.player2_pts_before - v_game.player1_pts_before) / 400.0));
  v_p1_pts_after := round(v_game.player1_pts_before + v_k * (v_s1 - v_exp1));
  v_p2_pts_after := round(v_game.player2_pts_before + v_k * ((1.0 - v_s1) - (1.0 - v_exp1)));
  if not v_game.ranked then
    v_p1_pts_after := v_game.player1_pts_before;
    v_p2_pts_after := v_game.player2_pts_before;
  end if;

  -- Resolve recorder's email for the audit column. Falls back to the
  -- game's player1 email if auth.users isn't joinable (rare).
  select email into v_creator_email from auth.users where id = auth.uid();
  if v_creator_email is null then
    v_creator_email := case when auth.uid() = v_game.player2_user_id
                            then v_game.player2_email else v_game.player1_email end;
  end if;

  -- Write the historical record. This is what arena_scrabble_points
  -- aggregates from.
  insert into public.arena_scrabble_matches (
    player1_email, player2_email,
    player1_name,  player2_name,
    result, termination, ranked, time_control,
    player1_score, player2_score,
    player1_pts_before, player2_pts_before,
    player1_pts_after,  player2_pts_after,
    created_by_user_id, created_by_email,
    started_at, ended_at
  ) values (
    v_game.player1_email, v_game.player2_email,
    v_game.player1_name,  v_game.player2_name,
    v_result, p_termination, v_game.ranked, v_game.time_control,
    v_p1_final, v_p2_final,
    v_game.player1_pts_before, v_game.player2_pts_before,
    v_p1_pts_after,  v_p2_pts_after,
    auth.uid(), v_creator_email,
    v_game.started_at, now()
  ) returning id into v_match_id;

  -- Flip the live game row to completed. Clients observing this UPDATE
  -- over Realtime know to fetch the just-inserted match row and paint
  -- the result modal.
  update public.arena_scrabble_games
     set status        = 'completed',
         ended_at      = now(),
         draw_offer_by = null
   where id = p_game_id;

  return jsonb_build_object(
    'ok',                true,
    'match_id',          v_match_id,
    'result',            v_result,
    'termination',       p_termination,
    'player1_score',     v_p1_final,
    'player2_score',     v_p2_final,
    'player1_leftover',  v_p1_left,
    'player2_leftover',  v_p2_left,
    'player1_pts_before', v_game.player1_pts_before,
    'player2_pts_before', v_game.player2_pts_before,
    'player1_pts_after',  v_p1_pts_after,
    'player2_pts_after',  v_p2_pts_after
  );
end;
$$;

revoke all on function public.settle_scrabble_game(uuid, text) from public;
grant execute on function public.settle_scrabble_game(uuid, text) to authenticated;
