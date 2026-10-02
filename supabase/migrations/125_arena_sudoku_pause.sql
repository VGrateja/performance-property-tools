-- =============================================================================
-- 125_arena_sudoku_pause.sql — Arena Sudoku: the BLIND pause
--
-- Van (2026-10-02), replacing the 2026-09-29 rule ("the clock never stops"):
-- a player asked for a pause. A pause can be a cheat (stop the clock, keep
-- thinking), so it is BLIND — the clock stops only while the board is hidden —
-- and it is AUTOMATIC on leaving: "exiting the tab or exiting the game will
-- pause it automatically, like if there's electric/internet interruption so it
-- auto-pauses." No penalty for pausing and no "untimed" flag: times rank for
-- medals and leaderboards exactly as before. Van accepts the residual loophole
-- (photograph the board, then pause): "since this is a company setup, if they
-- cheat there's a problem with the culture."
--
-- THE CLOCK (server-authoritative; the client never sends a time)
--   elapsed = (finished_at | ended_at | the pause start | now) - started_at - paused_ms
--   pause    sudoku_pause: paused_at = now() (the page has already hidden the
--            board). It may carry the board, so the page's unload beacon is ONE
--            keepalive request — a separate save could land after the pause,
--            be refused, and lose the last move.
--   resume   sudoku_resume: paused_ms += floor(now - paused_at), pauses + 1,
--            paused_at = null. floor(), never round: a pause never hands back
--            time (the 120 Scrabble rule).
--   paused   check / hint / save / submit answer {ok:false, reason:'paused'}.
--   Penalties (+0:30 a wrong digit, +1:00 a hint), the 250 ms/cell floor (now
--   on the running time), the penalty box and every tamper rule are unchanged.
--
-- THE HEARTBEAT + RECONCILE (an outage cannot send a pause)
--   The page calls sudoku_heartbeat every 15 s while the board shows and runs;
--   it stamps last_seen_at (so does any other activity on a running attempt).
--   EVERY call on an attempt first reconciles: an active, running attempt whose
--   last_seen_at is more than 45 s old becomes paused FROM last_seen_at
--   (paused_at := last_seen_at). Resume then banks the whole gap and counts the
--   pause — so a power cut, a dead connection or a crashed tab stops the clock
--   at the last heartbeat, not when the player comes back, and the next visit
--   shows the cover. Reads that don't write compute the same thing on the fly
--   (_sudoku_pause_start). A gap of 45 s or less is counted as play.
--
-- BACKWARD COMPATIBILITY (this file goes live before the page does)
--   last_seen_at is NULL until an attempt's first heartbeat / resume, and the
--   reconcile only applies once it is set. A page that never heartbeats — the
--   2026-09-30 build, still open or cached when 125 is applied — keeps the
--   never-stopping clock on its attempts and is never refused as 'paused'.
--   Skipping heartbeats can only cost a player time (the reconcile is a
--   favour), so the gate opens no cheat. No existing RPC changes signature;
--   payloads only gain keys.
--
-- NOT BROUGHT BACK from the first build (2026-09-28, removed 2026-09-29): no
-- client-side time, no pause that leaves the board visible, and no "pause the
-- other attempts" side effect (_sudoku_pause_others stays gone): each attempt
-- — a ladder stage, a daily, a sprint puzzle — pauses on its own.
--
-- DATA MODEL
--   arena_sudoku_attempts        + paused_at, paused_ms, pauses, last_seen_at
--   arena_sudoku_clears          + pauses, paused_ms (copied at the clear)
--   arena_sudoku_special_clears  + pauses, paused_ms
--   views, columns appended: arena_sudoku_best, arena_sudoku_stage_ranks,
--   arena_sudoku_special_ranks, arena_sudoku_sprint_totals (summed)
--
-- RPCs  new: sudoku_pause, sudoku_resume, sudoku_heartbeat, and the internal
--   _sudoku_heartbeat_ms, _sudoku_stale_after, _sudoku_pause_start,
--   _sudoku_reconcile, _sudoku_touch, _sudoku_paused_refusal, _sudoku_check_marks.
--   Re-created (bodies copied from 122 / 124 — only the pause changes):
--   _sudoku_elapsed, _sudoku_attempt_for_update (now reconciles), _sudoku_payload,
--   _sudoku_finish_special, sudoku_start, sudoku_daily_start, sudoku_sprint_start,
--   sudoku_restart, sudoku_save, sudoku_check, sudoku_hint, sudoku_submit,
--   sudoku_overview, sudoku_stage_board, sudoku_ranking, sudoku_daily_overview,
--   sudoku_daily_board, sudoku_sprint_overview.
--
-- RUN ORDER: 122 -> 124 -> 125. Re-runnable (add column if not exists, guarded
-- constraints, create or replace, drop ... if exists). CAUTION: re-running 122
-- after this file DROPS paused_at / paused_ms / pauses (122 removes the first
-- build's columns of those names) and sudoku_resume(bigint), and puts back 122's
-- bodies; re-run 124 and then this file to converge (the pause history on the
-- attempts would be gone; the clears keep their own copy).
-- Apply: supabase db query --linked -f supabase/migrations/125_arena_sudoku_pause.sql
-- (NEVER db push — see CLAUDE.md.)
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- Columns
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.arena_sudoku_attempts add column if not exists paused_at    timestamptz;              -- null = the clock is running
alter table public.arena_sudoku_attempts add column if not exists paused_ms    bigint not null default 0;  -- closed pauses, banked
alter table public.arena_sudoku_attempts add column if not exists pauses       int    not null default 0;  -- completed pauses
alter table public.arena_sudoku_attempts add column if not exists last_seen_at timestamptz;              -- last heartbeat; null = never heartbeated
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'arena_sudoku_attempts_pause_check') then
    alter table public.arena_sudoku_attempts add constraint arena_sudoku_attempts_pause_check
      check (paused_ms >= 0 and pauses >= 0);
  end if;
end $$;

-- the clear rows carry the pause facts too (transparency: times are NOT adjusted)
alter table public.arena_sudoku_clears         add column if not exists pauses    int    not null default 0;
alter table public.arena_sudoku_clears         add column if not exists paused_ms bigint not null default 0;
alter table public.arena_sudoku_special_clears add column if not exists pauses    int    not null default 0;
alter table public.arena_sudoku_special_clears add column if not exists paused_ms bigint not null default 0;


-- ─────────────────────────────────────────────────────────────────────────────
-- Views — the 122 / 124 definitions with pauses + paused_ms APPENDED (create or
-- replace view may only add columns at the end; every column is listed)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.arena_sudoku_best
with (security_invoker = on) as
select distinct on (c.stage, c.user_id)
  c.stage, c.user_id, c.name, c.final_ms, c.elapsed_ms, c.penalty_ms,
  c.mistakes, c.hints, c.finished_at, c.kind, c.pauses, c.paused_ms
from public.arena_sudoku_clears c
order by c.stage, c.user_id, c.final_ms, c.finished_at;

create or replace view public.arena_sudoku_stage_ranks
with (security_invoker = on) as
select b.stage, b.user_id, b.name, b.final_ms, b.elapsed_ms, b.penalty_ms,
  b.mistakes, b.hints, b.finished_at, b.kind,
  rank()   over (partition by b.stage order by b.final_ms, b.finished_at)::int as stage_rank,
  count(*) over (partition by b.stage)::int                                   as stage_players,
  b.pauses, b.paused_ms
from public.arena_sudoku_best b;

create or replace view public.arena_sudoku_special_ranks
with (security_invoker = on) as
select c.id, c.attempt_id, c.special_id, c.kind, c.day, c.slot, c.user_id, c.name,
  c.final_ms, c.elapsed_ms, c.penalty_ms, c.mistakes, c.hints, c.finished_at,
  rank()   over (partition by c.special_id order by c.final_ms, c.finished_at)::int as pz_rank,
  count(*) over (partition by c.special_id)::int                                   as pz_players,
  c.pauses, c.paused_ms
from public.arena_sudoku_special_clears c;

create or replace view public.arena_sudoku_sprint_totals
with (security_invoker = on) as
with t as (
  select c.day as week, c.user_id, max(c.name) as name, count(*)::int as done,
         sum(c.final_ms)::bigint as total_ms, max(c.finished_at) as completed_at,
         sum(c.pauses)::int as pauses, sum(c.paused_ms)::bigint as paused_ms
    from public.arena_sudoku_special_clears c
   where c.kind = 'sprint'
   group by c.day, c.user_id
)
select t.week, t.user_id, t.name, t.done, t.total_ms, t.completed_at,
  case when t.done >= 5 then
    (row_number() over (partition by t.week, (t.done >= 5) order by t.total_ms, t.completed_at, t.user_id))::int
  end as week_rank,
  (count(*) filter (where t.done >= 5) over (partition by t.week))::int as week_finishers,
  t.pauses, t.paused_ms
from t;

revoke all on table public.arena_sudoku_best          from anon;
revoke all on table public.arena_sudoku_stage_ranks   from anon;
revoke all on table public.arena_sudoku_special_ranks from anon;
revoke all on table public.arena_sudoku_sprint_totals from anon;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_best          from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_stage_ranks   from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_special_ranks from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_sprint_totals from authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- Internal helpers (EXECUTE for nobody but the owner)
-- ─────────────────────────────────────────────────────────────────────────────

-- The two numbers of the outage rule, in one place: the page heartbeats every
-- 15 s while the board shows; a board silent for more than 45 s (three missed
-- beats) counts as paused from its last heartbeat.
create or replace function public._sudoku_heartbeat_ms()
returns int
language sql immutable set search_path = public, pg_temp as $$
  select 15000;
$$;

create or replace function public._sudoku_stale_after()
returns interval
language sql immutable set search_path = public, pg_temp as $$
  select interval '45 seconds';
$$;

-- When the attempt's current pause began, as the server sees it — or null while
-- the clock runs. paused_at when the page paused it; last_seen_at when a
-- heartbeating board has gone silent for longer than _sudoku_stale_after() (an
-- outage the page could not report). Never-heartbeated attempts (last_seen_at
-- null: a pre-125 page) are never treated as paused.
create or replace function public._sudoku_pause_start(p_attempt public.arena_sudoku_attempts)
returns timestamptz
language sql stable set search_path = public, pg_temp as $$
  select case
    when p_attempt.status is distinct from 'active' then null
    when p_attempt.paused_at is not null then p_attempt.paused_at
    when p_attempt.last_seen_at is not null and now() - p_attempt.last_seen_at > public._sudoku_stale_after()
      then p_attempt.last_seen_at
  end;
$$;

-- Server-computed solving time. 125: the clock stops only while the board is
-- hidden — elapsed = (finish | restart | the pause start | now) - started_at -
-- the time banked by closed pauses. (122: pure wall clock, nothing subtracted.)
create or replace function public._sudoku_elapsed(p_attempt public.arena_sudoku_attempts)
returns bigint
language sql stable set search_path = public, pg_temp as $$
  select greatest(0::bigint,
    floor(extract(epoch from (coalesce(p_attempt.finished_at, p_attempt.ended_at,
                                       public._sudoku_pause_start(p_attempt), now())
                              - p_attempt.started_at)) * 1000)::bigint
    - coalesce(p_attempt.paused_ms, 0));
$$;

-- The reconcile rule, persisted: a running attempt whose heartbeat has gone
-- silent for > 45 s is paused FROM its last heartbeat. The caller holds the row
-- lock. Resume closes that pause (banks the gap, counts it) like any other.
create or replace function public._sudoku_reconcile(p_attempt public.arena_sudoku_attempts)
returns public.arena_sudoku_attempts
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.arena_sudoku_attempts;
begin
  if p_attempt.id is null or p_attempt.status <> 'active' or p_attempt.paused_at is not null
     or p_attempt.last_seen_at is null or now() - p_attempt.last_seen_at <= public._sudoku_stale_after() then
    return p_attempt;
  end if;
  update public.arena_sudoku_attempts
     set paused_at = p_attempt.last_seen_at
   where id = p_attempt.id and paused_at is null
  returning * into v_row;
  if found then return v_row; end if;
  return p_attempt;
end;
$$;

-- The caller's attempt, locked, or an error. 125: reconciled before anything
-- else reads it — "every server call on an attempt first reconciles".
create or replace function public._sudoku_attempt_for_update(p_user uuid, p_attempt bigint)
returns public.arena_sudoku_attempts
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.arena_sudoku_attempts;
begin
  select * into v_row from public.arena_sudoku_attempts
   where id = p_attempt and user_id = p_user
   for update;
  if not found then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  return public._sudoku_reconcile(v_row);
end;
$$;

-- Activity on a running board counts as a heartbeat — but only for an attempt
-- that heartbeats (last_seen_at set): an old page's attempt stays ungated.
create or replace function public._sudoku_touch(p_attempt bigint)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.arena_sudoku_attempts
     set last_seen_at = now()
   where id = p_attempt and status = 'active' and paused_at is null and last_seen_at is not null;
$$;

-- The refusal every board action gets while the attempt is paused.
create or replace function public._sudoku_paused_refusal()
returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', false, 'reason', 'paused',
    'message', 'The game is paused - press Resume to show the board and run the clock again.');
$$;

-- sudoku_save's notes / colours validation, for the board a pause may carry
-- (either may be null = keep what is stored). Same messages, same codes.
create or replace function public._sudoku_check_marks(p_notes jsonb, p_colors jsonb)
returns void
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p_notes is not null then
    if jsonb_typeof(p_notes) <> 'array' or jsonb_array_length(p_notes) <> 81 then
      raise exception 'Notes are 81 numbers' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_notes) e
                where jsonb_typeof(e) <> 'number'
                   or (e #>> '{}')::numeric < 0 or (e #>> '{}')::numeric > 511
                   or (e #>> '{}')::numeric <> floor((e #>> '{}')::numeric)) then
      raise exception 'Notes are 81 numbers from 0 to 511' using errcode = '22023';
    end if;
  end if;
  if p_colors is not null then
    if jsonb_typeof(p_colors) <> 'array' or jsonb_array_length(p_colors) <> 81 then
      raise exception 'Colours are 81 numbers' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_colors) e
                where jsonb_typeof(e) <> 'number'
                   or (e #>> '{}')::numeric not in (0, 1, 2, 3, 4, 5, 6)) then
      raise exception 'Colours are 81 numbers from 0 to 6' using errcode = '22023';
    end if;
  end if;
end;
$$;

-- What the client is allowed to know about an attempt. Never the solution,
-- never the symmetry key. (124's keys, plus the pause.) The board is still
-- returned while paused — the page hides it; withholding it would buy nothing
-- (resume, read, pause takes a second) and would break a pre-125 page.
create or replace function public._sudoku_payload(p_attempt public.arena_sudoku_attempts)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_stage    public.arena_sudoku_stages;
  v_sp       public.arena_sudoku_specials;
  v_wrong    jsonb;
  v_restarts int := 0;
  v_variant  text;
  v_par      int;
  v_tokens   int;
  v_closes   timestamptz;
  v_pstart   timestamptz;
begin
  if p_attempt.special_id is null then
    select * into v_stage from public.arena_sudoku_stages where stage = p_attempt.stage;
    v_variant := v_stage.variant; v_par := v_stage.par_ms;
    select count(*) into v_restarts from public.arena_sudoku_attempts
     where user_id = p_attempt.user_id and stage = p_attempt.stage and status = 'restarted';
  else
    select * into v_sp from public.arena_sudoku_specials where id = p_attempt.special_id;
    v_variant := v_sp.variant; v_par := v_sp.par_ms;
    v_closes := ((case when v_sp.kind = 'daily' then v_sp.day + 1 else v_sp.day + 7 end)::timestamp
                 at time zone 'Australia/Melbourne');
  end if;
  select coalesce(jsonb_agg(i order by i), '[]'::jsonb) into v_wrong
    from generate_series(0, 80) i
   where substr(p_attempt.grid, i + 1, 1) <> '0'
     and (i * 10 + (substr(p_attempt.grid, i + 1, 1))::int) = any (p_attempt.wrong_pairs);
  select hint_tokens into v_tokens from public.arena_sudoku_players where user_id = p_attempt.user_id;
  v_pstart := public._sudoku_pause_start(p_attempt);
  return jsonb_build_object(
    'attempt_id',   p_attempt.id,
    'stage',        p_attempt.stage,
    'attempt_no',   p_attempt.attempt_no,
    'kind',         p_attempt.kind,
    'variant',      v_variant,
    'shuffled',     p_attempt.xform is not null,
    'puzzle',       p_attempt.puzzle,
    'grid',         p_attempt.grid,
    'notes',        p_attempt.notes,
    'status',       p_attempt.status,
    'elapsed_ms',   public._sudoku_elapsed(p_attempt),
    'penalty_ms',   public._sudoku_attempt_penalty(p_attempt),
    'mistakes',     p_attempt.mistakes,
    'hints',        p_attempt.hints,
    'hints_left',   greatest(0, 3 - p_attempt.hints),
    'hinted_cells', to_jsonb(p_attempt.hinted_cells),
    'wrong_cells',  v_wrong,
    'restarts',     v_restarts,
    'par_ms',       v_par,
    'mode',         p_attempt.mode,
    'colors',       p_attempt.colors,
    'token_hints',  p_attempt.token_hints,
    'hint_tokens',  coalesce(v_tokens, 0),
    'special',      case when v_sp.id is null then null else jsonb_build_object(
                      'id', v_sp.id, 'kind', v_sp.kind, 'day', v_sp.day, 'slot', v_sp.slot,
                      'tier', v_sp.tier, 'tier_rank', v_sp.tier_rank, 'techniques', to_jsonb(v_sp.techniques),
                      'clue_count', v_sp.clue_count, 'closes_at', v_closes) end,
    'paused',         v_pstart is not null,
    'paused_at',      v_pstart,
    'pauses',         p_attempt.pauses,
    'paused_ms',      p_attempt.paused_ms,
    'heartbeat_ms',   public._sudoku_heartbeat_ms(),
    'stale_after_ms', (extract(epoch from public._sudoku_stale_after()) * 1000)::int,
    'server_now',   now()
  );
end;
$$;

-- A correct daily / sprint submit (validation already done by sudoku_submit):
-- the clear, the rank on that puzzle, the streak, and the sprint week so far.
-- (124, + the pause facts on the clear row and in the answer.)
create or replace function public._sudoku_finish_special(
  p_player public.arena_sudoku_players, p_attempt public.arena_sudoku_attempts,
  p_grid text, p_elapsed bigint, p_pen bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_sp          public.arena_sudoku_specials;
  v_final       bigint := p_elapsed + p_pen;
  v_best_before int;
  v_si          jsonb;
  v_rank        int;
  v_players     int;
  v_badge       int;
  v_tot         public.arena_sudoku_sprint_totals;
begin
  select * into v_sp from public.arena_sudoku_specials where id = p_attempt.special_id;
  select best_streak into v_best_before from public.arena_sudoku_streaks where user_id = p_player.user_id;

  update public.arena_sudoku_attempts
     set status = 'cleared', grid = p_grid, finished_at = now(),
         elapsed_ms = p_elapsed, penalty_ms = p_pen, final_ms = v_final
   where id = p_attempt.id;
  insert into public.arena_sudoku_special_clears
    (attempt_id, special_id, kind, day, slot, user_id, name, final_ms, elapsed_ms, penalty_ms, mistakes, hints, finished_at,
     pauses, paused_ms)
  values
    (p_attempt.id, v_sp.id, v_sp.kind, v_sp.day, v_sp.slot, p_player.user_id, p_player.name,
     v_final, p_elapsed, p_pen, p_attempt.mistakes, p_attempt.hints, now(),
     p_attempt.pauses, p_attempt.paused_ms);
  update public.arena_sudoku_players set updated_at = now() where user_id = p_player.user_id;

  select r.pz_rank, r.pz_players into v_rank, v_players
    from public.arena_sudoku_special_ranks r
   where r.special_id = v_sp.id and r.user_id = p_player.user_id;
  v_si := public._sudoku_streak_info(p_player.user_id);
  select max(t) into v_badge from unnest(array[3, 7, 14, 30, 100]) t
   where t > coalesce(v_best_before, 0) and t <= (v_si ->> 'best_streak')::int;
  if v_sp.kind = 'sprint' then
    select * into v_tot from public.arena_sudoku_sprint_totals where week = v_sp.day and user_id = p_player.user_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'mode', v_sp.kind,
    'kind', 'first',
    'special', jsonb_build_object('id', v_sp.id, 'kind', v_sp.kind, 'day', v_sp.day, 'slot', v_sp.slot,
                                  'tier', v_sp.tier, 'tier_rank', v_sp.tier_rank),
    'final_ms', v_final, 'elapsed_ms', p_elapsed, 'penalty_ms', p_pen,
    'mistakes', p_attempt.mistakes, 'hints', p_attempt.hints,
    'pauses', p_attempt.pauses, 'paused_ms', p_attempt.paused_ms,
    'rank', v_rank, 'players', v_players,
    'medal', case when v_rank between 1 and 3 then v_rank end,
    'par_ms', v_sp.par_ms,
    'par_beaten', v_final <= v_sp.par_ms,
    'streak_days', (v_si ->> 'streak_days')::int,
    'best_streak', (v_si ->> 'best_streak')::int,
    'new_badge', v_badge,
    'next_at', case when v_sp.kind = 'daily'
                    then (((now() at time zone 'Australia/Melbourne')::date + 1)::timestamp at time zone 'Australia/Melbourne') end,
    'sprint', case when v_sp.kind = 'sprint' then jsonb_build_object(
                'done', v_tot.done, 'total_ms', v_tot.total_ms, 'rank', v_tot.week_rank,
                'finishers', v_tot.week_finishers, 'slots', 5,
                'ends_at', ((v_sp.day + 7)::timestamp at time zone 'Australia/Melbourne')) end,
    'server_now', now()
  );
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- The pause RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- Pause: the page has hidden the board. Cost 0 — a pause must never be refused
-- by the rate limiter (that would cost the player time). If the clock is
-- running, the board the page sends (optional) is saved first — same checks as
-- sudoku_save — and then paused_at = now(). Already paused (a second tab, an
-- earlier beacon, a reconciled outage) = nothing changes, and the board is NOT
-- saved: no move lands while the clock is stopped.
drop function if exists public.sudoku_pause(bigint);     -- the first build's signature (gone since 2026-09-29)
create or replace function public.sudoku_pause(p_attempt bigint, p_grid text default null,
                                               p_notes jsonb default null, p_colors jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p     public.arena_sudoku_players;
  v_a     public.arena_sudoku_attempts;
  v_saved boolean := false;
  v_now   boolean := false;
begin
  v_p := public._sudoku_player(0);
  v_a := public._sudoku_attempt_for_update(v_p.user_id, p_attempt);       -- reconciles first
  if v_a.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'over'); end if;
  if not public._sudoku_live(v_a) then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'This puzzle has closed - its board is read-only now.');
  end if;
  if v_a.paused_at is null then
    if p_grid is not null then
      perform public._sudoku_check_grid(v_a, p_grid);
      perform public._sudoku_check_marks(p_notes, p_colors);
      update public.arena_sudoku_attempts
         set grid = p_grid, notes = coalesce(p_notes, notes), colors = coalesce(p_colors, colors),
             saves = saves + 1, last_save_at = now()
       where id = v_a.id;
      v_saved := true;
    end if;
    update public.arena_sudoku_attempts
       set paused_at = now()
     where id = v_a.id
    returning * into v_a;
    v_now := true;
  end if;
  return jsonb_build_object('ok', true, 'paused', true, 'paused_now', v_now, 'saved', v_saved,
    'paused_at', v_a.paused_at, 'elapsed_ms', public._sudoku_elapsed(v_a),
    'penalty_ms', public._sudoku_attempt_penalty(v_a), 'pauses', v_a.pauses, 'paused_ms', v_a.paused_ms,
    'server_now', now());
end;
$$;

-- Resume: the player pressed Resume on the cover. Banks the pause (floored to
-- the millisecond), counts it, and the clock runs again from where it stopped.
-- On a running attempt it is only a heartbeat. Returns the full state.
create or replace function public.sudoku_resume(p_attempt bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p   public.arena_sudoku_players;
  v_a   public.arena_sudoku_attempts;
  v_gap bigint := 0;
  v_res boolean := false;
begin
  v_p := public._sudoku_player(1);
  v_a := public._sudoku_attempt_for_update(v_p.user_id, p_attempt);       -- reconciles first
  if v_a.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'over'); end if;
  if not public._sudoku_live(v_a) then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'This puzzle has closed - its board is read-only now.');
  end if;
  if v_a.paused_at is not null then
    v_gap := greatest(0, floor(extract(epoch from (now() - v_a.paused_at)) * 1000))::bigint;
    update public.arena_sudoku_attempts
       set paused_ms = paused_ms + v_gap, pauses = pauses + 1, paused_at = null, last_seen_at = now()
     where id = v_a.id
    returning * into v_a;
    v_res := true;
  else
    update public.arena_sudoku_attempts set last_seen_at = now() where id = v_a.id
    returning * into v_a;
  end if;
  return jsonb_build_object('ok', true, 'resumed', v_res, 'paused_for_ms', v_gap, 'state', public._sudoku_payload(v_a));
end;
$$;

-- Heartbeat: every 15 s while the board shows and the clock runs. Stamps
-- last_seen_at (the first one switches the outage rule on for this attempt) and
-- answers with the server's clock, which the page adopts. A paused attempt
-- answers paused:true (another tab or device paused it, or the board went
-- silent) and the page covers the board. Cost 0: no player-row lock.
create or replace function public.sudoku_heartbeat(p_attempt bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p public.arena_sudoku_players;
  v_a public.arena_sudoku_attempts;
begin
  v_p := public._sudoku_player(0);
  v_a := public._sudoku_attempt_for_update(v_p.user_id, p_attempt);       -- reconciles first
  if v_a.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'over'); end if;
  if not public._sudoku_live(v_a) then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'This puzzle has closed - its board is read-only now.');
  end if;
  if v_a.paused_at is null then
    update public.arena_sudoku_attempts set last_seen_at = now() where id = v_a.id
    returning * into v_a;
  end if;
  return jsonb_build_object('ok', true, 'paused', v_a.paused_at is not null, 'paused_at', v_a.paused_at,
    'elapsed_ms', public._sudoku_elapsed(v_a), 'penalty_ms', public._sudoku_attempt_penalty(v_a),
    'pauses', v_a.pauses, 'paused_ms', v_a.paused_ms, 'heartbeat_ms', public._sudoku_heartbeat_ms(),
    'server_now', now());
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Opening a puzzle — 122 / 124 bodies; a re-opened attempt is reconciled first
-- (a board that went silent opens paused, on the cover)
-- ─────────────────────────────────────────────────────────────────────────────

-- Open (or re-open) a stage. The clock starts HERE, server-side, and this is
-- the only way the puzzle reaches a client. Re-opening an active attempt just
-- returns it — running, or paused (the page then shows the cover). Opening a
-- stage never touches any other attempt.
create or replace function public.sudoku_start(p_stage int)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p public.arena_sudoku_players;
  v_a public.arena_sudoku_attempts;
begin
  v_p := public._sudoku_player(1);
  if p_stage is null or not exists (select 1 from public.arena_sudoku_stages where stage = p_stage) then
    raise exception 'Unknown stage' using errcode = '22023';
  end if;
  if v_p.tutorial_done_at is null then
    return jsonb_build_object('ok', false, 'reason', 'tutorial', 'message', 'Finish the tutorial (stage 0) first.');
  end if;
  if p_stage > v_p.highest_stage + 1 then
    return jsonb_build_object('ok', false, 'reason', 'locked',
      'message', 'Stage ' || p_stage || ' is locked - clear stage ' || (v_p.highest_stage + 1) || ' first.');
  end if;
  select * into v_a from public.arena_sudoku_attempts
   where user_id = v_p.user_id and stage = p_stage and status = 'active'
   for update;
  if found then
    v_a := public._sudoku_reconcile(v_a);
    return jsonb_build_object('ok', true, 'resumed', true, 'state', public._sudoku_payload(v_a));
  end if;
  if p_stage = v_p.highest_stage + 1 and v_p.next_unlock_at is not null and now() < v_p.next_unlock_at then
    return jsonb_build_object('ok', false, 'reason', 'penalty', 'unlock_at', v_p.next_unlock_at,
      'message', 'Serving penalty time - stage ' || p_stage || ' opens shortly.');
  end if;
  v_a := public._sudoku_new_attempt(v_p.user_id, p_stage);
  return jsonb_build_object('ok', true, 'resumed', false, 'state', public._sudoku_payload(v_a));
end;
$$;

-- Open (or resume) the daily puzzle of p_day (default: Melbourne today). Only
-- today's puzzle can be played; a player gets one attempt and one clear per day.
create or replace function public.sudoku_daily_start(p_day date default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p     public.arena_sudoku_players;
  v_today date := (now() at time zone 'Australia/Melbourne')::date;
  v_day   date;
  v_sp    public.arena_sudoku_specials;
  v_a     public.arena_sudoku_attempts;
begin
  v_p := public._sudoku_player(1);
  v_day := coalesce(p_day, v_today);
  select * into v_sp from public.arena_sudoku_specials where kind = 'daily' and day = v_day;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_puzzle', 'message', 'There is no daily puzzle for that day.');
  end if;
  if v_day > v_today then
    return jsonb_build_object('ok', false, 'reason', 'not_yet',
      'opens_at', (v_day::timestamp at time zone 'Australia/Melbourne'),
      'message', 'That puzzle opens at midnight (Melbourne time).');
  end if;
  select * into v_a from public.arena_sudoku_attempts
   where user_id = v_p.user_id and special_id = v_sp.id
   for update;
  if v_a.id is not null and v_a.status = 'cleared' then
    return jsonb_build_object('ok', false, 'reason', 'cleared', 'final_ms', v_a.final_ms,
      'message', 'You have already cleared this puzzle - one clear per day.');
  end if;
  if v_day < v_today then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'That day has closed - its board is read-only.');
  end if;
  if v_a.id is not null then
    v_a := public._sudoku_reconcile(v_a);
    return jsonb_build_object('ok', true, 'resumed', true, 'state', public._sudoku_payload(v_a));
  end if;
  v_a := public._sudoku_special_new_attempt(v_p.user_id, v_sp.id);
  return jsonb_build_object('ok', true, 'resumed', false, 'state', public._sudoku_payload(v_a));
end;
$$;

-- Open (or resume) sprint puzzle p_slot (1 Basic … 5 Master) of the week that
-- holds p_week (default: this Melbourne week). Any order; one attempt each;
-- each puzzle has its own clock (and its own pause).
create or replace function public.sudoku_sprint_start(p_slot int, p_week date default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p     public.arena_sudoku_players;
  v_today date := (now() at time zone 'Australia/Melbourne')::date;
  v_week  date;
  v_sp    public.arena_sudoku_specials;
  v_a     public.arena_sudoku_attempts;
begin
  v_p := public._sudoku_player(1);
  if p_slot is null or p_slot < 1 or p_slot > 5 then raise exception 'A sprint puzzle is slot 1-5' using errcode = '22023'; end if;
  v_week := coalesce(p_week, v_today);
  v_week := v_week - (extract(isodow from v_week)::int - 1);
  select * into v_sp from public.arena_sudoku_specials where kind = 'sprint' and day = v_week and slot = p_slot;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_puzzle', 'message', 'There is no sprint for that week.');
  end if;
  if v_week > v_today then
    return jsonb_build_object('ok', false, 'reason', 'not_yet',
      'opens_at', (v_week::timestamp at time zone 'Australia/Melbourne'),
      'message', 'That sprint opens on Monday at midnight (Melbourne time).');
  end if;
  select * into v_a from public.arena_sudoku_attempts
   where user_id = v_p.user_id and special_id = v_sp.id
   for update;
  if v_a.id is not null and v_a.status = 'cleared' then
    return jsonb_build_object('ok', false, 'reason', 'cleared', 'final_ms', v_a.final_ms,
      'message', 'You have already cleared this sprint puzzle.');
  end if;
  if v_today > v_week + 6 then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'That sprint week has closed.');
  end if;
  if v_a.id is not null then
    v_a := public._sudoku_reconcile(v_a);
    return jsonb_build_object('ok', true, 'resumed', true, 'state', public._sudoku_payload(v_a));
  end if;
  v_a := public._sudoku_special_new_attempt(v_p.user_id, v_sp.id);
  return jsonb_build_object('ok', true, 'resumed', false, 'state', public._sudoku_payload(v_a));
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Game RPCs — 124 bodies + the pause (refused while paused; activity counts as
-- a heartbeat; the clear carries the pause facts)
-- ─────────────────────────────────────────────────────────────────────────────

-- Restart stays a LADDER thing. 125: an open pause is closed first (banked +
-- counted) so the ended attempt's books balance; the new attempt runs at 0:00
-- with every pause counter at zero.
create or replace function public.sudoku_restart(p_attempt bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p public.arena_sudoku_players;
  v_a public.arena_sudoku_attempts;
begin
  v_p := public._sudoku_player(1);
  v_a := public._sudoku_attempt_for_update(v_p.user_id, p_attempt);
  if v_a.mode <> 'ladder' then
    raise exception 'Only ladder stages restart - a daily or sprint clock never resets' using errcode = 'P0001';
  end if;
  if v_a.status <> 'active' then raise exception 'That attempt is already over' using errcode = 'P0001'; end if;
  update public.arena_sudoku_attempts
     set status = 'restarted', ended_at = now(),
         paused_ms = paused_ms + case when paused_at is null then 0
                                      else greatest(0, floor(extract(epoch from (now() - paused_at)) * 1000))::bigint end,
         pauses = pauses + case when paused_at is null then 0 else 1 end,
         paused_at = null
   where id = v_a.id;
  update public.arena_sudoku_players
     set total_restarts = total_restarts + 1, updated_at = now()
   where user_id = v_p.user_id;
  v_a := public._sudoku_new_attempt(v_p.user_id, v_a.stage);
  return jsonb_build_object('ok', true, 'state', public._sudoku_payload(v_a));
end;
$$;

-- Autosave the board (grid + notes + highlighter colours). Refused while paused.
create or replace function public.sudoku_save(p_attempt bigint, p_grid text, p_notes jsonb, p_colors jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p public.arena_sudoku_players;
  v_a public.arena_sudoku_attempts;
begin
  v_p := public._sudoku_player(0.5);
  v_a := public._sudoku_attempt_for_update(v_p.user_id, p_attempt);
  if v_a.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'over'); end if;
  if not public._sudoku_live(v_a) then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'This puzzle has closed - its board is read-only now.');
  end if;
  if v_a.paused_at is not null then return public._sudoku_paused_refusal(); end if;
  perform public._sudoku_check_grid(v_a, p_grid);
  if p_notes is null or jsonb_typeof(p_notes) <> 'array' or jsonb_array_length(p_notes) <> 81 then
    raise exception 'Notes are 81 numbers' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_notes) e
              where jsonb_typeof(e) <> 'number'
                 or (e #>> '{}')::numeric < 0 or (e #>> '{}')::numeric > 511
                 or (e #>> '{}')::numeric <> floor((e #>> '{}')::numeric)) then
    raise exception 'Notes are 81 numbers from 0 to 511' using errcode = '22023';
  end if;
  if p_colors is not null then
    if jsonb_typeof(p_colors) <> 'array' or jsonb_array_length(p_colors) <> 81 then
      raise exception 'Colours are 81 numbers' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_colors) e
                where jsonb_typeof(e) <> 'number'
                   or (e #>> '{}')::numeric not in (0, 1, 2, 3, 4, 5, 6)) then
      raise exception 'Colours are 81 numbers from 0 to 6' using errcode = '22023';
    end if;
  end if;
  update public.arena_sudoku_attempts
     set grid = p_grid, notes = p_notes, colors = coalesce(p_colors, colors),
         saves = saves + 1, last_save_at = now()
   where id = v_a.id
  returning * into v_a;
  perform public._sudoku_touch(v_a.id);
  return jsonb_build_object('ok', true, 'elapsed_ms', public._sudoku_elapsed(v_a),
    'penalty_ms', public._sudoku_attempt_penalty(v_a), 'server_now', now());
end;
$$;

-- Auto-check one placement (unchanged rules; + the closed / paused refusals).
create or replace function public.sudoku_check(p_attempt bigint, p_cell int, p_digit int)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p public.arena_sudoku_players;
  v_a public.arena_sudoku_attempts;
  v_right boolean;
  v_charged boolean := false;
begin
  v_p := public._sudoku_player(1);
  v_a := public._sudoku_attempt_for_update(v_p.user_id, p_attempt);
  if v_a.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'over'); end if;
  if not public._sudoku_live(v_a) then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'This puzzle has closed - its board is read-only now.');
  end if;
  if v_a.paused_at is not null then return public._sudoku_paused_refusal(); end if;
  if p_cell is null or p_cell < 0 or p_cell > 80 or p_digit is null or p_digit < 1 or p_digit > 9 then
    raise exception 'A check is a cell 0-80 and a digit 1-9' using errcode = '22023';
  end if;
  if substr(v_a.puzzle, p_cell + 1, 1) <> '0' then
    raise exception 'That cell is a given' using errcode = '22023';
  end if;
  v_right := substr(public._sudoku_solution(v_a), p_cell + 1, 1) = p_digit::text;
  if not v_right and not ((p_cell * 10 + p_digit) = any (v_a.wrong_pairs)) then
    update public.arena_sudoku_attempts
       set mistakes = mistakes + 1, wrong_pairs = wrong_pairs || (p_cell * 10 + p_digit)
     where id = v_a.id
    returning * into v_a;
    v_charged := true;
  end if;
  perform public._sudoku_touch(v_a.id);
  return jsonb_build_object('ok', true, 'correct', v_right, 'charged', v_charged,
    'mistakes', v_a.mistakes, 'penalty_ms', public._sudoku_attempt_penalty(v_a),
    'elapsed_ms', public._sudoku_elapsed(v_a), 'server_now', now());
end;
$$;

-- Reveal one cell (+60 s, max 3 per attempt; a banked token makes a ladder hint
-- free). 124's rules + the closed / paused refusals.
create or replace function public.sudoku_hint(p_attempt bigint, p_cell int, p_token boolean default false)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p     public.arena_sudoku_players;
  v_a     public.arena_sudoku_attempts;
  v_digit text;
  v_free  boolean := false;
  v_left  int;
begin
  v_p := public._sudoku_player(1);                       -- locks the player row (tokens)
  v_a := public._sudoku_attempt_for_update(v_p.user_id, p_attempt);
  if v_a.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'over'); end if;
  if not public._sudoku_live(v_a) then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'This puzzle has closed - its board is read-only now.');
  end if;
  if v_a.paused_at is not null then return public._sudoku_paused_refusal(); end if;
  if p_cell is null or p_cell < 0 or p_cell > 80 then raise exception 'A hint is for a cell 0-80' using errcode = '22023'; end if;
  if substr(v_a.puzzle, p_cell + 1, 1) <> '0' then raise exception 'That cell is a given' using errcode = '22023'; end if;
  if p_cell = any (v_a.hinted_cells) then
    return jsonb_build_object('ok', false, 'reason', 'hinted', 'message', 'That cell was already revealed.');
  end if;
  if v_a.hints >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'no_hints', 'message', 'No hints left on this attempt (3 per attempt).');
  end if;
  v_digit := substr(public._sudoku_solution(v_a), p_cell + 1, 1);
  if substr(v_a.grid, p_cell + 1, 1) = v_digit then
    return jsonb_build_object('ok', false, 'reason', 'correct', 'message', 'That cell is already right - pick another.');
  end if;
  v_free := coalesce(p_token, false) and v_a.mode = 'ladder' and coalesce(v_p.hint_tokens, 0) > 0;
  if v_free then
    update public.arena_sudoku_players
       set hint_tokens = hint_tokens - 1, tokens_spent = tokens_spent + 1, updated_at = now()
     where user_id = v_p.user_id
    returning hint_tokens into v_left;
  else
    v_left := coalesce(v_p.hint_tokens, 0);
  end if;
  update public.arena_sudoku_attempts
     set hints = hints + 1,
         token_hints = token_hints + case when v_free then 1 else 0 end,
         hinted_cells = hinted_cells || p_cell,
         grid = overlay(grid placing v_digit from p_cell + 1 for 1)
   where id = v_a.id
  returning * into v_a;
  perform public._sudoku_touch(v_a.id);
  return jsonb_build_object('ok', true, 'cell', p_cell, 'digit', v_digit::int,
    'hints', v_a.hints, 'hints_left', greatest(0, 3 - v_a.hints),
    'token_used', v_free, 'hint_tokens', v_left, 'token_hints', v_a.token_hints,
    'penalty_ms', public._sudoku_attempt_penalty(v_a),
    'elapsed_ms', public._sudoku_elapsed(v_a), 'server_now', now());
end;
$$;

-- Submit a full grid (124) — refused while paused; the time is the running
-- time (pauses excluded), and the clear rows carry pauses + paused_ms.
create or replace function public.sudoku_submit(p_attempt bigint, p_grid text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p           public.arena_sudoku_players;
  v_a           public.arena_sudoku_attempts;
  v_stage       public.arena_sudoku_stages;
  v_sol         text;
  v_wrong       int;
  v_empty       int;
  v_elapsed     bigint;
  v_pen         bigint;
  v_final       bigint;
  v_floor       bigint;
  v_first       boolean;
  v_prev        bigint;
  v_crown       boolean := false;
  v_rank        int;
  v_players     int;
  v_today       date := (now() at time zone 'Australia/Brisbane')::date;   -- legacy streak columns (122)
  v_unlock      timestamptz;
  v_next        int;
  v_progress    boolean := false;
  v_earned      boolean := false;
  v_best_before int;
  v_si          jsonb;
  v_badge       int;
begin
  v_p := public._sudoku_player(1);
  v_a := public._sudoku_attempt_for_update(v_p.user_id, p_attempt);
  if v_a.status <> 'active' then raise exception 'That attempt is already over' using errcode = 'P0001'; end if;
  if not public._sudoku_live(v_a) then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'This puzzle has closed - its board is read-only now.');
  end if;
  if v_a.paused_at is not null then return public._sudoku_paused_refusal(); end if;
  perform public._sudoku_check_grid(v_a, p_grid);
  v_empty := length(p_grid) - length(replace(p_grid, '0', ''));
  if v_empty > 0 then
    return jsonb_build_object('ok', false, 'reason', 'incomplete', 'empty', v_empty);
  end if;
  v_sol := public._sudoku_solution(v_a);
  if p_grid <> v_sol then
    select count(*) into v_wrong from generate_series(1, 81) i where substr(p_grid, i, 1) <> substr(v_sol, i, 1);
    update public.arena_sudoku_attempts set mistakes = mistakes + 1 where id = v_a.id returning * into v_a;
    perform public._sudoku_touch(v_a.id);
    return jsonb_build_object('ok', false, 'reason', 'wrong', 'wrong', v_wrong, 'mistakes', v_a.mistakes,
      'penalty_ms', public._sudoku_attempt_penalty(v_a));
  end if;
  v_elapsed := public._sudoku_elapsed(v_a);
  v_floor := greatest(0, (length(v_a.puzzle) - length(replace(v_a.puzzle, '0', ''))) - coalesce(array_length(v_a.hinted_cells, 1), 0)) * 250;
  if v_elapsed < v_floor then
    return jsonb_build_object('ok', false, 'reason', 'too_fast',
      'message', 'That was faster than anyone can type - the clear was not accepted.');
  end if;
  v_pen := public._sudoku_attempt_penalty(v_a);
  v_final := v_elapsed + v_pen;

  if v_a.special_id is not null then
    return public._sudoku_finish_special(v_p, v_a, p_grid, v_elapsed, v_pen);
  end if;

  -- ── the ladder (122's settlement, unchanged, + tokens + streak + the pause facts) ──
  select * into v_stage from public.arena_sudoku_stages where stage = v_a.stage;
  select best_streak into v_best_before from public.arena_sudoku_streaks where user_id = v_p.user_id;

  update public.arena_sudoku_attempts
     set status = 'cleared', grid = p_grid, finished_at = now(),
         elapsed_ms = v_elapsed, penalty_ms = v_pen, final_ms = v_final
   where id = v_a.id;

  select min(final_ms) into v_prev from public.arena_sudoku_clears where user_id = v_p.user_id and stage = v_a.stage;
  v_first := v_prev is null;
  v_unlock := now() + (v_pen::text || ' milliseconds')::interval;
  -- a hint token for a stage FIRST cleared without any hint (cap 5 banked)
  v_earned := v_first and v_a.hints = 0 and coalesce(v_p.hint_tokens, 0) < 5;

  insert into public.arena_sudoku_clears
    (attempt_id, user_id, name, stage, kind, first_clear, final_ms, elapsed_ms, penalty_ms, mistakes, hints, token_hints, finished_at, unlocked_at,
     pauses, paused_ms)
  values
    (v_a.id, v_p.user_id, v_p.name, v_a.stage, v_a.kind, v_first, v_final, v_elapsed, v_pen, v_a.mistakes, v_a.hints, v_a.token_hints, now(),
     case when v_first then v_unlock end,
     v_a.pauses, v_a.paused_ms);

  if v_first and v_a.stage = v_p.highest_stage + 1 then
    v_progress := true;
    update public.arena_sudoku_players
       set highest_stage = v_a.stage, reached_at = v_unlock, next_unlock_at = v_unlock
     where user_id = v_p.user_id;
  end if;
  update public.arena_sudoku_players
     set stages_cleared = stages_cleared + case when v_first then 1 else 0 end,
         clears = clears + 1,
         total_mistakes = total_mistakes + v_a.mistakes,
         total_hints = total_hints + v_a.hints,
         hint_tokens = case when v_earned then hint_tokens + 1 else hint_tokens end,
         tokens_earned = tokens_earned + case when v_earned then 1 else 0 end,
         streak_days = case when last_clear_day = v_today then streak_days
                            when last_clear_day = v_today - 1 then streak_days + 1
                            else 1 end,
         best_streak = greatest(best_streak, case when last_clear_day = v_today then streak_days
                                                  when last_clear_day = v_today - 1 then streak_days + 1
                                                  else 1 end),
         last_clear_day = v_today,
         updated_at = now()
   where user_id = v_p.user_id
  returning * into v_p;

  insert into public.arena_sudoku_crowns (stage, user_id, name, final_ms, cleared_at)
  values (v_a.stage, v_p.user_id, v_p.name, v_final, now())
  on conflict (stage) do nothing;
  v_crown := found;

  select r.stage_rank, r.stage_players into v_rank, v_players
    from public.arena_sudoku_stage_ranks r
   where r.stage = v_a.stage and r.user_id = v_p.user_id;
  select min(stage) into v_next from public.arena_sudoku_stages where stage > v_a.stage;
  v_si := public._sudoku_streak_info(v_p.user_id);
  select max(t) into v_badge from unnest(array[3, 7, 14, 30, 100]) t
   where t > coalesce(v_best_before, 0) and t <= (v_si ->> 'best_streak')::int;

  return jsonb_build_object(
    'ok', true,
    'mode', 'ladder',
    'stage', v_a.stage,
    'kind', v_a.kind,
    'final_ms', v_final, 'elapsed_ms', v_elapsed, 'penalty_ms', v_pen,
    'mistakes', v_a.mistakes, 'hints', v_a.hints, 'token_hints', v_a.token_hints,
    'pauses', v_a.pauses, 'paused_ms', v_a.paused_ms,
    'rank', v_rank, 'players', v_players,
    'medal', case when v_rank between 1 and 3 then v_rank end,
    'crown', v_crown,
    'first_clear', v_first,
    'progressed', v_progress,
    'pb', (v_prev is null or v_final < v_prev),
    'prev_best_ms', v_prev,
    'best_ms', least(coalesce(v_prev, v_final), v_final),
    'par_ms', v_stage.par_ms,
    'par_beaten', v_final <= v_stage.par_ms,
    'highest_stage', v_p.highest_stage,
    'next_stage', v_next,
    'next_unlock_at', v_p.next_unlock_at,
    'token_earned', v_earned,
    'hint_tokens', v_p.hint_tokens,
    'streak_days', (v_si ->> 'streak_days')::int,
    'best_streak', (v_si ->> 'best_streak')::int,
    'new_badge', v_badge,
    'server_now', now()
  );
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Read RPCs — 122 / 124 outputs, keys only ADDED
-- ─────────────────────────────────────────────────────────────────────────────

-- The stage map's call (124) — each active ladder attempt now says whether its
-- clock is running or paused, and how much has run.
create or replace function public.sudoku_overview()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p   public.arena_sudoku_players;
  v_uid uuid;
  v_si  jsonb;
begin
  v_p := public._sudoku_player(0);
  v_uid := v_p.user_id;
  v_si := public._sudoku_streak_info(v_uid);
  return jsonb_build_object(
    'me', jsonb_build_object(
      'name', v_p.name,
      'tutorial_done', v_p.tutorial_done_at is not null,
      'highest_stage', v_p.highest_stage,
      'reached_at', v_p.reached_at,
      'next_unlock_at', v_p.next_unlock_at,
      'stages_cleared', v_p.stages_cleared,
      'streak_days', (v_si ->> 'streak_days')::int,
      'best_streak', (v_si ->> 'best_streak')::int,
      'streak_badges', v_si -> 'badges',
      'hint_tokens', v_p.hint_tokens,
      'sprint_wins', (select count(*) from public.arena_sudoku_sprint_winners w where w.user_id = v_uid)),
    'stage_count', (select count(*) from public.arena_sudoku_stages),
    'mine', (select coalesce(jsonb_agg(jsonb_build_object('stage', r.stage, 'best_ms', r.final_ms, 'rank', r.stage_rank,
                                                          'players', r.stage_players) order by r.stage), '[]'::jsonb)
               from public.arena_sudoku_stage_ranks r where r.user_id = v_uid),
    'crowns', (select coalesce(jsonb_agg(jsonb_build_object('stage', c.stage, 'name', c.name, 'mine', c.user_id = v_uid)
                                         order by c.stage), '[]'::jsonb)
                 from public.arena_sudoku_crowns c),
    'players', (select coalesce(jsonb_object_agg(x.stage, x.n), '{}'::jsonb)
                  from (select stage, count(distinct user_id)::int as n from public.arena_sudoku_clears group by stage) x),
    'active', (select coalesce(jsonb_agg(jsonb_build_object('stage', a.stage, 'attempt_id', a.id, 'kind', a.kind,
                                                            'started_at', a.started_at,
                                                            'elapsed_ms', public._sudoku_elapsed(a),
                                                            'paused', public._sudoku_pause_start(a) is not null,
                                                            'pauses', a.pauses) order by a.stage), '[]'::jsonb)
                 from public.arena_sudoku_attempts a
                where a.user_id = v_uid and a.status = 'active' and a.mode = 'ladder'),
    'server_now', now()
  );
end;
$$;

-- A stage's board (122): top 5 fastest (best per player), my rank, the crown —
-- + each row's pauses / paused_ms (the marker; times are not adjusted).
create or replace function public.sudoku_stage_board(p_stage int)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p     public.arena_sudoku_players;
  v_top   jsonb;
  v_me    jsonb;
  v_crown jsonb;
  v_n     int;
begin
  v_p := public._sudoku_player(0);
  if p_stage is null or not exists (select 1 from public.arena_sudoku_stages where stage = p_stage) then
    raise exception 'Unknown stage' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('rank', r.stage_rank, 'name', r.name, 'final_ms', r.final_ms,
           'finished_at', r.finished_at, 'mistakes', r.mistakes, 'hints', r.hints, 'kind', r.kind,
           'pauses', r.pauses, 'paused_ms', r.paused_ms,
           'me', r.user_id = v_p.user_id) order by r.stage_rank, r.finished_at), '[]'::jsonb)
    into v_top
    from (select * from public.arena_sudoku_stage_ranks where stage = p_stage
          order by stage_rank, finished_at limit 5) r;
  select jsonb_build_object('rank', r.stage_rank, 'final_ms', r.final_ms, 'finished_at', r.finished_at,
                            'mistakes', r.mistakes, 'hints', r.hints, 'pauses', r.pauses, 'paused_ms', r.paused_ms)
    into v_me
    from public.arena_sudoku_stage_ranks r where r.stage = p_stage and r.user_id = v_p.user_id;
  select jsonb_build_object('name', c.name, 'final_ms', c.final_ms, 'cleared_at', c.cleared_at, 'mine', c.user_id = v_p.user_id)
    into v_crown
    from public.arena_sudoku_crowns c where c.stage = p_stage;
  select count(*) into v_n from public.arena_sudoku_best where stage = p_stage;
  return jsonb_build_object('stage', p_stage, 'top', v_top, 'me', v_me, 'crown', v_crown, 'players', v_n);
end;
$$;

-- The overall ranking (124) + each row's pauses over the best clears that make
-- up its total time.
create or replace function public.sudoku_ranking(p_limit int default 50)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p   public.arena_sudoku_players;
  v_top jsonb;
  v_me  jsonb;
  v_n   int;
begin
  v_p := public._sudoku_player(0);
  select coalesce(jsonb_agg(jsonb_build_object('rank', r.rank, 'name', r.name, 'highest_stage', r.highest_stage,
           'reached_at', r.reached_at, 'total_ms', r.total_ms, 'stages_cleared', r.stages_cleared,
           'streak', coalesce(s.streak_days, 0),
           'pauses', coalesce(pz.pauses, 0), 'paused_ms', coalesce(pz.paused_ms, 0),
           'me', r.user_id = v_p.user_id) order by r.rank), '[]'::jsonb)
    into v_top
    from (select * from public.arena_sudoku_ranking order by rank
          limit greatest(1, least(coalesce(p_limit, 50), 200))) r
    left join public.arena_sudoku_streaks s on s.user_id = r.user_id
    left join (select b.user_id, sum(b.pauses)::int as pauses, sum(b.paused_ms)::bigint as paused_ms
                 from public.arena_sudoku_best b group by b.user_id) pz on pz.user_id = r.user_id;
  select jsonb_build_object('rank', r.rank, 'name', r.name, 'highest_stage', r.highest_stage,
                            'reached_at', r.reached_at, 'total_ms', r.total_ms, 'stages_cleared', r.stages_cleared,
                            'streak', coalesce(s.streak_days, 0),
                            'pauses', coalesce(pz.pauses, 0), 'paused_ms', coalesce(pz.paused_ms, 0))
    into v_me
    from public.arena_sudoku_ranking r
    left join public.arena_sudoku_streaks s on s.user_id = r.user_id
    left join (select b.user_id, sum(b.pauses)::int as pauses, sum(b.paused_ms)::bigint as paused_ms
                 from public.arena_sudoku_best b where b.user_id = v_p.user_id group by b.user_id) pz on pz.user_id = r.user_id
   where r.user_id = v_p.user_id;
  select count(*) into v_n from public.arena_sudoku_ranking;
  return jsonb_build_object('top', v_top, 'me', v_me, 'players', v_n);
end;
$$;

-- The home card + the Daily tab (124) — my attempt now says whether its clock
-- is paused (elapsed_ms is the pause-aware running time).
create or replace function public.sudoku_daily_overview()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p      public.arena_sudoku_players;
  v_today  date := (now() at time zone 'Australia/Melbourne')::date;
  v_sp     public.arena_sudoku_specials;
  v_tom    public.arena_sudoku_specials;
  v_a      public.arena_sudoku_attempts;
  v_rank   int;
  v_n      int := 0;
  v_leader jsonb;
  v_cal    jsonb;
begin
  v_p := public._sudoku_player(0);
  select * into v_sp  from public.arena_sudoku_specials where kind = 'daily' and day = v_today;
  select * into v_tom from public.arena_sudoku_specials where kind = 'daily' and day = v_today + 1;
  if v_sp.id is not null then
    select * into v_a from public.arena_sudoku_attempts where user_id = v_p.user_id and special_id = v_sp.id;
    select r.pz_rank into v_rank from public.arena_sudoku_special_ranks r where r.special_id = v_sp.id and r.user_id = v_p.user_id;
    select count(*) into v_n from public.arena_sudoku_special_clears where special_id = v_sp.id;
    select jsonb_build_object('name', r.name, 'final_ms', r.final_ms, 'me', r.user_id = v_p.user_id) into v_leader
      from public.arena_sudoku_special_ranks r where r.special_id = v_sp.id order by r.pz_rank, r.finished_at limit 1;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', g.d, 'has_puzzle', sp.id is not null, 'tier', sp.tier, 'tier_rank', sp.tier_rank, 'par_ms', sp.par_ms,
           'status', case when r.user_id is not null then 'cleared'
                          when a.id is not null and a.status = 'active' and g.d = v_today then 'active'
                          when a.id is not null then 'played' end,
           'final_ms', r.final_ms, 'rank', r.pz_rank,
           'medal', case when r.pz_rank between 1 and 3 then r.pz_rank end,
           'players', (select count(*) from public.arena_sudoku_special_clears c where c.special_id = sp.id))
         order by g.d), '[]'::jsonb)
    into v_cal
    from (select (v_today - k) as d from generate_series(0, 29) k) g
    left join public.arena_sudoku_specials sp on sp.kind = 'daily' and sp.day = g.d
    left join public.arena_sudoku_attempts a on a.special_id = sp.id and a.user_id = v_p.user_id
    left join public.arena_sudoku_special_ranks r on r.special_id = sp.id and r.user_id = v_p.user_id;
  return jsonb_build_object(
    'today', v_today,
    'next_at', ((v_today + 1)::timestamp at time zone 'Australia/Melbourne'),
    'puzzle', case when v_sp.id is null then null else jsonb_build_object(
                'id', v_sp.id, 'day', v_sp.day, 'tier', v_sp.tier, 'tier_rank', v_sp.tier_rank, 'par_ms', v_sp.par_ms,
                'clue_count', v_sp.clue_count, 'techniques', to_jsonb(v_sp.techniques), 'variant', v_sp.variant) end,
    'my', jsonb_build_object(
      'status', case when v_a.id is null then 'none' when v_a.status = 'cleared' then 'cleared' else 'active' end,
      'attempt_id', v_a.id, 'started_at', v_a.started_at,
      'elapsed_ms', case when v_a.id is not null and v_a.status = 'active' then public._sudoku_elapsed(v_a) end,
      'paused', case when v_a.id is not null and v_a.status = 'active' then public._sudoku_pause_start(v_a) is not null end,
      'pauses', v_a.pauses,
      'final_ms', v_a.final_ms, 'rank', v_rank, 'medal', case when v_rank between 1 and 3 then v_rank end),
    'players', v_n,
    'leader', v_leader,
    'tomorrow', case when v_tom.id is null then null else jsonb_build_object(
                  'day', v_tom.day, 'tier', v_tom.tier, 'tier_rank', v_tom.tier_rank, 'par_ms', v_tom.par_ms) end,
    'calendar', v_cal,
    'streak', public._sudoku_streak_info(v_p.user_id),
    'server_now', now()
  );
end;
$$;

-- One day's board (124) + each row's pauses / paused_ms.
create or replace function public.sudoku_daily_board(p_day date default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p      public.arena_sudoku_players;
  v_today  date := (now() at time zone 'Australia/Melbourne')::date;
  v_day    date;
  v_sp     public.arena_sudoku_specials;
  v_a      public.arena_sudoku_attempts;
  v_top    jsonb;
  v_me     jsonb;
  v_n      int;
  v_closed boolean;
  v_givens text;
begin
  v_p := public._sudoku_player(0);
  v_day := coalesce(p_day, v_today);
  select * into v_sp from public.arena_sudoku_specials where kind = 'daily' and day = v_day;
  if not found then return jsonb_build_object('day', v_day, 'has_puzzle', false, 'server_now', now()); end if;
  if v_day > v_today then
    return jsonb_build_object('day', v_day, 'has_puzzle', true, 'future', true,
      'opens_at', (v_day::timestamp at time zone 'Australia/Melbourne'), 'server_now', now());
  end if;
  v_closed := v_day < v_today;
  select coalesce(jsonb_agg(jsonb_build_object('rank', r.pz_rank, 'name', r.name, 'final_ms', r.final_ms,
           'finished_at', r.finished_at, 'mistakes', r.mistakes, 'hints', r.hints,
           'pauses', r.pauses, 'paused_ms', r.paused_ms,
           'streak', coalesce(s.streak_days, 0), 'me', r.user_id = v_p.user_id)
           order by r.pz_rank, r.finished_at), '[]'::jsonb)
    into v_top
    from (select * from public.arena_sudoku_special_ranks where special_id = v_sp.id
          order by pz_rank, finished_at limit 10) r
    left join public.arena_sudoku_streaks s on s.user_id = r.user_id;
  select jsonb_build_object('rank', r.pz_rank, 'final_ms', r.final_ms, 'finished_at', r.finished_at,
                            'mistakes', r.mistakes, 'hints', r.hints, 'pauses', r.pauses, 'paused_ms', r.paused_ms)
    into v_me
    from public.arena_sudoku_special_ranks r where r.special_id = v_sp.id and r.user_id = v_p.user_id;
  select count(*) into v_n from public.arena_sudoku_special_clears where special_id = v_sp.id;
  select * into v_a from public.arena_sudoku_attempts where user_id = v_p.user_id and special_id = v_sp.id;
  if v_closed then select puzzle into v_givens from public.arena_sudoku_special_secrets where special_id = v_sp.id; end if;
  return jsonb_build_object(
    'day', v_day, 'has_puzzle', true, 'is_today', v_day = v_today, 'closed', v_closed,
    'id', v_sp.id, 'tier', v_sp.tier, 'tier_rank', v_sp.tier_rank, 'par_ms', v_sp.par_ms,
    'clue_count', v_sp.clue_count, 'techniques', to_jsonb(v_sp.techniques),
    'top', v_top, 'me', v_me, 'players', v_n,
    'my_status', case when v_a.id is null then 'none' when v_a.status = 'cleared' then 'cleared'
                      when v_closed then 'played' else 'active' end,
    'givens', v_givens,
    'my_grid', case when v_closed and v_a.id is not null then v_a.grid end,
    'server_now', now()
  );
end;
$$;

-- A sprint week (124) + whether each of my running puzzles is paused, and the
-- pauses on every board row (each puzzle's clears, the weekly totals).
create or replace function public.sudoku_sprint_overview(p_week date default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p      public.arena_sudoku_players;
  v_today  date := (now() at time zone 'Australia/Melbourne')::date;
  v_week   date;
  v_slots  jsonb;
  v_top    jsonb;
  v_me     jsonb;
  v_fin    int;
  v_racers int;
  v_win    jsonb;
begin
  v_p := public._sudoku_player(0);
  v_week := coalesce(p_week, v_today);
  v_week := v_week - (extract(isodow from v_week)::int - 1);
  if v_week > v_today then
    return jsonb_build_object('week', v_week, 'future', true,
      'starts_at', (v_week::timestamp at time zone 'Australia/Melbourne'), 'server_now', now());
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'slot', sp.slot, 'id', sp.id, 'tier', sp.tier, 'tier_rank', sp.tier_rank, 'par_ms', sp.par_ms,
           'clue_count', sp.clue_count, 'techniques', to_jsonb(sp.techniques),
           'my', case when a.id is null then null else jsonb_build_object(
                   'status', a.status, 'attempt_id', a.id, 'started_at', a.started_at, 'final_ms', a.final_ms,
                   'elapsed_ms', case when a.status = 'active' then public._sudoku_elapsed(a) end,
                   'paused', case when a.status = 'active' then public._sudoku_pause_start(a) is not null end,
                   'pauses', a.pauses,
                   'rank', (select r.pz_rank from public.arena_sudoku_special_ranks r where r.special_id = sp.id and r.user_id = v_p.user_id)) end,
           'players', (select count(*) from public.arena_sudoku_special_clears c where c.special_id = sp.id),
           'top', (select coalesce(jsonb_agg(jsonb_build_object('rank', r.pz_rank, 'name', r.name, 'final_ms', r.final_ms,
                                                                'pauses', r.pauses, 'paused_ms', r.paused_ms,
                                                                'me', r.user_id = v_p.user_id) order by r.pz_rank, r.finished_at), '[]'::jsonb)
                     from (select * from public.arena_sudoku_special_ranks where special_id = sp.id
                           order by pz_rank, finished_at limit 5) r))
         order by sp.slot), '[]'::jsonb)
    into v_slots
    from public.arena_sudoku_specials sp
    left join public.arena_sudoku_attempts a on a.special_id = sp.id and a.user_id = v_p.user_id
   where sp.kind = 'sprint' and sp.day = v_week;
  select coalesce(jsonb_agg(jsonb_build_object('rank', t.week_rank, 'name', t.name, 'total_ms', t.total_ms,
           'done', t.done, 'completed_at', t.completed_at, 'streak', coalesce(s.streak_days, 0),
           'pauses', t.pauses, 'paused_ms', t.paused_ms,
           'me', t.user_id = v_p.user_id) order by t.week_rank), '[]'::jsonb)
    into v_top
    from (select * from public.arena_sudoku_sprint_totals where week = v_week and week_rank is not null
          order by week_rank limit 10) t
    left join public.arena_sudoku_streaks s on s.user_id = t.user_id;
  select jsonb_build_object('rank', t.week_rank, 'total_ms', t.total_ms, 'done', t.done, 'completed_at', t.completed_at,
                            'pauses', t.pauses, 'paused_ms', t.paused_ms)
    into v_me
    from public.arena_sudoku_sprint_totals t where t.week = v_week and t.user_id = v_p.user_id;
  select count(*) filter (where done >= 5), count(*) filter (where done < 5) into v_fin, v_racers
    from public.arena_sudoku_sprint_totals where week = v_week;
  select coalesce(jsonb_agg(jsonb_build_object('week', w.week, 'iso_week', to_char(w.week, 'IYYY-"W"IW'), 'name', w.name,
           'total_ms', w.total_ms, 'finishers', w.week_finishers, 'me', w.user_id = v_p.user_id) order by w.week desc), '[]'::jsonb)
    into v_win
    from (select * from public.arena_sudoku_sprint_winners order by week desc limit 8) w;
  return jsonb_build_object(
    'week', v_week,
    'iso_week', to_char(v_week, 'IYYY-"W"IW'),
    'starts_at', (v_week::timestamp at time zone 'Australia/Melbourne'),
    'ends_at', ((v_week + 7)::timestamp at time zone 'Australia/Melbourne'),
    'is_current', v_today between v_week and v_week + 6,
    'closed', v_today > v_week + 6,
    'slots', v_slots,
    'top', v_top, 'me', v_me, 'finishers', v_fin, 'racers', v_racers,
    'winners', v_win,
    'my_wins', (select count(*) from public.arena_sudoku_sprint_winners where user_id = v_p.user_id),
    'server_now', now()
  );
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Function privileges (the 112 / 115 / 122 / 124 posture)
-- ─────────────────────────────────────────────────────────────────────────────
-- internal helpers: nobody but the owner
revoke all on function public._sudoku_heartbeat_ms()                                         from public, anon, authenticated;
revoke all on function public._sudoku_stale_after()                                          from public, anon, authenticated;
revoke all on function public._sudoku_pause_start(public.arena_sudoku_attempts)              from public, anon, authenticated;
revoke all on function public._sudoku_elapsed(public.arena_sudoku_attempts)                  from public, anon, authenticated;
revoke all on function public._sudoku_reconcile(public.arena_sudoku_attempts)                from public, anon, authenticated;
revoke all on function public._sudoku_attempt_for_update(uuid, bigint)                       from public, anon, authenticated;
revoke all on function public._sudoku_touch(bigint)                                          from public, anon, authenticated;
revoke all on function public._sudoku_paused_refusal()                                       from public, anon, authenticated;
revoke all on function public._sudoku_check_marks(jsonb, jsonb)                              from public, anon, authenticated;
revoke all on function public._sudoku_payload(public.arena_sudoku_attempts)                  from public, anon, authenticated;
revoke all on function public._sudoku_finish_special(public.arena_sudoku_players, public.arena_sudoku_attempts, text, bigint, bigint)
                                                                                             from public, anon, authenticated;

-- user-facing RPCs: signed-in staff (and the service role), never anon
revoke all     on function public.sudoku_pause(bigint, text, jsonb, jsonb)  from public;
revoke execute on function public.sudoku_pause(bigint, text, jsonb, jsonb)  from anon;
grant  execute on function public.sudoku_pause(bigint, text, jsonb, jsonb)  to authenticated, service_role;
revoke all     on function public.sudoku_resume(bigint)                     from public;
revoke execute on function public.sudoku_resume(bigint)                     from anon;
grant  execute on function public.sudoku_resume(bigint)                     to authenticated, service_role;
revoke all     on function public.sudoku_heartbeat(bigint)                  from public;
revoke execute on function public.sudoku_heartbeat(bigint)                  from anon;
grant  execute on function public.sudoku_heartbeat(bigint)                  to authenticated, service_role;
revoke all     on function public.sudoku_start(int)                         from public;
revoke execute on function public.sudoku_start(int)                         from anon;
grant  execute on function public.sudoku_start(int)                         to authenticated, service_role;
revoke all     on function public.sudoku_daily_start(date)                  from public;
revoke execute on function public.sudoku_daily_start(date)                  from anon;
grant  execute on function public.sudoku_daily_start(date)                  to authenticated, service_role;
revoke all     on function public.sudoku_sprint_start(int, date)            from public;
revoke execute on function public.sudoku_sprint_start(int, date)            from anon;
grant  execute on function public.sudoku_sprint_start(int, date)            to authenticated, service_role;
revoke all     on function public.sudoku_restart(bigint)                    from public;
revoke execute on function public.sudoku_restart(bigint)                    from anon;
grant  execute on function public.sudoku_restart(bigint)                    to authenticated, service_role;
revoke all     on function public.sudoku_save(bigint, text, jsonb, jsonb)   from public;
revoke execute on function public.sudoku_save(bigint, text, jsonb, jsonb)   from anon;
grant  execute on function public.sudoku_save(bigint, text, jsonb, jsonb)   to authenticated, service_role;
revoke all     on function public.sudoku_check(bigint, int, int)            from public;
revoke execute on function public.sudoku_check(bigint, int, int)            from anon;
grant  execute on function public.sudoku_check(bigint, int, int)            to authenticated, service_role;
revoke all     on function public.sudoku_hint(bigint, int, boolean)         from public;
revoke execute on function public.sudoku_hint(bigint, int, boolean)         from anon;
grant  execute on function public.sudoku_hint(bigint, int, boolean)         to authenticated, service_role;
revoke all     on function public.sudoku_submit(bigint, text)               from public;
revoke execute on function public.sudoku_submit(bigint, text)               from anon;
grant  execute on function public.sudoku_submit(bigint, text)               to authenticated, service_role;
revoke all     on function public.sudoku_overview()                         from public;
revoke execute on function public.sudoku_overview()                         from anon;
grant  execute on function public.sudoku_overview()                         to authenticated, service_role;
revoke all     on function public.sudoku_stage_board(int)                   from public;
revoke execute on function public.sudoku_stage_board(int)                   from anon;
grant  execute on function public.sudoku_stage_board(int)                   to authenticated, service_role;
revoke all     on function public.sudoku_ranking(int)                       from public;
revoke execute on function public.sudoku_ranking(int)                       from anon;
grant  execute on function public.sudoku_ranking(int)                       to authenticated, service_role;
revoke all     on function public.sudoku_daily_overview()                   from public;
revoke execute on function public.sudoku_daily_overview()                   from anon;
grant  execute on function public.sudoku_daily_overview()                   to authenticated, service_role;
revoke all     on function public.sudoku_daily_board(date)                  from public;
revoke execute on function public.sudoku_daily_board(date)                  from anon;
grant  execute on function public.sudoku_daily_board(date)                  to authenticated, service_role;
revoke all     on function public.sudoku_sprint_overview(date)              from public;
revoke execute on function public.sudoku_sprint_overview(date)              from anon;
grant  execute on function public.sudoku_sprint_overview(date)              to authenticated, service_role;

-- PostgREST: pick up the new functions straight away
notify pgrst, 'reload schema';
