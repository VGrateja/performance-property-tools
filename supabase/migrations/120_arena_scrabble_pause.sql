-- =============================================================================
-- 120_arena_scrabble_pause.sql — PAUSE / RESUME a Scrabble game (by consent)
--
-- Van (2026-09-11): "add a pause to a scrabble game. So players for that game
-- can request for a pause and continue the game some other time. Players who
-- have paused game cant participate in another game without finishing the
-- paused one."
--
-- Built as a mirror of the VOID flow (038 + 063) — same shape, same naming,
-- same error style — because pause is the same problem: a state change every
-- player has to agree to.
--
--   PAUSE   any active player asks; every other ACTIVE player must agree.
--           Unanimous → status flips to 'paused'. One decline → the game
--           continues and the REQUESTER is put on a 5-minute cooldown (the
--           others may still ask). Unanswered → the request lapses.
--   RESUME  the same machinery in the opposite direction: any player in a
--           paused game asks, every other active player must agree, and only
--           then does the game go back to 'active'. Deliberately NOT
--           unilateral — one player must not be able to restart an absent
--           player's turn clock at 3am.
--
-- New game state (arena_scrabble_games):
--   pause_by                 int          -- seat of the pending requester
--   pause_at                 timestamptz  -- when requested
--   pause_agreed             int[]        -- seats that have agreed (incl. requester)
--   paused_at                timestamptz  -- when the game actually froze
--   pause_turn_remaining_ms  int          -- the mover's banked clock (null = untimed)
-- Per-player cooldown (arena_scrabble_game_players):
--   pause_cooldown_until     timestamptz
--
-- There is ONE request slot for both directions; the game's STATUS says which
-- it is (pending on an 'active' game = a pause request; pending on a 'paused'
-- game = a resume request). A void request and a pause request can never be
-- open at the same time — each refuses while the other is pending.
--
-- THE CLOCK (must not be gameable)
--   A pause request does NOT stop the clock: while it is pending the game is
--   still live, so a player cannot dodge an imminent timeout by asking for a
--   pause. When the pause actually lands, whatever the player to move had
--   left is floored to the millisecond and banked in pause_turn_remaining_ms;
--   the resume back-dates turn_started_at so the deadline falls exactly that
--   far in the future. Banking 0 is legal and means the turn was already gone.
--   expire_scrabble_turn refuses outright on a paused game, so a paused board
--   can never time anyone out.
--
-- THE LOCK
--   A player who is an un-resigned participant in a 'paused' game cannot enter
--   another game. Enforced in the DATABASE on all four entry points —
--   create_scrabble_lobby, request_join_scrabble_lobby, accept_lobby_invite
--   and start_scrabble_lobby — and start_scrabble_lobby re-checks EVERY joined
--   participant, not just the host, because someone can have been sitting in
--   the lobby since before their other game froze. The error carries the
--   blocking game id in a machine-readable tag, "[paused_game:<uuid>]", so the
--   tool can offer a link straight back to it.
--   The lookup itself (scrabble_paused_game_for) swallows its own errors and
--   returns null: a broken lookup must never be able to stop the whole company
--   starting a game. It fails OPEN; only a positively-found paused game blocks.
--
-- ESCAPE HATCHES (a ghosted player must not lock everyone else out forever)
--   • resign_scrabble_game now accepts a paused game. The resigner takes the
--     loss and is freed; if that leaves one active player the game settles.
--   • request_void_scrabble_game / respond_void_scrabble_game now accept a
--     paused game, so a table that agrees can just bin it.
--   • settle_scrabble_game and _scrabble_void_game accept 'paused' so both of
--     the above can actually terminate the game.
--   There is deliberately NO automatic time-based expiry of a paused game:
--   Van's intent is "continue some other time", with no deadline. If that ever
--   needs to change, the natural shape is a sweeper like
--   expire_stale_scrabble_lobbies that abandons games paused for more than N
--   days — a future migration, not this one.
--
-- CONSENT WINDOW
--   A request lapses if it isn't answered: 60 seconds while the game is live
--   (mirroring the void window in 063 — everyone is at the board), 10 minutes
--   while it is paused (players drift in and out; a 60-second window would
--   make resuming practically impossible). Both live in one place,
--   _scrabble_consent_window, so the rule can be changed by editing one
--   function. The same window now governs void requests too, which is why the
--   void expiry moved onto the shared sweeper.
--
-- New RPCs: request_pause_scrabble_game, respond_pause_scrabble_game,
--   request_resume_scrabble_game, respond_resume_scrabble_game,
--   expire_scrabble_pause_request, plus the internal _scrabble_pause_game,
--   _scrabble_resume_game, _scrabble_expire_requests, _scrabble_consent_window,
--   scrabble_paused_game_for and _scrabble_block_if_paused.
--
-- Re-created here (bodies copied verbatim from the migration that last defined
-- them, with only the changes described above): settle_scrabble_game (101),
-- start_scrabble_lobby (101), expire_scrabble_turn (035), resign_scrabble_game
-- (035), _scrabble_void_game (038), request_void_scrabble_game /
-- respond_void_scrabble_game / expire_void_scrabble_game (063),
-- create_scrabble_lobby / request_join_scrabble_lobby / accept_lobby_invite
-- (108).
--
-- Run order: after 119_*.sql. Additive + re-runnable (add column if not
-- exists, drop-then-add on the status CHECK, create or replace throughout).
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- Schema — 'paused' becomes a legal game status, plus the request state.
-- (Drop + re-add the CHECK, the way 038 does for the matches termination.)
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.arena_scrabble_games drop constraint if exists arena_scrabble_games_status_check;
alter table public.arena_scrabble_games add constraint arena_scrabble_games_status_check
  check (status in ('active', 'paused', 'completed', 'abandoned'));

alter table public.arena_scrabble_games        add column if not exists pause_by                int;
alter table public.arena_scrabble_games        add column if not exists pause_at                timestamptz;
alter table public.arena_scrabble_games        add column if not exists pause_agreed            int[] not null default '{}';
alter table public.arena_scrabble_games        add column if not exists paused_at               timestamptz;
alter table public.arena_scrabble_games        add column if not exists pause_turn_remaining_ms int;
alter table public.arena_scrabble_game_players add column if not exists pause_cooldown_until    timestamptz;

alter table public.arena_scrabble_games drop constraint if exists arena_scrabble_games_pause_by_check;
alter table public.arena_scrabble_games add constraint arena_scrabble_games_pause_by_check
  check (pause_by is null or pause_by between 1 and 4);


-- ─────────────────────────────────────────────────────────────────────────────
-- _scrabble_consent_window — how long a consent request (void / pause /
-- resume) stays open before it lapses, given the game's status.
--   'paused' → 10 minutes.  Nobody is sitting at a frozen board; agreement is
--              gathered as players wander back. A 60-second window here would
--              mean a resume could only ever happen if every player happened
--              to have the tab open at the same moment.
--   anything else → 60 seconds.  The live-game window from 063, unchanged.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._scrabble_consent_window(p_status text)
  returns interval
  language sql
  immutable
  set search_path = public
as $$
  select case when p_status = 'paused' then interval '10 minutes'
              else interval '60 seconds' end;
$$;
revoke all on function public._scrabble_consent_window(text) from public;
revoke execute on function public._scrabble_consent_window(text) from anon;
grant execute on function public._scrabble_consent_window(text) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- _scrabble_expire_requests — the one sweeper for BOTH consent slots. Clears a
-- void request and/or a pause/resume request that has sat unanswered past the
-- window for the game's current status. Idempotent: first caller wins, the
-- rest no-op, so any client can fire it when its local countdown hits zero and
-- a request can never get stuck pending because everyone closed their tab.
-- A lapse is NOT a decline — nobody gets a cooldown for it.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._scrabble_expire_requests(p_game_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_game  record;
  v_void  boolean := false;
  v_pause boolean := false;
begin
  select * into v_game from public.arena_scrabble_games where id = p_game_id for update;
  if not found then
    return jsonb_build_object('ok', true, 'void_expired', false, 'pause_expired', false);
  end if;

  if v_game.void_by is not null and v_game.void_at is not null
     and v_game.void_at < now() - public._scrabble_consent_window(v_game.status) then
    update public.arena_scrabble_games
       set void_by = null, void_at = null, void_agreed = '{}', last_move_at = now()
     where id = p_game_id;
    v_void := true;
  end if;

  if v_game.pause_by is not null and v_game.pause_at is not null
     and v_game.pause_at < now() - public._scrabble_consent_window(v_game.status) then
    update public.arena_scrabble_games
       set pause_by = null, pause_at = null, pause_agreed = '{}', last_move_at = now()
     where id = p_game_id;
    v_pause := true;
  end if;

  return jsonb_build_object('ok', true, 'void_expired', v_void, 'pause_expired', v_pause);
end;
$$;
-- Internal: only the security-definer RPCs below call it. Not client-callable
-- (the two public wrappers, expire_void_scrabble_game and
-- expire_scrabble_pause_request, are the client's door in).
revoke all on function public._scrabble_expire_requests(uuid) from public;
revoke all on function public._scrabble_expire_requests(uuid) from anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- scrabble_paused_game_for — THE LOCK's lookup: the id of a 'paused' game this
-- user is still playing (un-resigned), or null.
--
-- Deliberately defensive. This runs inside every lobby entry point, so a fault
-- here would stop the whole company from starting a Scrabble game. It swallows
-- any error from the lookup and returns null — FAIL OPEN. Only a positively
-- found paused game is ever allowed to block anybody.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.scrabble_paused_game_for(p_user_id uuid)
  returns uuid
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_user_id is null then return null; end if;
  begin
    select g.id into v_id
      from public.arena_scrabble_games g
      join public.arena_scrabble_game_players gp on gp.game_id = g.id
     where gp.user_id = p_user_id
       and coalesce(gp.resigned, false) = false
       and g.status = 'paused'
     order by g.started_at desc
     limit 1;
  exception when others then
    return null;   -- fail OPEN: never let a broken lookup lock anyone out
  end;
  return v_id;
end;
$$;
revoke all on function public.scrabble_paused_game_for(uuid) from public;
revoke execute on function public.scrabble_paused_game_for(uuid) from anon;
grant execute on function public.scrabble_paused_game_for(uuid) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- _scrabble_block_if_paused — raise if the user is holding a paused game.
-- The message ends with a machine-readable "[paused_game:<uuid>]" tag so the
-- tool can turn the refusal into a link back to the game that's blocking them.
-- Internal: the lobby RPCs call it; clients never do.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._scrabble_block_if_paused(p_user_id uuid, p_action text)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_id uuid;
begin
  v_id := public.scrabble_paused_game_for(p_user_id);
  if v_id is not null then
    raise exception 'You have a paused game to finish first — resume, resign or void it before you %. [paused_game:%]',
                    coalesce(nullif(p_action, ''), 'play again'), v_id;
  end if;
end;
$$;
revoke all on function public._scrabble_block_if_paused(uuid, text) from public;
revoke all on function public._scrabble_block_if_paused(uuid, text) from anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- _scrabble_pause_game — freeze the board. Called once consensus is reached
-- (or immediately if the requester is the only active player).
--
-- Banks the mover's remaining clock. floor(), never round: a pause must not
-- hand back time. Clamped into [0, turn_time_seconds]; 0 is a legal bank and
-- means the turn had already run out, so it is still out on resume.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._scrabble_pause_game(p_game_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_game      record;
  v_remaining int;
begin
  select * into v_game from public.arena_scrabble_games where id = p_game_id for update;
  if not found then raise exception 'Game % not found', p_game_id; end if;
  if v_game.status = 'paused' then raise exception 'Game is already paused'; end if;
  if v_game.status <> 'active' then raise exception 'Game is %; cannot pause', v_game.status; end if;

  if v_game.turn_time_seconds is null or v_game.turn_started_at is null then
    v_remaining := null;                       -- untimed game: nothing to bank
  else
    v_remaining := greatest(0, least(
      (v_game.turn_time_seconds::bigint * 1000),
      floor(extract(epoch from
        (v_game.turn_started_at + make_interval(secs => v_game.turn_time_seconds) - now())
      ) * 1000)::bigint
    ))::int;
  end if;

  update public.arena_scrabble_games
     set status                  = 'paused',
         paused_at               = now(),
         pause_turn_remaining_ms = v_remaining,
         pause_by                = null,
         pause_at                = null,
         pause_agreed            = '{}',
         /* A void request can't survive the freeze — its window was measured
            against a live game. Ask again on the paused board if you meant it. */
         void_by                 = null,
         void_at                 = null,
         void_agreed             = '{}',
         draw_offer_by           = null,
         last_move_at            = now()
   where id = p_game_id;

  return jsonb_build_object(
    'ok',                true,
    'paused',            true,
    'game_id',           p_game_id,
    'turn_remaining_ms', v_remaining
  );
end;
$$;
-- Internal ONLY — never granted to clients. This is the function that actually
-- flips the status, so a direct grant would let one player pause a game
-- without anybody's consent. The consent RPCs reach it as security definers.
revoke all on function public._scrabble_pause_game(uuid) from public;
revoke all on function public._scrabble_pause_game(uuid) from anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- _scrabble_resume_game — un-freeze. Board, racks, scores and to_move were
-- never touched, so all that has to be restored is the clock: back-date
-- turn_started_at by the time that had already been used, so the deadline
-- lands exactly pause_turn_remaining_ms from now.
--
-- A null bank on a timed game (a row frozen before this column existed, or a
-- seat handed the turn mid-pause by a resignation) is read as a FULL turn —
-- always err towards giving the player their time, never towards taking it.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._scrabble_resume_game(p_game_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_game    record;
  v_used_ms bigint := 0;
begin
  select * into v_game from public.arena_scrabble_games where id = p_game_id for update;
  if not found then raise exception 'Game % not found', p_game_id; end if;
  if v_game.status <> 'paused' then raise exception 'Game is %; only a paused game can be resumed', v_game.status; end if;

  if v_game.turn_time_seconds is not null and v_game.pause_turn_remaining_ms is not null then
    v_used_ms := greatest(0, (v_game.turn_time_seconds::bigint * 1000) - v_game.pause_turn_remaining_ms);
  end if;

  update public.arena_scrabble_games
     set status                  = 'active',
         turn_started_at         = now() - make_interval(secs => (v_used_ms / 1000.0)::double precision),
         paused_at               = null,
         pause_turn_remaining_ms = null,
         pause_by                = null,
         pause_at                = null,
         pause_agreed            = '{}',
         last_move_at            = now()
   where id = p_game_id;

  return jsonb_build_object(
    'ok',       true,
    'resumed',  true,
    'game_id',  p_game_id,
    'to_move',  v_game.to_move,
    'clock_ms', v_game.pause_turn_remaining_ms
  );
end;
$$;
-- Internal ONLY — same reasoning as _scrabble_pause_game: this is the
-- unilateral un-freeze, and nobody gets to call it without consent.
revoke all on function public._scrabble_resume_game(uuid) from public;
revoke all on function public._scrabble_resume_game(uuid) from anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- request_pause_scrabble_game — a player asks to pause the game.
--   • Blocked if a pause or void request is already pending, or the caller is
--     on cooldown from a declined request.
--   • If there are no OTHER active players, pauses immediately.
--   • Otherwise records the request (requester implicitly agrees).
-- A lapsed request is swept first so it can never block a fresh one.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.request_pause_scrabble_game(p_game_id uuid)
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
  perform public._scrabble_expire_requests(p_game_id);

  select * into v_game from public.arena_scrabble_games where id = p_game_id for update;
  if not found then raise exception 'Game % not found', p_game_id; end if;
  if v_game.status = 'paused' then raise exception 'Game is already paused'; end if;
  if v_game.status <> 'active' then raise exception 'Game is no longer active'; end if;

  select * into v_my from public.arena_scrabble_game_players
    where game_id = p_game_id and user_id = auth.uid();
  if not found then raise exception 'You are not a participant in this game'; end if;
  if v_my.resigned then raise exception 'You have resigned from this game'; end if;

  if v_game.pause_by is not null then raise exception 'A pause request is already pending'; end if;
  if v_game.void_by  is not null then raise exception 'A void request is already pending — settle that first'; end if;
  if v_my.pause_cooldown_until is not null and v_my.pause_cooldown_until > now() then
    raise exception 'Your last pause request was declined — you can request again in % seconds',
                    ceil(extract(epoch from (v_my.pause_cooldown_until - now())))::int;
  end if;

  select count(*) into v_others from public.arena_scrabble_game_players
    where game_id = p_game_id and resigned = false and seat <> v_my.seat;

  -- No one else active to agree — pause straight away.
  if v_others <= 0 then
    return public._scrabble_pause_game(p_game_id);
  end if;

  update public.arena_scrabble_games
     set pause_by = v_my.seat, pause_at = now(), pause_agreed = array[v_my.seat], last_move_at = now()
   where id = p_game_id;

  return jsonb_build_object('ok', true, 'pending', true, 'pause_by', v_my.seat, 'intent', 'pause');
end;
$$;
revoke all on function public.request_pause_scrabble_game(uuid) from public;
revoke execute on function public.request_pause_scrabble_game(uuid) from anon;
grant execute on function public.request_pause_scrabble_game(uuid) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- respond_pause_scrabble_game — another player agrees or declines a pending
-- pause.
--   • Decline → cancel the request + 5-minute cooldown for the REQUESTER
--     (mirrors the void decline in 038; other players may still ask).
--   • Agree   → record agreement; once EVERY active player has agreed, pause.
--   • A lapsed request can no longer be answered — it is cleared and the
--     caller is told the game just continues (no cooldown; a timeout is not a
--     decline).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.respond_pause_scrabble_game(p_game_id uuid, p_agree boolean)
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
  if v_game.status = 'paused' then raise exception 'Game is already paused'; end if;
  if v_game.status <> 'active' then raise exception 'Game is no longer active'; end if;
  if v_game.pause_by is null then raise exception 'No pause request is pending'; end if;

  /* Too late: the request lapsed before this response arrived, so a late
     "agree" can't pause past the window. We only RAISE — deliberately no
     clearing UPDATE, because raising rolls back everything this call did
     (063 wrote one here and it was silently discarded every time). The
     lapsed row is cleaned by _scrabble_expire_requests instead: every
     request_* RPC sweeps before it reads, and the clients fire
     expire_scrabble_pause_request when their countdown hits zero. */
  if v_game.pause_at is not null
     and v_game.pause_at < now() - public._scrabble_consent_window(v_game.status) then
    raise exception 'This pause request has expired — the game continues';
  end if;

  select * into v_my from public.arena_scrabble_game_players
    where game_id = p_game_id and user_id = auth.uid();
  if not found then raise exception 'You are not a participant in this game'; end if;
  if v_my.resigned then raise exception 'You have resigned from this game'; end if;
  if v_my.seat = v_game.pause_by then raise exception 'You requested this pause — you can''t respond to it'; end if;

  if not p_agree then
    update public.arena_scrabble_game_players
       set pause_cooldown_until = now() + interval '5 minutes'
     where game_id = p_game_id and seat = v_game.pause_by;
    update public.arena_scrabble_games
       set pause_by = null, pause_at = null, pause_agreed = '{}', last_move_at = now()
     where id = p_game_id;
    return jsonb_build_object('ok', true, 'declined', true, 'continued', true);
  end if;

  v_agreed := v_game.pause_agreed;
  if not (v_my.seat = any(v_agreed)) then
    v_agreed := array_append(v_agreed, v_my.seat);
  end if;

  select count(*) into v_active from public.arena_scrabble_game_players
    where game_id = p_game_id and resigned = false;

  -- Everyone active has agreed → freeze the board.
  if coalesce(array_length(v_agreed, 1), 0) >= v_active then
    return public._scrabble_pause_game(p_game_id);
  end if;

  update public.arena_scrabble_games set pause_agreed = v_agreed, last_move_at = now()
   where id = p_game_id;
  return jsonb_build_object('ok', true, 'pending', true,
                            'agreed', coalesce(array_length(v_agreed, 1), 0), 'active', v_active);
end;
$$;
revoke all on function public.respond_pause_scrabble_game(uuid, boolean) from public;
revoke execute on function public.respond_pause_scrabble_game(uuid, boolean) from anon;
grant execute on function public.respond_pause_scrabble_game(uuid, boolean) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- request_resume_scrabble_game — the same request, pointing the other way: a
-- player in a PAUSED game asks to start playing again. Same consent rule, same
-- cooldown column, same lapse sweep. Unilateral resume is deliberately not
-- offered: restarting the board restarts somebody's turn clock.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.request_resume_scrabble_game(p_game_id uuid)
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
  perform public._scrabble_expire_requests(p_game_id);

  select * into v_game from public.arena_scrabble_games where id = p_game_id for update;
  if not found then raise exception 'Game % not found', p_game_id; end if;
  if v_game.status = 'active' then raise exception 'Game is already running'; end if;
  if v_game.status <> 'paused' then raise exception 'Game is %; nothing to resume', v_game.status; end if;

  select * into v_my from public.arena_scrabble_game_players
    where game_id = p_game_id and user_id = auth.uid();
  if not found then raise exception 'You are not a participant in this game'; end if;
  if v_my.resigned then raise exception 'You have resigned from this game'; end if;

  if v_game.pause_by is not null then raise exception 'A resume request is already pending'; end if;
  if v_game.void_by  is not null then raise exception 'A void request is already pending — settle that first'; end if;
  if v_my.pause_cooldown_until is not null and v_my.pause_cooldown_until > now() then
    raise exception 'Your last request was declined — you can ask again in % seconds',
                    ceil(extract(epoch from (v_my.pause_cooldown_until - now())))::int;
  end if;

  select count(*) into v_others from public.arena_scrabble_game_players
    where game_id = p_game_id and resigned = false and seat <> v_my.seat;

  -- No one else active to agree — resume straight away.
  if v_others <= 0 then
    return public._scrabble_resume_game(p_game_id);
  end if;

  update public.arena_scrabble_games
     set pause_by = v_my.seat, pause_at = now(), pause_agreed = array[v_my.seat], last_move_at = now()
   where id = p_game_id;

  return jsonb_build_object('ok', true, 'pending', true, 'pause_by', v_my.seat, 'intent', 'resume');
end;
$$;
revoke all on function public.request_resume_scrabble_game(uuid) from public;
revoke execute on function public.request_resume_scrabble_game(uuid) from anon;
grant execute on function public.request_resume_scrabble_game(uuid) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- respond_resume_scrabble_game — agree / decline a pending resume request.
-- Decline keeps the game paused and cools the requester down for 5 minutes.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.respond_resume_scrabble_game(p_game_id uuid, p_agree boolean)
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
  if v_game.status <> 'paused' then raise exception 'Game is %; nothing to resume', v_game.status; end if;
  if v_game.pause_by is null then raise exception 'No resume request is pending'; end if;

  /* Lapsed — raise only; see the note in respond_pause_scrabble_game. */
  if v_game.pause_at is not null
     and v_game.pause_at < now() - public._scrabble_consent_window(v_game.status) then
    raise exception 'This resume request has expired — the game is still paused';
  end if;

  select * into v_my from public.arena_scrabble_game_players
    where game_id = p_game_id and user_id = auth.uid();
  if not found then raise exception 'You are not a participant in this game'; end if;
  if v_my.resigned then raise exception 'You have resigned from this game'; end if;
  if v_my.seat = v_game.pause_by then raise exception 'You asked to resume — you can''t respond to it'; end if;

  if not p_agree then
    update public.arena_scrabble_game_players
       set pause_cooldown_until = now() + interval '5 minutes'
     where game_id = p_game_id and seat = v_game.pause_by;
    update public.arena_scrabble_games
       set pause_by = null, pause_at = null, pause_agreed = '{}', last_move_at = now()
     where id = p_game_id;
    return jsonb_build_object('ok', true, 'declined', true, 'still_paused', true);
  end if;

  v_agreed := v_game.pause_agreed;
  if not (v_my.seat = any(v_agreed)) then
    v_agreed := array_append(v_agreed, v_my.seat);
  end if;

  select count(*) into v_active from public.arena_scrabble_game_players
    where game_id = p_game_id and resigned = false;

  -- Everyone active has agreed → back to play.
  if coalesce(array_length(v_agreed, 1), 0) >= v_active then
    return public._scrabble_resume_game(p_game_id);
  end if;

  update public.arena_scrabble_games set pause_agreed = v_agreed, last_move_at = now()
   where id = p_game_id;
  return jsonb_build_object('ok', true, 'pending', true,
                            'agreed', coalesce(array_length(v_agreed, 1), 0), 'active', v_active);
end;
$$;
revoke all on function public.respond_resume_scrabble_game(uuid, boolean) from public;
revoke execute on function public.respond_resume_scrabble_game(uuid, boolean) from anon;
grant execute on function public.respond_resume_scrabble_game(uuid, boolean) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- expire_scrabble_pause_request — client-facing wrapper on the sweeper, for
-- the pause/resume countdown (the mirror of expire_void_scrabble_game).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.expire_scrabble_pause_request(p_game_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_r jsonb;
begin
  v_r := public._scrabble_expire_requests(p_game_id);
  return jsonb_build_object('ok', true, 'expired', coalesce((v_r->>'pause_expired')::boolean, false));
end;
$$;
revoke all on function public.expire_scrabble_pause_request(uuid) from public;
revoke execute on function public.expire_scrabble_pause_request(uuid) from anon;
grant execute on function public.expire_scrabble_pause_request(uuid) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- expire_void_scrabble_game — unchanged contract ({ ok, expired }), but the
-- work now happens in the shared sweeper so the void window follows the same
-- status-aware rule as pause (60s live, 10 min while paused).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.expire_void_scrabble_game(p_game_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_r jsonb;
begin
  v_r := public._scrabble_expire_requests(p_game_id);
  return jsonb_build_object('ok', true, 'expired', coalesce((v_r->>'void_expired')::boolean, false));
end;
$$;
revoke all on function public.expire_void_scrabble_game(uuid) from public;
revoke execute on function public.expire_void_scrabble_game(uuid) from anon;
grant execute on function public.expire_void_scrabble_game(uuid) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- request_void_scrabble_game — as 063, plus: a PAUSED game can be voided, the
-- lapse sweep is shared (and status-aware), and a pending pause/resume vote
-- blocks a void the same way a pending void blocks a pause.
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
  -- 120: sweep a lapsed void/pause request first so it never blocks a fresh
  -- one. (063 did this inline with a hard-coded 60s; the window is now
  -- status-aware and lives in _scrabble_expire_requests.)
  perform public._scrabble_expire_requests(p_game_id);

  select * into v_game from public.arena_scrabble_games where id = p_game_id for update;
  if not found then raise exception 'Game % not found', p_game_id; end if;
  if v_game.status not in ('active', 'paused') then raise exception 'Game is no longer active or paused (status=%)', v_game.status; end if;

  select * into v_my from public.arena_scrabble_game_players
    where game_id = p_game_id and user_id = auth.uid();
  if not found then raise exception 'You are not a participant in this game'; end if;
  if v_my.resigned then raise exception 'You have resigned from this game'; end if;

  if v_game.void_by is not null then raise exception 'A void request is already pending'; end if;
  -- 120: a pause/resume vote and a void vote can't be open at the same time.
  if v_game.pause_by is not null then raise exception 'A pause request is already pending — settle that first'; end if;
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
-- respond_void_scrabble_game — as 063, plus: a PAUSED game can be voided and
-- the lapse window follows the game's status.
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
  if v_game.status not in ('active', 'paused') then raise exception 'Game is no longer active or paused (status=%)', v_game.status; end if;
  if v_game.void_by is null then raise exception 'No void request is pending'; end if;

  -- Too late: the request lapsed before this response. Clear it (no cooldown —
  -- a timeout is not a decline) and tell the caller the game just continues.
  /* 120: window is now status-aware, and the clearing UPDATE 063 had here
     is gone — raising rolls the whole call back, so that update never
     persisted. _scrabble_expire_requests is the thing that actually clears
     a lapsed request (every request_* RPC sweeps first; clients call
     expire_void_scrabble_game on countdown zero). */
  if v_game.void_at is not null
     and v_game.void_at < now() - public._scrabble_consent_window(v_game.status) then
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

-- ─────────────────────────────────────────────────────────────────────────────
-- _scrabble_void_game — as 038, but a PAUSED game can be voided too (this is
-- one of the two escape hatches out of a game whose other player has gone
-- quiet), and the pause state is cleared along with the void state.
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
  if v_game.status not in ('active', 'paused') then raise exception 'Game is already %; cannot void', v_game.status; end if;
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
         void_by = null, void_at = null, void_agreed = '{}', draw_offer_by = null,
         /* 120: a voided game is over — drop any pause state with it. */
         paused_at = null, pause_turn_remaining_ms = null,
         pause_by = null, pause_at = null, pause_agreed = '{}'
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
-- expire_scrabble_turn — as 035, with an explicit refusal on a paused game.
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
  /* 120: a PAUSED board never times anyone out. The generic status check
     below already refuses, but this states the invariant explicitly so a
     later loosening of that check can't quietly reopen the hole. */
  if v_game.status = 'paused' then raise exception 'Game is paused — the turn clock is frozen'; end if;
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
-- resign_scrabble_game — as 035, extended to a PAUSED game (ESCAPE HATCH #1:
-- the resigner takes the loss and is freed from the lock; if that leaves one
-- active player the game settles and everyone is freed).
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
  /* 120: resigning out of a PAUSED game must work — it is the one escape
     hatch that does not need the other players' cooperation. */
  if v_game.status not in ('active', 'paused') then raise exception 'Game is no longer active (status=%)', v_game.status; end if;

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

  /* 120: a resignation invalidates any open consent vote. The pause/resume
     slot is cleared outright (the seat count it was counting against just
     changed); a void request is cleared only if the RESIGNER opened it —
     otherwise it stands, minus their seat, exactly as before. */
  if v_game.to_move = v_my.seat then
    /* It was their turn: hand off to the next active seat. On a LIVE game the
       new seat's clock starts now. On a PAUSED game there is no clock to
       start — bank a FULL turn for whoever inherits the move, so nobody
       inherits a nearly-expired clock they never used. */
    v_next := public._scrabble_next_active_seat(p_game_id, v_my.seat);
    update public.arena_scrabble_games
       set to_move = v_next,
           turn_started_at = case when status = 'paused' then turn_started_at else now() end,
           pause_turn_remaining_ms = case when status = 'paused'
                                          then turn_time_seconds * 1000
                                          else pause_turn_remaining_ms end,
           last_move_at = now(),
           draw_offer_by = case when draw_offer_by = v_my.seat then null else draw_offer_by end,
           void_by     = case when void_by = v_my.seat then null        else void_by     end,
           void_at     = case when void_by = v_my.seat then null        else void_at     end,
           void_agreed = case when void_by = v_my.seat then '{}'::int[] else void_agreed end,
           pause_by = null, pause_at = null, pause_agreed = '{}'
     where id = p_game_id;
  else
    -- Not their turn: leave the rotation alone; just clear any draw offer
    -- they had open and nudge last_move_at so watchers re-render.
    update public.arena_scrabble_games
       set last_move_at = now(),
           draw_offer_by = case when draw_offer_by = v_my.seat then null else draw_offer_by end,
           void_by     = case when void_by = v_my.seat then null        else void_by     end,
           void_at     = case when void_by = v_my.seat then null        else void_at     end,
           void_agreed = case when void_by = v_my.seat then '{}'::int[] else void_agreed end,
           pause_by = null, pause_at = null, pause_agreed = '{}'
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
-- settle_scrabble_game — as 101 (placement scoring, 5-game floor, resigned
-- ranked last), with one change: a PAUSED game can be settled, so resigning
-- out of a paused game actually ends it.
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
  /* 120: a PAUSED game can be settled — resign-while-paused funnels here. */
  if v_game.status not in ('active', 'paused') then raise exception 'Game is already %; cannot settle again', v_game.status; end if;
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

  /* PLACEMENT POINTS (replaces pairwise ELO, Van 2026-08-14).
     Fixed delta by finishing position, independent of opponent strength:

        delta = player_count + 1 - 2 * finish_rank

     For a 4-player game that IS the agreed table — 1st +3 · 2nd +1 · 3rd -1 ·
     4th -3 — and the formula keeps it ZERO-SUM at every lobby size, which a
     literal 4-value table does not:
        4 players   +3 +1 -1 -3   (sum 0)
        3 players   +2  0 -2      (sum 0)
        2 players   +1 -1         (sum 0)
     A literal table indexed by rank would hand a 2-player game +3 to the
     winner and +1 to the LOSER, inflating the ladder every head-to-head.

     Because it is zero-sum the total in circulation never drifts: points only
     move between players. Casual games still freeze points entirely.

     Ties are the one exception — players sharing a finish_rank each take that
     position's delta, so a tied game can move the total by a few points. Rare
     enough to leave alone. */
  v_pts_after := v_pts_before;
  if v_game.ranked then
    for v_i in 1 .. v_n loop
      v_pts_after[v_i] := v_pts_before[v_i] + (v_n + 1 - 2 * v_finish_rank[v_i]);
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
      match_id, seat, user_id, email, name, score, pts_before, pts_after, finish_rank,
      leftover                                                       -- 039: persist leftover
    ) values (
      v_match_id, v_seats[v_i], v_user_ids[v_i], v_emails[v_i], v_names[v_i],
      v_scores[v_i], v_pts_before[v_i], v_pts_after[v_i]::int, v_finish_rank[v_i],
      v_leftover[v_i]                                                -- 039: persist leftover
    );
  end loop;

  update public.arena_scrabble_games
     set status = 'completed', ended_at = now(), draw_offer_by = null,
         /* 120: the game is over — clear any pause state with it. */
         paused_at = null, pause_turn_remaining_ms = null,
         pause_by = null, pause_at = null, pause_agreed = '{}'
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


-- ═════════════════════════════════════════════════════════════════════════════
-- THE LOCK — "players who have a paused game can't participate in another one
-- without finishing the paused one". Enforced in the DATABASE on all four
-- entry points, because a UI-only guard is one devtools console away from
-- being bypassed.
-- ═════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- create_scrabble_lobby — as 108 + THE LOCK.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.create_scrabble_lobby(
  p_max_players       int     default 4,
  p_ranked            boolean default true,
  p_turn_time_seconds int     default null
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
  if p_turn_time_seconds is not null and p_turn_time_seconds not between 30 and 3600 then
    raise exception 'turn_time_seconds must be between 30 and 3600 (or null for untimed)';
  end if;

  select email into v_email from auth.users where id = v_uid;
  if v_email is null then raise exception 'Could not resolve caller email'; end if;
  v_name := split_part(v_email, '@', 1);

  /* 120 THE LOCK — checked BEFORE release_other_lobbies, so a refused create
     never tears down the lobby the caller already had. */
  perform public._scrabble_block_if_paused(v_uid, 'create a lobby');

  perform public.scrabble_release_other_lobbies(v_uid, null);

  insert into public.arena_scrabble_lobbies (
    host_user_id, host_email, host_name, max_players, ranked, turn_time_seconds
  ) values (
    v_uid, v_email, v_name, p_max_players, p_ranked, p_turn_time_seconds
  ) returning id into v_id;

  insert into public.arena_scrabble_lobby_players (lobby_id, user_id, email, name, status, joined_at)
    values (v_id, v_uid, v_email, v_name, 'joined', now());

  return v_id;
end;
$$;
revoke all on function public.create_scrabble_lobby(int, boolean, int) from public;
revoke execute on function public.create_scrabble_lobby(int, boolean, int) from anon;
grant execute on function public.create_scrabble_lobby(int, boolean, int) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- request_join_scrabble_lobby — as 108 + THE LOCK.
-- ─────────────────────────────────────────────────────────────────────────────
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
  v_row    record;
  v_count  int;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  /* 120 THE LOCK — before any read or write, so no partial state is left. */
  perform public._scrabble_block_if_paused(v_uid, 'join another one');

  select * into v_lobby from public.arena_scrabble_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.status <> 'open' then raise exception 'Lobby is no longer open'; end if;
  if v_lobby.host_user_id = v_uid then return; end if;   -- host's already joined

  select * into v_row from public.arena_scrabble_lobby_players
    where lobby_id = p_lobby_id and user_id = v_uid for update;

  if found and v_row.status = 'invited' then
    /* Requesting a lobby you're invited to = accepting the invite. */
    select count(*) into v_count from public.arena_scrabble_lobby_players
      where lobby_id = p_lobby_id and status = 'joined';
    if v_count >= v_lobby.max_players then raise exception 'Lobby is full'; end if;
    perform public.scrabble_release_other_lobbies(v_uid, p_lobby_id);
    update public.arena_scrabble_lobby_players
       set status = 'joined', joined_at = now()
     where lobby_id = p_lobby_id and user_id = v_uid;
    update public.arena_scrabble_lobbies
       set expires_at = now() + interval '10 minutes'
     where id = p_lobby_id;
    return;
  end if;

  if found and v_row.status in ('left', 'kicked') then
    update public.arena_scrabble_lobby_players
       set status = 'requested'
     where lobby_id = p_lobby_id and user_id = v_uid;
    return;
  end if;

  if found then return; end if;   -- already requested / joined — no-op

  select email into v_email from auth.users where id = v_uid;
  v_name := split_part(v_email, '@', 1);
  insert into public.arena_scrabble_lobby_players (lobby_id, user_id, email, name, status)
    values (p_lobby_id, v_uid, v_email, v_name, 'requested');
end;
$$;
revoke all on function public.request_join_scrabble_lobby(uuid) from public;
revoke execute on function public.request_join_scrabble_lobby(uuid) from anon;
grant execute on function public.request_join_scrabble_lobby(uuid) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- accept_lobby_invite — as 108 + THE LOCK.
-- ─────────────────────────────────────────────────────────────────────────────
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
  /* 120 THE LOCK — before release_other_lobbies, so a refused accept never
     costs the caller the lobby they were already in. */
  perform public._scrabble_block_if_paused(v_uid, 'accept an invite');

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

  /* One lobby at a time: cancel any open lobby I host and walk out of any
     other open lobby I'm attached to, so the client's single "My lobby"
     slot can never hide a membership. */
  perform public.scrabble_release_other_lobbies(v_uid, p_lobby_id);

  update public.arena_scrabble_lobby_players
     set status = 'joined', joined_at = now()
   where lobby_id = p_lobby_id and user_id = v_uid;

  /* Successful join — refresh expiry. */
  update public.arena_scrabble_lobbies
     set expires_at = now() + interval '10 minutes'
   where id = p_lobby_id;
end;
$$;
revoke all on function public.accept_lobby_invite(uuid) from public;
revoke execute on function public.accept_lobby_invite(uuid) from anon;
grant execute on function public.accept_lobby_invite(uuid) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- start_scrabble_lobby — as 101 + THE LOCK, re-checked for every participant.
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
  v_power     text;   -- shuffled power letters (J,Q,X,Z — one each)
  v_rest      text;   -- shuffled remaining 96 tiles
  v_bag       text;
  v_rack      text;
  v_game_id   uuid;
  v_pts       int;
  v_chk       record;   -- 120: per-participant paused-game re-check
  v_blocked   uuid;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;

  select * into v_lobby from public.arena_scrabble_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_user_id <> v_uid then raise exception 'Only the host can start the game'; end if;
  if v_lobby.status <> 'open' then raise exception 'Lobby is no longer open (status=%)', v_lobby.status; end if;

  select count(*) into v_n from public.arena_scrabble_lobby_players
    where lobby_id = p_lobby_id and status = 'joined';
  if v_n < 2 then raise exception 'Need at least 2 joined players to start (have %)', v_n; end if;

  /* 120 THE LOCK, re-checked at START time for EVERY joined participant — not
     just the caller. A player can have been sitting in this lobby since before
     their other game froze, so the host's own clean sheet says nothing about
     theirs. Runs before a single row of the new game is written. */
  for v_chk in
    select lp.user_id, lp.email, lp.name
    from public.arena_scrabble_lobby_players lp
    where lp.lobby_id = p_lobby_id and lp.status = 'joined'
  loop
    v_blocked := public.scrabble_paused_game_for(v_chk.user_id);
    if v_blocked is not null then
      if v_chk.user_id = v_uid then
        raise exception 'You have a paused game to finish first — resume, resign or void it before you start another. [paused_game:%]', v_blocked;
      else
        raise exception '% has a paused game to finish — they can''t start another until it is resumed, resigned or voided. Remove them from the lobby to start without them.',
                        coalesce(nullif(v_chk.name, ''), split_part(v_chk.email, '@', 1), 'That player');
      end if;
    end if;
  end loop;

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
      100
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

revoke all on function public.start_scrabble_lobby(uuid) from public;
revoke execute on function public.start_scrabble_lobby(uuid) from anon;
grant execute on function public.start_scrabble_lobby(uuid) to authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- Grants housekeeping
--
-- create-or-replace preserves the existing ACL, so the re-created functions
-- above already carry their old grants. These statements restate the anon
-- lockout (the 115 rule: every security-definer function gets an anon revoke)
-- so the file is self-sufficient if it is ever replayed onto a fresh database.
-- ═════════════════════════════════════════════════════════════════════════════
revoke execute on function public.request_void_scrabble_game(uuid)             from anon;
revoke execute on function public.respond_void_scrabble_game(uuid, boolean)    from anon;
revoke execute on function public.expire_scrabble_turn(uuid)                   from anon;
revoke execute on function public.resign_scrabble_game(uuid)                   from anon;
revoke execute on function public.settle_scrabble_game(uuid, text)             from anon;

-- 120: _scrabble_void_game was granted to `authenticated` by 038, but it is the
-- internal settler — it performs no participant check at all, so the grant let
-- any signed-in user void any game outright, skipping the consent flow. The
-- only callers are request_void_scrabble_game / respond_void_scrabble_game,
-- which are SECURITY DEFINER and therefore reach it as the owner regardless.
-- Nothing in tools/arena-scrabble.html ever called it directly.
-- (To undo: grant execute on function public._scrabble_void_game(uuid) to authenticated;)
revoke all on function public._scrabble_void_game(uuid) from anon, authenticated;

