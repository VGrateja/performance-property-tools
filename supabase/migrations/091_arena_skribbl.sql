-- =============================================================================
-- 091_arena_skribbl.sql — Arena game #4: Skribbl (draw & guess)
--
-- A Pictionary-style realtime game. One player draws a secret word; everyone
-- else guesses in chat. Points are speed-ranked (first correct guess scores
-- most); the drawer scores on how many players guessed their drawing. The
-- drawer role rotates round-robin so every player draws once per round.
--
-- Modelled on the Scrabble multiplayer stack (021) — same lobby lifecycle,
-- same SECURITY DEFINER RPC style, same realtime publication wiring.
--
-- THE CENTRAL SECURITY CONCERN: the word must stay secret from the guessers.
-- Guessers talk to the same auto-generated REST API as the drawer, so the word
-- can never live on a row they can read. It is therefore kept in
-- arena_skribbl_rounds, whose RLS policy admits ONLY the current drawer (the
-- same ownership-predicate trick arena_scrabble_racks uses for private racks).
-- Everything the guessers legitimately need — the masked hint, the word
-- length, the deadline — is mirrored onto the game row by the RPCs. Guesses
-- are checked server-side in submit_skribbl_guess(), and a correct guess is
-- logged WITHOUT its text so the chat log itself can't leak the answer.
--
-- Tables
--   skribbl_words                 word pool, keyed by topic x difficulty
--   arena_skribbl_lobbies         host-created waiting rooms (2-12 players)
--   arena_skribbl_lobby_players   join lifecycle per lobby
--   arena_skribbl_games           one row per game; the PUBLIC round state
--   arena_skribbl_game_players    one row per seat: score + per-round guess state
--   arena_skribbl_rounds          the SECRET word + the drawer's 3 choices
--   arena_skribbl_guesses         chat log (correct guesses stored text-less)
--   arena_skribbl_matches         finished-game history
--   arena_skribbl_match_players   per-player result rows
--   arena_skribbl_points (view)   the Arena leaderboard: total points per player
--
-- RPCs — lobby:  create / request_join / invite / respond_invite / accept_request
--                / kick / leave / cancel / start / expire_stale
--        game:   choose_word / submit_guess / tick / leave_game
--
-- Timing is server-authoritative: every phase carries phase_ends_at, and
-- skribbl_tick() is the single idempotent advance function. Clients call it
-- when their local countdown expires; it re-checks now() before doing anything,
-- so a laggy or hostile client cannot end a round early.
--
-- Run order: after 090_*.sql.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 1 — Word pool
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.skribbl_words (
  id          bigserial primary key,
  word        text not null,
  topic       text not null,
  difficulty  text not null check (difficulty in ('easy', 'medium', 'hard')),
  unique (word, topic)
);

create index if not exists skribbl_words_pool_idx
  on public.skribbl_words (topic, difficulty);

alter table public.skribbl_words enable row level security;

drop policy if exists "authenticated read skribbl words" on public.skribbl_words;
create policy "authenticated read skribbl words"
  on public.skribbl_words for select to authenticated using (true);

drop policy if exists "writers manage skribbl words" on public.skribbl_words;
create policy "writers manage skribbl words"
  on public.skribbl_words for all to authenticated
  using (public.is_writer()) with check (public.is_writer());

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2 — Lobbies
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.arena_skribbl_lobbies (
  id            uuid        primary key default gen_random_uuid(),
  host_user_id  uuid        not null references public.profiles(id) on delete cascade,
  host_email    text        not null,
  host_name     text,
  max_players   int         not null default 8  check (max_players between 2 and 12),
  rounds        int         not null default 3  check (rounds between 1 and 8),
  draw_seconds  int         not null default 80 check (draw_seconds in (60, 80, 120)),
  topic         text        not null default 'random',
  difficulty    text        not null default 'mixed'
                              check (difficulty in ('easy', 'medium', 'hard', 'mixed')),
  status        text        not null default 'open'
                              check (status in ('open', 'started', 'cancelled')),
  game_id       uuid,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  cancelled_at  timestamptz
);

create index if not exists arena_skribbl_lobbies_status_idx
  on public.arena_skribbl_lobbies (status, created_at desc);

alter table public.arena_skribbl_lobbies enable row level security;

drop policy if exists "authenticated read skribbl lobbies" on public.arena_skribbl_lobbies;
create policy "authenticated read skribbl lobbies"
  on public.arena_skribbl_lobbies for select to authenticated using (true);

create table if not exists public.arena_skribbl_lobby_players (
  lobby_id    uuid        not null references public.arena_skribbl_lobbies(id) on delete cascade,
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  email       text        not null,
  name        text,
  status      text        not null default 'requested'
                            check (status in ('requested', 'invited', 'joined', 'kicked', 'left')),
  joined_at   timestamptz,
  created_at  timestamptz not null default now(),
  primary key (lobby_id, user_id)
);

alter table public.arena_skribbl_lobby_players enable row level security;

drop policy if exists "authenticated read skribbl lobby players" on public.arena_skribbl_lobby_players;
create policy "authenticated read skribbl lobby players"
  on public.arena_skribbl_lobby_players for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 3 — Games, seats, the secret round, chat
-- ─────────────────────────────────────────────────────────────────────────────

-- The PUBLIC game state. Everything here is readable by every signed-in user,
-- so it must never carry the unrevealed word — only the masked hint.
create table if not exists public.arena_skribbl_games (
  id             uuid        primary key default gen_random_uuid(),
  lobby_id       uuid        references public.arena_skribbl_lobbies(id) on delete set null,
  status         text        not null default 'active'
                               check (status in ('active', 'finished', 'abandoned')),
  rounds_total   int         not null,
  draw_seconds   int         not null,
  topic          text        not null,
  difficulty     text        not null,
  player_count   int         not null,
  round_no       int         not null default 1,
  drawer_seat    int         not null default 0,
  phase          text        not null default 'choosing'
                               check (phase in ('choosing', 'drawing', 'reveal', 'ended')),
  phase_ends_at  timestamptz,
  hint           text,                -- masked pattern, e.g. "_ _ a _ _"
  word_len       int,
  reveal_word    text,                -- only set once the round is over
  round_summary  jsonb,               -- per-round scoring, shown on the reveal screen
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);

create index if not exists arena_skribbl_games_status_idx
  on public.arena_skribbl_games (status, created_at desc);

alter table public.arena_skribbl_games enable row level security;

drop policy if exists "authenticated read skribbl games" on public.arena_skribbl_games;
create policy "authenticated read skribbl games"
  on public.arena_skribbl_games for select to authenticated using (true);

create table if not exists public.arena_skribbl_game_players (
  game_id     uuid        not null references public.arena_skribbl_games(id) on delete cascade,
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  seat        int         not null,
  email       text        not null,
  name        text,
  score       int         not null default 0,
  guessed_at  timestamptz,            -- set when this player solved the CURRENT round
  guess_rank  int,                    -- 1 = first to solve this round
  round_pts   int         not null default 0,
  left_at     timestamptz,
  primary key (game_id, user_id),
  unique (game_id, seat)
);

alter table public.arena_skribbl_game_players enable row level security;

drop policy if exists "authenticated read skribbl game players" on public.arena_skribbl_game_players;
create policy "authenticated read skribbl game players"
  on public.arena_skribbl_game_players for select to authenticated using (true);

-- THE SECRET. One row per turn. RLS admits only the player currently drawing,
-- so the word and the three choices are unreachable for everyone else.
create table if not exists public.arena_skribbl_rounds (
  game_id      uuid        not null references public.arena_skribbl_games(id) on delete cascade,
  turn_no      int         not null,          -- 1..(rounds_total * player_count)
  round_no     int         not null,
  drawer_seat  int         not null,
  drawer_id    uuid        not null references public.profiles(id) on delete cascade,
  choices      text[]      not null,
  word         text,                          -- null until the drawer picks
  reveals      int         not null default 0,
  started_at   timestamptz,
  created_at   timestamptz not null default now(),
  primary key (game_id, turn_no)
);

alter table public.arena_skribbl_rounds enable row level security;

-- Only the drawer of that turn may read it. (Writes go through RPCs.)
drop policy if exists "drawer reads own skribbl round" on public.arena_skribbl_rounds;
create policy "drawer reads own skribbl round"
  on public.arena_skribbl_rounds for select to authenticated
  using (drawer_id = auth.uid());

-- Chat + guess log. A CORRECT guess is written with text = null: the row says
-- "so-and-so solved it", never what the answer was.
create table if not exists public.arena_skribbl_guesses (
  id          bigserial   primary key,
  game_id     uuid        not null references public.arena_skribbl_games(id) on delete cascade,
  turn_no     int         not null,
  user_id     uuid        references public.profiles(id) on delete set null,
  name        text,
  kind        text        not null default 'guess'
                            check (kind in ('guess', 'correct', 'system')),
  text        text,
  created_at  timestamptz not null default now()
);

create index if not exists arena_skribbl_guesses_game_idx
  on public.arena_skribbl_guesses (game_id, id);

alter table public.arena_skribbl_guesses enable row level security;

drop policy if exists "authenticated read skribbl guesses" on public.arena_skribbl_guesses;
create policy "authenticated read skribbl guesses"
  on public.arena_skribbl_guesses for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 4 — History + leaderboard
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.arena_skribbl_matches (
  id            uuid        primary key default gen_random_uuid(),
  game_id       uuid,
  player_count  int         not null,
  rounds        int         not null,
  topic         text,
  difficulty    text,
  ended_at      timestamptz not null default now()
);

alter table public.arena_skribbl_matches enable row level security;

drop policy if exists "authenticated read skribbl matches" on public.arena_skribbl_matches;
create policy "authenticated read skribbl matches"
  on public.arena_skribbl_matches for select to authenticated using (true);

create table if not exists public.arena_skribbl_match_players (
  match_id     uuid  not null references public.arena_skribbl_matches(id) on delete cascade,
  user_id      uuid  references public.profiles(id) on delete set null,
  email        text  not null,
  name         text,
  score        int   not null,
  finish_rank  int   not null,
  primary key (match_id, email)
);

alter table public.arena_skribbl_match_players enable row level security;

drop policy if exists "authenticated read skribbl match players" on public.arena_skribbl_match_players;
create policy "authenticated read skribbl match players"
  on public.arena_skribbl_match_players for select to authenticated using (true);

-- Leaderboard: cumulative points (not ELO — this is a party game, and totals
-- reward playing rather than protecting a rating).
create or replace view public.arena_skribbl_points as
  select
    lower(mp.email)                     as email,
    max(mp.name)                        as name,
    sum(mp.score)::int                  as points,
    count(*)::int                       as games,
    count(*) filter (where mp.finish_rank = 1)::int as wins,
    max(m.ended_at)                     as last_played
  from public.arena_skribbl_match_players mp
  join public.arena_skribbl_matches m on m.id = mp.match_id
  group by lower(mp.email);

alter view public.arena_skribbl_points set (security_invoker = on);

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 5 — Helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- Normalised comparison form: lowercase, letters/digits only.
create or replace function public.skribbl_norm(p_text text)
  returns text language sql immutable as $$
  select regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]', '', 'g');
$$;

-- Masked hint. Non-letters (spaces, hyphens) always show; `p_reveals` letters
-- are exposed at evenly spread positions so the reveal feels fair and every
-- client sees the same pattern (the server writes it to the game row).
create or replace function public.skribbl_hint(p_word text, p_reveals int)
  returns text language plpgsql immutable as $$
declare
  v_out    text := '';
  v_len    int  := length(p_word);
  v_i      int;
  v_ch     text;
  v_shown  int[] := '{}';
  v_letters int[] := '{}';
  v_n      int;
  v_k      int;
begin
  if p_word is null then return null; end if;

  for v_i in 1..v_len loop
    if substring(p_word from v_i for 1) ~ '[A-Za-z0-9]' then
      v_letters := v_letters || v_i;
    end if;
  end loop;

  v_n := coalesce(array_length(v_letters, 1), 0);
  if p_reveals > 0 and v_n > 2 then
    for v_k in 1..least(p_reveals, greatest(v_n - 2, 0)) loop
      v_shown := v_shown || v_letters[ 1 + floor(v_k * v_n::numeric / (least(p_reveals, v_n - 2) + 1))::int ];
    end loop;
  end if;

  for v_i in 1..v_len loop
    v_ch := substring(p_word from v_i for 1);
    if v_ch !~ '[A-Za-z0-9]' then
      v_out := v_out || v_ch;
    elsif v_i = any(v_shown) then
      v_out := v_out || upper(v_ch);
    else
      v_out := v_out || '_';
    end if;
  end loop;

  return v_out;
end;
$$;

-- "So close!" test — one edit away (substitution, insertion or deletion).
-- Hand-rolled so the game needs no fuzzystrmatch extension.
create or replace function public.skribbl_close(p_a text, p_b text)
  returns boolean language plpgsql immutable as $$
declare
  a text := public.skribbl_norm(p_a);
  b text := public.skribbl_norm(p_b);
  la int; lb int; i int; diff int := 0; j int;
begin
  la := length(a); lb := length(b);
  if la = 0 or lb = 0 then return false; end if;
  if abs(la - lb) > 1 then return false; end if;
  if la < 4 and lb < 4 then return false; end if;   -- short words: no near-miss help

  if la = lb then
    for i in 1..la loop
      if substring(a from i for 1) <> substring(b from i for 1) then diff := diff + 1; end if;
      if diff > 1 then return false; end if;
    end loop;
    return diff = 1;
  end if;

  -- one insertion / deletion: walk both, allowing a single skip
  if la > lb then i := la; else i := lb; end if;
  declare
    lng text := case when la > lb then a else b end;
    sht text := case when la > lb then b else a end;
    p int := 1; q int := 1; skipped boolean := false;
  begin
    while p <= length(lng) and q <= length(sht) loop
      if substring(lng from p for 1) = substring(sht from q for 1) then
        p := p + 1; q := q + 1;
      elsif skipped then
        return false;
      else
        skipped := true; p := p + 1;
      end if;
    end loop;
    return true;
  end;
end;
$$;

-- Draw three candidate words for a turn, honouring the lobby's topic and
-- difficulty ('random' / 'mixed' widen the pool), avoiding words already used
-- in this game.
create or replace function public.skribbl_pick_choices(
  p_game_id uuid, p_topic text, p_difficulty text
) returns text[] language plpgsql security definer set search_path = public as $$
declare
  v_words text[];
begin
  select array_agg(w.word) into v_words from (
    select sw.word
    from public.skribbl_words sw
    where (p_topic is null or p_topic = 'random' or sw.topic = p_topic)
      and (p_difficulty is null or p_difficulty = 'mixed' or sw.difficulty = p_difficulty)
      and not exists (
        select 1 from public.arena_skribbl_rounds r
        where r.game_id = p_game_id and r.word = sw.word
      )
    order by random()
    limit 3
  ) w;

  -- Pool exhausted (tiny topic, long game) — fall back to the whole dictionary.
  if v_words is null or array_length(v_words, 1) < 3 then
    select array_agg(w.word) into v_words from (
      select sw.word from public.skribbl_words sw order by random() limit 3
    ) w;
  end if;

  return v_words;
end;
$$;
-- internal only: it would otherwise hand any player three candidate words
revoke all on function public.skribbl_pick_choices(uuid, text, text) from public;

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 6 — Lobby RPCs
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.create_skribbl_lobby(
  p_max_players int     default 8,
  p_rounds      int     default 3,
  p_draw_secs   int     default 80,
  p_topic       text    default 'random',
  p_difficulty  text    default 'mixed'
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_email text; v_name text; v_id uuid;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  if p_max_players not between 2 and 12 then raise exception 'Players must be between 2 and 12'; end if;
  if p_rounds not between 1 and 8 then raise exception 'Rounds must be between 1 and 8'; end if;
  if p_draw_secs not in (60, 80, 120) then raise exception 'Draw time must be 60, 80 or 120 seconds'; end if;

  select email into v_email from auth.users where id = v_uid;
  if v_email is null then raise exception 'Could not resolve caller email'; end if;
  v_name := split_part(v_email, '@', 1);

  insert into public.arena_skribbl_lobbies
    (host_user_id, host_email, host_name, max_players, rounds, draw_seconds, topic, difficulty)
  values
    (v_uid, v_email, v_name, p_max_players, p_rounds, p_draw_secs,
     coalesce(p_topic, 'random'), coalesce(p_difficulty, 'mixed'))
  returning id into v_id;

  insert into public.arena_skribbl_lobby_players (lobby_id, user_id, email, name, status, joined_at)
    values (v_id, v_uid, v_email, v_name, 'joined', now());

  return v_id;
end;
$$;
revoke all on function public.create_skribbl_lobby(int, int, int, text, text) from public;
grant execute on function public.create_skribbl_lobby(int, int, int, text, text) to authenticated;


create or replace function public.request_join_skribbl_lobby(p_lobby_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_email text; v_name text; v_lobby record;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_lobby from public.arena_skribbl_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.status <> 'open' then raise exception 'Lobby is no longer open'; end if;
  if v_lobby.host_user_id = v_uid then return; end if;

  select email into v_email from auth.users where id = v_uid;
  v_name := split_part(v_email, '@', 1);

  insert into public.arena_skribbl_lobby_players (lobby_id, user_id, email, name, status)
    values (p_lobby_id, v_uid, v_email, v_name, 'requested')
  on conflict (lobby_id, user_id) do update
    set status = case
          when arena_skribbl_lobby_players.status = 'invited' then 'joined'
          when arena_skribbl_lobby_players.status in ('left', 'kicked') then 'requested'
          else arena_skribbl_lobby_players.status end,
        joined_at = case when arena_skribbl_lobby_players.status = 'invited'
                    then now() else arena_skribbl_lobby_players.joined_at end;
end;
$$;
revoke all on function public.request_join_skribbl_lobby(uuid) from public;
grant execute on function public.request_join_skribbl_lobby(uuid) to authenticated;


create or replace function public.invite_to_skribbl_lobby(p_lobby_id uuid, p_user_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_lobby record; v_email text; v_name text;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_lobby from public.arena_skribbl_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_user_id <> v_uid then raise exception 'Only the host can invite'; end if;
  if v_lobby.status <> 'open' then raise exception 'Lobby is no longer open'; end if;

  select email into v_email from auth.users where id = p_user_id;
  if v_email is null then raise exception 'User not found'; end if;
  v_name := split_part(v_email, '@', 1);

  insert into public.arena_skribbl_lobby_players (lobby_id, user_id, email, name, status)
    values (p_lobby_id, p_user_id, v_email, v_name, 'invited')
  on conflict (lobby_id, user_id) do update
    set status = case when arena_skribbl_lobby_players.status = 'joined' then 'joined' else 'invited' end;
end;
$$;
revoke all on function public.invite_to_skribbl_lobby(uuid, uuid) from public;
grant execute on function public.invite_to_skribbl_lobby(uuid, uuid) to authenticated;


create or replace function public.respond_skribbl_invite(p_lobby_id uuid, p_accept boolean)
  returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  update public.arena_skribbl_lobby_players
     set status = case when p_accept then 'joined' else 'left' end,
         joined_at = case when p_accept then now() else joined_at end
   where lobby_id = p_lobby_id and user_id = v_uid and status = 'invited';
end;
$$;
revoke all on function public.respond_skribbl_invite(uuid, boolean) from public;
grant execute on function public.respond_skribbl_invite(uuid, boolean) to authenticated;


create or replace function public.accept_skribbl_join_request(p_lobby_id uuid, p_user_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_lobby record; v_joined int;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_lobby from public.arena_skribbl_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_user_id <> v_uid then raise exception 'Only the host can accept players'; end if;

  select count(*) into v_joined from public.arena_skribbl_lobby_players
    where lobby_id = p_lobby_id and status = 'joined';
  if v_joined >= v_lobby.max_players then raise exception 'Lobby is full'; end if;

  update public.arena_skribbl_lobby_players
     set status = 'joined', joined_at = now()
   where lobby_id = p_lobby_id and user_id = p_user_id and status in ('requested', 'invited');
end;
$$;
revoke all on function public.accept_skribbl_join_request(uuid, uuid) from public;
grant execute on function public.accept_skribbl_join_request(uuid, uuid) to authenticated;


create or replace function public.kick_skribbl_lobby_player(p_lobby_id uuid, p_user_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_lobby record;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_lobby from public.arena_skribbl_lobbies where id = p_lobby_id;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_user_id <> v_uid then raise exception 'Only the host can remove players'; end if;
  if p_user_id = v_uid then raise exception 'The host cannot remove themselves'; end if;

  update public.arena_skribbl_lobby_players set status = 'kicked'
   where lobby_id = p_lobby_id and user_id = p_user_id;
end;
$$;
revoke all on function public.kick_skribbl_lobby_player(uuid, uuid) from public;
grant execute on function public.kick_skribbl_lobby_player(uuid, uuid) to authenticated;


create or replace function public.leave_skribbl_lobby(p_lobby_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_lobby record;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_lobby from public.arena_skribbl_lobbies where id = p_lobby_id for update;
  if not found then return; end if;

  if v_lobby.host_user_id = v_uid then
    -- the host leaving folds the lobby
    update public.arena_skribbl_lobbies
       set status = 'cancelled', cancelled_at = now()
     where id = p_lobby_id and status = 'open';
  else
    update public.arena_skribbl_lobby_players set status = 'left'
     where lobby_id = p_lobby_id and user_id = v_uid;
  end if;
end;
$$;
revoke all on function public.leave_skribbl_lobby(uuid) from public;
grant execute on function public.leave_skribbl_lobby(uuid) to authenticated;


create or replace function public.cancel_skribbl_lobby(p_lobby_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_lobby record;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_lobby from public.arena_skribbl_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_user_id <> v_uid then raise exception 'Only the host can cancel'; end if;

  update public.arena_skribbl_lobbies
     set status = 'cancelled', cancelled_at = now()
   where id = p_lobby_id and status = 'open';
end;
$$;
revoke all on function public.cancel_skribbl_lobby(uuid) from public;
grant execute on function public.cancel_skribbl_lobby(uuid) to authenticated;


-- Housekeeping: fold lobbies nobody started. Called opportunistically by the
-- client when it opens the lobby list (same pattern as Scrabble).
create or replace function public.expire_stale_skribbl_lobbies()
  returns void language plpgsql security definer set search_path = public as $$
begin
  update public.arena_skribbl_lobbies
     set status = 'cancelled', cancelled_at = now()
   where status = 'open' and created_at < now() - interval '2 hours';
end;
$$;
revoke all on function public.expire_stale_skribbl_lobbies() from public;
grant execute on function public.expire_stale_skribbl_lobbies() to authenticated;


-- start_skribbl_lobby — seats everyone in random order, opens turn 1 in the
-- 'choosing' phase and deals the first drawer their three word choices.
create or replace function public.start_skribbl_lobby(p_lobby_id uuid)
  returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_lobby record; v_count int; v_game uuid;
  v_seat int := 0; v_p record; v_drawer uuid; v_choices text[];
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_lobby from public.arena_skribbl_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_user_id <> v_uid then raise exception 'Only the host can start'; end if;
  if v_lobby.status <> 'open' then raise exception 'Lobby already started'; end if;

  select count(*) into v_count from public.arena_skribbl_lobby_players
   where lobby_id = p_lobby_id and status = 'joined';
  if v_count < 2 then raise exception 'Need at least 2 players to start'; end if;

  insert into public.arena_skribbl_games
    (lobby_id, rounds_total, draw_seconds, topic, difficulty, player_count,
     round_no, drawer_seat, phase, phase_ends_at)
  values
    (p_lobby_id, v_lobby.rounds, v_lobby.draw_seconds, v_lobby.topic, v_lobby.difficulty,
     v_count, 1, 0, 'choosing', now() + interval '20 seconds')
  returning id into v_game;

  for v_p in
    select user_id, email, name from public.arena_skribbl_lobby_players
     where lobby_id = p_lobby_id and status = 'joined'
     order by random()
  loop
    insert into public.arena_skribbl_game_players (game_id, user_id, seat, email, name)
      values (v_game, v_p.user_id, v_seat, v_p.email, v_p.name);
    if v_seat = 0 then v_drawer := v_p.user_id; end if;
    v_seat := v_seat + 1;
  end loop;

  v_choices := public.skribbl_pick_choices(v_game, v_lobby.topic, v_lobby.difficulty);

  insert into public.arena_skribbl_rounds
    (game_id, turn_no, round_no, drawer_seat, drawer_id, choices)
  values (v_game, 1, 1, 0, v_drawer, v_choices);

  update public.arena_skribbl_lobbies
     set status = 'started', started_at = now(), game_id = v_game
   where id = p_lobby_id;

  insert into public.arena_skribbl_guesses (game_id, turn_no, kind, text)
    values (v_game, 1, 'system', 'Game started — round 1 of ' || v_lobby.rounds);

  return v_game;
end;
$$;
revoke all on function public.start_skribbl_lobby(uuid) from public;
grant execute on function public.start_skribbl_lobby(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 7 — Game RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- Internal: close the current turn — score the drawer, expose the word, and
-- park the game in 'reveal' for a few seconds. Called from the tick (timer
-- expiry) and from submit_guess (everyone solved it).
create or replace function public.skribbl_close_turn(p_game_id uuid, p_reason text)
  returns void language plpgsql security definer set search_path = public as $$
declare
  v_g record; v_r record; v_turn int; v_eligible int; v_correct int;
  v_drawer_pts int; v_summary jsonb;
begin
  select * into v_g from public.arena_skribbl_games where id = p_game_id for update;
  if not found or v_g.phase not in ('choosing', 'drawing') then return; end if;

  v_turn := (v_g.round_no - 1) * v_g.player_count + v_g.drawer_seat + 1;
  select * into v_r from public.arena_skribbl_rounds where game_id = p_game_id and turn_no = v_turn;

  select count(*) into v_eligible from public.arena_skribbl_game_players
   where game_id = p_game_id and seat <> v_g.drawer_seat and left_at is null;
  select count(*) into v_correct from public.arena_skribbl_game_players
   where game_id = p_game_id and seat <> v_g.drawer_seat and guessed_at is not null;

  -- The drawer is scored on how much of the room solved it: a clear drawing
  -- everyone gets is worth the full 200; nobody guessing is worth nothing.
  v_drawer_pts := case when v_eligible > 0
                       then round(200.0 * v_correct / v_eligible)::int else 0 end;

  update public.arena_skribbl_game_players
     set score = score + v_drawer_pts, round_pts = v_drawer_pts
   where game_id = p_game_id and seat = v_g.drawer_seat;

  select jsonb_agg(jsonb_build_object(
           'name', name, 'seat', seat, 'round_pts', round_pts,
           'score', score, 'rank', guess_rank) order by seat)
    into v_summary
    from public.arena_skribbl_game_players where game_id = p_game_id;

  update public.arena_skribbl_games
     set phase = 'reveal',
         reveal_word = v_r.word,
         hint = v_r.word,
         phase_ends_at = now() + interval '7 seconds',
         round_summary = v_summary
   where id = p_game_id;

  insert into public.arena_skribbl_guesses (game_id, turn_no, kind, text)
    values (p_game_id, v_turn, 'system',
            case when v_r.word is null then 'Nobody picked a word — skipping.'
                 else 'The word was "' || v_r.word || '" · ' || coalesce(p_reason, '') end);
end;
$$;
revoke all on function public.skribbl_close_turn(uuid, text) from public;


-- The drawer locks in one of their three words.
create or replace function public.skribbl_choose_word(p_game_id uuid, p_index int)
  returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_g record; v_r record; v_turn int; v_word text;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_g from public.arena_skribbl_games where id = p_game_id for update;
  if not found then raise exception 'Game not found'; end if;
  if v_g.phase <> 'choosing' then return; end if;

  v_turn := (v_g.round_no - 1) * v_g.player_count + v_g.drawer_seat + 1;
  select * into v_r from public.arena_skribbl_rounds where game_id = p_game_id and turn_no = v_turn for update;
  if not found then raise exception 'Round not found'; end if;
  if v_r.drawer_id <> v_uid then raise exception 'Only the drawer can choose the word'; end if;

  v_word := v_r.choices[greatest(1, least(3, coalesce(p_index, 0) + 1))];

  update public.arena_skribbl_rounds
     set word = v_word, started_at = now(), reveals = 0
   where game_id = p_game_id and turn_no = v_turn;

  update public.arena_skribbl_game_players
     set guessed_at = null, guess_rank = null, round_pts = 0
   where game_id = p_game_id;

  update public.arena_skribbl_games
     set phase = 'drawing',
         phase_ends_at = now() + (v_g.draw_seconds || ' seconds')::interval,
         hint = public.skribbl_hint(v_word, 0),
         word_len = length(v_word),
         reveal_word = null,
         round_summary = null
   where id = p_game_id;
end;
$$;
revoke all on function public.skribbl_choose_word(uuid, int) from public;
grant execute on function public.skribbl_choose_word(uuid, int) to authenticated;


-- A guess. Returns {status: correct|close|normal, points: n}.
-- The comparison happens here, server-side, because the client must never hold
-- the answer. A correct guess is logged without its text.
create or replace function public.submit_skribbl_guess(p_game_id uuid, p_text text)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_g record; v_r record; v_me record;
  v_turn int; v_rank int; v_ratio numeric; v_pts int;
  v_eligible int; v_correct int; v_txt text;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  v_txt := btrim(coalesce(p_text, ''));
  if v_txt = '' then return jsonb_build_object('status', 'normal'); end if;
  if length(v_txt) > 120 then v_txt := left(v_txt, 120); end if;

  select * into v_g from public.arena_skribbl_games where id = p_game_id for update;
  if not found then raise exception 'Game not found'; end if;

  select * into v_me from public.arena_skribbl_game_players
   where game_id = p_game_id and user_id = v_uid;
  if not found then raise exception 'You are not in this game'; end if;

  v_turn := (v_g.round_no - 1) * v_g.player_count + v_g.drawer_seat + 1;

  -- Not in play, the drawer, or already solved → it is just chat.
  if v_g.phase <> 'drawing' or v_me.seat = v_g.drawer_seat or v_me.guessed_at is not null then
    insert into public.arena_skribbl_guesses (game_id, turn_no, user_id, name, kind, text)
      values (p_game_id, v_turn, v_uid, v_me.name, 'guess', v_txt);
    return jsonb_build_object('status', 'normal');
  end if;

  select * into v_r from public.arena_skribbl_rounds where game_id = p_game_id and turn_no = v_turn;
  if not found or v_r.word is null then
    insert into public.arena_skribbl_guesses (game_id, turn_no, user_id, name, kind, text)
      values (p_game_id, v_turn, v_uid, v_me.name, 'guess', v_txt);
    return jsonb_build_object('status', 'normal');
  end if;

  if public.skribbl_norm(v_txt) = public.skribbl_norm(v_r.word) then
    select count(*) + 1 into v_rank from public.arena_skribbl_game_players
     where game_id = p_game_id and guessed_at is not null and seat <> v_g.drawer_seat;

    v_ratio := greatest(0, least(1,
      extract(epoch from (v_g.phase_ends_at - now())) / nullif(v_g.draw_seconds, 0)));
    -- speed is most of it; each later solver loses a little ground
    v_pts := greatest(60, round(100 + 200 * v_ratio - 20 * (v_rank - 1))::int);

    update public.arena_skribbl_game_players
       set score = score + v_pts, guessed_at = now(), guess_rank = v_rank, round_pts = v_pts
     where game_id = p_game_id and user_id = v_uid;

    insert into public.arena_skribbl_guesses (game_id, turn_no, user_id, name, kind, text)
      values (p_game_id, v_turn, v_uid, v_me.name, 'correct', null);

    select count(*) into v_eligible from public.arena_skribbl_game_players
     where game_id = p_game_id and seat <> v_g.drawer_seat and left_at is null;
    select count(*) into v_correct from public.arena_skribbl_game_players
     where game_id = p_game_id and seat <> v_g.drawer_seat and guessed_at is not null;

    if v_correct >= v_eligible then
      perform public.skribbl_close_turn(p_game_id, 'everyone guessed it!');
    end if;

    return jsonb_build_object('status', 'correct', 'points', v_pts, 'rank', v_rank);
  end if;

  -- Wrong: it goes to chat like any message. "Close" is returned only to the
  -- guesser, so a near-miss never hands the answer to the room.
  insert into public.arena_skribbl_guesses (game_id, turn_no, user_id, name, kind, text)
    values (p_game_id, v_turn, v_uid, v_me.name, 'guess', v_txt);

  if public.skribbl_close(v_txt, v_r.word) then
    return jsonb_build_object('status', 'close');
  end if;
  return jsonb_build_object('status', 'normal');
end;
$$;
revoke all on function public.submit_skribbl_guess(uuid, text) from public;
grant execute on function public.submit_skribbl_guess(uuid, text) to authenticated;


-- The clock. Idempotent and server-timed: clients call it when their local
-- countdown hits zero; it only acts if the deadline really has passed.
create or replace function public.skribbl_tick(p_game_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare
  v_g record; v_r record; v_turn int; v_due boolean;
  v_next_seat int; v_next_round int; v_next_turn int; v_drawer record;
  v_choices text[]; v_elapsed numeric; v_want int; v_match uuid;
begin
  select * into v_g from public.arena_skribbl_games where id = p_game_id for update;
  if not found or v_g.status <> 'active' then return; end if;

  v_turn := (v_g.round_no - 1) * v_g.player_count + v_g.drawer_seat + 1;
  v_due  := v_g.phase_ends_at is not null and now() >= v_g.phase_ends_at;

  -- 1. Drawer took too long to choose → auto-pick their first word.
  if v_g.phase = 'choosing' and v_due then
    perform public.skribbl_choose_word_auto(p_game_id);
    return;
  end if;

  -- 2. Mid-draw: either the round is over, or it is time to reveal a letter.
  if v_g.phase = 'drawing' then
    if v_due then
      perform public.skribbl_close_turn(p_game_id, 'time is up.');
      return;
    end if;
    select * into v_r from public.arena_skribbl_rounds where game_id = p_game_id and turn_no = v_turn;
    if found and v_r.word is not null and v_r.started_at is not null then
      v_elapsed := extract(epoch from (now() - v_r.started_at)) / nullif(v_g.draw_seconds, 0);
      v_want := case when v_elapsed >= 0.75 then 2 when v_elapsed >= 0.45 then 1 else 0 end;
      if v_want > v_r.reveals then
        update public.arena_skribbl_rounds set reveals = v_want
         where game_id = p_game_id and turn_no = v_turn;
        update public.arena_skribbl_games set hint = public.skribbl_hint(v_r.word, v_want)
         where id = p_game_id;
      end if;
    end if;
    return;
  end if;

  -- 3. Reveal screen finished → next drawer, next round, or the final scoreboard.
  if v_g.phase = 'reveal' and v_due then
    v_next_seat  := v_g.drawer_seat + 1;
    v_next_round := v_g.round_no;
    if v_next_seat >= v_g.player_count then
      v_next_seat := 0; v_next_round := v_next_round + 1;
    end if;

    if v_next_round > v_g.rounds_total then
      update public.arena_skribbl_games
         set status = 'finished', phase = 'ended', finished_at = now(),
             phase_ends_at = null, hint = null
       where id = p_game_id;

      insert into public.arena_skribbl_matches (game_id, player_count, rounds, topic, difficulty)
        values (p_game_id, v_g.player_count, v_g.rounds_total, v_g.topic, v_g.difficulty)
        returning id into v_match;

      insert into public.arena_skribbl_match_players (match_id, user_id, email, name, score, finish_rank)
        select v_match, gp.user_id, gp.email, gp.name, gp.score,
               rank() over (order by gp.score desc)
          from public.arena_skribbl_game_players gp
         where gp.game_id = p_game_id;

      insert into public.arena_skribbl_guesses (game_id, turn_no, kind, text)
        values (p_game_id, v_turn, 'system', 'Game over — final scores are in.');
      return;
    end if;

    v_next_turn := (v_next_round - 1) * v_g.player_count + v_next_seat + 1;
    select * into v_drawer from public.arena_skribbl_game_players
     where game_id = p_game_id and seat = v_next_seat;

    v_choices := public.skribbl_pick_choices(p_game_id, v_g.topic, v_g.difficulty);

    insert into public.arena_skribbl_rounds
      (game_id, turn_no, round_no, drawer_seat, drawer_id, choices)
    values (p_game_id, v_next_turn, v_next_round, v_next_seat, v_drawer.user_id, v_choices)
    on conflict (game_id, turn_no) do nothing;

    update public.arena_skribbl_game_players
       set guessed_at = null, guess_rank = null, round_pts = 0
     where game_id = p_game_id;

    update public.arena_skribbl_games
       set round_no = v_next_round, drawer_seat = v_next_seat,
           phase = 'choosing', phase_ends_at = now() + interval '20 seconds',
           hint = null, word_len = null, reveal_word = null, round_summary = null
     where id = p_game_id;
  end if;
end;
$$;
revoke all on function public.skribbl_tick(uuid) from public;
grant execute on function public.skribbl_tick(uuid) to authenticated;


-- Auto-pick helper (drawer idled through the choosing phase).
create or replace function public.skribbl_choose_word_auto(p_game_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare
  v_g record; v_r record; v_turn int; v_word text;
begin
  select * into v_g from public.arena_skribbl_games where id = p_game_id for update;
  if not found or v_g.phase <> 'choosing' then return; end if;

  v_turn := (v_g.round_no - 1) * v_g.player_count + v_g.drawer_seat + 1;
  select * into v_r from public.arena_skribbl_rounds where game_id = p_game_id and turn_no = v_turn for update;
  if not found then return; end if;

  v_word := v_r.choices[1];

  update public.arena_skribbl_rounds set word = v_word, started_at = now(), reveals = 0
   where game_id = p_game_id and turn_no = v_turn;

  update public.arena_skribbl_game_players
     set guessed_at = null, guess_rank = null, round_pts = 0
   where game_id = p_game_id;

  update public.arena_skribbl_games
     set phase = 'drawing',
         phase_ends_at = now() + (v_g.draw_seconds || ' seconds')::interval,
         hint = public.skribbl_hint(v_word, 0),
         word_len = length(v_word),
         reveal_word = null, round_summary = null
   where id = p_game_id;
end;
$$;
revoke all on function public.skribbl_choose_word_auto(uuid) from public;


-- Leaving mid-game. If the drawer walks, the turn closes; if the room empties
-- below two players, the game is abandoned (no match row — nothing to rank).
create or replace function public.skribbl_leave_game(p_game_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_g record; v_me record; v_left int;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_g from public.arena_skribbl_games where id = p_game_id for update;
  if not found or v_g.status <> 'active' then return; end if;

  select * into v_me from public.arena_skribbl_game_players
   where game_id = p_game_id and user_id = v_uid;
  if not found or v_me.left_at is not null then return; end if;

  update public.arena_skribbl_game_players set left_at = now()
   where game_id = p_game_id and user_id = v_uid;

  insert into public.arena_skribbl_guesses (game_id, turn_no, kind, text)
    values (p_game_id, (v_g.round_no - 1) * v_g.player_count + v_g.drawer_seat + 1,
            'system', coalesce(v_me.name, 'A player') || ' left the game.');

  select count(*) into v_left from public.arena_skribbl_game_players
   where game_id = p_game_id and left_at is null;

  if v_left < 2 then
    update public.arena_skribbl_games
       set status = 'abandoned', phase = 'ended', finished_at = now(), phase_ends_at = null
     where id = p_game_id;
  elsif v_me.seat = v_g.drawer_seat and v_g.phase in ('choosing', 'drawing') then
    perform public.skribbl_close_turn(p_game_id, 'the drawer left.');
  end if;
end;
$$;
revoke all on function public.skribbl_leave_game(uuid) from public;
grant execute on function public.skribbl_leave_game(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 8 — Realtime publication (postgres_changes needs the table listed)
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'arena_skribbl_lobbies', 'arena_skribbl_lobby_players',
    'arena_skribbl_games', 'arena_skribbl_game_players', 'arena_skribbl_guesses'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 9 — Word pool seed (10 topics x 3 difficulties x 12 words)
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.skribbl_words (word, topic, difficulty) values
  -- animals
  ('cat','animals','easy'),('dog','animals','easy'),('fish','animals','easy'),('bird','animals','easy'),
  ('cow','animals','easy'),('pig','animals','easy'),('duck','animals','easy'),('frog','animals','easy'),
  ('bee','animals','easy'),('snake','animals','easy'),('horse','animals','easy'),('sheep','animals','easy'),
  ('penguin','animals','medium'),('giraffe','animals','medium'),('octopus','animals','medium'),
  ('kangaroo','animals','medium'),('dolphin','animals','medium'),('squirrel','animals','medium'),
  ('hedgehog','animals','medium'),('flamingo','animals','medium'),('crocodile','animals','medium'),
  ('koala','animals','medium'),('tortoise','animals','medium'),('jellyfish','animals','medium'),
  ('platypus','animals','hard'),('chameleon','animals','hard'),('armadillo','animals','hard'),
  ('pelican','animals','hard'),('wombat','animals','hard'),('meerkat','animals','hard'),
  ('narwhal','animals','hard'),('iguana','animals','hard'),('walrus','animals','hard'),
  ('cassowary','animals','hard'),('echidna','animals','hard'),('seahorse','animals','hard'),
  -- food
  ('pizza','food','easy'),('apple','food','easy'),('banana','food','easy'),('cake','food','easy'),
  ('bread','food','easy'),('egg','food','easy'),('ice cream','food','easy'),('burger','food','easy'),
  ('carrot','food','easy'),('cheese','food','easy'),('donut','food','easy'),('milk','food','easy'),
  ('pineapple','food','medium'),('spaghetti','food','medium'),('pancakes','food','medium'),
  ('sandwich','food','medium'),('popcorn','food','medium'),('sushi','food','medium'),
  ('cupcake','food','medium'),('watermelon','food','medium'),('hot dog','food','medium'),
  ('avocado','food','medium'),('noodles','food','medium'),('taco','food','medium'),
  ('croissant','food','hard'),('lamington','food','hard'),('pavlova','food','hard'),
  ('dumpling','food','hard'),('artichoke','food','hard'),('meat pie','food','hard'),
  ('espresso','food','hard'),('pomegranate','food','hard'),('waffle','food','hard'),
  ('pretzel','food','hard'),('casserole','food','hard'),('souvlaki','food','hard'),
  -- objects
  ('chair','objects','easy'),('key','objects','easy'),('cup','objects','easy'),('book','objects','easy'),
  ('clock','objects','easy'),('hat','objects','easy'),('shoe','objects','easy'),('umbrella','objects','easy'),
  ('phone','objects','easy'),('lamp','objects','easy'),('ball','objects','easy'),('spoon','objects','easy'),
  ('telescope','objects','medium'),('backpack','objects','medium'),('sunglasses','objects','medium'),
  ('toothbrush','objects','medium'),('ladder','objects','medium'),('camera','objects','medium'),
  ('guitar','objects','medium'),('scissors','objects','medium'),('wheelbarrow','objects','medium'),
  ('mailbox','objects','medium'),('suitcase','objects','medium'),('headphones','objects','medium'),
  ('chandelier','objects','hard'),('typewriter','objects','hard'),('microscope','objects','hard'),
  ('metronome','objects','hard'),('corkscrew','objects','hard'),('sewing machine','objects','hard'),
  ('binoculars','objects','hard'),('fire extinguisher','objects','hard'),('wheelchair','objects','hard'),
  ('hourglass','objects','hard'),('projector','objects','hard'),('accordion','objects','hard'),
  -- sports
  ('soccer','sports','easy'),('tennis','sports','easy'),('running','sports','easy'),('swimming','sports','easy'),
  ('golf','sports','easy'),('boxing','sports','easy'),('cricket','sports','easy'),('surfing','sports','easy'),
  ('cycling','sports','easy'),('basketball','sports','easy'),('skateboard','sports','easy'),('fishing','sports','easy'),
  ('volleyball','sports','medium'),('badminton','sports','medium'),('gymnastics','sports','medium'),
  ('snowboarding','sports','medium'),('rowing','sports','medium'),('archery','sports','medium'),
  ('marathon','sports','medium'),('high jump','sports','medium'),('water polo','sports','medium'),
  ('netball','sports','medium'),('hockey','sports','medium'),('bowling','sports','medium'),
  ('pole vault','sports','hard'),('fencing','sports','hard'),('curling','sports','hard'),
  ('triathlon','sports','hard'),('javelin','sports','hard'),('hurdles','sports','hard'),
  ('wakeboarding','sports','hard'),('sumo wrestling','sports','hard'),('rock climbing','sports','hard'),
  ('kayaking','sports','hard'),('cheerleading','sports','hard'),('dressage','sports','hard'),
  -- movies & tv
  ('Star Wars','movies','easy'),('Titanic','movies','easy'),('Batman','movies','easy'),
  ('Spider-Man','movies','easy'),('Jaws','movies','easy'),('Frozen','movies','easy'),
  ('Toy Story','movies','easy'),('Superman','movies','easy'),('Shrek','movies','easy'),
  ('The Simpsons','movies','easy'),('Harry Potter','movies','easy'),('King Kong','movies','easy'),
  ('Jurassic Park','movies','medium'),('Ghostbusters','movies','medium'),('Finding Nemo','movies','medium'),
  ('The Lion King','movies','medium'),('Home Alone','movies','medium'),('Men in Black','movies','medium'),
  ('Back to the Future','movies','medium'),('The Matrix','movies','medium'),('Stranger Things','movies','medium'),
  ('Wall-E','movies','medium'),('Up','movies','medium'),('Monsters Inc','movies','medium'),
  ('The Godfather','movies','hard'),('Forrest Gump','movies','hard'),('Breaking Bad','movies','hard'),
  ('Mad Max','movies','hard'),('Indiana Jones','movies','hard'),('The Wizard of Oz','movies','hard'),
  ('Jumanji','movies','hard'),('Groundhog Day','movies','hard'),('Casablanca','movies','hard'),
  ('Interstellar','movies','hard'),('The Office','movies','hard'),('Squid Game','movies','hard'),
  -- places
  ('beach','places','easy'),('house','places','easy'),('school','places','easy'),('park','places','easy'),
  ('farm','places','easy'),('city','places','easy'),('island','places','easy'),('bridge','places','easy'),
  ('castle','places','easy'),('hospital','places','easy'),('church','places','easy'),('airport','places','easy'),
  ('lighthouse','places','medium'),('pyramid','places','medium'),('volcano','places','medium'),
  ('waterfall','places','medium'),('skyscraper','places','medium'),('harbour','places','medium'),
  ('windmill','places','medium'),('campsite','places','medium'),('museum','places','medium'),
  ('stadium','places','medium'),('subway','places','medium'),('vineyard','places','medium'),
  ('Opera House','places','hard'),('Eiffel Tower','places','hard'),('Great Wall','places','hard'),
  ('Stonehenge','places','hard'),('Uluru','places','hard'),('Colosseum','places','hard'),
  ('Taj Mahal','places','hard'),('Machu Picchu','places','hard'),('Big Ben','places','hard'),
  ('Grand Canyon','places','hard'),('Golden Gate','places','hard'),('Times Square','places','hard'),
  -- actions
  ('run','actions','easy'),('sleep','actions','easy'),('jump','actions','easy'),('eat','actions','easy'),
  ('swim','actions','easy'),('dance','actions','easy'),('sing','actions','easy'),('read','actions','easy'),
  ('drive','actions','easy'),('laugh','actions','easy'),('cry','actions','easy'),('write','actions','easy'),
  ('juggling','actions','medium'),('snoring','actions','medium'),('sneezing','actions','medium'),
  ('painting','actions','medium'),('camping','actions','medium'),('shopping','actions','medium'),
  ('cooking','actions','medium'),('texting','actions','medium'),('gardening','actions','medium'),
  ('skating','actions','medium'),('hiking','actions','medium'),('yawning','actions','medium'),
  ('procrastinating','actions','hard'),('negotiating','actions','hard'),('celebrating','actions','hard'),
  ('meditating','actions','hard'),('renovating','actions','hard'),('auctioning','actions','hard'),
  ('hitchhiking','actions','hard'),('moonwalking','actions','hard'),('daydreaming','actions','hard'),
  ('eavesdropping','actions','hard'),('tiptoeing','actions','hard'),('arm wrestling','actions','hard'),
  -- nature
  ('tree','nature','easy'),('sun','nature','easy'),('rain','nature','easy'),('moon','nature','easy'),
  ('flower','nature','easy'),('mountain','nature','easy'),('cloud','nature','easy'),('star','nature','easy'),
  ('river','nature','easy'),('leaf','nature','easy'),('fire','nature','easy'),('snow','nature','easy'),
  ('rainbow','nature','medium'),('tornado','nature','medium'),('cactus','nature','medium'),
  ('forest','nature','medium'),('desert','nature','medium'),('coral reef','nature','medium'),
  ('lightning','nature','medium'),('iceberg','nature','medium'),('sunflower','nature','medium'),
  ('mushroom','nature','medium'),('canyon','nature','medium'),('swamp','nature','medium'),
  ('aurora','nature','hard'),('glacier','nature','hard'),('stalactite','nature','hard'),
  ('eucalyptus','nature','hard'),('geyser','nature','hard'),('avalanche','nature','hard'),
  ('monsoon','nature','hard'),('savannah','nature','hard'),('quicksand','nature','hard'),
  ('tsunami','nature','hard'),('wetlands','nature','hard'),('eclipse','nature','hard'),
  -- property (house flavour)
  ('key','property','easy'),('fence','property','easy'),('roof','property','easy'),('door','property','easy'),
  ('garden','property','easy'),('garage','property','easy'),('window','property','easy'),('pool','property','easy'),
  ('mailbox','property','easy'),('driveway','property','easy'),('sold sign','property','easy'),('letterbox','property','easy'),
  ('apartment','property','medium'),('townhouse','property','medium'),('floor plan','property','medium'),
  ('auction','property','medium'),('open house','property','medium'),('balcony','property','medium'),
  ('renovation','property','medium'),('blueprint','property','medium'),('moving truck','property','medium'),
  ('granny flat','property','medium'),('high rise','property','medium'),('picket fence','property','medium'),
  ('subdivision','property','hard'),('settlement','property','hard'),('conveyancer','property','hard'),
  ('body corporate','property','hard'),('capital growth','property','hard'),('rental yield','property','hard'),
  ('off the plan','property','hard'),('stamp duty','property','hard'),('mortgage broker','property','hard'),
  ('building inspection','property','hard'),('strata title','property','hard'),('negative gearing','property','hard'),
  -- office
  ('laptop','office','easy'),('coffee','office','easy'),('desk','office','easy'),('sticky note','office','easy'),
  ('printer','office','easy'),('keyboard','office','easy'),('email','office','easy'),('meeting','office','easy'),
  ('whiteboard','office','easy'),('calculator','office','easy'),('notebook','office','easy'),('name tag','office','easy'),
  ('video call','office','medium'),('spreadsheet','office','medium'),('presentation','office','medium'),
  ('deadline','office','medium'),('coffee machine','office','medium'),('filing cabinet','office','medium'),
  ('brainstorm','office','medium'),('water cooler','office','medium'),('swivel chair','office','medium'),
  ('conference room','office','medium'),('paper jam','office','medium'),('stapler','office','medium'),
  ('performance review','office','hard'),('quarterly report','office','hard'),('org chart','office','hard'),
  ('out of office','office','hard'),('project timeline','office','hard'),('team building','office','hard'),
  ('expense claim','office','hard'),('standing desk','office','hard'),('inbox zero','office','hard'),
  ('cubicle farm','office','hard'),('keynote speech','office','hard'),('annual leave','office','hard')
on conflict (word, topic) do nothing;
