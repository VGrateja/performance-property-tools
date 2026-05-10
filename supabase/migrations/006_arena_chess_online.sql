-- =============================================================================
-- 006_arena_chess_online.sql — Arena chess Phase 2 (online play)
--
-- Adds the realtime infrastructure for two browsers to play chess against each
-- other. Three new tables, all wired into the supabase_realtime publication so
-- clients can subscribe to changes:
--
--   arena_chess_challenges  → pending invitations (challenger → challengee).
--                             Auto-expire after 10 minutes.
--   arena_chess_games       → live games. Per-row Realtime updates carry
--                             status changes (active → completed / abandoned)
--                             and draw offers between the two clients.
--   arena_chess_moves       → ply-by-ply move log. Source of truth for
--                             reconstructing position on refresh / late join.
--                             INSERTs broadcast over Realtime so the opponent
--                             sees each move in real time.
--
-- arena_chess_matches (from migration 005) stays as the historical record;
-- when a live game ends, the client writes a final row there with PGN
-- reconstructed from arena_chess_moves, then flips arena_chess_games.status to
-- 'completed'. The leaderboard view (arena_chess_points) continues to read
-- from arena_chess_matches only — live games don't move the ladder until
-- they finish.
--
-- RLS:
--   - Challenges are private to the two participants — no third party sees
--     pending invitations between them.
--   - Games + moves are readable by any authenticated user (open spectate
--     story for v2.3) but writeable only by the two participants.
--
-- Run order: after 005_*.sql.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- arena_chess_challenges
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.arena_chess_challenges (
  id                   bigserial    primary key,
  challenger_user_id   uuid         not null references public.profiles(id) on delete cascade,
  challengee_user_id   uuid         not null references public.profiles(id) on delete cascade,
  challenger_email     text         not null,
  challengee_email     text         not null,
  challenger_name      text,
  challengee_name      text,
  -- Color the challenger wants to play. 'random' is resolved at accept time
  -- by the accept_chess_challenge RPC, so the chosen color is locked in
  -- against the resulting arena_chess_games row.
  challenger_color     text         not null default 'random'
                                       check (challenger_color in ('w', 'b', 'random')),
  ranked               boolean      not null default true,
  time_control         text         not null default '20+0',
  status               text         not null default 'pending'
                                       check (status in ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  -- Set on accept; null otherwise. Lets the challenger's client jump
  -- straight to the new game on Realtime UPDATE.
  game_id              uuid,
  created_at           timestamptz  not null default now(),
  -- Auto-expire after 10 minutes. The lobby UI filters out expired rows;
  -- a future cron job can flip status='expired' for rows past expires_at.
  expires_at           timestamptz  not null default (now() + interval '10 minutes'),
  responded_at         timestamptz,
  constraint arena_chess_challenges_distinct check (challenger_user_id <> challengee_user_id)
);

create index if not exists arena_chess_challenges_challengee_idx
  on public.arena_chess_challenges (challengee_user_id, status, created_at desc);
create index if not exists arena_chess_challenges_challenger_idx
  on public.arena_chess_challenges (challenger_user_id, status, created_at desc);

alter table public.arena_chess_challenges enable row level security;

drop policy if exists "participants read arena chess challenges"  on public.arena_chess_challenges;
drop policy if exists "challenger insert arena chess challenges"  on public.arena_chess_challenges;
drop policy if exists "participants update arena chess challenges" on public.arena_chess_challenges;

-- Only the two participants can see the row.
create policy "participants read arena chess challenges"
  on public.arena_chess_challenges for select to authenticated
  using (auth.uid() in (challenger_user_id, challengee_user_id));

-- Only the challenger can insert their own challenge.
create policy "challenger insert arena chess challenges"
  on public.arena_chess_challenges for insert to authenticated
  with check (auth.uid() = challenger_user_id);

-- Either participant can update — challenger to cancel, challengee to
-- accept/decline. The application layer enforces the legal status
-- transitions; the policy only gates *who* can write. accept_chess_challenge
-- (security definer) handles the atomic accept path; this policy covers the
-- simpler decline / cancel cases.
create policy "participants update arena chess challenges"
  on public.arena_chess_challenges for update to authenticated
  using (auth.uid() in (challenger_user_id, challengee_user_id))
  with check (auth.uid() in (challenger_user_id, challengee_user_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- arena_chess_games
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.arena_chess_games (
  id                uuid         primary key default gen_random_uuid(),
  white_user_id     uuid         not null references public.profiles(id) on delete cascade,
  black_user_id     uuid         not null references public.profiles(id) on delete cascade,
  white_email       text         not null,
  black_email       text         not null,
  white_name        text,
  black_name        text,
  status            text         not null default 'active'
                                    check (status in ('active', 'completed', 'abandoned')),
  ranked            boolean      not null default true,
  time_control      text         not null default 'untimed',
  -- Snapshotted at game start so points math is reproducible even if either
  -- player's rating moves in another concurrent game.
  white_pts_before  int          not null,
  black_pts_before  int          not null,
  -- Cached current position for cheap "open the game" rendering. The
  -- arena_chess_moves ply list remains the authoritative source — clients
  -- replay it on join to verify state. The cache is updated by the moving
  -- side after each successful move.
  current_fen       text         not null default 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  current_turn      text         not null default 'w' check (current_turn in ('w', 'b')),
  -- Draw offers: null when no offer pending. The offering side sets it; the
  -- opponent sees a banner via Realtime UPDATE. Cleared by the next move,
  -- accept (queueResult), or decline (UPDATE → null).
  draw_offer_by     text                      check (draw_offer_by in ('w', 'b')),
  started_at        timestamptz  not null default now(),
  ended_at          timestamptz,
  created_at        timestamptz  not null default now(),
  constraint arena_chess_games_distinct_players check (white_user_id <> black_user_id)
);

create index if not exists arena_chess_games_white_idx
  on public.arena_chess_games (white_user_id, status);
create index if not exists arena_chess_games_black_idx
  on public.arena_chess_games (black_user_id, status);
create index if not exists arena_chess_games_status_idx
  on public.arena_chess_games (status, started_at desc);

alter table public.arena_chess_games enable row level security;

drop policy if exists "authenticated read arena chess games"  on public.arena_chess_games;
drop policy if exists "participants insert arena chess games" on public.arena_chess_games;
drop policy if exists "participants update arena chess games" on public.arena_chess_games;

-- Open spectate: any authenticated user can read live games.
create policy "authenticated read arena chess games"
  on public.arena_chess_games for select to authenticated using (true);

-- Both participants can insert (covers the rare manual-create path; the
-- happy path is via the accept_chess_challenge RPC which is security
-- definer and writes regardless of the policy).
create policy "participants insert arena chess games"
  on public.arena_chess_games for insert to authenticated
  with check (auth.uid() in (white_user_id, black_user_id));

-- Only participants can update (status changes, draw offers, ended_at).
create policy "participants update arena chess games"
  on public.arena_chess_games for update to authenticated
  using (auth.uid() in (white_user_id, black_user_id))
  with check (auth.uid() in (white_user_id, black_user_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- arena_chess_moves
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.arena_chess_moves (
  game_id              uuid        not null references public.arena_chess_games(id) on delete cascade,
  ply                  int         not null check (ply >= 1),
  san                  text        not null,
  fen_after            text        not null,
  made_at              timestamptz not null default now(),
  -- Time remaining on the clock of the side that just moved, in ms. Null
  -- for untimed games. Lets late-joiners reconstruct clock state without
  -- replaying every made_at delta.
  clock_remaining_ms   int,
  primary key (game_id, ply)
);

alter table public.arena_chess_moves enable row level security;

drop policy if exists "authenticated read arena chess moves"  on public.arena_chess_moves;
drop policy if exists "participants insert arena chess moves" on public.arena_chess_moves;

-- Open spectate: any authenticated user can read move logs.
create policy "authenticated read arena chess moves"
  on public.arena_chess_moves for select to authenticated using (true);

-- Insert allowed only by a participant of the parent game. The client
-- enforces turn order via chess.js; a malicious client can only append
-- moves to its own games, not anyone else's.
create policy "participants insert arena chess moves"
  on public.arena_chess_moves for insert to authenticated
  with check (
    exists (
      select 1 from public.arena_chess_games g
      where g.id = arena_chess_moves.game_id
        and auth.uid() in (g.white_user_id, g.black_user_id)
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- accept_chess_challenge RPC — atomically accept an invitation and create the
-- live game row, with color resolution and points snapshotting in one txn.
-- security definer so the inserts succeed even if the row-level policies
-- would have rejected them on edge cases.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.accept_chess_challenge(p_challenge_id bigint)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_challenge       record;
  v_color           text;
  v_white_email     text;
  v_black_email     text;
  v_white_name      text;
  v_black_name      text;
  v_white_user      uuid;
  v_black_user      uuid;
  v_white_pts       int;
  v_black_pts       int;
  v_game_id         uuid;
begin
  -- Lock the challenge row for the duration of the transaction.
  select * into v_challenge
  from public.arena_chess_challenges
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
    update public.arena_chess_challenges
       set status = 'expired'
     where id = p_challenge_id;
    raise exception 'Challenge has expired';
  end if;

  -- Resolve color. 'random' uses a 50/50 server-side coin flip so neither
  -- client can pre-determine the outcome.
  v_color := v_challenge.challenger_color;
  if v_color = 'random' then
    v_color := case when random() < 0.5 then 'w' else 'b' end;
  end if;

  if v_color = 'w' then
    v_white_email := v_challenge.challenger_email;
    v_black_email := v_challenge.challengee_email;
    v_white_name  := v_challenge.challenger_name;
    v_black_name  := v_challenge.challengee_name;
    v_white_user  := v_challenge.challenger_user_id;
    v_black_user  := v_challenge.challengee_user_id;
  else
    v_white_email := v_challenge.challengee_email;
    v_black_email := v_challenge.challenger_email;
    v_white_name  := v_challenge.challengee_name;
    v_black_name  := v_challenge.challenger_name;
    v_white_user  := v_challenge.challengee_user_id;
    v_black_user  := v_challenge.challenger_user_id;
  end if;

  -- Snapshot current ranked points; defaults to 1000 for first-time players
  -- (the arena_chess_points view excludes them).
  select coalesce(
    (select points from public.arena_chess_points where email = lower(v_white_email)),
    1000
  ) into v_white_pts;
  select coalesce(
    (select points from public.arena_chess_points where email = lower(v_black_email)),
    1000
  ) into v_black_pts;

  -- Create the game.
  insert into public.arena_chess_games (
    white_user_id, black_user_id,
    white_email, black_email,
    white_name, black_name,
    ranked, time_control,
    white_pts_before, black_pts_before
  ) values (
    v_white_user, v_black_user,
    v_white_email, v_black_email,
    v_white_name, v_black_name,
    v_challenge.ranked, v_challenge.time_control,
    v_white_pts, v_black_pts
  ) returning id into v_game_id;

  -- Mark the challenge accepted + link to the new game so the
  -- challenger's client (subscribed to its row via Realtime) gets the
  -- game_id automatically.
  update public.arena_chess_challenges
     set status       = 'accepted',
         game_id      = v_game_id,
         responded_at = now()
   where id = p_challenge_id;

  return v_game_id;
end;
$$;

-- Allow authenticated users to call the RPC. The function body's auth.uid()
-- check enforces that only the challengee can actually accept.
revoke all on function public.accept_chess_challenge(bigint) from public;
grant execute on function public.accept_chess_challenge(bigint) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime publication — without these, supabase-js channel.subscribe()
-- doesn't receive INSERT/UPDATE events for the tables. Wrapped in a
-- DO block because supabase_realtime already exists by default; we only
-- need to add tables to it. Idempotent — `add table` on an already-
-- published table errors, so we guard with a lookup.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'arena_chess_challenges'
  ) then
    alter publication supabase_realtime add table public.arena_chess_challenges;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'arena_chess_games'
  ) then
    alter publication supabase_realtime add table public.arena_chess_games;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'arena_chess_moves'
  ) then
    alter publication supabase_realtime add table public.arena_chess_moves;
  end if;
end$$;
