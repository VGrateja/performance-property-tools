-- =============================================================================
-- 122_arena_sudoku.sql — Arena game #5: Sudoku (a shared-puzzle stage race)
--
-- Van (2026-09-28): stages 1..N that get harder and harder, a stage-0 tutorial,
-- everyone faces the exact same grid per stage, a top-5 per stage, and an
-- overall ranking by the highest stage reached — ties go to whoever got there
-- first. tools/arena-sudoku.html is the client; the stage set comes from
-- scripts/generate-sudoku-stages.mjs and is seeded through the service role.
--
-- THE RACE IS SERVER-AUTHORITATIVE. The clock, the solution and every
-- judgement live here; the client only ever sends "I placed this digit" and
-- "here is my grid". Elapsed time is never taken from the client.
--
--   clock      started_at (server) → finished_at (server), pure wall-clock.
--              THE CLOCK NEVER STOPS ONCE YOU'VE SEEN THE GRID (Van,
--              2026-09-29): there is no pause — leaving, refreshing or opening
--              another stage keeps it running, and several stages' clocks may
--              run at once. A pause would let a player look at the grid, stop
--              the clock, solve it elsewhere and come back to type it in. The
--              only exits are finishing or sudoku_restart (a shuffled grid
--              with a fresh clock). An earlier build of this file had
--              sudoku_pause / sudoku_resume and pause columns; they are
--              dropped below so re-running this file converges.
--   mistakes   judged by sudoku_check against the private solution (the
--              "auto-check" setting) — +30 s each, charged once per wrong
--              (cell, digit) pair. A wrong full-grid submit also costs +30 s.
--   hints      sudoku_hint reveals one cell — +60 s each, max 3 per attempt.
--   ranked     final_ms = elapsed + penalties.
--   penalty    penalties are SERVED: the next stage opens at clear + penalty
--   box        (players.next_unlock_at). Without that, penalties would only
--              touch the per-stage times and anyone could guess-and-check
--              through stages to the top of the overall ranking.
--   floor      a clear faster than 250 ms per cell the player had to fill is
--              refused — nobody types that fast; a script does.
--
-- WHAT A CLIENT CAN NEVER READ
--   arena_sudoku_stage_secrets — the puzzle, the solution and the generator
--     seed. The PUZZLE is secret too: if it were readable before a stage
--     starts, a player could pre-solve stage n+1 on paper with no clock
--     running. sudoku_start is the only door, and it starts the clock.
--   arena_sudoku_attempts — the in-progress grid, notes and the SYMMETRY key.
--     Attempt 1 of a stage is the canonical grid everyone shares. A restart or
--     a replay gets the same stage with rows/columns/digits relabelled
--     (identical logic and difficulty) so "restart and type it in from
--     memory" or "replay from a screenshot" cannot buy a better time. The key
--     (xform) never leaves the server.
--   Both tables: RLS on, a deny-all policy, and every table privilege revoked
--   from anon + authenticated. Only the SECURITY DEFINER RPCs below read them.
--
-- WHAT IS PUBLIC (to signed-in staff): stage metadata (tier, technique chips,
-- clue count, par), clears (display name + times — the Typing-leaderboard
-- model), crowns, and three security_invoker views over them.
--
-- Security posture (per 112 / 115): every function pins search_path; EXECUTE
-- is revoked from PUBLIC and anon on all of them; user-facing RPCs are granted
-- to authenticated + service_role; internal helpers to nobody. RLS on every
-- table. The RPCs also re-check the caller is a staff tier (dev / admin /
-- leads / company — the Arena page gate's list) and rate-limit per user.
--
-- Additive + re-runnable: create … if not exists, create or replace,
-- drop policy if exists. Run order: after 121_*.sql.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

-- Stage catalogue — PUBLIC metadata only (no puzzle, no solution).
create table if not exists public.arena_sudoku_stages (
  stage         int          primary key check (stage between 1 and 9999),
  variant       text         not null default 'classic' check (variant in ('classic', 'x')),
  tier          text         not null,
  tier_rank     int          not null check (tier_rank between 1 and 9),
  techniques    text[]       not null default '{}',
  hardest       text         not null,
  hardest_rank  int          not null,
  clue_count    int          not null check (clue_count between 17 and 80),
  par_ms        int          not null check (par_ms > 0),
  difficulty    numeric      not null default 0,
  created_at    timestamptz  not null default now()
);

-- The secret half of every stage.
create table if not exists public.arena_sudoku_stage_secrets (
  stage     int    primary key references public.arena_sudoku_stages(stage) on delete cascade,
  puzzle    text   not null check (puzzle ~ '^[0-9]{81}$'),
  solution  text   not null check (solution ~ '^[1-9]{81}$'),
  seed      text   not null,
  gen       jsonb  not null default '{}'::jsonb
);

-- One row per player: progression, counters, the penalty box, rate limiter.
create table if not exists public.arena_sudoku_players (
  user_id           uuid         primary key references public.profiles(id) on delete cascade,
  name              text         not null,
  tutorial_done_at  timestamptz,
  highest_stage     int          not null default 0,   -- highest stage cleared, in order
  reached_at        timestamptz,                       -- when that clear opened the next stage (clear + penalty)
  next_unlock_at    timestamptz,                       -- the penalty box for stage highest_stage + 1
  stages_cleared    int          not null default 0,
  clears            int          not null default 0,   -- includes replays
  total_mistakes    int          not null default 0,
  total_hints       int          not null default 0,
  total_restarts    int          not null default 0,
  streak_days       int          not null default 0,
  best_streak       int          not null default 0,
  last_clear_day    date,                              -- AEST day of the last clear
  rl_tokens         real         not null default 60,
  rl_at             timestamptz  not null default now(),
  created_at        timestamptz  not null default now(),
  updated_at        timestamptz  not null default now()
);

-- One row per attempt. Attempt 1 = the canonical grid; later attempts carry
-- a symmetry key (xform) so a restart or replay can't be typed from memory.
create table if not exists public.arena_sudoku_attempts (
  id            bigint       generated always as identity primary key,
  user_id       uuid         not null references public.profiles(id) on delete cascade,
  stage         int          not null references public.arena_sudoku_stages(stage) on delete cascade,
  attempt_no    int          not null,
  kind          text         not null check (kind in ('first', 'retry', 'replay')),
  xform         jsonb,
  puzzle        text         not null check (puzzle ~ '^[0-9]{81}$'),
  grid          text         not null check (grid ~ '^[0-9]{81}$'),
  notes         jsonb        not null default '[]'::jsonb,
  status        text         not null default 'active' check (status in ('active', 'cleared', 'restarted', 'abandoned')),
  started_at    timestamptz  not null default now(),
  mistakes      int          not null default 0,
  hints         int          not null default 0,
  wrong_pairs   int[]        not null default '{}',    -- cell*10 + digit, each charged once
  hinted_cells  int[]        not null default '{}',
  saves         int          not null default 0,
  last_save_at  timestamptz,
  finished_at   timestamptz,
  ended_at      timestamptz,
  elapsed_ms    bigint,
  penalty_ms    bigint,
  final_ms      bigint,
  created_at    timestamptz  not null default now()
);
create unique index if not exists arena_sudoku_attempts_one_active
  on public.arena_sudoku_attempts (user_id, stage) where status = 'active';
create index if not exists arena_sudoku_attempts_user_stage_idx
  on public.arena_sudoku_attempts (user_id, stage, id desc);
create index if not exists arena_sudoku_attempts_stage_idx
  on public.arena_sudoku_attempts (stage);
-- The clock never stops (see header): the pause columns of the first build go.
-- (Re-running this file on a project that still has them converges it.)
alter table public.arena_sudoku_attempts drop column if exists paused_at;
alter table public.arena_sudoku_attempts drop column if exists paused_ms;
alter table public.arena_sudoku_attempts drop column if exists pauses;

-- Every successful clear — the public leaderboard facts (names + times only).
create table if not exists public.arena_sudoku_clears (
  id           bigint       generated always as identity primary key,
  attempt_id   bigint       not null unique references public.arena_sudoku_attempts(id) on delete cascade,
  user_id      uuid         not null references public.profiles(id) on delete cascade,
  name         text         not null,
  stage        int          not null references public.arena_sudoku_stages(stage) on delete cascade,
  kind         text         not null check (kind in ('first', 'retry', 'replay')),
  first_clear  boolean      not null,
  final_ms     bigint       not null check (final_ms >= 0),
  elapsed_ms   bigint       not null check (elapsed_ms >= 0),
  penalty_ms   bigint       not null default 0,
  mistakes     int          not null default 0,
  hints        int          not null default 0,
  finished_at  timestamptz  not null default now(),
  unlocked_at  timestamptz                          -- first clears: when the next stage opened
);
create index if not exists arena_sudoku_clears_stage_time_idx
  on public.arena_sudoku_clears (stage, final_ms, finished_at);
create index if not exists arena_sudoku_clears_user_stage_idx
  on public.arena_sudoku_clears (user_id, stage);

-- First-clear crowns: written once per stage, never moved.
create table if not exists public.arena_sudoku_crowns (
  stage       int          primary key references public.arena_sudoku_stages(stage) on delete cascade,
  user_id     uuid         references public.profiles(id) on delete set null,
  name        text         not null,
  final_ms    bigint       not null,
  cleared_at  timestamptz  not null
);
create index if not exists arena_sudoku_crowns_user_idx on public.arena_sudoku_crowns (user_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- RLS + table privileges
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.arena_sudoku_stages         enable row level security;
alter table public.arena_sudoku_stage_secrets  enable row level security;
alter table public.arena_sudoku_players        enable row level security;
alter table public.arena_sudoku_attempts       enable row level security;
alter table public.arena_sudoku_clears         enable row level security;
alter table public.arena_sudoku_crowns         enable row level security;

drop policy if exists "authenticated read sudoku stages" on public.arena_sudoku_stages;
create policy "authenticated read sudoku stages"
  on public.arena_sudoku_stages for select to authenticated using (true);

drop policy if exists "no client access to sudoku secrets" on public.arena_sudoku_stage_secrets;
create policy "no client access to sudoku secrets"
  on public.arena_sudoku_stage_secrets for select to authenticated using (false);

drop policy if exists "player reads own sudoku row" on public.arena_sudoku_players;
create policy "player reads own sudoku row"
  on public.arena_sudoku_players for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "no direct client access to sudoku attempts" on public.arena_sudoku_attempts;
create policy "no direct client access to sudoku attempts"
  on public.arena_sudoku_attempts for select to authenticated using (false);

drop policy if exists "authenticated read sudoku clears" on public.arena_sudoku_clears;
create policy "authenticated read sudoku clears"
  on public.arena_sudoku_clears for select to authenticated using (true);

drop policy if exists "authenticated read sudoku crowns" on public.arena_sudoku_crowns;
create policy "authenticated read sudoku crowns"
  on public.arena_sudoku_crowns for select to authenticated using (true);

-- No client writes anywhere (the RPCs write as the table owner). The secret
-- tables lose even SELECT, so a direct read is a permission error, not an
-- empty result.
revoke all on table public.arena_sudoku_stage_secrets from anon, authenticated;
revoke all on table public.arena_sudoku_attempts      from anon, authenticated;
revoke all on table public.arena_sudoku_stages        from anon;
revoke all on table public.arena_sudoku_players       from anon;
revoke all on table public.arena_sudoku_clears        from anon;
revoke all on table public.arena_sudoku_crowns        from anon;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_stages  from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_players from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_clears  from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_crowns  from authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- Public leaderboard views (security_invoker: they read only the public
-- clears table, under the caller's own RLS)
-- ─────────────────────────────────────────────────────────────────────────────

-- Each player's best clear of each stage.
create or replace view public.arena_sudoku_best
with (security_invoker = on) as
select distinct on (c.stage, c.user_id)
  c.stage, c.user_id, c.name, c.final_ms, c.elapsed_ms, c.penalty_ms,
  c.mistakes, c.hints, c.finished_at, c.kind
from public.arena_sudoku_clears c
order by c.stage, c.user_id, c.final_ms, c.finished_at;

-- Per-stage ranks on those bests (medal = rank 1..3).
create or replace view public.arena_sudoku_stage_ranks
with (security_invoker = on) as
select b.*,
  rank()   over (partition by b.stage order by b.final_ms, b.finished_at)::int as stage_rank,
  count(*) over (partition by b.stage)::int                                   as stage_players
from public.arena_sudoku_best b;

-- The overall ranking: highest stage cleared (desc), then who got there first.
create or replace view public.arena_sudoku_ranking
with (security_invoker = on) as
with prog as (
  select distinct on (c.user_id)
    c.user_id, c.name, c.stage as highest_stage,
    coalesce(c.unlocked_at, c.finished_at) as reached_at
  from public.arena_sudoku_clears c
  where c.first_clear
  order by c.user_id, c.stage desc, c.finished_at
), tot as (
  select b.user_id, sum(b.final_ms)::bigint as total_ms, count(*)::int as stages_cleared
  from public.arena_sudoku_best b
  group by b.user_id
)
select
  row_number() over (order by p.highest_stage desc, p.reached_at asc, p.user_id)::int as rank,
  p.user_id, p.name, p.highest_stage, p.reached_at, t.total_ms, t.stages_cleared
from prog p
join tot t on t.user_id = p.user_id;

revoke all on table public.arena_sudoku_best        from anon;
revoke all on table public.arena_sudoku_stage_ranks from anon;
revoke all on table public.arena_sudoku_ranking     from anon;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_best        from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_stage_ranks from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_ranking     from authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- Internal helpers (EXECUTE for nobody but the owner)
-- ─────────────────────────────────────────────────────────────────────────────

-- The caller's player row (created on first use), after the staff-tier check
-- and — when p_cost > 0 — a token-bucket rate limit (60 burst, 6 per second).
create or replace function public._sudoku_player(p_cost real default 1)
returns public.arena_sudoku_players
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text;
  v_row    public.arena_sudoku_players;
  v_tokens real;
begin
  if v_uid is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  select p.email into v_email from public.profiles p
   where p.id = v_uid and p.tier in ('dev', 'admin', 'leads', 'company');
  if v_email is null then raise exception 'Sudoku is open to staff accounts only' using errcode = '42501'; end if;
  insert into public.arena_sudoku_players (user_id, name)
    values (v_uid, split_part(v_email, '@', 1))
  on conflict (user_id) do nothing;
  if coalesce(p_cost, 0) <= 0 then
    select * into v_row from public.arena_sudoku_players where user_id = v_uid;
    return v_row;
  end if;
  select * into v_row from public.arena_sudoku_players where user_id = v_uid for update;
  v_tokens := least(60::real, v_row.rl_tokens + 6 * extract(epoch from (clock_timestamp() - v_row.rl_at))::real);
  if v_tokens < p_cost then
    raise exception 'Slow down - too many moves in a short time' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  update public.arena_sudoku_players
     set rl_tokens = v_tokens - p_cost, rl_at = clock_timestamp()
   where user_id = v_uid
  returning * into v_row;
  return v_row;
end;
$$;

-- A random band-preserving permutation of 0..8 (1-based array ↔ positions 0..8).
create or replace function public._sudoku_band_perm()
returns int[]
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  v_bands int[]; v_w int[]; v_out int[] := '{}'; b int; j int;
begin
  select array_agg(x order by random()) into v_bands from generate_series(0, 2) x;
  for b in 1..3 loop
    select array_agg(x order by random()) into v_w from generate_series(0, 2) x;
    for j in 1..3 loop v_out := v_out || (v_bands[b] * 3 + v_w[j]); end loop;
  end loop;
  return v_out;
end;
$$;

-- A random symmetry of the grid. Mirrors randomXform() in
-- scripts/generate-sudoku-stages.mjs:
--   classic: independent band-preserving row / column permutations
--   x:       rows from the 24-element group that keeps the diagonal pair,
--            columns = rows or their mirror
-- plus a random digit relabelling and an optional transpose.
create or replace function public._sudoku_xform_random(p_variant text)
returns jsonb
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  v_r int[]; v_c int[]; v_d int[]; v_q int[]; v_swap boolean; v_mid boolean; j int;
begin
  if p_variant = 'x' then
    select array_agg(x order by random()) into v_q from generate_series(0, 2) x;
    v_swap := random() < 0.5; v_mid := random() < 0.5;
    v_r := array_fill(0, array[9]);
    for j in 0..2 loop
      v_r[j + 1] := (case when v_swap then 6 else 0 end) + v_q[j + 1];
      v_r[9 - j] := 8 - v_r[j + 1];
    end loop;
    v_r[4] := case when v_mid then 5 else 3 end;
    v_r[5] := 4;
    v_r[6] := 8 - v_r[4];
    if random() < 0.5 then
      v_c := v_r;
    else
      select array_agg(8 - u.v order by u.o) into v_c from unnest(v_r) with ordinality u(v, o);
    end if;
  else
    v_r := public._sudoku_band_perm();
    v_c := public._sudoku_band_perm();
  end if;
  select array_agg(x order by random()) into v_d from generate_series(1, 9) x;
  return jsonb_build_object('r', to_jsonb(v_r), 'c', to_jsonb(v_c), 'd', to_jsonb(array[0] || v_d),
                            't', case when random() < 0.5 then 1 else 0 end);
end;
$$;

-- Apply a symmetry key to an 81-char grid. target(R,C) = d[ S'(r[R], c[C]) ].
create or replace function public._sudoku_apply(p_grid text, p_x jsonb)
returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_r int[]; v_c int[]; v_d int[]; v_t boolean; v_out text := '';
  rr int; cc int; sr int; sc int; v int;
begin
  if p_x is null then return p_grid; end if;
  select array_agg(e::int order by o) into v_r from jsonb_array_elements_text(p_x -> 'r') with ordinality a(e, o);
  select array_agg(e::int order by o) into v_c from jsonb_array_elements_text(p_x -> 'c') with ordinality a(e, o);
  select array_agg(e::int order by o) into v_d from jsonb_array_elements_text(p_x -> 'd') with ordinality a(e, o);
  v_t := coalesce((p_x ->> 't')::int, 0) = 1;
  for rr in 0..8 loop
    for cc in 0..8 loop
      sr := v_r[rr + 1]; sc := v_c[cc + 1];
      if v_t then v := sr; sr := sc; sc := v; end if;
      v := ascii(substr(p_grid, sr * 9 + sc + 1, 1)) - 48;
      v_out := v_out || v_d[v + 1]::text;
    end loop;
  end loop;
  return v_out;
end;
$$;

-- The solution AS THIS ATTEMPT SEES IT (canonical, or relabelled by its key).
create or replace function public._sudoku_solution(p_attempt public.arena_sudoku_attempts)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select public._sudoku_apply(s.solution, p_attempt.xform)
  from public.arena_sudoku_stage_secrets s
  where s.stage = p_attempt.stage;
$$;

-- Server-computed solving time: pure wall-clock from Play (started_at) until
-- the clear (finished_at) or a restart (ended_at). Nothing is subtracted —
-- the clock never stops once the grid has been seen.
create or replace function public._sudoku_elapsed(p_attempt public.arena_sudoku_attempts)
returns bigint
language sql stable set search_path = public, pg_temp as $$
  select greatest(0::bigint,
    floor(extract(epoch from (coalesce(p_attempt.finished_at, p_attempt.ended_at, now())
                              - p_attempt.started_at)) * 1000)::bigint);
$$;

create or replace function public._sudoku_penalty(p_mistakes int, p_hints int)
returns bigint
language sql immutable set search_path = public, pg_temp as $$
  select (coalesce(p_mistakes, 0) * 30000 + coalesce(p_hints, 0) * 60000)::bigint;
$$;

-- What the client is allowed to know about an attempt. Never the solution,
-- never the symmetry key.
create or replace function public._sudoku_payload(p_attempt public.arena_sudoku_attempts)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_stage    public.arena_sudoku_stages;
  v_wrong    jsonb;
  v_restarts int;
begin
  select * into v_stage from public.arena_sudoku_stages where stage = p_attempt.stage;
  select coalesce(jsonb_agg(i order by i), '[]'::jsonb) into v_wrong
    from generate_series(0, 80) i
   where substr(p_attempt.grid, i + 1, 1) <> '0'
     and (i * 10 + (substr(p_attempt.grid, i + 1, 1))::int) = any (p_attempt.wrong_pairs);
  select count(*) into v_restarts from public.arena_sudoku_attempts
   where user_id = p_attempt.user_id and stage = p_attempt.stage and status = 'restarted';
  return jsonb_build_object(
    'attempt_id',   p_attempt.id,
    'stage',        p_attempt.stage,
    'attempt_no',   p_attempt.attempt_no,
    'kind',         p_attempt.kind,
    'variant',      v_stage.variant,
    'shuffled',     p_attempt.xform is not null,
    'puzzle',       p_attempt.puzzle,
    'grid',         p_attempt.grid,
    'notes',        p_attempt.notes,
    'status',       p_attempt.status,
    'elapsed_ms',   public._sudoku_elapsed(p_attempt),
    'penalty_ms',   public._sudoku_penalty(p_attempt.mistakes, p_attempt.hints),
    'mistakes',     p_attempt.mistakes,
    'hints',        p_attempt.hints,
    'hints_left',   greatest(0, 3 - p_attempt.hints),
    'hinted_cells', to_jsonb(p_attempt.hinted_cells),
    'wrong_cells',  v_wrong,
    'restarts',     v_restarts,
    'par_ms',       v_stage.par_ms,
    'server_now',   now()
  );
end;
$$;

-- Removed on 2026-09-29 with the pause feature: there is no pause, and
-- opening a stage never stops another stage's clock (several may run at once).
-- The drops make a re-run of this file converge on a project that has them.
drop function if exists public.sudoku_pause(bigint);
drop function if exists public.sudoku_resume(bigint);
drop function if exists public._sudoku_pause_others(uuid, bigint);

-- Open a NEW attempt on a stage (the caller has already checked the gates).
create or replace function public._sudoku_new_attempt(p_user uuid, p_stage int)
returns public.arena_sudoku_attempts
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_variant text; v_puzzle text; v_no int; v_cleared boolean; v_kind text; v_x jsonb;
  v_row public.arena_sudoku_attempts;
begin
  select st.variant, se.puzzle into v_variant, v_puzzle
    from public.arena_sudoku_stages st
    join public.arena_sudoku_stage_secrets se on se.stage = st.stage
   where st.stage = p_stage;
  if v_puzzle is null then raise exception 'Stage % is not ready yet', p_stage; end if;
  select coalesce(max(attempt_no), 0) + 1 into v_no from public.arena_sudoku_attempts
   where user_id = p_user and stage = p_stage;
  v_cleared := exists (select 1 from public.arena_sudoku_clears where user_id = p_user and stage = p_stage);
  v_kind := case when v_cleared then 'replay' when v_no = 1 then 'first' else 'retry' end;
  v_x := case when v_no = 1 then null else public._sudoku_xform_random(v_variant) end;
  v_puzzle := public._sudoku_apply(v_puzzle, v_x);
  insert into public.arena_sudoku_attempts (user_id, stage, attempt_no, kind, xform, puzzle, grid, notes)
  values (p_user, p_stage, v_no, v_kind, v_x, v_puzzle, v_puzzle, '[]'::jsonb)
  returning * into v_row;
  return v_row;
end;
$$;

-- The caller's attempt, locked, or an error.
create or replace function public._sudoku_attempt_for_update(p_user uuid, p_attempt bigint)
returns public.arena_sudoku_attempts
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.arena_sudoku_attempts;
begin
  select * into v_row from public.arena_sudoku_attempts
   where id = p_attempt and user_id = p_user
   for update;
  if not found then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  return v_row;
end;
$$;

-- Validate an 81-char client grid against an attempt: shape, givens, hints.
create or replace function public._sudoku_check_grid(p_attempt public.arena_sudoku_attempts, p_grid text)
returns void
language plpgsql stable set search_path = public, pg_temp as $$
declare i int;
begin
  if p_grid is null or p_grid !~ '^[0-9]{81}$' then
    raise exception 'A grid is 81 digits (0 = empty)' using errcode = '22023';
  end if;
  for i in 1..81 loop
    if substr(p_attempt.puzzle, i, 1) <> '0' and substr(p_grid, i, 1) <> substr(p_attempt.puzzle, i, 1) then
      raise exception 'The given digits cannot change' using errcode = '22023';
    end if;
  end loop;
  foreach i in array p_attempt.hinted_cells loop
    if substr(p_grid, i + 1, 1) <> substr(p_attempt.grid, i + 1, 1) then
      raise exception 'Hinted cells cannot change' using errcode = '22023';
    end if;
  end loop;
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Game RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- Stage 0: mark the tutorial done (it is never ranked; it opens stage 1).
create or replace function public.sudoku_complete_tutorial()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_p public.arena_sudoku_players;
begin
  v_p := public._sudoku_player(1);
  update public.arena_sudoku_players
     set tutorial_done_at = coalesce(tutorial_done_at, now()), updated_at = now()
   where user_id = v_p.user_id;
  return jsonb_build_object('ok', true, 'tutorial_done', true);
end;
$$;

-- Open (or re-open) a stage. The clock starts HERE, server-side, and this is
-- the only way the puzzle reaches a client. Re-opening an active attempt just
-- returns it — its clock has been running all along. Opening a stage never
-- touches any other attempt: several clocks may run at once.
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

-- Restart: the attempt ends, the restart is counted, and a fresh attempt of
-- the same stage (relabelled — see header) starts from 0:00.
create or replace function public.sudoku_restart(p_attempt bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p public.arena_sudoku_players;
  v_a public.arena_sudoku_attempts;
begin
  v_p := public._sudoku_player(1);
  v_a := public._sudoku_attempt_for_update(v_p.user_id, p_attempt);
  if v_a.status <> 'active' then raise exception 'That attempt is already over' using errcode = 'P0001'; end if;
  update public.arena_sudoku_attempts
     set status = 'restarted', ended_at = now()
   where id = v_a.id;
  update public.arena_sudoku_players
     set total_restarts = total_restarts + 1, updated_at = now()
   where user_id = v_p.user_id;
  v_a := public._sudoku_new_attempt(v_p.user_id, v_a.stage);
  return jsonb_build_object('ok', true, 'state', public._sudoku_payload(v_a));
end;
$$;

-- Autosave the board (grid + notes) for resume on any device.
create or replace function public.sudoku_save(p_attempt bigint, p_grid text, p_notes jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p public.arena_sudoku_players;
  v_a public.arena_sudoku_attempts;
begin
  v_p := public._sudoku_player(0.5);
  v_a := public._sudoku_attempt_for_update(v_p.user_id, p_attempt);
  if v_a.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'over'); end if;
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
  update public.arena_sudoku_attempts
     set grid = p_grid, notes = p_notes, saves = saves + 1, last_save_at = now()
   where id = v_a.id
  returning * into v_a;
  return jsonb_build_object('ok', true, 'elapsed_ms', public._sudoku_elapsed(v_a),
    'penalty_ms', public._sudoku_penalty(v_a.mistakes, v_a.hints), 'server_now', now());
end;
$$;

-- Auto-check one placement against the private solution. A wrong (cell,
-- digit) pair is charged once (+30 s); the answer is only ever right/wrong.
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
  return jsonb_build_object('ok', true, 'correct', v_right, 'charged', v_charged,
    'mistakes', v_a.mistakes, 'penalty_ms', public._sudoku_penalty(v_a.mistakes, v_a.hints),
    'elapsed_ms', public._sudoku_elapsed(v_a), 'server_now', now());
end;
$$;

-- Reveal one cell (+60 s, max 3 per attempt). The digit is written into the
-- saved grid and the cell is locked.
create or replace function public.sudoku_hint(p_attempt bigint, p_cell int)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p public.arena_sudoku_players;
  v_a public.arena_sudoku_attempts;
  v_digit text;
begin
  v_p := public._sudoku_player(1);
  v_a := public._sudoku_attempt_for_update(v_p.user_id, p_attempt);
  if v_a.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'over'); end if;
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
  update public.arena_sudoku_attempts
     set hints = hints + 1,
         hinted_cells = hinted_cells || p_cell,
         grid = overlay(grid placing v_digit from p_cell + 1 for 1)
   where id = v_a.id
  returning * into v_a;
  return jsonb_build_object('ok', true, 'cell', p_cell, 'digit', v_digit::int,
    'hints', v_a.hints, 'hints_left', greatest(0, 3 - v_a.hints),
    'penalty_ms', public._sudoku_penalty(v_a.mistakes, v_a.hints),
    'elapsed_ms', public._sudoku_elapsed(v_a), 'server_now', now());
end;
$$;

-- Submit a full grid. Wrong → only a COUNT of wrong cells comes back (+30 s).
-- Right → the clear is written with server time, progression + crown +
-- medal are settled, and the stage rank comes back.
create or replace function public.sudoku_submit(p_attempt bigint, p_grid text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p        public.arena_sudoku_players;
  v_a        public.arena_sudoku_attempts;
  v_stage    public.arena_sudoku_stages;
  v_sol      text;
  v_wrong    int;
  v_empty    int;
  v_elapsed  bigint;
  v_pen      bigint;
  v_final    bigint;
  v_floor    bigint;
  v_first    boolean;
  v_prev     bigint;
  v_crown    boolean := false;
  v_rank     int;
  v_players  int;
  v_today    date := (now() at time zone 'Australia/Brisbane')::date;
  v_unlock   timestamptz;
  v_next     int;
  v_progress boolean := false;
begin
  v_p := public._sudoku_player(1);
  v_a := public._sudoku_attempt_for_update(v_p.user_id, p_attempt);
  if v_a.status <> 'active' then raise exception 'That attempt is already over' using errcode = 'P0001'; end if;
  perform public._sudoku_check_grid(v_a, p_grid);
  v_empty := length(p_grid) - length(replace(p_grid, '0', ''));
  if v_empty > 0 then
    return jsonb_build_object('ok', false, 'reason', 'incomplete', 'empty', v_empty);
  end if;
  v_sol := public._sudoku_solution(v_a);
  if p_grid <> v_sol then
    select count(*) into v_wrong from generate_series(1, 81) i where substr(p_grid, i, 1) <> substr(v_sol, i, 1);
    update public.arena_sudoku_attempts set mistakes = mistakes + 1 where id = v_a.id returning * into v_a;
    return jsonb_build_object('ok', false, 'reason', 'wrong', 'wrong', v_wrong, 'mistakes', v_a.mistakes,
      'penalty_ms', public._sudoku_penalty(v_a.mistakes, v_a.hints));
  end if;
  v_elapsed := public._sudoku_elapsed(v_a);
  v_floor := greatest(0, (length(v_a.puzzle) - length(replace(v_a.puzzle, '0', ''))) - coalesce(array_length(v_a.hinted_cells, 1), 0)) * 250;
  if v_elapsed < v_floor then
    return jsonb_build_object('ok', false, 'reason', 'too_fast',
      'message', 'That was faster than anyone can type - the clear was not accepted.');
  end if;
  v_pen := public._sudoku_penalty(v_a.mistakes, v_a.hints);
  v_final := v_elapsed + v_pen;
  select * into v_stage from public.arena_sudoku_stages where stage = v_a.stage;

  update public.arena_sudoku_attempts
     set status = 'cleared', grid = p_grid, finished_at = now(),
         elapsed_ms = v_elapsed, penalty_ms = v_pen, final_ms = v_final
   where id = v_a.id;

  select min(final_ms) into v_prev from public.arena_sudoku_clears where user_id = v_p.user_id and stage = v_a.stage;
  v_first := v_prev is null;
  v_unlock := now() + (v_pen::text || ' milliseconds')::interval;

  insert into public.arena_sudoku_clears
    (attempt_id, user_id, name, stage, kind, first_clear, final_ms, elapsed_ms, penalty_ms, mistakes, hints, finished_at, unlocked_at)
  values
    (v_a.id, v_p.user_id, v_p.name, v_a.stage, v_a.kind, v_first, v_final, v_elapsed, v_pen, v_a.mistakes, v_a.hints, now(),
     case when v_first then v_unlock end);

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

  return jsonb_build_object(
    'ok', true,
    'stage', v_a.stage,
    'kind', v_a.kind,
    'final_ms', v_final, 'elapsed_ms', v_elapsed, 'penalty_ms', v_pen,
    'mistakes', v_a.mistakes, 'hints', v_a.hints,
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
    'server_now', now()
  );
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Read RPCs (names + times only; "me" markers resolved server-side)
-- ─────────────────────────────────────────────────────────────────────────────

-- Everything the stage map needs about me and the crowns, in one call.
create or replace function public.sudoku_overview()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p   public.arena_sudoku_players;
  v_uid uuid;
begin
  v_p := public._sudoku_player(0);
  v_uid := v_p.user_id;
  return jsonb_build_object(
    'me', jsonb_build_object(
      'name', v_p.name,
      'tutorial_done', v_p.tutorial_done_at is not null,
      'highest_stage', v_p.highest_stage,
      'reached_at', v_p.reached_at,
      'next_unlock_at', v_p.next_unlock_at,
      'stages_cleared', v_p.stages_cleared,
      'streak_days', case when v_p.last_clear_day >= (now() at time zone 'Australia/Brisbane')::date - 1 then v_p.streak_days else 0 end),
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
                                                            'started_at', a.started_at) order by a.stage), '[]'::jsonb)
                 from public.arena_sudoku_attempts a where a.user_id = v_uid and a.status = 'active'),
    'server_now', now()
  );
end;
$$;

-- A stage's board: top 5 fastest (best per player), my rank, the crown.
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
           'me', r.user_id = v_p.user_id) order by r.stage_rank, r.finished_at), '[]'::jsonb)
    into v_top
    from (select * from public.arena_sudoku_stage_ranks where stage = p_stage
          order by stage_rank, finished_at limit 5) r;
  select jsonb_build_object('rank', r.stage_rank, 'final_ms', r.final_ms, 'finished_at', r.finished_at,
                            'mistakes', r.mistakes, 'hints', r.hints)
    into v_me
    from public.arena_sudoku_stage_ranks r where r.stage = p_stage and r.user_id = v_p.user_id;
  select jsonb_build_object('name', c.name, 'final_ms', c.final_ms, 'cleared_at', c.cleared_at, 'mine', c.user_id = v_p.user_id)
    into v_crown
    from public.arena_sudoku_crowns c where c.stage = p_stage;
  select count(*) into v_n from public.arena_sudoku_best where stage = p_stage;
  return jsonb_build_object('stage', p_stage, 'top', v_top, 'me', v_me, 'crown', v_crown, 'players', v_n);
end;
$$;

-- The overall ranking (highest stage, then earliest), with my row pinned.
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
           'me', r.user_id = v_p.user_id) order by r.rank), '[]'::jsonb)
    into v_top
    from (select * from public.arena_sudoku_ranking order by rank
          limit greatest(1, least(coalesce(p_limit, 50), 200))) r;
  select jsonb_build_object('rank', r.rank, 'name', r.name, 'highest_stage', r.highest_stage,
                            'reached_at', r.reached_at, 'total_ms', r.total_ms, 'stages_cleared', r.stages_cleared)
    into v_me
    from public.arena_sudoku_ranking r where r.user_id = v_p.user_id;
  select count(*) into v_n from public.arena_sudoku_ranking;
  return jsonb_build_object('top', v_top, 'me', v_me, 'players', v_n);
end;
$$;

-- Personal stats for the signed-in player.
create or replace function public.sudoku_stats()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p     public.arena_sudoku_players;
  v_today date := (now() at time zone 'Australia/Brisbane')::date;
  v_out   jsonb;
begin
  v_p := public._sudoku_player(0);
  select jsonb_build_object(
    'name', v_p.name,
    'tutorial_done', v_p.tutorial_done_at is not null,
    'highest_stage', v_p.highest_stage,
    'reached_at', v_p.reached_at,
    'stages_cleared', v_p.stages_cleared,
    'clears', v_p.clears,
    'replays', (select count(*) from public.arena_sudoku_clears where user_id = v_p.user_id and kind = 'replay'),
    'gold',   (select count(*) from public.arena_sudoku_stage_ranks where user_id = v_p.user_id and stage_rank = 1),
    'silver', (select count(*) from public.arena_sudoku_stage_ranks where user_id = v_p.user_id and stage_rank = 2),
    'bronze', (select count(*) from public.arena_sudoku_stage_ranks where user_id = v_p.user_id and stage_rank = 3),
    'crowns', (select count(*) from public.arena_sudoku_crowns where user_id = v_p.user_id),
    'par_stars', (select count(*) from public.arena_sudoku_best b join public.arena_sudoku_stages s on s.stage = b.stage
                   where b.user_id = v_p.user_id and b.final_ms <= s.par_ms),
    'avg_ms',   (select round(avg(final_ms))::bigint from public.arena_sudoku_best where user_id = v_p.user_id),
    'total_ms', (select sum(final_ms)::bigint from public.arena_sudoku_best where user_id = v_p.user_id),
    'total_mistakes', v_p.total_mistakes,
    'total_hints', v_p.total_hints,
    'total_restarts', v_p.total_restarts,
    'streak_days', case when v_p.last_clear_day >= v_today - 1 then v_p.streak_days else 0 end,
    'best_streak', v_p.best_streak,
    'first_clear_at', (select min(finished_at) from public.arena_sudoku_clears where user_id = v_p.user_id),
    'last_clear_at',  (select max(finished_at) from public.arena_sudoku_clears where user_id = v_p.user_id),
    'rank', (select r.rank from public.arena_sudoku_ranking r where r.user_id = v_p.user_id)
  ) into v_out;
  return v_out;
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Function privileges (112 / 115 posture)
-- ─────────────────────────────────────────────────────────────────────────────
-- internal helpers: nobody but the owner
revoke all on function public._sudoku_player(real)                                           from public, anon, authenticated;
revoke all on function public._sudoku_band_perm()                                            from public, anon, authenticated;
revoke all on function public._sudoku_xform_random(text)                                     from public, anon, authenticated;
revoke all on function public._sudoku_apply(text, jsonb)                                     from public, anon, authenticated;
revoke all on function public._sudoku_solution(public.arena_sudoku_attempts)                 from public, anon, authenticated;
revoke all on function public._sudoku_elapsed(public.arena_sudoku_attempts)                  from public, anon, authenticated;
revoke all on function public._sudoku_penalty(int, int)                                      from public, anon, authenticated;
revoke all on function public._sudoku_payload(public.arena_sudoku_attempts)                  from public, anon, authenticated;
revoke all on function public._sudoku_new_attempt(uuid, int)                                 from public, anon, authenticated;
revoke all on function public._sudoku_attempt_for_update(uuid, bigint)                       from public, anon, authenticated;
revoke all on function public._sudoku_check_grid(public.arena_sudoku_attempts, text)         from public, anon, authenticated;

-- user-facing RPCs: signed-in staff (and the service role), never anon
revoke all     on function public.sudoku_complete_tutorial()          from public;
revoke execute on function public.sudoku_complete_tutorial()          from anon;
grant  execute on function public.sudoku_complete_tutorial()          to authenticated, service_role;
revoke all     on function public.sudoku_start(int)                   from public;
revoke execute on function public.sudoku_start(int)                   from anon;
grant  execute on function public.sudoku_start(int)                   to authenticated, service_role;
revoke all     on function public.sudoku_restart(bigint)              from public;
revoke execute on function public.sudoku_restart(bigint)              from anon;
grant  execute on function public.sudoku_restart(bigint)              to authenticated, service_role;
revoke all     on function public.sudoku_save(bigint, text, jsonb)    from public;
revoke execute on function public.sudoku_save(bigint, text, jsonb)    from anon;
grant  execute on function public.sudoku_save(bigint, text, jsonb)    to authenticated, service_role;
revoke all     on function public.sudoku_check(bigint, int, int)      from public;
revoke execute on function public.sudoku_check(bigint, int, int)      from anon;
grant  execute on function public.sudoku_check(bigint, int, int)      to authenticated, service_role;
revoke all     on function public.sudoku_hint(bigint, int)            from public;
revoke execute on function public.sudoku_hint(bigint, int)            from anon;
grant  execute on function public.sudoku_hint(bigint, int)            to authenticated, service_role;
revoke all     on function public.sudoku_submit(bigint, text)         from public;
revoke execute on function public.sudoku_submit(bigint, text)         from anon;
grant  execute on function public.sudoku_submit(bigint, text)         to authenticated, service_role;
revoke all     on function public.sudoku_overview()                   from public;
revoke execute on function public.sudoku_overview()                   from anon;
grant  execute on function public.sudoku_overview()                   to authenticated, service_role;
revoke all     on function public.sudoku_stage_board(int)             from public;
revoke execute on function public.sudoku_stage_board(int)             from anon;
grant  execute on function public.sudoku_stage_board(int)             to authenticated, service_role;
revoke all     on function public.sudoku_ranking(int)                 from public;
revoke execute on function public.sudoku_ranking(int)                 from anon;
grant  execute on function public.sudoku_ranking(int)                 to authenticated, service_role;
revoke all     on function public.sudoku_stats()                      from public;
revoke execute on function public.sudoku_stats()                      from anon;
grant  execute on function public.sudoku_stats()                      to authenticated, service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Hub wiring: Sudoku joins the company baseline like every other Arena game
-- (shared/tool-registry.js DEFAULT_BASELINE carries 'arena-sudoku' in lockstep)
-- ─────────────────────────────────────────────────────────────────────────────
update public.hub_groups
   set tools = tools || '["arena-sudoku"]'::jsonb
 where key = 'company_baseline'
   and not (tools ? 'arena-sudoku');
