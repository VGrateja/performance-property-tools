-- =============================================================================
-- 063_arena_scrabble_void_timeout.sql — auto-cancel a void request after 1 min
--
-- A void request (038) stays pending until EVERY other active player agrees or
-- someone declines. This adds a time limit: if the request isn't fully agreed
-- within 60 seconds of void_at, it is cancelled automatically and the game
-- continues. A timeout is NOT a decline — the requester gets NO cooldown (only
-- an explicit decline does), so they can simply ask again.
--
-- Enforced server-side (authoritative) so it holds no matter which/whether a
-- client is watching:
--   • expire_void_scrabble_game — clears a pending request once it's >60s old.
--     Idempotent; any client can call it when its local countdown hits zero
--     (first caller wins, the rest no-op). Also self-heals a stale request if
--     everyone had closed the tab.
--   • request_void_scrabble_game — a lapsed pending request no longer BLOCKS a
--     new one (it's cleared first).
--   • respond_void_scrabble_game — agreeing/declining a lapsed request is
--     rejected + the request cleared, so a late "agree" can't void past the
--     window.
--
-- Window: 60 seconds. Run order: after 038_*.sql. Re-runnable.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- expire_void_scrabble_game — cancel a pending void that wasn't agreed in time.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.expire_void_scrabble_game(p_game_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_game record;
begin
  select * into v_game from public.arena_scrabble_games where id = p_game_id for update;
  if not found then return jsonb_build_object('ok', true, 'expired', false); end if;

  if v_game.status = 'active'
     and v_game.void_by is not null
     and v_game.void_at is not null
     and v_game.void_at < now() - interval '60 seconds' then
    update public.arena_scrabble_games
       set void_by = null, void_at = null, void_agreed = '{}', last_move_at = now()
     where id = p_game_id;
    return jsonb_build_object('ok', true, 'expired', true);
  end if;

  -- Not pending, not yet expired, or already handled by another client.
  return jsonb_build_object('ok', true, 'expired', false);
end;
$$;
revoke all on function public.expire_void_scrabble_game(uuid) from public;
grant execute on function public.expire_void_scrabble_game(uuid) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- request_void_scrabble_game — as 038, but a lapsed (>60s) pending request is
-- cleared first so it never blocks a fresh request.
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

  -- Auto-clear a lapsed request (nobody agreed within 60s) so it doesn't block.
  if v_game.void_by is not null and v_game.void_at is not null
     and v_game.void_at < now() - interval '60 seconds' then
    update public.arena_scrabble_games
       set void_by = null, void_at = null, void_agreed = '{}'
     where id = p_game_id;
    v_game.void_by := null;
  end if;

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
-- respond_void_scrabble_game — as 038, but a lapsed (>60s) request can no longer
-- be agreed/declined: it's cleared and the caller is told it expired.
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

  -- Too late: the request lapsed before this response. Clear it (no cooldown —
  -- a timeout is not a decline) and tell the caller the game just continues.
  if v_game.void_at is not null and v_game.void_at < now() - interval '60 seconds' then
    update public.arena_scrabble_games
       set void_by = null, void_at = null, void_agreed = '{}', last_move_at = now()
     where id = p_game_id;
    raise exception 'This void request has expired — the game continues';
  end if;

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
