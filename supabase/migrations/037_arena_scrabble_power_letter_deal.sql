-- =============================================================================
-- 037_arena_scrabble_power_letter_deal.sql
--
-- Opening-hand fairness: every player's STARTING rack now contains at least one
-- "power letter" (Z, Q, J or X). The standard bag holds exactly one of each
-- (4 power letters total) and a lobby is capped at 4 players, so there are
-- always enough to give every player exactly one.
--
-- start_scrabble_lobby now splits the freshly-shuffled bag into a power pool
-- (J/Q/X/Z) and the remaining 96 tiles, deals each player 1 power tile + 6
-- others (shuffled together so the power tile isn't always first), and returns
-- the leftover power tiles + remaining tiles (reshuffled) to the bag. Seat
-- order stays randomised (035). Everything else is unchanged.
--
-- Run order: after 035_*.sql (re-creates start_scrabble_lobby; CREATE OR
-- REPLACE preserves the existing grants).
-- =============================================================================

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
      1000
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
