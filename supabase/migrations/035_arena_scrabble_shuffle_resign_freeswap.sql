-- =============================================================================
-- 035_arena_scrabble_shuffle_resign_freeswap.sql
--
-- Three gameplay changes requested for Arena Scrabble:
--
--   1. SHUFFLE TURN ORDER — start_scrabble_lobby seated the host at seat 1
--      (first to move) every time. Seats are now assigned in random order, so
--      who goes first (and the whole rotation) is shuffled each game.
--
--   2. RESIGN CONTINUES (multi-player) — resigning no longer always ends the
--      game. A new resign_scrabble_game RPC marks the player resigned and:
--        • if 2+ players remain active, the game CONTINUES — the resigner is
--          flagged (greyed out client-side) and skipped in the turn rotation;
--        • if only 1 active player would remain, the game settles (that player
--          effectively wins), exactly like the old 2-player resign.
--      Turn rotation everywhere (submit_scrabble_move, expire_scrabble_turn)
--      now skips resigned seats via _scrabble_next_active_seat(). At final
--      settlement resigned players are ranked below every player who stayed.
--
--   3. FREE-SWAP COMBINATIONS — the free swap (swap tiles, keep your turn) used
--      to require every picked tile be the SAME letter you hold 3+ of. It now
--      qualifies as long as EVERY picked tile is an A-Z letter you hold 3+ of,
--      so you can mix them (e.g. 2× I + 1× O when you hold 3+ of each).
--
-- Run order: after 034_*.sql. Re-runnable (CREATE OR REPLACE / IF [NOT] EXISTS).
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Schema: resigned flag per seat + allow a 'resign' move row in the audit log.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.arena_scrabble_game_players
  add column if not exists resigned    boolean     not null default false;
alter table public.arena_scrabble_game_players
  add column if not exists resigned_at timestamptz;

alter table public.arena_scrabble_moves drop constraint if exists arena_scrabble_moves_kind_check;
alter table public.arena_scrabble_moves add constraint arena_scrabble_moves_kind_check
  check (kind in ('play', 'exchange', 'pass', 'play_invalid', 'resign'));

-- ─────────────────────────────────────────────────────────────────────────────
-- _scrabble_next_active_seat — the next seat (cyclically after p_from_seat)
-- whose player has NOT resigned. Used by every turn-advancing path so a
-- resigned seat is never handed the turn. If everyone else has resigned it
-- returns p_from_seat (the caller handles end-of-game).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._scrabble_next_active_seat(p_game_id uuid, p_from_seat int)
  returns int
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
declare
  v_n        int;
  v_seat     int;
  v_i        int;
  v_resigned boolean;
begin
  select player_count into v_n from public.arena_scrabble_games where id = p_game_id;
  if v_n is null or v_n < 1 then return p_from_seat; end if;
  v_seat := p_from_seat;
  for v_i in 1 .. v_n loop
    v_seat := (v_seat % v_n) + 1;
    select resigned into v_resigned from public.arena_scrabble_game_players
      where game_id = p_game_id and seat = v_seat;
    if not coalesce(v_resigned, false) then return v_seat; end if;
  end loop;
  return p_from_seat;   -- everyone else has resigned
end;
$$;
revoke all on function public._scrabble_next_active_seat(uuid, int) from public;
grant execute on function public._scrabble_next_active_seat(uuid, int) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- start_scrabble_lobby — identical to 022 EXCEPT the seat-assignment loop now
-- orders joined players RANDOMLY (was: host first, then join order). to_move
-- still starts at seat 1, so a random player goes first and the rotation order
-- is shuffled.
-- ─────────────────────────────────────────────────────────────────────────────
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

  with letters as (
    select unnest(array[
      'A','A','A','A','A','A','A','A','A',
      'B','B',
      'C','C',
      'D','D','D','D',
      'E','E','E','E','E','E','E','E','E','E','E','E',
      'F','F',
      'G','G','G',
      'H','H',
      'I','I','I','I','I','I','I','I','I',
      'J',
      'K',
      'L','L','L','L',
      'M','M',
      'N','N','N','N','N','N',
      'O','O','O','O','O','O','O','O',
      'P','P',
      'Q',
      'R','R','R','R','R','R',
      'S','S','S','S',
      'T','T','T','T','T','T',
      'U','U','U','U',
      'V','V',
      'W','W',
      'X',
      'Y','Y',
      'Z',
      '?','?'
    ]) as ch
  )
  select string_agg(ch, '') into v_bag
  from (select ch from letters order by random()) shuffled;

  insert into public.arena_scrabble_games (
    player_count, status, ranked, turn_time_seconds, board, to_move,
    tiles_in_bag, turn_started_at
  ) values (
    v_n, 'active', v_lobby.ranked, v_lobby.turn_time_seconds,
    repeat('.', 225), 1,
    char_length(v_bag) - (v_n * 7), now()
  ) returning id into v_game_id;

  -- Seats assigned in RANDOM order so the host is no longer always first.
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

    v_rack := substr(v_bag, 1, 7);
    v_bag  := substr(v_bag, 8);
    insert into public.arena_scrabble_racks (game_id, player_user_id, rack)
      values (v_game_id, v_players.user_id, v_rack);
  end loop;

  insert into public.arena_scrabble_bags (game_id, bag) values (v_game_id, v_bag);

  update public.arena_scrabble_lobbies
     set status = 'started', game_id = v_game_id, started_at = now()
   where id = p_lobby_id;

  return v_game_id;
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- submit_scrabble_move — based on 034 (the latest). Two changes:
--   • turn rotation uses _scrabble_next_active_seat (skips resigned seats);
--   • FREE SWAP qualifies when every picked tile is an A-Z letter held 3+
--     (letters may be mixed), instead of requiring a single repeated letter.
-- Everything else (placement validation, scoring, dictionary forfeit, timer
-- touchpoints) is unchanged.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.submit_scrabble_move(
  p_game_id            uuid,
  p_kind               text,
  p_tiles              jsonb default '[]'::jsonb,
  p_exchange_letters   text  default '',
  p_clock_remaining_ms int   default null
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_game             record;
  v_my_seat          int;
  v_my_player        record;
  v_rack             text;
  v_bag              text;
  v_next_ply         int;
  v_score            int := 0;
  v_main_word        text := '';
  v_cross_words      text[] := '{}';
  v_end_hint         text := '';
  v_new_board        text;
  v_t                jsonb;
  v_n                int;
  v_letter           text;
  v_row              int;
  v_col              int;
  v_blank            boolean;
  v_token            text;
  v_tile_count       int;
  v_rack_check       text;
  v_placed_rows      int[] := '{}';
  v_placed_cols      int[] := '{}';
  v_placed_idx       int[] := '{}';
  v_axis             text;
  v_min_r            int := 15; v_max_r int := -1;
  v_min_c            int := 15; v_max_c int := -1;
  v_idx              int;
  v_r                int;
  v_c                int;
  v_word_chars       text;
  v_word_score       int;
  v_word_mult        int;
  v_letter_mult      int;
  v_base             int;
  v_premium          text;
  v_first_move       boolean;
  v_connected        boolean;
  v_word             text;
  v_exists           boolean;
  v_drawn            text;
  v_n_draw           int;
  v_exch_n           int;
  v_exch_letters     text;
  v_dim              int := 15;
  v_payload          jsonb;
  v_consec           int;
  v_next_to_move     int;
  v_max_letter_count int;
  v_invalid_word     text := null;       -- set when a word fails the dictionary check
  v_free             boolean := false;   -- exchange perk: same/mixed 3+ swap keeps the turn
  v_swap_letter      text;               -- (retained; unused since the combo rule)
begin
  select * into v_game from public.arena_scrabble_games where id = p_game_id for update;
  if not found then raise exception 'Game % not found', p_game_id; end if;
  if v_game.status <> 'active' then raise exception 'Game is no longer active (status=%)', v_game.status; end if;

  select * into v_my_player from public.arena_scrabble_game_players
    where game_id = p_game_id and user_id = auth.uid();
  if not found then raise exception 'You are not a participant in this game'; end if;
  v_my_seat := v_my_player.seat;
  if v_game.to_move <> v_my_seat then raise exception 'Not your turn'; end if;

  select rack into v_rack from public.arena_scrabble_racks
    where game_id = p_game_id and player_user_id = auth.uid() for update;
  if not found then raise exception 'No rack found for current player'; end if;

  select bag into v_bag from public.arena_scrabble_bags
    where game_id = p_game_id for update;
  if not found then raise exception 'No bag row found for game'; end if;

  select coalesce(max(ply), 0) + 1 into v_next_ply
    from public.arena_scrabble_moves where game_id = p_game_id;

  v_consec := v_game.consecutive_zero_scores;
  -- Skip any resigned seats when rotating the turn (resign-continues, #2).
  v_next_to_move := public._scrabble_next_active_seat(p_game_id, v_my_seat);

  if p_kind = 'pass' then
    v_consec := v_consec + 1;
    if v_consec >= 6 then v_end_hint := 'six_passes'; end if;
    insert into public.arena_scrabble_moves (
      game_id, ply, player_user_id, kind, payload, score, clock_remaining_ms
    ) values (
      p_game_id, v_next_ply, auth.uid(), 'pass', '{}'::jsonb, 0, p_clock_remaining_ms
    );
    update public.arena_scrabble_games
       set to_move = v_next_to_move,
           consecutive_zero_scores = v_consec,
           draw_offer_by = null,
           last_move_at = now(),
           turn_started_at = now()
     where id = p_game_id;

  elsif p_kind = 'exchange' then
    v_exch_letters := upper(coalesce(p_exchange_letters, ''));
    v_exch_n := char_length(v_exch_letters);
    if v_exch_n = 0 or v_exch_n > 7 then raise exception 'Exchange must specify 1-7 letters'; end if;

    /* Detect the FREE SWAP perk (#7): EVERY picked tile must be an A-Z letter
       (blanks '?' never qualify) the rack holds 3+ of. Letters may be mixed,
       e.g. 2× I + 1× O when the rack holds 3+ of each. */
    v_free := true;
    for v_n in 1 .. v_exch_n loop
      v_letter := substr(v_exch_letters, v_n, 1);
      if v_letter !~ '^[A-Z]$'
         or (char_length(v_rack) - char_length(replace(v_rack, v_letter, ''))) < 3 then
        v_free := false;
        exit;
      end if;
    end loop;

    /* Bag requirement: a free swap only needs enough tiles to redraw; a
       turn-costing standard exchange keeps the classic 7-in-the-bag rule. */
    if v_free then
      if char_length(v_bag) < v_exch_n then
        raise exception 'Not enough tiles left in the bag to swap';
      end if;
    else
      if char_length(v_bag) < 7 then
        raise exception 'Cannot exchange — fewer than 7 tiles remain in the bag';
      end if;
    end if;

    /* Pull the picked letters off the rack (validates they're actually held). */
    v_rack_check := v_rack;
    for v_n in 1 .. v_exch_n loop
      v_letter := substr(v_exch_letters, v_n, 1);
      v_rack_check := public._scrabble_remove_char(v_rack_check, v_letter);
      if v_rack_check is null then raise exception 'Exchange letter % not in rack', v_letter; end if;
    end loop;

    /* Draw replacements, return the swapped tiles to the bag, reshuffle. */
    v_drawn := substr(v_bag, 1, v_exch_n);
    v_bag   := substr(v_bag, v_exch_n + 1);
    v_bag := public._scrabble_shuffle_text(v_bag || v_exch_letters);
    v_rack := v_rack_check || v_drawn;

    update public.arena_scrabble_racks set rack = v_rack, updated_at = now()
      where game_id = p_game_id and player_user_id = auth.uid();
    update public.arena_scrabble_bags  set bag = v_bag, updated_at = now()
      where game_id = p_game_id;

    if v_free then
      /* FREE SWAP — keep the turn. to_move, the zero-counter, and the turn
         clock are intentionally left untouched. Audit row records free=true. */
      insert into public.arena_scrabble_moves (
        game_id, ply, player_user_id, kind, payload, score, clock_remaining_ms
      ) values (
        p_game_id, v_next_ply, auth.uid(), 'exchange',
        jsonb_build_object('count', v_exch_n, 'free', true, 'letters', v_exch_letters),
        0, p_clock_remaining_ms
      );
      update public.arena_scrabble_games
         set tiles_in_bag = char_length(v_bag),
             last_move_at  = now()
       where id = p_game_id;
    else
      /* STANDARD EXCHANGE — costs the turn (counts a zero toward six-zero end). */
      v_consec := v_consec + 1;
      if v_consec >= 6 then v_end_hint := 'six_passes'; end if;
      insert into public.arena_scrabble_moves (
        game_id, ply, player_user_id, kind, payload, score, clock_remaining_ms
      ) values (
        p_game_id, v_next_ply, auth.uid(), 'exchange',
        jsonb_build_object('count', v_exch_n, 'free', false),
        0, p_clock_remaining_ms
      );
      update public.arena_scrabble_games
         set to_move = v_next_to_move,
             consecutive_zero_scores = v_consec,
             tiles_in_bag = char_length(v_bag),
             draw_offer_by = null,
             last_move_at = now(),
             turn_started_at = now()
       where id = p_game_id;
    end if;

  elsif p_kind = 'play' then
    v_tile_count := jsonb_array_length(coalesce(p_tiles, '[]'::jsonb));
    if v_tile_count < 1 or v_tile_count > 7 then raise exception 'Play must place 1-7 tiles'; end if;

    v_new_board := v_game.board;
    v_rack_check := v_rack;

    for v_n in 0 .. v_tile_count - 1 loop
      v_t := p_tiles -> v_n;
      v_row := (v_t->>'row')::int;
      v_col := (v_t->>'col')::int;
      v_letter := upper(v_t->>'letter');
      v_blank := coalesce((v_t->>'blank')::boolean, false);

      if v_row < 0 or v_row > 14 or v_col < 0 or v_col > 14 then
        raise exception 'Tile out of board bounds: (%, %)', v_row, v_col;
      end if;
      if v_letter !~ '^[A-Z]$' then raise exception 'Tile letter must be A-Z, got: %', v_letter; end if;

      v_idx := v_row * v_dim + v_col;
      if v_idx = any(v_placed_idx) then raise exception 'Two tiles at the same square (%, %)', v_row, v_col; end if;
      if substr(v_new_board, v_idx + 1, 1) <> '.' then
        raise exception 'Square (%, %) is already occupied', v_row, v_col;
      end if;

      v_token := case when v_blank then '?' else v_letter end;
      v_rack_check := public._scrabble_remove_char(v_rack_check, v_token);
      if v_rack_check is null then raise exception 'Tile % not in rack', v_token; end if;

      v_new_board := overlay(
        v_new_board placing (case when v_blank then lower(v_letter) else v_letter end)
        from v_idx + 1 for 1
      );

      v_placed_idx  := array_append(v_placed_idx,  v_idx);
      v_placed_rows := array_append(v_placed_rows, v_row);
      v_placed_cols := array_append(v_placed_cols, v_col);
      if v_row < v_min_r then v_min_r := v_row; end if;
      if v_row > v_max_r then v_max_r := v_row; end if;
      if v_col < v_min_c then v_min_c := v_col; end if;
      if v_col > v_max_c then v_max_c := v_col; end if;
    end loop;

    if v_min_r = v_max_r and v_min_c = v_max_c then v_axis := 'auto';
    elsif v_min_r = v_max_r then v_axis := 'across';
    elsif v_min_c = v_max_c then v_axis := 'down';
    else raise exception 'Tiles must all share a single row or single column'; end if;

    v_first_move := not (v_game.board ~ '[A-Za-z]');
    if v_first_move then
      if not (7 * v_dim + 7) = any(v_placed_idx) then raise exception 'The first move must cover the centre square'; end if;
      if v_tile_count < 2 then raise exception 'The first move must place at least two tiles'; end if;
    end if;

    if v_axis = 'across' then
      for v_c in v_min_c .. v_max_c loop
        if substr(v_new_board, v_min_r * v_dim + v_c + 1, 1) = '.' then
          raise exception 'Gap in placement at (%, %)', v_min_r, v_c;
        end if;
      end loop;
    elsif v_axis = 'down' then
      for v_r in v_min_r .. v_max_r loop
        if substr(v_new_board, v_r * v_dim + v_min_c + 1, 1) = '.' then
          raise exception 'Gap in placement at (%, %)', v_r, v_min_c;
        end if;
      end loop;
    end if;

    if v_axis = 'across' or (v_axis = 'auto') then
      v_r := v_min_r;
      v_c := v_min_c;
      while v_c > 0 and substr(v_new_board, v_r * v_dim + v_c, 1) <> '.' loop v_c := v_c - 1; end loop;
      if substr(v_new_board, v_r * v_dim + v_c + 1, 1) = '.' then v_c := v_c + 1; end if;
      v_word_chars := '';
      v_word_score := 0;
      v_word_mult  := 1;
      while v_c < v_dim and substr(v_new_board, v_r * v_dim + v_c + 1, 1) <> '.' loop
        v_letter := substr(v_new_board, v_r * v_dim + v_c + 1, 1);
        v_word_chars := v_word_chars || upper(v_letter);
        v_base := case when v_letter ~ '^[a-z]$' then 0 else public._scrabble_letter_value(v_letter) end;
        v_letter_mult := 1;
        if (v_r * v_dim + v_c) = any(v_placed_idx) then
          v_premium := public._scrabble_square_premium(v_r, v_c);
          if    v_premium = 'TW' then v_word_mult := v_word_mult * 3;
          elsif v_premium = 'DW' then v_word_mult := v_word_mult * 2;
          elsif v_premium = 'TL' then v_letter_mult := 3;
          elsif v_premium = 'DL' then v_letter_mult := 2;
          end if;
        end if;
        v_word_score := v_word_score + v_base * v_letter_mult;
        v_c := v_c + 1;
      end loop;
      if char_length(v_word_chars) >= 2 then
        v_main_word := v_word_chars;
        v_score := v_score + v_word_score * v_word_mult;
      end if;
    end if;

    if v_axis = 'down' or (v_axis = 'auto' and v_main_word = '') then
      v_r := v_min_r;
      v_c := v_min_c;
      while v_r > 0 and substr(v_new_board, (v_r - 1) * v_dim + v_c + 1, 1) <> '.' loop v_r := v_r - 1; end loop;
      v_word_chars := '';
      v_word_score := 0;
      v_word_mult  := 1;
      while v_r < v_dim and substr(v_new_board, v_r * v_dim + v_c + 1, 1) <> '.' loop
        v_letter := substr(v_new_board, v_r * v_dim + v_c + 1, 1);
        v_word_chars := v_word_chars || upper(v_letter);
        v_base := case when v_letter ~ '^[a-z]$' then 0 else public._scrabble_letter_value(v_letter) end;
        v_letter_mult := 1;
        if (v_r * v_dim + v_c) = any(v_placed_idx) then
          v_premium := public._scrabble_square_premium(v_r, v_c);
          if    v_premium = 'TW' then v_word_mult := v_word_mult * 3;
          elsif v_premium = 'DW' then v_word_mult := v_word_mult * 2;
          elsif v_premium = 'TL' then v_letter_mult := 3;
          elsif v_premium = 'DL' then v_letter_mult := 2;
          end if;
        end if;
        v_word_score := v_word_score + v_base * v_letter_mult;
        v_r := v_r + 1;
      end loop;
      if char_length(v_word_chars) >= 2 then
        v_main_word := v_word_chars;
        v_score := v_score + v_word_score * v_word_mult;
      end if;
    end if;

    for v_n in 1 .. array_length(v_placed_idx, 1) loop
      v_r := v_placed_rows[v_n];
      v_c := v_placed_cols[v_n];
      if v_axis = 'across' or (v_axis = 'auto' and v_main_word <> '' and v_main_word !~ '^.$') then
        v_r := v_placed_rows[v_n];
        while v_r > 0 and substr(v_new_board, (v_r - 1) * v_dim + v_c + 1, 1) <> '.' loop v_r := v_r - 1; end loop;
        v_word_chars := '';
        v_word_score := 0;
        v_word_mult  := 1;
        while v_r < v_dim and substr(v_new_board, v_r * v_dim + v_c + 1, 1) <> '.' loop
          v_letter := substr(v_new_board, v_r * v_dim + v_c + 1, 1);
          v_word_chars := v_word_chars || upper(v_letter);
          v_base := case when v_letter ~ '^[a-z]$' then 0 else public._scrabble_letter_value(v_letter) end;
          v_letter_mult := 1;
          if (v_r * v_dim + v_c) = any(v_placed_idx) then
            v_premium := public._scrabble_square_premium(v_r, v_c);
            if    v_premium = 'TW' then v_word_mult := v_word_mult * 3;
            elsif v_premium = 'DW' then v_word_mult := v_word_mult * 2;
            elsif v_premium = 'TL' then v_letter_mult := 3;
            elsif v_premium = 'DL' then v_letter_mult := 2;
            end if;
          end if;
          v_word_score := v_word_score + v_base * v_letter_mult;
          v_r := v_r + 1;
        end loop;
        if char_length(v_word_chars) >= 2 then
          v_cross_words := array_append(v_cross_words, v_word_chars);
          v_score := v_score + v_word_score * v_word_mult;
        end if;
      else
        v_c := v_placed_cols[v_n];
        v_r := v_placed_rows[v_n];
        while v_c > 0 and substr(v_new_board, v_r * v_dim + v_c, 1) <> '.' loop v_c := v_c - 1; end loop;
        v_word_chars := '';
        v_word_score := 0;
        v_word_mult  := 1;
        while v_c < v_dim and substr(v_new_board, v_r * v_dim + v_c + 1, 1) <> '.' loop
          v_letter := substr(v_new_board, v_r * v_dim + v_c + 1, 1);
          v_word_chars := v_word_chars || upper(v_letter);
          v_base := case when v_letter ~ '^[a-z]$' then 0 else public._scrabble_letter_value(v_letter) end;
          v_letter_mult := 1;
          if (v_r * v_dim + v_c) = any(v_placed_idx) then
            v_premium := public._scrabble_square_premium(v_r, v_c);
            if    v_premium = 'TW' then v_word_mult := v_word_mult * 3;
            elsif v_premium = 'DW' then v_word_mult := v_word_mult * 2;
            elsif v_premium = 'TL' then v_letter_mult := 3;
            elsif v_premium = 'DL' then v_letter_mult := 2;
            end if;
          end if;
          v_word_score := v_word_score + v_base * v_letter_mult;
          v_c := v_c + 1;
        end loop;
        if char_length(v_word_chars) >= 2 then
          v_cross_words := array_append(v_cross_words, v_word_chars);
          v_score := v_score + v_word_score * v_word_mult;
        end if;
      end if;
    end loop;

    if v_main_word = '' then raise exception 'Move does not form a valid word'; end if;

    if not v_first_move then
      v_connected := false;
      if char_length(v_main_word) > v_tile_count then
        v_connected := true;
      else
        for v_n in 1 .. array_length(v_placed_idx, 1) loop
          v_r := v_placed_rows[v_n];
          v_c := v_placed_cols[v_n];
          if v_r > 0  and substr(v_game.board, (v_r - 1) * v_dim + v_c + 1, 1) <> '.' then v_connected := true; exit; end if;
          if v_r < 14 and substr(v_game.board, (v_r + 1) * v_dim + v_c + 1, 1) <> '.' then v_connected := true; exit; end if;
          if v_c > 0  and substr(v_game.board, v_r * v_dim + v_c, 1) <> '.'              then v_connected := true; exit; end if;
          if v_c < 14 and substr(v_game.board, v_r * v_dim + v_c + 2, 1) <> '.'          then v_connected := true; exit; end if;
        end loop;
      end if;
      if not v_connected then raise exception 'Move must connect to at least one existing tile'; end if;
    end if;

    select not exists (select 1 from public.scrabble_words where word = v_main_word) into v_exists;
    if v_exists then v_invalid_word := v_main_word; end if;
    if v_invalid_word is null then
      foreach v_word in array v_cross_words loop
        select not exists (select 1 from public.scrabble_words where word = v_word) into v_exists;
        if v_exists then v_invalid_word := v_word; exit; end if;
      end loop;
    end if;

    if v_invalid_word is not null then
      v_consec := v_consec + 1;
      if v_consec >= 6 then v_end_hint := 'six_passes'; end if;
      v_payload := jsonb_build_object(
        'invalid_word', v_invalid_word,
        'attempted',    p_tiles,
        'main_word',    v_main_word,
        'cross_words',  to_jsonb(v_cross_words)
      );
      insert into public.arena_scrabble_moves (
        game_id, ply, player_user_id, kind, payload, score, clock_remaining_ms
      ) values (
        p_game_id, v_next_ply, auth.uid(), 'play_invalid', v_payload, 0, p_clock_remaining_ms
      );
      update public.arena_scrabble_games
         set to_move = v_next_to_move,
             consecutive_zero_scores = v_consec,
             draw_offer_by = null,
             last_move_at = now(),
             turn_started_at = now()
       where id = p_game_id;

      select * into v_game from public.arena_scrabble_games where id = p_game_id;
      return jsonb_build_object(
        'ok',            true,
        'forfeit',       true,
        'invalid_word',  v_invalid_word,
        'score',         0,
        'ply',           v_next_ply,
        'rack_after',    v_rack,
        'tiles_in_bag',  v_game.tiles_in_bag,
        'to_move',       v_game.to_move,
        'game_status',   v_game.status,
        'end_hint',      v_end_hint
      );
    end if;

    if v_tile_count = 7 then v_score := v_score + 50; end if;

    v_n_draw := least(v_tile_count, char_length(v_bag));
    v_drawn  := substr(v_bag, 1, v_n_draw);
    v_bag    := substr(v_bag, v_n_draw + 1);
    v_rack   := v_rack_check || v_drawn;

    update public.arena_scrabble_racks set rack = v_rack, updated_at = now()
      where game_id = p_game_id and player_user_id = auth.uid();
    update public.arena_scrabble_bags set bag = v_bag, updated_at = now()
      where game_id = p_game_id;
    update public.arena_scrabble_game_players set score = score + v_score
      where game_id = p_game_id and seat = v_my_seat;
    update public.arena_scrabble_games
       set board = v_new_board,
           to_move = v_next_to_move,
           consecutive_zero_scores = 0,
           tiles_in_bag = char_length(v_bag),
           draw_offer_by = null,
           last_move_at = now(),
           turn_started_at = now()
     where id = p_game_id;

    if char_length(v_bag) = 0 and char_length(v_rack) = 0 then
      v_end_hint := 'out_of_tiles';
    end if;

    v_payload := jsonb_build_object(
      'tiles', p_tiles, 'main_word', v_main_word,
      'cross_words', to_jsonb(v_cross_words), 'axis', v_axis
    );
    insert into public.arena_scrabble_moves (
      game_id, ply, player_user_id, kind, payload, score, clock_remaining_ms
    ) values (
      p_game_id, v_next_ply, auth.uid(), 'play', v_payload, v_score, p_clock_remaining_ms
    );

  else
    raise exception 'Unknown move kind: % (expected play / exchange / pass)', p_kind;
  end if;

  select * into v_game from public.arena_scrabble_games where id = p_game_id;

  return jsonb_build_object(
    'ok',           true,
    'forfeit',      false,
    'free',         v_free,
    'score',        v_score,
    'ply',          v_next_ply,
    'main_word',    v_main_word,
    'cross_words',  to_jsonb(v_cross_words),
    'rack_after',   v_rack,
    'tiles_in_bag', v_game.tiles_in_bag,
    'to_move',      v_game.to_move,
    'game_status',  v_game.status,
    'end_hint',     v_end_hint
  );
end;
$$;
revoke all on function public.submit_scrabble_move(uuid, text, jsonb, text, int) from public;
grant execute on function public.submit_scrabble_move(uuid, text, jsonb, text, int) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- expire_scrabble_turn — based on 022; rotation now skips resigned seats.
-- (A resigned player is never to_move, so their clock never runs; this only
-- changes which seat the turn advances TO when a real player times out.)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.expire_scrabble_turn(p_game_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_game         record;
  v_now          timestamptz := now();
  v_deadline     timestamptz;
  v_active_uid   uuid;
  v_next_to_move int;
  v_next_ply     int;
  v_consec       int;
  v_end_hint     text := '';
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;

  select * into v_game from public.arena_scrabble_games where id = p_game_id for update;
  if not found then raise exception 'Game % not found', p_game_id; end if;
  if v_game.status <> 'active' then raise exception 'Game is no longer active (status=%)', v_game.status; end if;
  if v_game.turn_time_seconds is null then raise exception 'Game is untimed; nothing to expire'; end if;
  if v_game.turn_started_at is null then raise exception 'No turn-start timestamp recorded'; end if;

  v_deadline := v_game.turn_started_at + make_interval(secs => v_game.turn_time_seconds);
  if v_now < v_deadline then
    raise exception 'Turn has not expired yet (% seconds remaining)',
                    extract(epoch from (v_deadline - v_now))::int;
  end if;

  select user_id into v_active_uid from public.arena_scrabble_game_players
    where game_id = p_game_id and seat = v_game.to_move;

  v_next_to_move := public._scrabble_next_active_seat(p_game_id, v_game.to_move);
  v_consec := v_game.consecutive_zero_scores + 1;
  if v_consec >= 6 then v_end_hint := 'six_passes'; end if;

  select coalesce(max(ply), 0) + 1 into v_next_ply
    from public.arena_scrabble_moves where game_id = p_game_id;

  insert into public.arena_scrabble_moves (
    game_id, ply, player_user_id, kind, payload, score
  ) values (
    p_game_id, v_next_ply, v_active_uid, 'pass',
    jsonb_build_object('reason', 'timeout'), 0
  );

  update public.arena_scrabble_games
     set to_move = v_next_to_move,
         consecutive_zero_scores = v_consec,
         draw_offer_by = null,
         last_move_at = v_now,
         turn_started_at = v_now
   where id = p_game_id;

  return jsonb_build_object(
    'ok', true,
    'to_move', v_next_to_move,
    'end_hint', v_end_hint
  );
end;
$$;
revoke all on function public.expire_scrabble_turn(uuid) from public;
grant execute on function public.expire_scrabble_turn(uuid) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- resign_scrabble_game — resign without necessarily ending the game.
--   • Marks the caller resigned.
--   • If ≤ 1 active player would remain, settles the game now (settle ranks
--     resigned players last, so the last player standing wins).
--   • Otherwise records a 'resign' move, advances the turn off the resigner
--     if it was theirs (skipping other resigned seats), and the game continues.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.resign_scrabble_game(p_game_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_game          record;
  v_my            record;
  v_active_after  int;
  v_next          int;
  v_ply           int;
begin
  select * into v_game from public.arena_scrabble_games where id = p_game_id for update;
  if not found then raise exception 'Game % not found', p_game_id; end if;
  if v_game.status <> 'active' then raise exception 'Game is no longer active (status=%)', v_game.status; end if;

  select * into v_my from public.arena_scrabble_game_players
    where game_id = p_game_id and user_id = auth.uid();
  if not found then raise exception 'You are not a participant in this game'; end if;
  if v_my.resigned then raise exception 'You have already resigned'; end if;

  update public.arena_scrabble_game_players
     set resigned = true, resigned_at = now()
   where game_id = p_game_id and seat = v_my.seat;

  select count(*) into v_active_after from public.arena_scrabble_game_players
    where game_id = p_game_id and resigned = false;

  -- One (or zero) active player left → end the game now. settle_scrabble_game
  -- reads the resigned flags and ranks every resigned player below the rest.
  if v_active_after <= 1 then
    return public.settle_scrabble_game(p_game_id, 'resign');
  end if;

  -- Game continues. Record the resignation for the history + realtime feed.
  select coalesce(max(ply), 0) + 1 into v_ply
    from public.arena_scrabble_moves where game_id = p_game_id;
  insert into public.arena_scrabble_moves (game_id, ply, player_user_id, kind, payload, score)
    values (p_game_id, v_ply, auth.uid(), 'resign',
            jsonb_build_object('seat', v_my.seat, 'name', v_my.name), 0);

  if v_game.to_move = v_my.seat then
    -- It was their turn: hand off to the next active seat + restart its clock.
    v_next := public._scrabble_next_active_seat(p_game_id, v_my.seat);
    update public.arena_scrabble_games
       set to_move = v_next,
           turn_started_at = now(),
           last_move_at = now(),
           draw_offer_by = case when draw_offer_by = v_my.seat then null else draw_offer_by end
     where id = p_game_id;
  else
    -- Not their turn: leave the rotation alone; just clear any draw offer
    -- they had open and nudge last_move_at so watchers re-render.
    update public.arena_scrabble_games
       set last_move_at = now(),
           draw_offer_by = case when draw_offer_by = v_my.seat then null else draw_offer_by end
     where id = p_game_id;
  end if;

  return jsonb_build_object(
    'ok',        true,
    'settled',   false,
    'continued', true,
    'seat',      v_my.seat
  );
end;
$$;
revoke all on function public.resign_scrabble_game(uuid) from public;
grant execute on function public.resign_scrabble_game(uuid) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- settle_scrabble_game — based on 022. Adds general RESIGNED handling: any
-- player flagged resigned is ranked BELOW every player who stayed (and treated
-- as a loss for ELO), regardless of termination, via a separate ranking key.
-- Recorded/displayed scores stay the players' real (leftover-adjusted) scores.
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
      match_id, seat, user_id, email, name, score, pts_before, pts_after, finish_rank
    ) values (
      v_match_id, v_seats[v_i], v_user_ids[v_i], v_emails[v_i], v_names[v_i],
      v_scores[v_i], v_pts_before[v_i], v_pts_after[v_i]::int, v_finish_rank[v_i]
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
