-- =============================================================================
-- 039_arena_scrabble_match_leftover.sql
--
-- Persist each player's end-of-game leftover (the point value of the tiles
-- still on their rack) into arena_scrabble_match_players. Previously this was
-- only computed in-memory by settle_scrabble_game and returned in the RPC
-- payload — so the SETTLING client (who reads the RPC return) saw the full
-- score breakdown, but every OTHER client (who renders from the fetched match
-- row) had no leftover and therefore saw a reduced/different breakdown.
--
-- Storing it makes the end-of-game window identical for everyone: the player
-- who went out, the other players, and spectators all render the same
-- "points − leftover = final" math from the same persisted data.
--
-- Run order: after 035_*.sql (re-creates settle_scrabble_game; CREATE OR
-- REPLACE preserves the existing grants). Re-runnable. Historical matches keep
-- leftover = NULL (the client treats NULL as 0); only matches settled after
-- this migration is applied carry the value.
-- =============================================================================

alter table public.arena_scrabble_match_players
  add column if not exists leftover int;


-- ─────────────────────────────────────────────────────────────────────────────
-- settle_scrabble_game — identical to 035 except the per-player INSERT now also
-- writes the leftover value (the only change is the two marked lines).
-- ─────────────────────────────────────────────────────────────────────────────
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
  v_game            record;
  v_n               int;
  v_creator_email   text;
  v_match_id        bigint;
  v_k_eff           float;
  v_si              float;
  v_exp             float;
  v_pi              record;
  v_i               int;
  v_j               int;
  v_seats           int[];
  v_scores          int[];
  v_rank_key        int[];
  v_resigned        boolean[];
  v_leftover        int[];
  v_pts_before      int[];
  v_pts_after       int[];
  v_finish_rank     int[];
  v_user_ids        uuid[];
  v_emails          text[];
  v_names           text[];
  v_lv              int;
  v_letter          text;
  v_total_leftover  int := 0;
  v_outer_seat      int;
  v_payload         jsonb;
  v_min_score       int;
  v_any_resigned    boolean := false;
begin
  select * into v_game from public.arena_scrabble_games where id = p_game_id for update;
  if not found then raise exception 'Game % not found', p_game_id; end if;
  if v_game.status <> 'active' then raise exception 'Game is already %; cannot settle again', v_game.status; end if;
  if p_termination not in ('out_of_tiles', 'six_passes', 'resign', 'agreement') then
    raise exception 'Unknown termination: %', p_termination;
  end if;
  if p_termination in ('resign', 'agreement') then
    if not exists (select 1 from public.arena_scrabble_game_players
                   where game_id = p_game_id and user_id = auth.uid()) then
      raise exception 'Only participants can resign / agree to a draw';
    end if;
  end if;

  v_n := v_game.player_count;

  for v_pi in
    select gp.seat, gp.user_id, gp.email, gp.name, gp.score, gp.pts_before, gp.resigned,
           coalesce((select rack from public.arena_scrabble_racks
                     where game_id = p_game_id and player_user_id = gp.user_id), '') as rack
    from public.arena_scrabble_game_players gp
    where gp.game_id = p_game_id
    order by gp.seat
  loop
    v_seats        := array_append(v_seats,        v_pi.seat);
    v_user_ids     := array_append(v_user_ids,     v_pi.user_id);
    v_emails       := array_append(v_emails,       v_pi.email);
    v_names        := array_append(v_names,        v_pi.name);
    v_pts_before   := array_append(v_pts_before,   v_pi.pts_before);
    v_scores       := array_append(v_scores,       v_pi.score);
    v_resigned     := array_append(v_resigned,     coalesce(v_pi.resigned, false));
    if coalesce(v_pi.resigned, false) then v_any_resigned := true; end if;
    v_lv := 0;
    for v_i in 1 .. char_length(v_pi.rack) loop
      v_letter := substr(v_pi.rack, v_i, 1);
      v_lv := v_lv + public._scrabble_letter_value(v_letter);
    end loop;
    v_leftover := array_append(v_leftover, v_lv);
    v_total_leftover := v_total_leftover + v_lv;
  end loop;

  /* Universal leftover deduction; out_of_tiles also awards the emptied-rack
     player the sum of the others' leftovers. (Scores below are the REAL
     scores that get recorded + displayed.) */
  case p_termination
    when 'out_of_tiles' then
      if v_game.tiles_in_bag <> 0 then
        raise exception 'Cannot settle out-of-tiles: bag still has % tiles', v_game.tiles_in_bag;
      end if;
      v_outer_seat := null;
      for v_i in 1 .. v_n loop
        if v_leftover[v_i] = 0 then v_outer_seat := v_seats[v_i]; exit; end if;
      end loop;
      if v_outer_seat is null then
        raise exception 'Cannot settle out-of-tiles: no rack is empty';
      end if;
      for v_i in 1 .. v_n loop
        v_scores[v_i] := v_scores[v_i] - v_leftover[v_i];
        if v_seats[v_i] = v_outer_seat then
          v_scores[v_i] := v_scores[v_i] + v_total_leftover;
        end if;
      end loop;
    when 'six_passes' then
      if v_game.consecutive_zero_scores < 6 then
        raise exception 'Cannot settle six-passes: only % consecutive zero-score moves recorded',
                        v_game.consecutive_zero_scores;
      end if;
      for v_i in 1 .. v_n loop
        v_scores[v_i] := v_scores[v_i] - v_leftover[v_i];
      end loop;
    when 'resign' then
      for v_i in 1 .. v_n loop
        v_scores[v_i] := v_scores[v_i] - v_leftover[v_i];
      end loop;
    when 'agreement' then
      for v_i in 1 .. v_n loop
        v_scores[v_i] := v_scores[v_i] - v_leftover[v_i];
      end loop;
  end case;

  /* Ranking key — normally the real score, but any resigned player is forced
     below every active player (they don't get to win by quitting). For a
     legacy 'resign' call with no flag set, treat the caller as resigned. */
  v_rank_key := v_scores;
  v_min_score := v_scores[1];
  for v_i in 2 .. v_n loop
    if v_scores[v_i] < v_min_score then v_min_score := v_scores[v_i]; end if;
  end loop;
  for v_i in 1 .. v_n loop
    if v_resigned[v_i]
       or (p_termination = 'resign' and not v_any_resigned and v_user_ids[v_i] = auth.uid()) then
      v_rank_key[v_i] := v_min_score - 1;
    end if;
  end loop;

  /* finish_rank from the ranking key (competition ranking, ties share a rank). */
  v_finish_rank := array_fill(0, ARRAY[v_n]);
  for v_i in 1 .. v_n loop
    v_finish_rank[v_i] := 1;
    for v_j in 1 .. v_n loop
      if v_rank_key[v_j] > v_rank_key[v_i] then
        v_finish_rank[v_i] := v_finish_rank[v_i] + 1;
      end if;
    end loop;
  end loop;

  /* Pairwise ELO off the ranking key so a resigned player counts as a loss. */
  v_pts_after := v_pts_before;
  if v_game.ranked then
    v_k_eff := 32.0 / greatest(v_n - 1, 1);
    for v_i in 1 .. v_n loop
      for v_j in 1 .. v_n loop
        if v_i = v_j then continue; end if;
        if v_rank_key[v_i] > v_rank_key[v_j] then v_si := 1.0;
        elsif v_rank_key[v_i] < v_rank_key[v_j] then v_si := 0.0;
        else v_si := 0.5;
        end if;
        v_exp := 1.0 / (1.0 + power(10.0, (v_pts_before[v_j] - v_pts_before[v_i]) / 400.0));
        v_pts_after[v_i] := v_pts_after[v_i] + (v_k_eff * (v_si - v_exp));
      end loop;
    end loop;
    for v_i in 1 .. v_n loop
      v_pts_after[v_i] := round(v_pts_after[v_i]);
    end loop;
  end if;

  select email into v_creator_email from auth.users where id = auth.uid();
  if v_creator_email is null then v_creator_email := v_emails[1]; end if;

  insert into public.arena_scrabble_matches (
    termination, ranked, turn_time_seconds, player_count, game_id,
    created_by_user_id, created_by_email,
    started_at, ended_at
  ) values (
    p_termination, v_game.ranked, v_game.turn_time_seconds, v_n, p_game_id,
    auth.uid(), v_creator_email,
    v_game.started_at, now()
  ) returning id into v_match_id;

  for v_i in 1 .. v_n loop
    insert into public.arena_scrabble_match_players (
      match_id, seat, user_id, email, name, score, pts_before, pts_after, finish_rank,
      leftover                                                       -- 039: persist leftover
    ) values (
      v_match_id, v_seats[v_i], v_user_ids[v_i], v_emails[v_i], v_names[v_i],
      v_scores[v_i], v_pts_before[v_i], v_pts_after[v_i]::int, v_finish_rank[v_i],
      v_leftover[v_i]                                                -- 039: persist leftover
    );
  end loop;

  update public.arena_scrabble_games
     set status = 'completed', ended_at = now(), draw_offer_by = null
   where id = p_game_id;

  v_payload := '[]'::jsonb;
  for v_i in 1 .. v_n loop
    v_payload := v_payload || jsonb_build_array(jsonb_build_object(
      'seat',        v_seats[v_i],
      'user_id',     v_user_ids[v_i],
      'email',       v_emails[v_i],
      'name',        v_names[v_i],
      'score',       v_scores[v_i],
      'leftover',    v_leftover[v_i],
      'pts_before',  v_pts_before[v_i],
      'pts_after',   v_pts_after[v_i]::int,
      'finish_rank', v_finish_rank[v_i],
      'resigned',    v_resigned[v_i]
    ));
  end loop;

  return jsonb_build_object(
    'ok',           true,
    'match_id',     v_match_id,
    'termination',  p_termination,
    'player_count', v_n,
    'players',      v_payload
  );
end;
$$;
revoke all on function public.settle_scrabble_game(uuid, text) from public;
grant execute on function public.settle_scrabble_game(uuid, text) to authenticated;
