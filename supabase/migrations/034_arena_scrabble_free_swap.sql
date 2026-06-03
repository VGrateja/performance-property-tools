-- =============================================================================
-- 034_arena_scrabble_free_swap.sql — Two exchange modes
--
-- Replaces the old "house rule" exchange (which required 3-of-a-kind AND still
-- cost your turn — neither standard Scrabble nor a real perk) with two clean,
-- auto-distinguished modes inside submit_scrabble_move(p_kind='exchange'):
--
--   1. STANDARD EXCHANGE — swap any 1-7 tiles. Requires 7+ tiles in the bag.
--      Costs your turn (rotates to_move, counts as a zero toward the
--      six-zero end-game). This is the normal Scrabble exchange.
--
--   2. FREE SWAP (new perk) — when EVERY tile you picked is the SAME A-Z letter
--      AND your rack holds 3+ of that letter, you may swap 1, 2, or 3 of them
--      WITHOUT losing your turn: to_move, the zero-counter, and the turn clock
--      are all left untouched, so you immediately play (or pass/exchange again)
--      on the same turn. Only needs enough tiles in the bag to redraw.
--
-- The mode is detected server-side from the submitted letters — the client
-- sends the same p_exchange_letters either way, so no signature change. The
-- move row records kind='exchange' with payload.free = true|false for audit.
--
-- Also hardens v_first_move: it now checks the board for any placed letter
-- instead of "ply = 1", so a pass / exchange / free-swap taken as the opening
-- action can no longer trick the centre-square requirement into being skipped.
--
-- Run order: after 033_*.sql. CREATE OR REPLACE preserves existing grants
-- (authenticated EXECUTE; anon revoked in 026/027).
-- =============================================================================

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
  v_free             boolean := false;   -- exchange perk: same-letter 3+ swap keeps the turn
  v_swap_letter      text;               -- the repeated letter when v_free is true
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
  v_next_to_move := (v_my_seat % v_game.player_count) + 1;

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

    /* Detect the FREE SWAP perk: every picked tile must be the SAME A-Z letter
       (blanks '?' never qualify) and the rack must hold 3+ of it. */
    v_swap_letter := substr(v_exch_letters, 1, 1);
    if v_swap_letter ~ '^[A-Z]$'
       and v_exch_letters = repeat(v_swap_letter, v_exch_n)
       and (char_length(v_rack) - char_length(replace(v_rack, v_swap_letter, ''))) >= 3
    then
      v_free := true;
    end if;

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
        jsonb_build_object('count', v_exch_n, 'free', true, 'letter', v_swap_letter),
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

    /* Phase 1: per-tile validation. Mechanical errors (out of bounds,
       duplicate squares, on top of an existing tile, not in rack)
       raise immediately so the player can fix the placement. */
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

    /* First move = empty board (no letters placed yet). Board-based so an
       opening pass / exchange / free-swap can't slip past the centre rule. */
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

    /* Phase 2: word + score walks (same as before). */
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

    /* Phase 3: dictionary check. Failure no longer raises — it
       FORFEITS the turn (zero score, no board / rack / bag changes,
       a play_invalid move row is recorded with the bad word). */
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

    /* Phase 4: valid play — bingo bonus + state updates. */
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
