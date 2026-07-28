-- =============================================================================
-- 092_arena_skribbl_void_game.sql — "Void game" for Skribbl
--
-- Ports the Scrabble void model (038 + 063) to Skribbl, same rules so the two
-- games behave identically for players:
--   • Any active player may REQUEST a void.
--   • Every OTHER active player must agree, within 60 seconds.
--   • A decline cancels the request, the game continues, and the REQUESTER is
--     put on a 5-minute cooldown (anyone else may still request meanwhile).
--   • A timeout is NOT a decline — the request just lapses, no cooldown, so
--     the requester can simply ask again.
--   • A successful void ends the game with NO points: unlike a normal finish,
--     no match row is written, so nothing reaches arena_skribbl_points.
--
-- Expiry is enforced server-side inside skribbl_tick() — every client already
-- calls that every 3 seconds, so a lapsed request self-heals even if the
-- requester closed their tab. No extra RPC and no cron needed.
--
-- Run order: after 091_*.sql. Re-runnable.
-- =============================================================================

-- 'void' becomes a terminal game status alongside finished/abandoned.
alter table public.arena_skribbl_games drop constraint if exists arena_skribbl_games_status_check;
alter table public.arena_skribbl_games add constraint arena_skribbl_games_status_check
  check (status in ('active', 'finished', 'abandoned', 'void'));

alter table public.arena_skribbl_games        add column if not exists void_by     int;
alter table public.arena_skribbl_games        add column if not exists void_at     timestamptz;
alter table public.arena_skribbl_games        add column if not exists void_agreed int[] not null default '{}';
alter table public.arena_skribbl_game_players add column if not exists void_cooldown_until timestamptz;


-- ─────────────────────────────────────────────────────────────────────────────
-- _skribbl_void_game — end the game as VOID. No match row is written, so no
-- points reach the leaderboard (the Skribbl equivalent of Scrabble's
-- "pts_after = pts_before"). Scores stay visible on the final card for context.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._skribbl_void_game(p_game_id uuid)
  returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_g record; v_summary jsonb;
begin
  select * into v_g from public.arena_skribbl_games where id = p_game_id for update;
  if not found then raise exception 'Game not found'; end if;
  if v_g.status <> 'active' then raise exception 'Game is already %; cannot void', v_g.status; end if;

  select jsonb_agg(jsonb_build_object('name', name, 'seat', seat, 'score', score) order by score desc)
    into v_summary from public.arena_skribbl_game_players where game_id = p_game_id;

  update public.arena_skribbl_games
     set status = 'void', phase = 'ended', finished_at = now(),
         phase_ends_at = null, hint = null,
         void_by = null, void_at = null, void_agreed = '{}',
         round_summary = v_summary
   where id = p_game_id;

  insert into public.arena_skribbl_guesses (game_id, turn_no, kind, text)
    values (p_game_id, (v_g.round_no - 1) * v_g.player_count + v_g.drawer_seat + 1,
            'system', 'Game voided by agreement — no points awarded.');

  return jsonb_build_object('ok', true, 'voided', true);
end;
$fn$;
revoke all on function public._skribbl_void_game(uuid) from public;


-- ─────────────────────────────────────────────────────────────────────────────
-- request_skribbl_void — ask everyone else to void. Clears a lapsed request
-- first so a stale one can never block a fresh ask.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.request_skribbl_void(p_game_id uuid)
  returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_g record; v_me record; v_others int;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;

  select * into v_g from public.arena_skribbl_games where id = p_game_id for update;
  if not found then raise exception 'Game not found'; end if;
  if v_g.status <> 'active' then raise exception 'Game is no longer active'; end if;

  -- a pending request older than the 60s window is dead — clear it
  if v_g.void_by is not null and v_g.void_at < now() - interval '60 seconds' then
    update public.arena_skribbl_games set void_by = null, void_at = null, void_agreed = '{}'
     where id = p_game_id;
    v_g.void_by := null;
  end if;

  select * into v_me from public.arena_skribbl_game_players
   where game_id = p_game_id and user_id = auth.uid();
  if not found then raise exception 'You are not in this game'; end if;
  if v_me.left_at is not null then raise exception 'You have left this game'; end if;
  if v_g.void_by is not null then raise exception 'A void request is already pending'; end if;
  if v_me.void_cooldown_until is not null and v_me.void_cooldown_until > now() then
    raise exception 'Your last void was declined — you can ask again in % seconds',
                    ceil(extract(epoch from (v_me.void_cooldown_until - now())))::int;
  end if;

  select count(*) into v_others from public.arena_skribbl_game_players
   where game_id = p_game_id and left_at is null and seat <> v_me.seat;

  if v_others <= 0 then                     -- nobody left to agree
    return public._skribbl_void_game(p_game_id);
  end if;

  update public.arena_skribbl_games
     set void_by = v_me.seat, void_at = now(), void_agreed = array[v_me.seat]
   where id = p_game_id;

  insert into public.arena_skribbl_guesses (game_id, turn_no, kind, text)
    values (p_game_id, (v_g.round_no - 1) * v_g.player_count + v_g.drawer_seat + 1,
            'system', coalesce(v_me.name, 'A player') || ' asked to void the game.');

  return jsonb_build_object('ok', true, 'pending', true, 'void_by', v_me.seat);
end;
$fn$;
revoke all on function public.request_skribbl_void(uuid) from public;
grant execute on function public.request_skribbl_void(uuid) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- respond_skribbl_void — agree or decline. A late response to a lapsed request
-- is rejected (and the request cleared) so nobody can void past the window.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.respond_skribbl_void(p_game_id uuid, p_agree boolean)
  returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_g record; v_me record; v_active int; v_agreed int[]; v_name text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;

  select * into v_g from public.arena_skribbl_games where id = p_game_id for update;
  if not found then raise exception 'Game not found'; end if;
  if v_g.status <> 'active' then raise exception 'Game is no longer active'; end if;
  if v_g.void_by is null then raise exception 'No void request is pending'; end if;

  if v_g.void_at < now() - interval '60 seconds' then
    update public.arena_skribbl_games set void_by = null, void_at = null, void_agreed = '{}'
     where id = p_game_id;
    raise exception 'That void request has expired';
  end if;

  select * into v_me from public.arena_skribbl_game_players
   where game_id = p_game_id and user_id = auth.uid();
  if not found then raise exception 'You are not in this game'; end if;
  if v_me.left_at is not null then raise exception 'You have left this game'; end if;
  if v_me.seat = v_g.void_by then raise exception 'You asked for this void — you cannot answer it'; end if;

  if not p_agree then
    update public.arena_skribbl_game_players
       set void_cooldown_until = now() + interval '5 minutes'
     where game_id = p_game_id and seat = v_g.void_by;
    update public.arena_skribbl_games set void_by = null, void_at = null, void_agreed = '{}'
     where id = p_game_id;
    insert into public.arena_skribbl_guesses (game_id, turn_no, kind, text)
      values (p_game_id, (v_g.round_no - 1) * v_g.player_count + v_g.drawer_seat + 1,
              'system', coalesce(v_me.name, 'A player') || ' declined the void — play on.');
    return jsonb_build_object('ok', true, 'declined', true);
  end if;

  v_agreed := v_g.void_agreed;
  if not (v_me.seat = any(v_agreed)) then v_agreed := array_append(v_agreed, v_me.seat); end if;

  select count(*) into v_active from public.arena_skribbl_game_players
   where game_id = p_game_id and left_at is null;

  if coalesce(array_length(v_agreed, 1), 0) >= v_active then
    return public._skribbl_void_game(p_game_id);
  end if;

  update public.arena_skribbl_games set void_agreed = v_agreed where id = p_game_id;
  return jsonb_build_object('ok', true, 'pending', true,
                            'agreed', coalesce(array_length(v_agreed, 1), 0), 'active', v_active);
end;
$fn$;
revoke all on function public.respond_skribbl_void(uuid, boolean) from public;
grant execute on function public.respond_skribbl_void(uuid, boolean) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- skribbl_tick — unchanged except for the void-expiry sweep at the top. Every
-- client calls this every 3s, so a lapsed request clears itself; a timeout is
-- NOT a decline, so no cooldown is applied.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.skribbl_tick(p_game_id uuid)
  returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_g record; v_r record; v_turn int; v_due boolean;
  v_next_seat int; v_next_round int; v_next_turn int; v_drawer record;
  v_choices text[]; v_elapsed numeric; v_want int; v_match uuid;
begin
  select * into v_g from public.arena_skribbl_games where id = p_game_id for update;
  if not found or v_g.status <> 'active' then return; end if;

  -- lapsed void request → clear it and carry on (no cooldown: not a decline)
  if v_g.void_by is not null and v_g.void_at < now() - interval '60 seconds' then
    update public.arena_skribbl_games set void_by = null, void_at = null, void_agreed = '{}'
     where id = p_game_id;
    insert into public.arena_skribbl_guesses (game_id, turn_no, kind, text)
      values (p_game_id, (v_g.round_no - 1) * v_g.player_count + v_g.drawer_seat + 1,
              'system', 'The void request expired — play on.');
  end if;

  v_turn := (v_g.round_no - 1) * v_g.player_count + v_g.drawer_seat + 1;
  v_due  := v_g.phase_ends_at is not null and now() >= v_g.phase_ends_at;

  if v_g.phase = 'choosing' and v_due then
    perform public.skribbl_choose_word_auto(p_game_id);
    return;
  end if;

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

  if v_g.phase = 'reveal' and v_due then
    v_next_seat := v_g.drawer_seat + 1;
    v_next_round := v_g.round_no;
    if v_next_seat >= v_g.player_count then v_next_seat := 0; v_next_round := v_next_round + 1; end if;

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
          from public.arena_skribbl_game_players gp where gp.game_id = p_game_id;

      insert into public.arena_skribbl_guesses (game_id, turn_no, kind, text)
        values (p_game_id, v_turn, 'system', 'Game over — final scores are in.');
      return;
    end if;

    v_next_turn := (v_next_round - 1) * v_g.player_count + v_next_seat + 1;
    select * into v_drawer from public.arena_skribbl_game_players
     where game_id = p_game_id and seat = v_next_seat;
    v_choices := public.skribbl_pick_choices(p_game_id, v_g.topic, v_g.difficulty);

    insert into public.arena_skribbl_rounds (game_id, turn_no, round_no, drawer_seat, drawer_id, choices)
      values (p_game_id, v_next_turn, v_next_round, v_next_seat, v_drawer.user_id, v_choices)
      on conflict (game_id, turn_no) do nothing;

    update public.arena_skribbl_game_players
       set guessed_at = null, guess_rank = null, round_pts = 0 where game_id = p_game_id;

    update public.arena_skribbl_games
       set round_no = v_next_round, drawer_seat = v_next_seat,
           phase = 'choosing', phase_ends_at = now() + interval '20 seconds',
           hint = null, word_len = null, reveal_word = null, round_summary = null
     where id = p_game_id;
  end if;
end;
$fn$;
revoke all on function public.skribbl_tick(uuid) from public;
grant execute on function public.skribbl_tick(uuid) to authenticated;
