-- =============================================================================
-- 101 — Scrabble: ladder RESET + placement-points scoring + 5-game floor
--
-- Four changes, all agreed with the players (2026-08-14). Run as one unit.
--
-- 1. SCORING: pairwise ELO is replaced by a fixed placement delta
--        1st +3 · 2nd +1 · 3rd -1 · 4th -3
--    Opponent strength no longer matters. Simple and checkable by hand, which
--    is what the players wanted. Implemented as
--        delta = player_count + 1 - 2 * finish_rank
--    which reproduces that table exactly for 4 players AND stays zero-sum for
--    2- and 3-player lobbies (a literal 4-value table would have paid the
--    loser of a head-to-head +1). Points only move between players; the total
--    in circulation never drifts.
--
-- 2. FIRST-TIMER RATING: 100 (was 1000 in start_scrabble_lobby's fallback,
--    which never matched the client's STARTING_POINTS = 100 — a long-standing
--    mismatch, fixed here).
--
-- 3. LEADERBOARD FLOOR: 5 decided ranked games before a player is listed.
--    CRITICAL: the floor is a "listed" FLAG on the view, not a filter that
--    removes rows. start_scrabble_lobby reads this view to snapshot each
--    player's pts_before:
--        coalesce((select points from arena_scrabble_points where email = ...), 100)
--    so a missing row silently resets that player to 100. Filtering rows out
--    would have wiped the rating of everyone under the floor every time they
--    started a game. Clients filter on "listed"; the server always resolves a
--    real rating.
--
-- 4. HISTORY WIPED: all matches, games and lobbies cleared so everyone starts
--    level at 100 with zero games. A JSON backup of the 519 pre-reset rows was
--    taken first (scratch/scrabble-backup/, gitignored).
--
-- Voided games are also excluded from the view's counts now — a void has no
-- winner and moves no points, so it is not a game played.
--
-- Run order: after 100_vr_workforce.sql.
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
  v_game            record;
  v_n               int;
  v_creator_email   text;
  v_match_id        bigint;
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

  /* PLACEMENT POINTS (replaces pairwise ELO, Van 2026-08-14).
     Fixed delta by finishing position, independent of opponent strength:

        delta = player_count + 1 - 2 * finish_rank

     For a 4-player game that IS the agreed table — 1st +3 · 2nd +1 · 3rd -1 ·
     4th -3 — and the formula keeps it ZERO-SUM at every lobby size, which a
     literal 4-value table does not:
        4 players   +3 +1 -1 -3   (sum 0)
        3 players   +2  0 -2      (sum 0)
        2 players   +1 -1         (sum 0)
     A literal table indexed by rank would hand a 2-player game +3 to the
     winner and +1 to the LOSER, inflating the ladder every head-to-head.

     Because it is zero-sum the total in circulation never drifts: points only
     move between players. Casual games still freeze points entirely.

     Ties are the one exception — players sharing a finish_rank each take that
     position's delta, so a tied game can move the total by a few points. Rare
     enough to leave alone. */
  v_pts_after := v_pts_before;
  if v_game.ranked then
    for v_i in 1 .. v_n loop
      v_pts_after[v_i] := v_pts_before[v_i] + (v_n + 1 - 2 * v_finish_rank[v_i]);
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

create or replace function public.start_scrabble_lobby(p_lobby_id uuid)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_lobby     record;
  v_players   record;
  v_seat      int := 0;
  v_n         int;
  v_power     text;   -- shuffled power letters (J,Q,X,Z — one each)
  v_rest      text;   -- shuffled remaining 96 tiles
  v_bag       text;
  v_rack      text;
  v_game_id   uuid;
  v_pts       int;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;

  select * into v_lobby from public.arena_scrabble_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_user_id <> v_uid then raise exception 'Only the host can start the game'; end if;
  if v_lobby.status <> 'open' then raise exception 'Lobby is no longer open (status=%)', v_lobby.status; end if;

  select count(*) into v_n from public.arena_scrabble_lobby_players
    where lobby_id = p_lobby_id and status = 'joined';
  if v_n < 2 then raise exception 'Need at least 2 joined players to start (have %)', v_n; end if;

  -- Power-letter pool — one each of J, Q, X, Z (the four high-value tiles),
  -- shuffled. With max 4 players this always covers one per player.
  select string_agg(ch, '') into v_power
  from (select unnest(array['J','Q','X','Z']) as ch order by random()) p;

  -- Everything else (the standard 100-tile distribution minus J/Q/X/Z = 96
  -- tiles), shuffled.
  select string_agg(ch, '') into v_rest
  from (
    select ch from (select unnest(array[
      'A','A','A','A','A','A','A','A','A',
      'B','B',
      'C','C',
      'D','D','D','D',
      'E','E','E','E','E','E','E','E','E','E','E','E',
      'F','F',
      'G','G','G',
      'H','H',
      'I','I','I','I','I','I','I','I','I',
      'K',
      'L','L','L','L',
      'M','M',
      'N','N','N','N','N','N',
      'O','O','O','O','O','O','O','O',
      'P','P',
      'R','R','R','R','R','R',
      'S','S','S','S',
      'T','T','T','T','T','T',
      'U','U','U','U',
      'V','V',
      'W','W',
      'Y','Y',
      '?','?'
    ]) as ch) letters
    order by random()
  ) shuffled;

  insert into public.arena_scrabble_games (
    player_count, status, ranked, turn_time_seconds, board, to_move,
    tiles_in_bag, turn_started_at
  ) values (
    v_n, 'active', v_lobby.ranked, v_lobby.turn_time_seconds,
    repeat('.', 225), 1,
    (char_length(v_power) + char_length(v_rest)) - (v_n * 7), now()
  ) returning id into v_game_id;

  -- Seats assigned in RANDOM order. Each player gets one power tile + 6 others.
  for v_players in
    select lp.user_id, lp.email, lp.name
    from public.arena_scrabble_lobby_players lp
    where lp.lobby_id = p_lobby_id and lp.status = 'joined'
    order by random()
  loop
    v_seat := v_seat + 1;
    select coalesce(
      (select points from public.arena_scrabble_points where email = lower(v_players.email)),
      100
    ) into v_pts;

    insert into public.arena_scrabble_game_players (
      game_id, seat, user_id, email, name, pts_before, score
    ) values (v_game_id, v_seat, v_players.user_id, v_players.email, v_players.name, v_pts, 0);

    -- 1 guaranteed power letter + 6 from the rest, mixed so the power tile
    -- isn't always the first in the rack.
    v_rack  := public._scrabble_shuffle_text(substr(v_power, 1, 1) || substr(v_rest, 1, 6));
    v_power := substr(v_power, 2);
    v_rest  := substr(v_rest, 7);

    insert into public.arena_scrabble_racks (game_id, player_user_id, rack)
      values (v_game_id, v_players.user_id, v_rack);
  end loop;

  -- Whatever's left (unused power letters + remaining tiles) becomes the bag,
  -- reshuffled so the leftover power tiles aren't clumped at the front.
  v_bag := public._scrabble_shuffle_text(v_power || v_rest);
  insert into public.arena_scrabble_bags (game_id, bag) values (v_game_id, v_bag);

  update public.arena_scrabble_lobbies
     set status = 'started', game_id = v_game_id, started_at = now()
   where id = p_lobby_id;

  return v_game_id;
end;
$$;

revoke all on function public.start_scrabble_lobby(uuid) from public;
revoke execute on function public.start_scrabble_lobby(uuid) from anon;
grant execute on function public.start_scrabble_lobby(uuid) to authenticated;

-- ── the ladder view ─────────────────────────────────────────────────────────
--  = has enough decided games to appear on the leaderboard. Rows are
-- NEVER dropped, because start_scrabble_lobby resolves pts_before from here.
drop view if exists public.arena_scrabble_points;

create view public.arena_scrabble_points
  with (security_invoker = true)
as
  with appearances as (
    select lower(mp.email) as email,
           mp.name          as name,
           mp.pts_after     as points,
           m.ended_at       as ended_at,
           m.ranked         as ranked,
           m.termination    as termination
    from public.arena_scrabble_match_players mp
    join public.arena_scrabble_matches m on m.id = mp.match_id
  ),
  -- ranked AND actually decided: a voided game is not a game played
  ranked_only as (
    select * from appearances
    where ranked = true
      and termination <> 'void'
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
    (gc.games >= 5) as listed,        -- 5-game floor for the leaderboard
    (gc.games < 10) as provisional,
    l.ended_at as last_played
  from latest l
  join game_counts gc using (email);

comment on view public.arena_scrabble_points is
  'Scrabble ladder. One row per player who has played a decided ranked game. listed = 5+ games, i.e. eligible for the leaderboard; rows are kept below that because start_scrabble_lobby reads points from here and a missing row would reset the player to 100.';


-- ── reset the ladder ───────────────────────────────────────────────────────
-- Children first (no ON DELETE CASCADE assumed). Everyone restarts at 100
-- with zero games; the leaderboard is empty until someone reaches 5.
delete from public.arena_scrabble_match_players;
delete from public.arena_scrabble_matches;
delete from public.arena_scrabble_game_players;
delete from public.arena_scrabble_games;
delete from public.arena_scrabble_lobby_players;
delete from public.arena_scrabble_lobbies;
