-- =============================================================================
-- 038_arena_scrabble_void_game.sql — "Void Game" (replaces the draw offer)
--
-- A player can request to VOID the game. Every other ACTIVE player must agree;
-- if any one declines, the game continues and the REQUESTER is put on a
-- 5-minute cooldown (other players may still request in the meantime). When a
-- void succeeds the game ends with NO points added/deducted (even if ranked),
-- and the match is recorded with termination = 'void' so the recent-matches
-- list can flag it as voided.
--
-- New game state (arena_scrabble_games):
--   void_by      int          -- seat of the pending requester (null = none)
--   void_at      timestamptz  -- when requested
--   void_agreed  int[]        -- seats that have agreed (incl. the requester)
-- Per-player cooldown (arena_scrabble_game_players):
--   void_cooldown_until timestamptz
--
-- New RPCs: request_void_scrabble_game, respond_void_scrabble_game, and the
-- internal _scrabble_void_game settler.
--
-- Run order: after 037_*.sql. Re-runnable.
-- =============================================================================

-- Allow 'void' as a match termination.
alter table public.arena_scrabble_matches drop constraint if exists arena_scrabble_matches_termination_check;
alter table public.arena_scrabble_matches add constraint arena_scrabble_matches_termination_check
  check (termination in ('out_of_tiles', 'six_passes', 'resign', 'timeout', 'agreement', 'manual', 'void'));

-- Void-request state on the game + per-player cooldown.
alter table public.arena_scrabble_games        add column if not exists void_by     int;
alter table public.arena_scrabble_games        add column if not exists void_at      timestamptz;
alter table public.arena_scrabble_games        add column if not exists void_agreed  int[] not null default '{}';
alter table public.arena_scrabble_game_players add column if not exists void_cooldown_until timestamptz;


-- ─────────────────────────────────────────────────────────────────────────────
-- _scrabble_void_game — settle a game as VOID: record a no-points match
-- (pts_after = pts_before for everyone, finish_rank = 1 for all) and mark the
-- game completed. Called once consensus is reached (or immediately if the
-- requester is the only active player).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._scrabble_void_game(p_game_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_game          record;
  v_n             int;
  v_match_id      bigint;
  v_creator_email text;
  v_pi            record;
  v_payload       jsonb := '[]'::jsonb;
begin
  select * into v_game from public.arena_scrabble_games where id = p_game_id for update;
  if not found then raise exception 'Game % not found', p_game_id; end if;
  if v_game.status <> 'active' then raise exception 'Game is already %; cannot void', v_game.status; end if;
  v_n := v_game.player_count;

  select email into v_creator_email from auth.users where id = auth.uid();

  insert into public.arena_scrabble_matches (
    termination, ranked, turn_time_seconds, player_count, game_id,
    created_by_user_id, created_by_email, started_at, ended_at
  ) values (
    'void', v_game.ranked, v_game.turn_time_seconds, v_n, p_game_id,
    auth.uid(), coalesce(v_creator_email, 'unknown'), v_game.started_at, now()
  ) returning id into v_match_id;

  for v_pi in
    select gp.seat, gp.user_id, gp.email, gp.name, gp.score, gp.pts_before
    from public.arena_scrabble_game_players gp
    where gp.game_id = p_game_id
    order by gp.seat
  loop
    /* Voided → NO point change (pts_after = pts_before); everyone ranked 1. */
    insert into public.arena_scrabble_match_players (
      match_id, seat, user_id, email, name, score, pts_before, pts_after, finish_rank
    ) values (
      v_match_id, v_pi.seat, v_pi.user_id, v_pi.email, v_pi.name,
      v_pi.score, v_pi.pts_before, v_pi.pts_before, 1
    );
    v_payload := v_payload || jsonb_build_array(jsonb_build_object(
      'seat',        v_pi.seat,
      'user_id',     v_pi.user_id,
      'email',       v_pi.email,
      'name',        v_pi.name,
      'score',       v_pi.score,
      'pts_before',  v_pi.pts_before,
      'pts_after',   v_pi.pts_before,
      'finish_rank', 1
    ));
  end loop;

  update public.arena_scrabble_games
     set status = 'completed', ended_at = now(),
         void_by = null, void_at = null, void_agreed = '{}', draw_offer_by = null
   where id = p_game_id;

  return jsonb_build_object(
    'ok',           true,
    'voided',       true,
    'match_id',     v_match_id,
    'termination',  'void',
    'player_count', v_n,
    'players',      v_payload
  );
end;
$$;
revoke all on function public._scrabble_void_game(uuid) from public;
grant execute on function public._scrabble_void_game(uuid) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- request_void_scrabble_game — a player asks to void the game.
--   • Blocked if a void is already pending, or the caller is on cooldown.
--   • If there are no OTHER active players, voids immediately.
--   • Otherwise records the request (requester implicitly agrees).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.request_void_scrabble_game(p_game_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_game   record;
  v_my     record;
  v_others int;
begin
  select * into v_game from public.arena_scrabble_games where id = p_game_id for update;
  if not found then raise exception 'Game % not found', p_game_id; end if;
  if v_game.status <> 'active' then raise exception 'Game is no longer active'; end if;

  select * into v_my from public.arena_scrabble_game_players
    where game_id = p_game_id and user_id = auth.uid();
  if not found then raise exception 'You are not a participant in this game'; end if;
  if v_my.resigned then raise exception 'You have resigned from this game'; end if;

  if v_game.void_by is not null then raise exception 'A void request is already pending'; end if;
  if v_my.void_cooldown_until is not null and v_my.void_cooldown_until > now() then
    raise exception 'Your last void was declined — you can request again in % seconds',
                    ceil(extract(epoch from (v_my.void_cooldown_until - now())))::int;
  end if;

  select count(*) into v_others from public.arena_scrabble_game_players
    where game_id = p_game_id and resigned = false and seat <> v_my.seat;

  -- No one else active to agree — void straight away.
  if v_others <= 0 then
    return public._scrabble_void_game(p_game_id);
  end if;

  update public.arena_scrabble_games
     set void_by = v_my.seat, void_at = now(), void_agreed = array[v_my.seat], last_move_at = now()
   where id = p_game_id;

  return jsonb_build_object('ok', true, 'pending', true, 'void_by', v_my.seat);
end;
$$;
revoke all on function public.request_void_scrabble_game(uuid) from public;
grant execute on function public.request_void_scrabble_game(uuid) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- respond_void_scrabble_game — another player agrees or declines a pending void.
--   • Decline → cancel the request + 5-minute cooldown for the REQUESTER.
--   • Agree   → record agreement; once EVERY active player has agreed, void.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.respond_void_scrabble_game(p_game_id uuid, p_agree boolean)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_game   record;
  v_my     record;
  v_active int;
  v_agreed int[];
begin
  select * into v_game from public.arena_scrabble_games where id = p_game_id for update;
  if not found then raise exception 'Game % not found', p_game_id; end if;
  if v_game.status <> 'active' then raise exception 'Game is no longer active'; end if;
  if v_game.void_by is null then raise exception 'No void request is pending'; end if;

  select * into v_my from public.arena_scrabble_game_players
    where game_id = p_game_id and user_id = auth.uid();
  if not found then raise exception 'You are not a participant in this game'; end if;
  if v_my.resigned then raise exception 'You have resigned from this game'; end if;
  if v_my.seat = v_game.void_by then raise exception 'You requested this void — you can''t respond to it'; end if;

  if not p_agree then
    -- Decline: cancel + cooldown the original requester (others may still request).
    update public.arena_scrabble_game_players
       set void_cooldown_until = now() + interval '5 minutes'
     where game_id = p_game_id and seat = v_game.void_by;
    update public.arena_scrabble_games
       set void_by = null, void_at = null, void_agreed = '{}', last_move_at = now()
     where id = p_game_id;
    return jsonb_build_object('ok', true, 'declined', true, 'continued', true);
  end if;

  -- Agree.
  v_agreed := v_game.void_agreed;
  if not (v_my.seat = any(v_agreed)) then
    v_agreed := array_append(v_agreed, v_my.seat);
  end if;

  select count(*) into v_active from public.arena_scrabble_game_players
    where game_id = p_game_id and resigned = false;

  -- Everyone active has agreed → void.
  if coalesce(array_length(v_agreed, 1), 0) >= v_active then
    return public._scrabble_void_game(p_game_id);
  end if;

  update public.arena_scrabble_games set void_agreed = v_agreed, last_move_at = now()
   where id = p_game_id;
  return jsonb_build_object('ok', true, 'pending', true,
                            'agreed', coalesce(array_length(v_agreed, 1), 0), 'active', v_active);
end;
$$;
revoke all on function public.respond_void_scrabble_game(uuid, boolean) from public;
grant execute on function public.respond_void_scrabble_game(uuid, boolean) to authenticated;
