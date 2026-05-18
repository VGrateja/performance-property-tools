-- =============================================================================
-- 018_arena_scrabble.sql — Arena Scrabble Phase 1 (schema only)
--
-- Skeleton for two-player online Scrabble. Parallel to the chess tables
-- (005_arena_chess.sql, 006_arena_chess_online.sql), but with a few extra
-- pieces that Scrabble needs and chess doesn't:
--
--   scrabble_words            → SOWPODS dictionary lookup. Seeded once via
--                               scripts/seed-scrabble-words.mjs (~270k rows).
--                               Read-only for clients.
--   arena_scrabble_challenges → pending invitations.
--   arena_scrabble_games      → live game state (board, scores, to_move,
--                               tile-bag count). Public-readable so spectators
--                               work. Racks + bag composition live in
--                               separate tables so opponents can't peek.
--   arena_scrabble_racks      → per-player rack contents. RLS hides the
--                               opponent's rack.
--   arena_scrabble_bags       → the actual unshuffled-letter pool remaining.
--                               RLS locks all reads/writes from clients;
--                               only security-definer RPCs touch it.
--   arena_scrabble_moves      → move-by-move audit log. Source of truth for
--                               replay / late-join state reconstruction.
--   arena_scrabble_matches    → completed-game history (mirrors
--                               arena_chess_matches). Drives the leaderboard.
--   arena_scrabble_points     → view that aggregates the latest ranked
--                               points per player.
--   accept_scrabble_challenge → atomic challenge-accept RPC: resolves the
--                               first-move coin flip, shuffles a fresh bag,
--                               deals two racks, and creates the game.
--
-- submit_scrabble_move (the placement-validation + scoring RPC) is added in
-- migration 019, since it depends on scrabble_words being seeded first.
--
-- Run order: after 017_*.sql. Re-runnable (everything guarded with
-- `if not exists` / drop-then-create on policies).
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- scrabble_words — the dictionary. Seeded out-of-band by the seed script.
-- We store one row per word, uppercase. PK is the word itself so existence
-- lookups are an index hit. ~270k rows for SOWPODS.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.scrabble_words (
  word text primary key
);

alter table public.scrabble_words enable row level security;

drop policy if exists "authenticated read scrabble words" on public.scrabble_words;

-- Anyone authenticated can look up words. No INSERT/UPDATE/DELETE policy is
-- defined, so client roles can't mutate the dictionary — only the
-- service-role key (which bypasses RLS) can seed it.
create policy "authenticated read scrabble words"
  on public.scrabble_words for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- arena_scrabble_matches — historical record of completed games. Mirrors
-- arena_chess_matches and drives the leaderboard view further down.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.arena_scrabble_matches (
  id                   bigserial    primary key,
  -- Denormalised identity (same trick as arena_chess_matches — keeps the
  -- leaderboard renderable even when profiles RLS hides a peer).
  player1_email        text         not null,
  player2_email        text         not null,
  player1_name         text,
  player2_name         text,
  -- 1 = player1 wins, 2 = player2 wins, draw = tied final score.
  result               text         not null check (result in ('1-0', '0-1', '1/2-1/2')),
  -- Standard end-of-game conditions. 'manual' is reserved for back-fill
  -- entries logged from in-person play.
  termination          text         not null check (termination in (
                                        'out_of_tiles', 'six_passes',
                                        'resign', 'timeout', 'agreement',
                                        'manual')),
  ranked               boolean      not null default true,
  time_control         text         not null default 'untimed',
  -- Final raw scores (post leftover-tile adjustment).
  player1_score        int          not null,
  player2_score        int          not null,
  -- Points snapshots so ELO math is reproducible from the row.
  player1_pts_before   int          not null,
  player2_pts_before   int          not null,
  player1_pts_after    int          not null,
  player2_pts_after    int          not null,
  created_by_user_id   uuid         not null references public.profiles(id) on delete cascade,
  created_by_email     text         not null,
  started_at           timestamptz,
  ended_at             timestamptz  not null default now(),
  created_at           timestamptz  not null default now(),
  constraint arena_scrabble_distinct_players check (lower(player1_email) <> lower(player2_email))
);

create index if not exists arena_scrabble_matches_p1_idx
  on public.arena_scrabble_matches (lower(player1_email), ended_at desc);
create index if not exists arena_scrabble_matches_p2_idx
  on public.arena_scrabble_matches (lower(player2_email), ended_at desc);
create index if not exists arena_scrabble_matches_ranked_idx
  on public.arena_scrabble_matches (ranked, ended_at desc);

alter table public.arena_scrabble_matches enable row level security;

drop policy if exists "authenticated read arena scrabble matches" on public.arena_scrabble_matches;
drop policy if exists "users insert own arena scrabble matches"   on public.arena_scrabble_matches;
drop policy if exists "writers delete arena scrabble matches"     on public.arena_scrabble_matches;

create policy "authenticated read arena scrabble matches"
  on public.arena_scrabble_matches for select to authenticated using (true);

create policy "users insert own arena scrabble matches"
  on public.arena_scrabble_matches for insert to authenticated
  with check (created_by_user_id = auth.uid());

create policy "writers delete arena scrabble matches"
  on public.arena_scrabble_matches for delete to authenticated
  using (public.is_writer());

-- ─────────────────────────────────────────────────────────────────────────────
-- arena_scrabble_points view — current ranked rating per player. Same shape
-- and provisional rule (first 10 ranked games) as the chess ladder.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.arena_scrabble_points as
  with appearances as (
    select
      lower(player1_email) as email,
      player1_name         as name,
      player1_pts_after    as points,
      ended_at,
      ranked
    from public.arena_scrabble_matches
    union all
    select
      lower(player2_email),
      player2_name,
      player2_pts_after,
      ended_at,
      ranked
    from public.arena_scrabble_matches
  ),
  ranked_only as (
    select * from appearances where ranked = true
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
    (gc.games < 10) as provisional,
    l.ended_at as last_played
  from latest l
  join game_counts gc using (email);

-- ─────────────────────────────────────────────────────────────────────────────
-- arena_scrabble_challenges — pending invitations. Auto-expire after 10 min.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.arena_scrabble_challenges (
  id                       bigserial    primary key,
  challenger_user_id       uuid         not null references public.profiles(id) on delete cascade,
  challengee_user_id       uuid         not null references public.profiles(id) on delete cascade,
  challenger_email         text         not null,
  challengee_email         text         not null,
  challenger_name          text,
  challengee_name          text,
  -- 'yes' = challenger goes first, 'no' = challengee goes first,
  -- 'random' resolved at accept time. (Scrabble's analogue of chess color.)
  challenger_goes_first    text         not null default 'random'
                                            check (challenger_goes_first in ('yes', 'no', 'random')),
  ranked                   boolean      not null default true,
  -- Untimed games use 'untimed' (the default for unranked). Ranked games
  -- pick from '25+0' / '15+0' / '10+0' per the Arena UI.
  time_control             text         not null default 'untimed',
  status                   text         not null default 'pending'
                                            check (status in ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  game_id                  uuid,
  created_at               timestamptz  not null default now(),
  expires_at               timestamptz  not null default (now() + interval '10 minutes'),
  responded_at             timestamptz,
  constraint arena_scrabble_challenges_distinct
    check (challenger_user_id <> challengee_user_id)
);

create index if not exists arena_scrabble_challenges_challengee_idx
  on public.arena_scrabble_challenges (challengee_user_id, status, created_at desc);
create index if not exists arena_scrabble_challenges_challenger_idx
  on public.arena_scrabble_challenges (challenger_user_id, status, created_at desc);

alter table public.arena_scrabble_challenges enable row level security;

drop policy if exists "participants read arena scrabble challenges"  on public.arena_scrabble_challenges;
drop policy if exists "challenger insert arena scrabble challenges"  on public.arena_scrabble_challenges;
drop policy if exists "participants update arena scrabble challenges" on public.arena_scrabble_challenges;

create policy "participants read arena scrabble challenges"
  on public.arena_scrabble_challenges for select to authenticated
  using (auth.uid() in (challenger_user_id, challengee_user_id));

create policy "challenger insert arena scrabble challenges"
  on public.arena_scrabble_challenges for insert to authenticated
  with check (auth.uid() = challenger_user_id);

create policy "participants update arena scrabble challenges"
  on public.arena_scrabble_challenges for update to authenticated
  using (auth.uid() in (challenger_user_id, challengee_user_id))
  with check (auth.uid() in (challenger_user_id, challengee_user_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- arena_scrabble_games — live game state. The board, scores, and turn
-- indicator are public-readable so anyone in the office can spectate; only
-- the two participants can update. Sensitive state (each player's rack and
-- the unshuffled letter pool) is split into separate tables so RLS can
-- properly hide them.
--
-- Board encoding (225 chars row-major a1..o15):
--   '.'        → empty square
--   'A'-'Z'    → placed natural tile (face value)
--   'a'-'z'    → placed blank tile played as that letter (scores 0)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.arena_scrabble_games (
  id                       uuid         primary key default gen_random_uuid(),
  player1_user_id          uuid         not null references public.profiles(id) on delete cascade,
  player2_user_id          uuid         not null references public.profiles(id) on delete cascade,
  player1_email            text         not null,
  player2_email            text         not null,
  player1_name             text,
  player2_name             text,
  status                   text         not null default 'active'
                                            check (status in ('active', 'completed', 'abandoned')),
  ranked                   boolean      not null default true,
  time_control             text         not null default 'untimed',
  player1_pts_before       int          not null,
  player2_pts_before       int          not null,
  -- 225 dots — empty 15×15 board.
  board                    text         not null default repeat('.', 225)
                                            check (length(board) = 225),
  player1_score            int          not null default 0,
  player2_score            int          not null default 0,
  to_move                  int          not null default 1 check (to_move in (1, 2)),
  -- 100 starting tiles minus 14 dealt to the two opening racks.
  tiles_in_bag             int          not null default 86 check (tiles_in_bag between 0 and 100),
  -- Six consecutive zero-score turns (pass/exchange) ends the game in a
  -- draw under official rules. Reset to 0 on any scoring play.
  consecutive_zero_scores  int          not null default 0,
  -- Draw offers: null when no offer pending; '1' or '2' to indicate which
  -- side has the open offer. Cleared on the next move, accept, or decline.
  draw_offer_by            int                       check (draw_offer_by in (1, 2)),
  last_move_at             timestamptz,
  started_at               timestamptz  not null default now(),
  ended_at                 timestamptz,
  created_at               timestamptz  not null default now(),
  constraint arena_scrabble_games_distinct_players check (player1_user_id <> player2_user_id)
);

create index if not exists arena_scrabble_games_p1_idx
  on public.arena_scrabble_games (player1_user_id, status);
create index if not exists arena_scrabble_games_p2_idx
  on public.arena_scrabble_games (player2_user_id, status);
create index if not exists arena_scrabble_games_status_idx
  on public.arena_scrabble_games (status, started_at desc);

alter table public.arena_scrabble_games enable row level security;

drop policy if exists "authenticated read arena scrabble games"  on public.arena_scrabble_games;
drop policy if exists "participants insert arena scrabble games" on public.arena_scrabble_games;
drop policy if exists "participants update arena scrabble games" on public.arena_scrabble_games;

create policy "authenticated read arena scrabble games"
  on public.arena_scrabble_games for select to authenticated using (true);

create policy "participants insert arena scrabble games"
  on public.arena_scrabble_games for insert to authenticated
  with check (auth.uid() in (player1_user_id, player2_user_id));

create policy "participants update arena scrabble games"
  on public.arena_scrabble_games for update to authenticated
  using (auth.uid() in (player1_user_id, player2_user_id))
  with check (auth.uid() in (player1_user_id, player2_user_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- arena_scrabble_racks — per-player rack contents. Each row is one player's
-- current letters in a game. RLS lets only the owning player read their own
-- rack; the opponent and spectators see nothing. All writes happen via the
-- security-definer submit_scrabble_move RPC (added in 019).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.arena_scrabble_racks (
  game_id          uuid         not null references public.arena_scrabble_games(id) on delete cascade,
  player_user_id   uuid         not null references public.profiles(id) on delete cascade,
  -- Up to 7 letters. Uppercase A-Z for natural tiles; '?' for a blank.
  rack             text         not null default '',
  updated_at       timestamptz  not null default now(),
  primary key (game_id, player_user_id),
  constraint arena_scrabble_racks_len check (char_length(rack) <= 7)
);

alter table public.arena_scrabble_racks enable row level security;

drop policy if exists "owner read arena scrabble racks" on public.arena_scrabble_racks;

-- Only the owner of the rack can read it. No INSERT/UPDATE/DELETE policy is
-- defined for client roles — mutations flow through security-definer RPCs.
create policy "owner read arena scrabble racks"
  on public.arena_scrabble_racks for select to authenticated
  using (auth.uid() = player_user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- arena_scrabble_bags — remaining unshuffled letter pool for each live game.
-- Clients NEVER read this directly (revealing it would let players plan
-- against the bag composition). All access goes through security-definer
-- RPCs which draw tiles atomically as part of a move.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.arena_scrabble_bags (
  game_id     uuid         primary key references public.arena_scrabble_games(id) on delete cascade,
  -- Remaining letters concatenated in a fixed shuffle order; the RPC pops
  -- from the front when drawing replacements. Includes '?' for the two
  -- blank tiles.
  bag         text         not null,
  updated_at  timestamptz  not null default now()
);

alter table public.arena_scrabble_bags enable row level security;

-- No SELECT / INSERT / UPDATE / DELETE policies for client roles. Only the
-- service-role and security-definer RPCs can access bag contents.

-- ─────────────────────────────────────────────────────────────────────────────
-- arena_scrabble_moves — per-move audit log. Mirrors arena_chess_moves.
-- Realtime INSERT events on this table are what the opponent's client
-- subscribes to in order to update the board live.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.arena_scrabble_moves (
  game_id              uuid         not null references public.arena_scrabble_games(id) on delete cascade,
  ply                  int          not null check (ply >= 1),
  player_user_id       uuid         not null references public.profiles(id) on delete cascade,
  kind                 text         not null check (kind in ('play', 'exchange', 'pass')),
  -- Structured move payload. For 'play': { tiles:[{row,col,letter,blank}],
  -- main_word, cross_words[], direction:'across'|'down' }. For 'exchange':
  -- { count }. For 'pass': {}.
  payload              jsonb        not null default '{}'::jsonb,
  score                int          not null default 0,
  made_at              timestamptz  not null default now(),
  clock_remaining_ms   int,
  primary key (game_id, ply)
);

create index if not exists arena_scrabble_moves_game_ply_idx
  on public.arena_scrabble_moves (game_id, ply);

alter table public.arena_scrabble_moves enable row level security;

drop policy if exists "authenticated read arena scrabble moves"  on public.arena_scrabble_moves;

-- Anyone authenticated can read the move log (spectate replays). Inserts go
-- through submit_scrabble_move (security definer) only — no client policy.
create policy "authenticated read arena scrabble moves"
  on public.arena_scrabble_moves for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- accept_scrabble_challenge RPC — mirror of accept_chess_challenge. Atomic:
--   1. Lock the challenge row.
--   2. Verify caller is the challengee + challenge is pending + not expired.
--   3. Resolve 'random' first-mover with a server-side coin flip.
--   4. Snapshot both players' current ranked points.
--   5. Build a freshly-shuffled tile bag (100 tiles, standard distribution).
--   6. Deal 7 tiles to each player; remainder goes into arena_scrabble_bags.
--   7. Create the game row + the two rack rows + the bag row.
--   8. Mark the challenge accepted with the new game_id.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.accept_scrabble_challenge(p_challenge_id bigint)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_challenge       record;
  v_first           text;          -- 'yes' / 'no' after coin flip resolution
  v_p1_email        text;
  v_p2_email        text;
  v_p1_name         text;
  v_p2_name         text;
  v_p1_user         uuid;
  v_p2_user         uuid;
  v_p1_pts          int;
  v_p2_pts          int;
  v_game_id         uuid;
  v_bag             text;
  v_p1_rack         text;
  v_p2_rack         text;
begin
  -- Lock the challenge row so two simultaneous accept attempts can't double-create.
  select * into v_challenge
  from public.arena_scrabble_challenges
  where id = p_challenge_id
  for update;

  if not found then
    raise exception 'Challenge % not found', p_challenge_id;
  end if;

  if v_challenge.challengee_user_id <> auth.uid() then
    raise exception 'Only the challengee can accept this challenge';
  end if;

  if v_challenge.status <> 'pending' then
    raise exception 'Challenge is no longer pending (status=%)', v_challenge.status;
  end if;

  if v_challenge.expires_at < now() then
    update public.arena_scrabble_challenges set status = 'expired' where id = p_challenge_id;
    raise exception 'Challenge has expired';
  end if;

  -- Resolve first-mover. 'random' → 50/50 coin flip server-side.
  v_first := v_challenge.challenger_goes_first;
  if v_first = 'random' then
    v_first := case when random() < 0.5 then 'yes' else 'no' end;
  end if;

  if v_first = 'yes' then
    v_p1_email := v_challenge.challenger_email;
    v_p2_email := v_challenge.challengee_email;
    v_p1_name  := v_challenge.challenger_name;
    v_p2_name  := v_challenge.challengee_name;
    v_p1_user  := v_challenge.challenger_user_id;
    v_p2_user  := v_challenge.challengee_user_id;
  else
    v_p1_email := v_challenge.challengee_email;
    v_p2_email := v_challenge.challenger_email;
    v_p1_name  := v_challenge.challengee_name;
    v_p2_name  := v_challenge.challenger_name;
    v_p1_user  := v_challenge.challengee_user_id;
    v_p2_user  := v_challenge.challenger_user_id;
  end if;

  -- Snapshot current ranked points (default 1000 for first-timers).
  select coalesce(
    (select points from public.arena_scrabble_points where email = lower(v_p1_email)),
    1000
  ) into v_p1_pts;
  select coalesce(
    (select points from public.arena_scrabble_points where email = lower(v_p2_email)),
    1000
  ) into v_p2_pts;

  -- Build the standard 100-tile Scrabble bag, shuffle it server-side, then
  -- deal 7 to each player. Standard English distribution:
  --   A:9 B:2 C:2 D:4 E:12 F:2 G:3 H:2 I:9 J:1 K:1 L:4 M:2 N:6 O:8
  --   P:2 Q:1 R:6 S:4 T:6 U:4 V:2 W:2 X:1 Y:2 Z:1   ?:2 (blanks) = 100
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

  -- Pop 7 tiles per player off the front of the shuffled bag.
  v_p1_rack := substr(v_bag, 1,  7);
  v_p2_rack := substr(v_bag, 8, 7);
  v_bag     := substr(v_bag, 15);

  -- Create the game row.
  insert into public.arena_scrabble_games (
    player1_user_id, player2_user_id,
    player1_email, player2_email,
    player1_name, player2_name,
    ranked, time_control,
    player1_pts_before, player2_pts_before,
    tiles_in_bag
  ) values (
    v_p1_user, v_p2_user,
    v_p1_email, v_p2_email,
    v_p1_name, v_p2_name,
    v_challenge.ranked, v_challenge.time_control,
    v_p1_pts, v_p2_pts,
    char_length(v_bag)
  ) returning id into v_game_id;

  insert into public.arena_scrabble_racks (game_id, player_user_id, rack)
    values (v_game_id, v_p1_user, v_p1_rack),
           (v_game_id, v_p2_user, v_p2_rack);

  insert into public.arena_scrabble_bags (game_id, bag)
    values (v_game_id, v_bag);

  -- Link the new game back to the challenge so the challenger's client
  -- (subscribed to its row over Realtime) jumps straight into the board.
  update public.arena_scrabble_challenges
     set status       = 'accepted',
         game_id      = v_game_id,
         responded_at = now()
   where id = p_challenge_id;

  return v_game_id;
end;
$$;

revoke all on function public.accept_scrabble_challenge(bigint) from public;
grant execute on function public.accept_scrabble_challenge(bigint) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime publication — wire the four user-facing tables so clients can
-- subscribe to INSERT/UPDATE events. Bags + racks intentionally NOT added
-- (clients never subscribe to those directly; rack changes are signalled
-- via game/move updates instead).
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'arena_scrabble_challenges'
  ) then
    alter publication supabase_realtime add table public.arena_scrabble_challenges;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'arena_scrabble_games'
  ) then
    alter publication supabase_realtime add table public.arena_scrabble_games;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'arena_scrabble_moves'
  ) then
    alter publication supabase_realtime add table public.arena_scrabble_moves;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'arena_scrabble_racks'
  ) then
    alter publication supabase_realtime add table public.arena_scrabble_racks;
  end if;
end$$;
