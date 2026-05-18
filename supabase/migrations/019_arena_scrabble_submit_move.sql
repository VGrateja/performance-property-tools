-- =============================================================================
-- 019_arena_scrabble_submit_move.sql — Arena Scrabble Phase 2 (move RPC)
--
-- One single security-definer RPC, `submit_scrabble_move`, handles every kind
-- of move (play / exchange / pass) atomically:
--
--   1. Lock the game row + verify it's the caller's turn.
--   2. Dispatch on p_kind:
--        play     → geometry check, dictionary lookup, score, rack/bag/board
--                   update, move-row insert.
--        exchange → rack/bag swap; bag must hold ≥7 tiles (official rule).
--        pass     → no state change beyond turn flip + consecutive-zero
--                   counter increment.
--   3. Flip to_move, update consecutive_zero_scores, set last_move_at.
--   4. If the game just ended (bag empty AND a rack empty → out_of_tiles;
--      six consecutive zero-score moves → six_passes), do NOT settle results
--      here — the client picks up the change via Realtime and writes the
--      arena_scrabble_matches row, mirroring how chess handles end-of-game.
--      We just flag termination context in the returned JSON.
--
-- Helper SQL functions (`_scrabble_letter_value`, `_scrabble_square_premium`,
-- `_scrabble_remove_char`, `_scrabble_shuffle_text`) live at the top of this
-- migration. They're internal and intentionally not granted to anon — only
-- the RPC body calls them.
--
-- Run order: after 018_arena_scrabble.sql AND after the scrabble_words table
-- has been seeded (otherwise every word lookup returns false and no move
-- is ever legal).
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper: letter point value. Uppercase A-Z follow the standard English
-- Scrabble distribution; lowercase a-z represent BLANK tiles played as that
-- letter — they score 0. Anything else → 0 (defensive).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._scrabble_letter_value(p_ch text)
  returns int
  language sql
  immutable
as $$
  select case
    when p_ch in ('A','E','I','L','N','O','R','S','T','U') then 1
    when p_ch in ('D','G')                                  then 2
    when p_ch in ('B','C','M','P')                          then 3
    when p_ch in ('F','H','V','W','Y')                      then 4
    when p_ch  = 'K'                                        then 5
    when p_ch in ('J','X')                                  then 8
    when p_ch in ('Q','Z')                                  then 10
    else                                                          0
  end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper: premium-square classifier. Rows / cols are 0-indexed; (0,0) is the
-- top-left, (14,14) is the bottom-right, (7,7) is the centre. Returns one of
-- 'TW' (triple word), 'DW' (double word), 'TL' (triple letter), 'DL' (double
-- letter), or '' for a plain square.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._scrabble_square_premium(p_r int, p_c int)
  returns text
  language sql
  immutable
as $$
  select case
    -- Triple word: corners, edge mid-points.
    when (p_r, p_c) in ((0,0),(0,7),(0,14),(7,0),(7,14),(14,0),(14,7),(14,14))
      then 'TW'
    -- Double word: two diagonals from each corner toward the centre, plus
    -- the centre itself ((7,7)).
    when (p_r, p_c) in (
      (1,1),(2,2),(3,3),(4,4),
      (1,13),(2,12),(3,11),(4,10),
      (13,1),(12,2),(11,3),(10,4),
      (13,13),(12,12),(11,11),(10,10),
      (7,7)
    ) then 'DW'
    -- Triple letter.
    when (p_r, p_c) in (
      (1,5),(1,9),
      (5,1),(5,5),(5,9),(5,13),
      (9,1),(9,5),(9,9),(9,13),
      (13,5),(13,9)
    ) then 'TL'
    -- Double letter.
    when (p_r, p_c) in (
      (0,3),(0,11),
      (2,6),(2,8),
      (3,0),(3,7),(3,14),
      (6,2),(6,6),(6,8),(6,12),
      (7,3),(7,11),
      (8,2),(8,6),(8,8),(8,12),
      (11,0),(11,7),(11,14),
      (12,6),(12,8),
      (14,3),(14,11)
    ) then 'DL'
    else ''
  end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper: remove ONE occurrence of ch from s (rack / bag string ops).
-- Returns NULL if the char isn't present, so callers can detect bad input.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._scrabble_remove_char(p_s text, p_ch text)
  returns text
  language plpgsql
  immutable
as $$
declare
  v_pos int;
begin
  v_pos := position(p_ch in p_s);
  if v_pos = 0 then return null; end if;
  return substr(p_s, 1, v_pos - 1) || substr(p_s, v_pos + 1);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper: shuffle the characters of s. Used when exchanging tiles — the
-- returned letters re-enter the bag and we re-shuffle so the next draw isn't
-- deterministic. ORDER BY random() inside a set-returning unnest is the
-- idiomatic Postgres shuffle.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._scrabble_shuffle_text(p_s text)
  returns text
  language sql
  volatile
as $$
  select coalesce(string_agg(ch, ''), '')
  from (
    select ch
    from unnest(string_to_array(p_s, null)) as t(ch)
    order by random()
  ) shuffled
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- submit_scrabble_move RPC.
--
-- Parameters
--   p_game_id            uuid    target game.
--   p_kind               text    'play' | 'exchange' | 'pass'.
--   p_tiles              jsonb   for 'play': array of
--                                  { "row": int, "col": int, "letter": "A".."Z",
--                                    "blank": bool }
--                                row/col are 0-indexed; letter is the FACE
--                                letter (for blanks too — the blank counter
--                                stores '?' on the rack but plays as a
--                                specific letter, lowercased on the board).
--   p_exchange_letters   text    for 'exchange': uppercase letters to swap
--                                ('?' for blanks). Each character = one tile.
--   p_clock_remaining_ms int     caller's clock remaining after the move
--                                (null for untimed games).
--
-- Returns JSON
--   {
--     ok: true,
--     score: int,                  -- points scored on this move (0 for pass/exchange)
--     ply:   int,                  -- the move's ply number (1-indexed)
--     main_word: text,             -- for 'play': the primary word formed
--     cross_words: text[],         -- for 'play': all cross-words formed
--     rack_after: text,            -- caller's rack post-move
--     tiles_in_bag: int,           -- public bag count after the move
--     to_move: int,                -- next player to move (1 or 2)
--     game_status: text,           -- 'active' (unchanged), or 'completed' once
--                                  --   the client follows up to settle results
--     end_hint: text               -- '' / 'out_of_tiles' / 'six_passes'
--   }
--
-- Errors: raises with a human-readable message on every illegal-move case.
-- The client surfaces the message to the user without further translation.
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
  v_my_num           int;
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
  v_token            text;          -- '?' for blanks; otherwise the face letter
  v_tile_count       int;
  v_rack_check       text;
  v_placed_rows      int[] := '{}';
  v_placed_cols      int[] := '{}';
  v_placed_idx       int[] := '{}';   -- linear indices 0..224 of placed tiles
  v_axis             text;            -- 'across' or 'down'
  v_min_r            int := 15; v_max_r int := -1;
  v_min_c            int := 15; v_max_c int := -1;
  v_idx              int;
  v_r                int;
  v_c                int;
  v_word_chars       text;
  v_word_chars_arr   text[];
  v_word_score       int;
  v_word_mult        int;
  v_letter_mult      int;
  v_base             int;
  v_premium          text;
  v_first_move       boolean;
  v_connected        boolean;
  v_word_norm        text;
  v_word             text;
  v_exists           boolean;
  v_drawn            text;
  v_n_draw           int;
  v_exch_n           int;
  v_exch_letters     text;
  v_dim              int := 15;
  v_payload          jsonb;
  v_new_score        int;
  v_consec           int;
begin
  -- ── Lock the game row ────────────────────────────────────────────────────
  select * into v_game
  from public.arena_scrabble_games
  where id = p_game_id
  for update;

  if not found then
    raise exception 'Game % not found', p_game_id;
  end if;

  if v_game.status <> 'active' then
    raise exception 'Game is no longer active (status=%)', v_game.status;
  end if;

  -- Identify caller's seat. auth.uid() is set to the JWT subject for any
  -- authenticated supabase client.
  if auth.uid() = v_game.player1_user_id then
    v_my_num := 1;
  elsif auth.uid() = v_game.player2_user_id then
    v_my_num := 2;
  else
    raise exception 'You are not a participant in this game';
  end if;

  if v_game.to_move <> v_my_num then
    raise exception 'Not your turn';
  end if;

  -- Load rack + bag (locked for update via the game lock above; FK chain
  -- means no concurrent mutator can sneak in here).
  select rack into v_rack
  from public.arena_scrabble_racks
  where game_id = p_game_id and player_user_id = auth.uid()
  for update;

  if not found then
    raise exception 'No rack found for current player';
  end if;

  select bag into v_bag
  from public.arena_scrabble_bags
  where game_id = p_game_id
  for update;

  if not found then
    raise exception 'No bag row found for game';
  end if;

  select coalesce(max(ply), 0) + 1 into v_next_ply
  from public.arena_scrabble_moves
  where game_id = p_game_id;

  v_consec := v_game.consecutive_zero_scores;

  -- ── PASS ────────────────────────────────────────────────────────────────
  if p_kind = 'pass' then
    v_consec := v_consec + 1;
    if v_consec >= 6 then v_end_hint := 'six_passes'; end if;

    insert into public.arena_scrabble_moves (
      game_id, ply, player_user_id, kind, payload, score, clock_remaining_ms
    ) values (
      p_game_id, v_next_ply, auth.uid(), 'pass', '{}'::jsonb, 0, p_clock_remaining_ms
    );

    update public.arena_scrabble_games
       set to_move                  = 3 - v_my_num,
           consecutive_zero_scores  = v_consec,
           draw_offer_by            = null,
           last_move_at             = now()
     where id = p_game_id;

  -- ── EXCHANGE ────────────────────────────────────────────────────────────
  elsif p_kind = 'exchange' then
    v_exch_letters := upper(coalesce(p_exchange_letters, ''));
    v_exch_n := char_length(v_exch_letters);
    if v_exch_n = 0 or v_exch_n > 7 then
      raise exception 'Exchange must specify 1-7 letters';
    end if;
    if char_length(v_bag) < 7 then
      raise exception 'Cannot exchange — fewer than 7 tiles remain in the bag';
    end if;

    -- Verify each exchanged letter is currently in the rack, removing as we go.
    v_rack_check := v_rack;
    for v_n in 1 .. v_exch_n loop
      v_letter := substr(v_exch_letters, v_n, 1);
      v_rack_check := public._scrabble_remove_char(v_rack_check, v_letter);
      if v_rack_check is null then
        raise exception 'Exchange letter % not in rack', v_letter;
      end if;
    end loop;

    -- Draw replacements from the front of the bag.
    v_drawn := substr(v_bag, 1, v_exch_n);
    v_bag   := substr(v_bag, v_exch_n + 1);

    -- Put exchanged letters back into the bag and reshuffle.
    v_bag := public._scrabble_shuffle_text(v_bag || v_exch_letters);

    -- New rack = (rack minus exchanged) + drawn.
    v_rack := v_rack_check || v_drawn;

    v_consec := v_consec + 1;
    if v_consec >= 6 then v_end_hint := 'six_passes'; end if;

    insert into public.arena_scrabble_moves (
      game_id, ply, player_user_id, kind, payload, score, clock_remaining_ms
    ) values (
      p_game_id, v_next_ply, auth.uid(), 'exchange',
      jsonb_build_object('count', v_exch_n),
      0, p_clock_remaining_ms
    );

    update public.arena_scrabble_racks
       set rack = v_rack, updated_at = now()
     where game_id = p_game_id and player_user_id = auth.uid();

    update public.arena_scrabble_bags
       set bag = v_bag, updated_at = now()
     where game_id = p_game_id;

    update public.arena_scrabble_games
       set to_move                  = 3 - v_my_num,
           consecutive_zero_scores  = v_consec,
           tiles_in_bag             = char_length(v_bag),
           draw_offer_by            = null,
           last_move_at             = now()
     where id = p_game_id;

  -- ── PLAY ────────────────────────────────────────────────────────────────
  elsif p_kind = 'play' then
    v_tile_count := jsonb_array_length(coalesce(p_tiles, '[]'::jsonb));
    if v_tile_count < 1 or v_tile_count > 7 then
      raise exception 'Play must place 1-7 tiles';
    end if;

    v_new_board := v_game.board;
    v_rack_check := v_rack;

    -- First pass: validate each tile, accumulate placed positions, mutate
    -- the working board copy, and verify the tile came from the rack.
    for v_n in 0 .. v_tile_count - 1 loop
      v_t      := p_tiles -> v_n;
      v_row    := (v_t->>'row')::int;
      v_col    := (v_t->>'col')::int;
      v_letter := upper(v_t->>'letter');
      v_blank  := coalesce((v_t->>'blank')::boolean, false);

      if v_row < 0 or v_row > 14 or v_col < 0 or v_col > 14 then
        raise exception 'Tile out of board bounds: (%, %)', v_row, v_col;
      end if;
      if v_letter !~ '^[A-Z]$' then
        raise exception 'Tile letter must be A-Z, got: %', v_letter;
      end if;

      v_idx := v_row * v_dim + v_col;
      if v_idx = any(v_placed_idx) then
        raise exception 'Two tiles at the same square (%, %)', v_row, v_col;
      end if;
      if substr(v_new_board, v_idx + 1, 1) <> '.' then
        raise exception 'Square (%, %) is already occupied', v_row, v_col;
      end if;

      -- Consume the matching rack token. Blanks use '?' on the rack but
      -- score 0 and store as lowercase on the board.
      v_token := case when v_blank then '?' else v_letter end;
      v_rack_check := public._scrabble_remove_char(v_rack_check, v_token);
      if v_rack_check is null then
        raise exception 'Tile % not in rack', v_token;
      end if;

      -- Stamp the working board: uppercase for natural tiles, lowercase
      -- for blanks-played-as-letter. The lowercase distinction is what
      -- lets the scorer skip blanks during point calculation.
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

    -- Determine axis from row/column spread.
    if v_min_r = v_max_r and v_min_c = v_max_c then
      -- Single tile — axis decision deferred; we test both directions for
      -- the main word below and pick whichever yields the longer one.
      v_axis := 'auto';
    elsif v_min_r = v_max_r then
      v_axis := 'across';
    elsif v_min_c = v_max_c then
      v_axis := 'down';
    else
      raise exception 'Tiles must all share a single row or single column';
    end if;

    -- First-move test (must cover centre + place ≥2 tiles for a 1-tile
    -- play to make a word it must connect — that's checked by the
    -- connectivity loop further down, which auto-fires on subsequent
    -- moves).
    v_first_move := (v_next_ply = 1);
    if v_first_move then
      if not (7 * v_dim + 7) = any(v_placed_idx) then
        raise exception 'The first move must cover the centre square';
      end if;
      if v_tile_count < 2 then
        raise exception 'The first move must place at least two tiles';
      end if;
    end if;

    -- Contiguity test: every square in [min..max] along the axis must be
    -- non-empty on the new board. Existing letters in between are fine —
    -- they just extend the word.
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

    -- ── Build main word + cross-words and tally their score.
    -- For each "word run" (the main word + every cross-word that crosses
    -- a newly-placed tile and is ≥2 letters long), we accumulate
    -- (chars + multipliers) and add the result to v_score.

    -- Local closures aren't a thing in plpgsql, so the word-walk + scoring
    -- logic is open-coded twice (main word, then cross words).

    -- Helper macro-style block: walk along the axis from (r, c) collecting
    -- the maximal contiguous word.
    -- (Re-used three times — written out inline rather than via a sub-
    -- function to keep this migration self-contained.)

    -- ── Main word ──
    if v_axis = 'across' or (v_axis = 'auto' and true) then
      -- Across walk from min_c leftward, then min_c rightward.
      v_r := v_min_r;
      v_c := v_min_c;
      while v_c > 0 and substr(v_new_board, v_r * v_dim + v_c, 1) <> '.' loop
        v_c := v_c - 1;
      end loop;
      -- v_c is now either 0 or sitting on a dot — step forward to the first letter.
      if substr(v_new_board, v_r * v_dim + v_c + 1, 1) = '.' then v_c := v_c + 1; end if;
      v_word_chars := '';
      v_word_score := 0;
      v_word_mult  := 1;
      while v_c < v_dim and substr(v_new_board, v_r * v_dim + v_c + 1, 1) <> '.' loop
        v_letter := substr(v_new_board, v_r * v_dim + v_c + 1, 1);
        v_word_chars := v_word_chars || upper(v_letter);
        v_base := case when v_letter ~ '^[a-z]$' then 0
                       else public._scrabble_letter_value(v_letter) end;
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
      -- Down walk from (min_r, min_c).
      v_r := v_min_r;
      v_c := v_min_c;
      while v_r > 0 and substr(v_new_board, (v_r - 1) * v_dim + v_c + 1, 1) <> '.' loop
        v_r := v_r - 1;
      end loop;
      v_word_chars := '';
      v_word_score := 0;
      v_word_mult  := 1;
      while v_r < v_dim and substr(v_new_board, v_r * v_dim + v_c + 1, 1) <> '.' loop
        v_letter := substr(v_new_board, v_r * v_dim + v_c + 1, 1);
        v_word_chars := v_word_chars || upper(v_letter);
        v_base := case when v_letter ~ '^[a-z]$' then 0
                       else public._scrabble_letter_value(v_letter) end;
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

    -- ── Cross-words ──
    -- For each placed tile, walk PERPENDICULAR to the main axis. Tiles
    -- placed on the main axis that don't extend an existing perpendicular
    -- word produce a length-1 "word" which we skip.
    for v_n in 1 .. array_length(v_placed_idx, 1) loop
      v_r := v_placed_rows[v_n];
      v_c := v_placed_cols[v_n];
      if v_axis = 'across' or (v_axis = 'auto' and v_main_word <> '' and v_main_word !~ '^.$') then
        -- Cross direction = down.
        v_r := v_placed_rows[v_n];
        while v_r > 0 and substr(v_new_board, (v_r - 1) * v_dim + v_c + 1, 1) <> '.' loop
          v_r := v_r - 1;
        end loop;
        v_word_chars := '';
        v_word_score := 0;
        v_word_mult  := 1;
        while v_r < v_dim and substr(v_new_board, v_r * v_dim + v_c + 1, 1) <> '.' loop
          v_letter := substr(v_new_board, v_r * v_dim + v_c + 1, 1);
          v_word_chars := v_word_chars || upper(v_letter);
          v_base := case when v_letter ~ '^[a-z]$' then 0
                         else public._scrabble_letter_value(v_letter) end;
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
        -- axis 'down' → cross direction = across.
        v_c := v_placed_cols[v_n];
        v_r := v_placed_rows[v_n];
        while v_c > 0 and substr(v_new_board, v_r * v_dim + v_c, 1) <> '.' loop
          v_c := v_c - 1;
        end loop;
        v_word_chars := '';
        v_word_score := 0;
        v_word_mult  := 1;
        while v_c < v_dim and substr(v_new_board, v_r * v_dim + v_c + 1, 1) <> '.' loop
          v_letter := substr(v_new_board, v_r * v_dim + v_c + 1, 1);
          v_word_chars := v_word_chars || upper(v_letter);
          v_base := case when v_letter ~ '^[a-z]$' then 0
                         else public._scrabble_letter_value(v_letter) end;
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

    if v_main_word = '' then
      raise exception 'Move does not form a valid word';
    end if;

    -- Connectivity (only enforced after the first move).
    if not v_first_move then
      v_connected := false;
      -- Connected if either (a) the main word grew by passing through any
      -- pre-existing letter, or (b) some placed tile has an orthogonal
      -- neighbour that was on the board before this move.
      if char_length(v_main_word) > v_tile_count then
        v_connected := true;
      else
        for v_n in 1 .. array_length(v_placed_idx, 1) loop
          v_r := v_placed_rows[v_n];
          v_c := v_placed_cols[v_n];
          -- Check four orthogonal neighbours on the OLD board (v_game.board).
          if v_r > 0  and substr(v_game.board, (v_r - 1) * v_dim + v_c + 1, 1) <> '.' then
            v_connected := true; exit;
          end if;
          if v_r < 14 and substr(v_game.board, (v_r + 1) * v_dim + v_c + 1, 1) <> '.' then
            v_connected := true; exit;
          end if;
          if v_c > 0  and substr(v_game.board, v_r * v_dim + v_c, 1) <> '.' then
            v_connected := true; exit;
          end if;
          if v_c < 14 and substr(v_game.board, v_r * v_dim + v_c + 2, 1) <> '.' then
            v_connected := true; exit;
          end if;
        end loop;
      end if;
      if not v_connected then
        raise exception 'Move must connect to at least one existing tile';
      end if;
    end if;

    -- Dictionary check: main word + every cross word must exist. Lower-case
    -- blanks on the board were already upper-cased when we built each word
    -- string, so the lookup is straightforward.
    select not exists (
      select 1 from public.scrabble_words where word = v_main_word
    ) into v_exists;
    if v_exists then
      raise exception 'Not a valid word: %', v_main_word;
    end if;
    foreach v_word in array v_cross_words loop
      select not exists (
        select 1 from public.scrabble_words where word = v_word
      ) into v_exists;
      if v_exists then
        raise exception 'Not a valid word: %', v_word;
      end if;
    end loop;

    -- Bingo bonus.
    if v_tile_count = 7 then
      v_score := v_score + 50;
    end if;

    -- Draw replacements. Tiles drawn = min(tiles played, bag length).
    v_n_draw := least(v_tile_count, char_length(v_bag));
    v_drawn  := substr(v_bag, 1, v_n_draw);
    v_bag    := substr(v_bag, v_n_draw + 1);
    v_rack   := v_rack_check || v_drawn;

    -- Apply state.
    update public.arena_scrabble_racks
       set rack = v_rack, updated_at = now()
     where game_id = p_game_id and player_user_id = auth.uid();

    update public.arena_scrabble_bags
       set bag = v_bag, updated_at = now()
     where game_id = p_game_id;

    if v_my_num = 1 then
      v_new_score := v_game.player1_score + v_score;
      update public.arena_scrabble_games
         set board                    = v_new_board,
             player1_score            = v_new_score,
             to_move                  = 2,
             consecutive_zero_scores  = 0,
             tiles_in_bag             = char_length(v_bag),
             draw_offer_by            = null,
             last_move_at             = now()
       where id = p_game_id;
    else
      v_new_score := v_game.player2_score + v_score;
      update public.arena_scrabble_games
         set board                    = v_new_board,
             player2_score            = v_new_score,
             to_move                  = 1,
             consecutive_zero_scores  = 0,
             tiles_in_bag             = char_length(v_bag),
             draw_offer_by            = null,
             last_move_at             = now()
       where id = p_game_id;
    end if;

    -- End-game flag: bag empty AND the player who just moved emptied their
    -- rack. We don't change game.status here — the client picks up the
    -- end_hint via Realtime + writes the final arena_scrabble_matches row
    -- with the leftover-tile adjustment (which depends on BOTH players'
    -- racks and is therefore better handled by the end-game RPC added in
    -- S8 — for now we just flag it).
    if char_length(v_bag) = 0 and char_length(v_rack) = 0 then
      v_end_hint := 'out_of_tiles';
    end if;

    -- Build the move payload AFTER all updates so the row has the final
    -- state.
    v_payload := jsonb_build_object(
      'tiles',       p_tiles,
      'main_word',   v_main_word,
      'cross_words', to_jsonb(v_cross_words),
      'axis',        v_axis
    );

    insert into public.arena_scrabble_moves (
      game_id, ply, player_user_id, kind, payload, score, clock_remaining_ms
    ) values (
      p_game_id, v_next_ply, auth.uid(), 'play', v_payload, v_score, p_clock_remaining_ms
    );

  else
    raise exception 'Unknown move kind: % (expected play / exchange / pass)', p_kind;
  end if;

  -- Re-read the post-update game row so we return consistent values.
  select * into v_game from public.arena_scrabble_games where id = p_game_id;

  return jsonb_build_object(
    'ok',           true,
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
