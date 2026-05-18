-- =============================================================================
-- 021_arena_scrabble_multiplayer.sql — 2-4 player Scrabble + lobby flow
--
-- Big rewrite. Replaces the 2-player challenge model with a lobby model that
-- supports 2-4 players per game.
--
-- Schema reshape
--   arena_scrabble_challenges                    → dropped (replaced by lobbies)
--   arena_scrabble_lobbies            NEW         → host-created waiting rooms;
--                                                   open to any logged-in staff
--                                                   to browse / request to join
--   arena_scrabble_lobby_players      NEW         → who's joined / requested /
--                                                   been invited per lobby
--   arena_scrabble_games (player1_* / player2_*) → replaced by a join table
--   arena_scrabble_game_players       NEW         → one row per seat (1..N)
--   arena_scrabble_matches (player1_* / player2_*, result) → replaced by a join
--   arena_scrabble_match_players      NEW         → finish_rank + per-player pts
--
-- New RPCs
--   create_scrabble_lobby             host opens an open lobby; auto-joins themselves
--   request_join_scrabble_lobby       any signed-in staff requests to join
--   invite_to_scrabble_lobby          host invites a specific user
--   accept_lobby_invite               invitee accepts
--   decline_lobby_invite              invitee declines
--   accept_join_request               host accepts a request
--   kick_lobby_player                 host kicks someone joined / declines a request
--   leave_scrabble_lobby              player leaves (host leaving cancels lobby)
--   cancel_scrabble_lobby             host cancels
--   start_scrabble_lobby              host starts (≥2 joined); deals racks, makes game
--
-- Updated RPCs
--   submit_scrabble_move              rotates to_move across player_count seats;
--                                     reads/writes seat from game_players
--   settle_scrabble_game              N-player out-of-tiles bonus + pairwise ELO
--                                     (K = 32 / (N-1), summed per opponent pair)
--
-- Migration is destructive in one place: existing player1/player2 columns on
-- games + matches are dropped after their data has been backfilled into the
-- new join tables. Active in-flight games migrate cleanly to the new schema.
--
-- Run order: after 020_*.sql.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 1 — Drop everything that depends on the old player1/player2 columns
-- ─────────────────────────────────────────────────────────────────────────────
drop view if exists public.arena_scrabble_points;
drop function if exists public.accept_scrabble_challenge(bigint);
drop function if exists public.submit_scrabble_move(uuid, text, jsonb, text, int);
drop function if exists public.settle_scrabble_game(uuid, text);
drop table if exists public.arena_scrabble_challenges cascade;

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2 — New tables (lobbies + per-game/match player join tables)
-- ─────────────────────────────────────────────────────────────────────────────

-- Lobbies: host-created waiting rooms; public-browseable.
create table if not exists public.arena_scrabble_lobbies (
  id              uuid         primary key default gen_random_uuid(),
  host_user_id    uuid         not null references public.profiles(id) on delete cascade,
  host_email      text         not null,
  host_name       text,
  max_players     int          not null default 4 check (max_players between 2 and 4),
  ranked          boolean      not null default true,
  time_control    text         not null default 'untimed',
  status          text         not null default 'open'
                                  check (status in ('open', 'started', 'cancelled')),
  game_id         uuid,
  created_at      timestamptz  not null default now(),
  started_at      timestamptz,
  cancelled_at    timestamptz
);

create index if not exists arena_scrabble_lobbies_status_idx
  on public.arena_scrabble_lobbies (status, created_at desc);

alter table public.arena_scrabble_lobbies enable row level security;

drop policy if exists "authenticated read arena scrabble lobbies" on public.arena_scrabble_lobbies;
create policy "authenticated read arena scrabble lobbies"
  on public.arena_scrabble_lobbies for select to authenticated using (true);

-- Lobby members: one row per (user, lobby). status walks the join lifecycle.
create table if not exists public.arena_scrabble_lobby_players (
  lobby_id    uuid         not null references public.arena_scrabble_lobbies(id) on delete cascade,
  user_id     uuid         not null references public.profiles(id) on delete cascade,
  email       text         not null,
  name        text,
  status      text         not null default 'requested'
                              check (status in ('requested', 'invited', 'joined', 'kicked', 'left')),
  joined_at   timestamptz,
  created_at  timestamptz  not null default now(),
  primary key (lobby_id, user_id)
);

create index if not exists arena_scrabble_lobby_players_user_idx
  on public.arena_scrabble_lobby_players (user_id, status);

alter table public.arena_scrabble_lobby_players enable row level security;

drop policy if exists "authenticated read arena scrabble lobby players" on public.arena_scrabble_lobby_players;
create policy "authenticated read arena scrabble lobby players"
  on public.arena_scrabble_lobby_players for select to authenticated using (true);

-- Per-game player rows (replaces player1_*/player2_* columns).
create table if not exists public.arena_scrabble_game_players (
  game_id     uuid  not null references public.arena_scrabble_games(id) on delete cascade,
  seat        int   not null check (seat between 1 and 4),
  user_id     uuid  not null references public.profiles(id) on delete cascade,
  email       text  not null,
  name        text,
  pts_before  int   not null,
  score       int   not null default 0,
  primary key (game_id, seat),
  unique (game_id, user_id)
);

create index if not exists arena_scrabble_game_players_user_idx
  on public.arena_scrabble_game_players (user_id);

alter table public.arena_scrabble_game_players enable row level security;

drop policy if exists "authenticated read arena scrabble game players" on public.arena_scrabble_game_players;
create policy "authenticated read arena scrabble game players"
  on public.arena_scrabble_game_players for select to authenticated using (true);

-- Per-match player rows. finish_rank lets the leaderboard view aggregate any
-- player count cleanly. user_id is nullable to accommodate any historical
-- back-fill rows that didn't carry a profile link.
create table if not exists public.arena_scrabble_match_players (
  match_id     bigint  not null references public.arena_scrabble_matches(id) on delete cascade,
  seat         int     not null check (seat between 1 and 4),
  user_id      uuid,
  email        text    not null,
  name         text,
  score        int     not null,
  pts_before   int     not null,
  pts_after    int     not null,
  finish_rank  int     not null check (finish_rank between 1 and 4),
  primary key (match_id, seat)
);

create index if not exists arena_scrabble_match_players_email_idx
  on public.arena_scrabble_match_players (lower(email));

alter table public.arena_scrabble_match_players enable row level security;

drop policy if exists "authenticated read arena scrabble match players" on public.arena_scrabble_match_players;
create policy "authenticated read arena scrabble match players"
  on public.arena_scrabble_match_players for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 3 — Backfill existing data into the new join tables
-- ─────────────────────────────────────────────────────────────────────────────

-- Games: seat 1 from player1_*, seat 2 from player2_*. The CHECK on user_id
-- non-null is satisfied because every existing game row has both players.
insert into public.arena_scrabble_game_players (game_id, seat, user_id, email, name, pts_before, score)
  select id, 1, player1_user_id, player1_email, player1_name, player1_pts_before, player1_score
  from public.arena_scrabble_games
  where player1_user_id is not null
on conflict do nothing;

insert into public.arena_scrabble_game_players (game_id, seat, user_id, email, name, pts_before, score)
  select id, 2, player2_user_id, player2_email, player2_name, player2_pts_before, player2_score
  from public.arena_scrabble_games
  where player2_user_id is not null
on conflict do nothing;

-- Matches: derive finish_rank from the old 'result' string.
insert into public.arena_scrabble_match_players (
  match_id, seat, user_id, email, name, score, pts_before, pts_after, finish_rank
)
  select id, 1, null, player1_email, player1_name,
         player1_score, player1_pts_before, player1_pts_after,
         case result when '1-0' then 1 when '0-1' then 2 else 1 end
  from public.arena_scrabble_matches
on conflict do nothing;

insert into public.arena_scrabble_match_players (
  match_id, seat, user_id, email, name, score, pts_before, pts_after, finish_rank
)
  select id, 2, null, player2_email, player2_name,
         player2_score, player2_pts_before, player2_pts_after,
         case result when '0-1' then 1 when '1-0' then 2 else 1 end
  from public.arena_scrabble_matches
on conflict do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 4 — Reshape games + matches (drop old columns, add new ones)
-- ─────────────────────────────────────────────────────────────────────────────

-- Games: add player_count + relax 2-player constraints.
alter table public.arena_scrabble_games
  add column if not exists player_count int not null default 2;

-- Loosen to_move + draw_offer_by to allow 1..4.
alter table public.arena_scrabble_games drop constraint if exists arena_scrabble_games_to_move_check;
alter table public.arena_scrabble_games add constraint arena_scrabble_games_to_move_check
  check (to_move between 1 and 4);
alter table public.arena_scrabble_games drop constraint if exists arena_scrabble_games_draw_offer_by_check;
alter table public.arena_scrabble_games add constraint arena_scrabble_games_draw_offer_by_check
  check (draw_offer_by is null or draw_offer_by between 1 and 4);

-- Distinct-player constraint was 2-player specific; uniqueness now enforced
-- via the unique constraint on arena_scrabble_game_players (game_id, user_id).
alter table public.arena_scrabble_games drop constraint if exists arena_scrabble_games_distinct_players;

-- Update player_count for backfilled rows (all have 2 players).
update public.arena_scrabble_games set player_count = 2 where player_count is null;

-- Drop the old RLS policies that reference player1_user_id / player2_user_id
-- BEFORE dropping the columns themselves. Replacements created further down
-- using the arena_scrabble_game_players join table.
drop policy if exists "participants insert arena scrabble games" on public.arena_scrabble_games;
drop policy if exists "participants update arena scrabble games" on public.arena_scrabble_games;

-- Drop old player columns (data lives in the join table now).
alter table public.arena_scrabble_games drop column if exists player1_user_id;
alter table public.arena_scrabble_games drop column if exists player2_user_id;
alter table public.arena_scrabble_games drop column if exists player1_email;
alter table public.arena_scrabble_games drop column if exists player2_email;
alter table public.arena_scrabble_games drop column if exists player1_name;
alter table public.arena_scrabble_games drop column if exists player2_name;
alter table public.arena_scrabble_games drop column if exists player1_score;
alter table public.arena_scrabble_games drop column if exists player2_score;
alter table public.arena_scrabble_games drop column if exists player1_pts_before;
alter table public.arena_scrabble_games drop column if exists player2_pts_before;

-- Drop the by-player indexes too (they reference the dropped columns).
drop index if exists arena_scrabble_games_p1_idx;
drop index if exists arena_scrabble_games_p2_idx;

-- Matches: add player_count + game_id link, drop old per-player columns + result string.
alter table public.arena_scrabble_matches
  add column if not exists player_count int not null default 2;
-- game_id links a match row back to the game it was settled from, so the
-- "opponent" client can fetch the just-inserted match row in O(1) without
-- joining on player email sets.
alter table public.arena_scrabble_matches
  add column if not exists game_id uuid references public.arena_scrabble_games(id) on delete set null;
create index if not exists arena_scrabble_matches_game_id_idx
  on public.arena_scrabble_matches (game_id);
alter table public.arena_scrabble_matches drop column if exists player1_email;
alter table public.arena_scrabble_matches drop column if exists player2_email;
alter table public.arena_scrabble_matches drop column if exists player1_name;
alter table public.arena_scrabble_matches drop column if exists player2_name;
alter table public.arena_scrabble_matches drop column if exists player1_score;
alter table public.arena_scrabble_matches drop column if exists player2_score;
alter table public.arena_scrabble_matches drop column if exists player1_pts_before;
alter table public.arena_scrabble_matches drop column if exists player2_pts_before;
alter table public.arena_scrabble_matches drop column if exists player1_pts_after;
alter table public.arena_scrabble_matches drop column if exists player2_pts_after;
alter table public.arena_scrabble_matches drop column if exists result;
alter table public.arena_scrabble_matches drop constraint if exists arena_scrabble_distinct_players;

-- Drop the by-player indexes too.
drop index if exists arena_scrabble_matches_p1_idx;
drop index if exists arena_scrabble_matches_p2_idx;

-- Recreate the UPDATE policy on arena_scrabble_games using the new
-- join table. Clients still need to update draw_offer_by directly
-- (draw-offer flow), so we keep a participant-only UPDATE allowed.
-- No INSERT policy: game rows are only created by the security-definer
-- start_scrabble_lobby RPC, so direct INSERTs from clients should fail.
drop policy if exists "participants update arena scrabble games" on public.arena_scrabble_games;
create policy "participants update arena scrabble games"
  on public.arena_scrabble_games for update to authenticated
  using (
    exists (
      select 1 from public.arena_scrabble_game_players gp
      where gp.game_id = arena_scrabble_games.id and gp.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.arena_scrabble_game_players gp
      where gp.game_id = arena_scrabble_games.id and gp.user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 5 — Recreate the leaderboard view from the join table
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.arena_scrabble_points as
  with appearances as (
    select lower(mp.email) as email,
           mp.name          as name,
           mp.pts_after     as points,
           m.ended_at       as ended_at,
           m.ranked         as ranked
    from public.arena_scrabble_match_players mp
    join public.arena_scrabble_matches m on m.id = mp.match_id
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
-- Phase 6 — Lobby management RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- create_scrabble_lobby — host creates an open lobby and is auto-joined.
create or replace function public.create_scrabble_lobby(
  p_max_players  int  default 4,
  p_ranked       boolean default true,
  p_time_control text default 'untimed'
)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text;
  v_name   text;
  v_id     uuid;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  if p_max_players not between 2 and 4 then
    raise exception 'max_players must be 2, 3 or 4';
  end if;

  select email into v_email from auth.users where id = v_uid;
  if v_email is null then raise exception 'Could not resolve caller email'; end if;
  v_name := split_part(v_email, '@', 1);

  insert into public.arena_scrabble_lobbies (
    host_user_id, host_email, host_name, max_players, ranked, time_control
  ) values (
    v_uid, v_email, v_name, p_max_players, p_ranked, coalesce(p_time_control, 'untimed')
  ) returning id into v_id;

  -- Host auto-joins as the first member.
  insert into public.arena_scrabble_lobby_players (lobby_id, user_id, email, name, status, joined_at)
    values (v_id, v_uid, v_email, v_name, 'joined', now());

  return v_id;
end;
$$;
revoke all on function public.create_scrabble_lobby(int, boolean, text) from public;
grant execute on function public.create_scrabble_lobby(int, boolean, text) to authenticated;


-- request_join_scrabble_lobby — any signed-in user can request to join.
create or replace function public.request_join_scrabble_lobby(p_lobby_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text;
  v_name   text;
  v_lobby  record;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;

  select * into v_lobby from public.arena_scrabble_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.status <> 'open' then raise exception 'Lobby is no longer open'; end if;
  if v_lobby.host_user_id = v_uid then return; end if;   -- host's already joined

  select email into v_email from auth.users where id = v_uid;
  v_name := split_part(v_email, '@', 1);

  insert into public.arena_scrabble_lobby_players (lobby_id, user_id, email, name, status)
    values (p_lobby_id, v_uid, v_email, v_name, 'requested')
  on conflict (lobby_id, user_id) do update
    set status = case
      when arena_scrabble_lobby_players.status = 'invited' then 'joined'
      when arena_scrabble_lobby_players.status in ('left', 'kicked') then 'requested'
      else arena_scrabble_lobby_players.status
    end,
    joined_at = case when arena_scrabble_lobby_players.status = 'invited' then now() else arena_scrabble_lobby_players.joined_at end;
end;
$$;
revoke all on function public.request_join_scrabble_lobby(uuid) from public;
grant execute on function public.request_join_scrabble_lobby(uuid) to authenticated;


-- invite_to_scrabble_lobby — host invites a specific user.
create or replace function public.invite_to_scrabble_lobby(p_lobby_id uuid, p_invitee_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_lobby  record;
  v_email  text;
  v_name   text;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;

  select * into v_lobby from public.arena_scrabble_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_user_id <> v_uid then raise exception 'Only the host can invite'; end if;
  if v_lobby.status <> 'open' then raise exception 'Lobby is no longer open'; end if;

  select email into v_email from auth.users where id = p_invitee_id;
  if v_email is null then raise exception 'Invitee not found'; end if;
  v_name := split_part(v_email, '@', 1);

  insert into public.arena_scrabble_lobby_players (lobby_id, user_id, email, name, status)
    values (p_lobby_id, p_invitee_id, v_email, v_name, 'invited')
  on conflict (lobby_id, user_id) do update
    set status = 'invited'
    where arena_scrabble_lobby_players.status in ('left', 'kicked', 'requested');
end;
$$;
revoke all on function public.invite_to_scrabble_lobby(uuid, uuid) from public;
grant execute on function public.invite_to_scrabble_lobby(uuid, uuid) to authenticated;


-- accept_lobby_invite — invitee accepts; status invited → joined.
create or replace function public.accept_lobby_invite(p_lobby_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_lobby  record;
  v_row    record;
  v_count  int;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;

  select * into v_lobby from public.arena_scrabble_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.status <> 'open' then raise exception 'Lobby is no longer open'; end if;

  select * into v_row from public.arena_scrabble_lobby_players
    where lobby_id = p_lobby_id and user_id = v_uid for update;
  if not found then raise exception 'No invite found for you on this lobby'; end if;
  if v_row.status <> 'invited' then raise exception 'You are not currently invited (status=%)', v_row.status; end if;

  select count(*) into v_count from public.arena_scrabble_lobby_players
    where lobby_id = p_lobby_id and status = 'joined';
  if v_count >= v_lobby.max_players then raise exception 'Lobby is full'; end if;

  update public.arena_scrabble_lobby_players
     set status = 'joined', joined_at = now()
   where lobby_id = p_lobby_id and user_id = v_uid;
end;
$$;
revoke all on function public.accept_lobby_invite(uuid) from public;
grant execute on function public.accept_lobby_invite(uuid) to authenticated;


-- decline_lobby_invite — invitee declines; row flipped to 'left'.
create or replace function public.decline_lobby_invite(p_lobby_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  update public.arena_scrabble_lobby_players
     set status = 'left'
   where lobby_id = p_lobby_id and user_id = v_uid and status = 'invited';
end;
$$;
revoke all on function public.decline_lobby_invite(uuid) from public;
grant execute on function public.decline_lobby_invite(uuid) to authenticated;


-- accept_join_request — host accepts a request; status requested → joined.
create or replace function public.accept_join_request(p_lobby_id uuid, p_requester_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_lobby  record;
  v_count  int;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_lobby from public.arena_scrabble_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_user_id <> v_uid then raise exception 'Only the host can accept requests'; end if;
  if v_lobby.status <> 'open' then raise exception 'Lobby is no longer open'; end if;

  select count(*) into v_count from public.arena_scrabble_lobby_players
    where lobby_id = p_lobby_id and status = 'joined';
  if v_count >= v_lobby.max_players then raise exception 'Lobby is full'; end if;

  update public.arena_scrabble_lobby_players
     set status = 'joined', joined_at = now()
   where lobby_id = p_lobby_id and user_id = p_requester_id and status = 'requested';
end;
$$;
revoke all on function public.accept_join_request(uuid, uuid) from public;
grant execute on function public.accept_join_request(uuid, uuid) to authenticated;


-- kick_lobby_player — host kicks someone joined OR declines a request.
create or replace function public.kick_lobby_player(p_lobby_id uuid, p_target_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_lobby record;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_lobby from public.arena_scrabble_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_user_id <> v_uid then raise exception 'Only the host can kick'; end if;
  if v_lobby.host_user_id = p_target_id then raise exception 'Host cannot kick themselves'; end if;
  update public.arena_scrabble_lobby_players
     set status = 'kicked'
   where lobby_id = p_lobby_id and user_id = p_target_id;
end;
$$;
revoke all on function public.kick_lobby_player(uuid, uuid) from public;
grant execute on function public.kick_lobby_player(uuid, uuid) to authenticated;


-- leave_scrabble_lobby — any player leaves. If the host leaves, the lobby is cancelled.
create or replace function public.leave_scrabble_lobby(p_lobby_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_lobby record;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_lobby from public.arena_scrabble_lobbies where id = p_lobby_id for update;
  if not found then return; end if;

  update public.arena_scrabble_lobby_players
     set status = 'left'
   where lobby_id = p_lobby_id and user_id = v_uid;

  if v_lobby.host_user_id = v_uid and v_lobby.status = 'open' then
    update public.arena_scrabble_lobbies
       set status = 'cancelled', cancelled_at = now()
     where id = p_lobby_id;
  end if;
end;
$$;
revoke all on function public.leave_scrabble_lobby(uuid) from public;
grant execute on function public.leave_scrabble_lobby(uuid) to authenticated;


-- cancel_scrabble_lobby — host explicit cancel.
create or replace function public.cancel_scrabble_lobby(p_lobby_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_lobby record;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_lobby from public.arena_scrabble_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_user_id <> v_uid then raise exception 'Only the host can cancel'; end if;
  if v_lobby.status <> 'open' then return; end if;
  update public.arena_scrabble_lobbies
     set status = 'cancelled', cancelled_at = now()
   where id = p_lobby_id;
end;
$$;
revoke all on function public.cancel_scrabble_lobby(uuid) from public;
grant execute on function public.cancel_scrabble_lobby(uuid) to authenticated;


-- start_scrabble_lobby — host starts the game (≥2 joined). Atomic:
--   1. Lock lobby + verify host + ≥2 joined.
--   2. Build a shuffled 100-tile bag.
--   3. Deal 7 tiles to each joined player.
--   4. Create arena_scrabble_games row with player_count.
--   5. Create arena_scrabble_game_players rows (seats assigned 1..N in join order).
--   6. Create arena_scrabble_racks + arena_scrabble_bags rows.
--   7. Flip lobby to status='started' + link game_id.
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

  -- Build the shuffled 100-tile bag (same distribution as the 2-player flow).
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

  -- Create the game row first so we have an id to attach players to. The
  -- host is always seat 1 so they go first; the rest follow in join order.
  insert into public.arena_scrabble_games (
    player_count, status, ranked, time_control, board, to_move, tiles_in_bag
  ) values (
    v_n, 'active', v_lobby.ranked, v_lobby.time_control,
    repeat('.', 225), 1, char_length(v_bag) - (v_n * 7)
  ) returning id into v_game_id;

  -- Walk joined players: host first, then everyone else in join-time order.
  for v_players in
    select lp.user_id, lp.email, lp.name
    from public.arena_scrabble_lobby_players lp
    where lp.lobby_id = p_lobby_id and lp.status = 'joined'
    order by case when lp.user_id = v_lobby.host_user_id then 0 else 1 end,
             lp.joined_at nulls last
  loop
    v_seat := v_seat + 1;
    -- Snapshot current ranked points (defaults to 1000 for newbies).
    select coalesce(
      (select points from public.arena_scrabble_points where email = lower(v_players.email)),
      1000
    ) into v_pts;

    insert into public.arena_scrabble_game_players (
      game_id, seat, user_id, email, name, pts_before, score
    ) values (v_game_id, v_seat, v_players.user_id, v_players.email, v_players.name, v_pts, 0);

    -- Pop 7 tiles off the front of the shuffled bag.
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
revoke all on function public.start_scrabble_lobby(uuid) from public;
grant execute on function public.start_scrabble_lobby(uuid) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 7 — submit_scrabble_move (rotates to_move across player_count seats)
-- Same placement / scoring rules as the 2-player version; only the turn-flip
-- arithmetic changes (next = to_move % player_count + 1) and the score lives
-- in arena_scrabble_game_players instead of player1_score / player2_score.
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
begin
  select * into v_game from public.arena_scrabble_games where id = p_game_id for update;
  if not found then raise exception 'Game % not found', p_game_id; end if;
  if v_game.status <> 'active' then raise exception 'Game is no longer active (status=%)', v_game.status; end if;

  -- Find caller's seat via the join table.
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
       set to_move = v_next_to_move,
           consecutive_zero_scores = v_consec,
           draw_offer_by = null,
           last_move_at = now()
     where id = p_game_id;

  -- ── EXCHANGE ────────────────────────────────────────────────────────────
  elsif p_kind = 'exchange' then
    v_exch_letters := upper(coalesce(p_exchange_letters, ''));
    v_exch_n := char_length(v_exch_letters);
    if v_exch_n = 0 or v_exch_n > 7 then raise exception 'Exchange must specify 1-7 letters'; end if;
    if char_length(v_bag) < 7 then raise exception 'Cannot exchange — fewer than 7 tiles remain in the bag'; end if;

    v_rack_check := v_rack;
    for v_n in 1 .. v_exch_n loop
      v_letter := substr(v_exch_letters, v_n, 1);
      v_rack_check := public._scrabble_remove_char(v_rack_check, v_letter);
      if v_rack_check is null then raise exception 'Exchange letter % not in rack', v_letter; end if;
    end loop;

    v_drawn := substr(v_bag, 1, v_exch_n);
    v_bag   := substr(v_bag, v_exch_n + 1);
    v_bag := public._scrabble_shuffle_text(v_bag || v_exch_letters);
    v_rack := v_rack_check || v_drawn;

    v_consec := v_consec + 1;
    if v_consec >= 6 then v_end_hint := 'six_passes'; end if;

    insert into public.arena_scrabble_moves (
      game_id, ply, player_user_id, kind, payload, score, clock_remaining_ms
    ) values (
      p_game_id, v_next_ply, auth.uid(), 'exchange',
      jsonb_build_object('count', v_exch_n), 0, p_clock_remaining_ms
    );

    update public.arena_scrabble_racks set rack = v_rack, updated_at = now()
      where game_id = p_game_id and player_user_id = auth.uid();
    update public.arena_scrabble_bags  set bag = v_bag, updated_at = now()
      where game_id = p_game_id;
    update public.arena_scrabble_games
       set to_move = v_next_to_move,
           consecutive_zero_scores = v_consec,
           tiles_in_bag = char_length(v_bag),
           draw_offer_by = null,
           last_move_at = now()
     where id = p_game_id;

  -- ── PLAY ────────────────────────────────────────────────────────────────
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

    v_first_move := (v_next_ply = 1);
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

    -- Main word (across).
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

    -- Cross words.
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
    if v_exists then raise exception 'Not a valid word: %', v_main_word; end if;
    foreach v_word in array v_cross_words loop
      select not exists (select 1 from public.scrabble_words where word = v_word) into v_exists;
      if v_exists then raise exception 'Not a valid word: %', v_word; end if;
    end loop;

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
           last_move_at = now()
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
-- Phase 8 — settle_scrabble_game (multi-player out-of-tiles, pairwise ELO)
--
-- For out_of_tiles: the player who emptied their rack adds the SUM of every
-- other player's leftover-tile value to their score; each other player loses
-- their own leftover. Officially what happens when 3+ players sit at one board.
--
-- ELO: pairwise. K_eff = 32 / (N-1). For each unordered pair (i, j):
--   score_i = 1 if final_i > final_j; 0.5 if tied; 0 otherwise.
--   expected_i = 1 / (1 + 10^((rating_j - rating_i)/400)).
--   delta = K_eff * (score_i - expected_i).
-- Player i's net delta is summed across every j ≠ i.
-- Unranked games freeze points (pts_after = pts_before).
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
  v_resigner_seat   int;
  v_creator_email   text;
  v_match_id        bigint;
  v_k_eff           float;
  v_si              float;
  v_exp             float;
  v_pi              record;
  v_pj              record;
  v_i               int;
  v_j               int;
  v_seats           int[];
  v_scores          int[];
  v_leftover        int[];
  v_pts_before      int[];
  v_pts_after       int[];
  v_finish_rank     int[];
  v_user_ids        uuid[];
  v_emails          text[];
  v_names           text[];
  v_rack            text;
  v_lv              int;
  v_letter          text;
  v_total_leftover  int := 0;
  v_outer_seat      int;
  v_payload         jsonb;
  v_temp_score      int;
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

  -- Pull every seat's current state into parallel arrays so we can compute
  -- leftover values, final scores, and pairwise ELO without re-querying.
  for v_pi in
    select gp.seat, gp.user_id, gp.email, gp.name, gp.score, gp.pts_before,
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

    -- Sum the tile values of the rack we just pulled.
    v_lv := 0;
    for v_i in 1 .. char_length(v_pi.rack) loop
      v_letter := substr(v_pi.rack, v_i, 1);
      v_lv := v_lv + public._scrabble_letter_value(v_letter);
    end loop;
    v_leftover := array_append(v_leftover, v_lv);
    v_total_leftover := v_total_leftover + v_lv;
  end loop;

  -- Apply termination-specific score adjustments.
  case p_termination
    when 'out_of_tiles' then
      if v_game.tiles_in_bag <> 0 then
        raise exception 'Cannot settle out-of-tiles: bag still has % tiles', v_game.tiles_in_bag;
      end if;
      -- Find the player who emptied their rack (one of the leftovers is 0
      -- AND tiles_in_bag is 0). Bonus = sum of OTHER players' leftovers.
      v_outer_seat := null;
      for v_i in 1 .. v_n loop
        if v_leftover[v_i] = 0 then v_outer_seat := v_seats[v_i]; exit; end if;
      end loop;
      if v_outer_seat is null then
        raise exception 'Cannot settle out-of-tiles: no rack is empty';
      end if;
      -- The "outer" gets +sum(others' leftover); everyone else -their own leftover.
      for v_i in 1 .. v_n loop
        if v_seats[v_i] = v_outer_seat then
          v_scores[v_i] := v_scores[v_i] + (v_total_leftover - v_leftover[v_i]);
        else
          v_scores[v_i] := v_scores[v_i] - v_leftover[v_i];
        end if;
      end loop;

    when 'six_passes' then
      if v_game.consecutive_zero_scores < 6 then
        raise exception 'Cannot settle six-passes: only % consecutive zero-score moves recorded',
                        v_game.consecutive_zero_scores;
      end if;
      -- Scores unchanged.

    when 'resign' then
      -- Identify resigner's seat.
      v_resigner_seat := null;
      for v_i in 1 .. v_n loop
        if v_user_ids[v_i] = auth.uid() then v_resigner_seat := v_seats[v_i]; exit; end if;
      end loop;
      -- For multi-player resign, we DEMOTE the resigner to last place
      -- (rank = N) without changing the scoreboard order of the others.
      -- We accomplish that downstream by overriding their score to the
      -- minimum-of-others - 1 so they sort last.
      v_temp_score := v_scores[1];
      for v_i in 1 .. v_n loop
        if v_scores[v_i] < v_temp_score then v_temp_score := v_scores[v_i]; end if;
      end loop;
      for v_i in 1 .. v_n loop
        if v_seats[v_i] = v_resigner_seat then
          v_scores[v_i] := v_temp_score - 1;
        end if;
      end loop;

    when 'agreement' then
      -- Scores unchanged.
      null;
  end case;

  -- Compute finish_rank: 1 = highest score; ties get the same rank
  -- (competition ranking — next rank skips: 1,1,3,4 if two tie for first).
  v_finish_rank := array_fill(0, ARRAY[v_n]);
  for v_i in 1 .. v_n loop
    v_finish_rank[v_i] := 1;
    for v_j in 1 .. v_n loop
      if v_scores[v_j] > v_scores[v_i] then
        v_finish_rank[v_i] := v_finish_rank[v_i] + 1;
      end if;
    end loop;
  end loop;

  -- Pairwise ELO. K_eff = 32 / (N - 1) so total movement per game stays in
  -- the same ballpark regardless of player count. Unranked → freeze.
  v_pts_after := v_pts_before;  -- copy starting ratings
  if v_game.ranked then
    v_k_eff := 32.0 / greatest(v_n - 1, 1);
    for v_i in 1 .. v_n loop
      for v_j in 1 .. v_n loop
        if v_i = v_j then continue; end if;
        if v_scores[v_i] > v_scores[v_j] then v_si := 1.0;
        elsif v_scores[v_i] < v_scores[v_j] then v_si := 0.0;
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
    termination, ranked, time_control, player_count, game_id,
    created_by_user_id, created_by_email,
    started_at, ended_at
  ) values (
    p_termination, v_game.ranked, v_game.time_control, v_n, p_game_id,
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

  -- Build a JSONB array of per-player results for the client.
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
      'finish_rank', v_finish_rank[v_i]
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


-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 9 — Realtime publication for new tables
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public'
                   and tablename = 'arena_scrabble_lobbies') then
    alter publication supabase_realtime add table public.arena_scrabble_lobbies;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public'
                   and tablename = 'arena_scrabble_lobby_players') then
    alter publication supabase_realtime add table public.arena_scrabble_lobby_players;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public'
                   and tablename = 'arena_scrabble_game_players') then
    alter publication supabase_realtime add table public.arena_scrabble_game_players;
  end if;
end$$;
