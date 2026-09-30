-- =============================================================================
-- 124_arena_sudoku_twists.sql — Arena Sudoku: the twists Van approved
--
-- On top of 122_arena_sudoku.sql (the 300-stage ladder). Adds, in priority
-- order:
--   1. DAILY CHALLENGE  one fresh puzzle per Melbourne calendar day, the same
--                       for everyone, outside the ladder. Playable only on its
--                       day; per-day top 10; gold/silver/bronze for the day's
--                       fastest three; a 30-day calendar.
--   2. COLOUR HIGHLIGHTER  per-attempt cell colours (0 = none, 1..6), saved
--                       with the board like notes are, never validated.
--   3. STREAK BADGES    consecutive Melbourne days with at least one clear of
--                       any kind; badges at 3 / 7 / 14 / 30 / 100 days, earned
--                       by the best streak and kept. Computed in a view from the
--                       clears themselves (no client trust, nothing to drift).
--   4. HINT TOKENS      +1 for every ladder stage FIRST-cleared with zero hints
--                       (cap 5 banked). A token makes one ladder hint penalty-
--                       free; the three-hints-per-attempt ceiling stays.
--   5. WEEKLY SPRINT    Monday 00:00 – Sunday 23:59 Melbourne: five puzzles,
--                       Basic → Master, any order; one total time (all five,
--                       penalties included) per player; the fastest total of an
--                       ended week is its Sprint winner, kept for good.
--
-- THE RULES OF 122 STAND. The clock never stops after Play (a daily or sprint
-- puzzle has no restart at all — "Clear" in the page wipes entries, the clock
-- keeps running); penalties, not strikes (+0:30 a wrong digit, +1:00 a hint,
-- three hints per attempt); crown = first clear, gold = best time; server clock,
-- server-side penalties, every write through an RPC.
--
-- DATA MODEL
--   arena_sudoku_specials         public catalogue of the daily + sprint puzzles
--                                 (kind, day, slot, tier, par … — no puzzle, no
--                                 solution). Readable up to Melbourne tomorrow.
--   arena_sudoku_special_secrets  puzzle + solution + seed; no client access.
--   arena_sudoku_special_clears   public leaderboard facts of daily/sprint clears.
--   arena_sudoku_attempts         GENERALISED: mode ('ladder' | 'daily' |
--                                 'sprint') + special_id; stage is now null for
--                                 specials. colors + token_hints added. So the
--                                 existing sudoku_save / check / hint / submit
--                                 work on any attempt by id — no duplicate RPCs.
--   arena_sudoku_players          + hint_tokens (0..5), tokens_earned/spent.
--   arena_sudoku_clears           + token_hints (penalty stays reconstructible).
--   Legacy, kept: players.streak_days / best_streak / last_clear_day are still
--   written by the ladder submit (Brisbane days, ladder only) but nothing reads
--   them any more — the streak view is the truth.
--
-- SIGNATURE CHANGES (old version dropped; the new one has defaults, so every
-- existing call — named arguments — still resolves):
--   sudoku_save(p_attempt, p_grid, p_notes)  → + p_colors jsonb default null
--   sudoku_hint(p_attempt, p_cell)           → + p_token boolean default false
--
-- RUN ORDER: after 122. Re-runnable (if not exists, create or replace, drop …
-- if exists, guarded constraints). Re-running 122 AFTER this file would put
-- back 122's function bodies and the old save/hint signatures — re-run this
-- file afterwards and it converges again.
-- Apply: supabase db query --linked -f supabase/migrations/124_arena_sudoku_twists.sql
-- (NEVER db push — see CLAUDE.md.) Seed: scripts/generate-sudoku-stages.mjs
-- --daily / --sprint, then --apply (service role, in-process).
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

-- The daily + sprint catalogue — PUBLIC metadata only.
--   daily:  day = the Melbourne calendar day, slot = 1
--   sprint: day = the Monday of the ISO week, slot = 1..5 (Basic … Master)
create table if not exists public.arena_sudoku_specials (
  id            int          generated always as identity primary key,
  kind          text         not null check (kind in ('daily', 'sprint')),
  day           date         not null,
  slot          int          not null default 1 check (slot between 1 and 5),
  variant       text         not null default 'classic' check (variant in ('classic', 'x')),
  tier          text         not null,
  tier_rank     int          not null check (tier_rank between 1 and 9),
  techniques    text[]       not null default '{}',
  hardest       text         not null,
  hardest_rank  int          not null,
  clue_count    int          not null check (clue_count between 17 and 80),
  par_ms        int          not null check (par_ms > 0),
  difficulty    numeric      not null default 0,
  created_at    timestamptz  not null default now(),
  constraint arena_sudoku_specials_key unique (kind, day, slot),
  constraint arena_sudoku_specials_daily_slot check (kind <> 'daily' or slot = 1),
  constraint arena_sudoku_specials_sprint_monday check (kind <> 'sprint' or extract(isodow from day) = 1)
);

-- The secret half of every daily / sprint puzzle.
create table if not exists public.arena_sudoku_special_secrets (
  special_id  int    primary key references public.arena_sudoku_specials(id) on delete cascade,
  puzzle      text   not null check (puzzle ~ '^[0-9]{81}$'),
  solution    text   not null check (solution ~ '^[1-9]{81}$'),
  seed        text   not null,
  gen         jsonb  not null default '{}'::jsonb
);

-- Attempts learn which kind of puzzle they belong to.
alter table public.arena_sudoku_attempts add column if not exists mode text not null default 'ladder';
alter table public.arena_sudoku_attempts add column if not exists special_id int
  references public.arena_sudoku_specials(id) on delete cascade;
alter table public.arena_sudoku_attempts add column if not exists colors jsonb not null default '[]'::jsonb;
alter table public.arena_sudoku_attempts add column if not exists token_hints int not null default 0;
alter table public.arena_sudoku_attempts alter column stage drop not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'arena_sudoku_attempts_mode_check') then
    alter table public.arena_sudoku_attempts add constraint arena_sudoku_attempts_mode_check
      check (mode in ('ladder', 'daily', 'sprint'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'arena_sudoku_attempts_target_check') then
    alter table public.arena_sudoku_attempts add constraint arena_sudoku_attempts_target_check
      check ((mode = 'ladder' and stage is not null and special_id is null)
          or (mode <> 'ladder' and stage is null and special_id is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'arena_sudoku_attempts_token_hints_check') then
    alter table public.arena_sudoku_attempts add constraint arena_sudoku_attempts_token_hints_check
      check (token_hints >= 0 and token_hints <= hints);
  end if;
end $$;
-- one attempt per player per daily / sprint puzzle, ever (no restarts, no replays)
create unique index if not exists arena_sudoku_attempts_one_special
  on public.arena_sudoku_attempts (user_id, special_id) where special_id is not null;
create index if not exists arena_sudoku_attempts_special_idx
  on public.arena_sudoku_attempts (special_id);

-- Hint tokens live on the player row, server-side only.
alter table public.arena_sudoku_players add column if not exists hint_tokens   int not null default 0;
alter table public.arena_sudoku_players add column if not exists tokens_earned int not null default 0;
alter table public.arena_sudoku_players add column if not exists tokens_spent  int not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'arena_sudoku_players_hint_tokens_check') then
    alter table public.arena_sudoku_players add constraint arena_sudoku_players_hint_tokens_check
      check (hint_tokens between 0 and 5);
  end if;
end $$;

-- A ladder clear records how many of its hints a token paid for.
alter table public.arena_sudoku_clears add column if not exists token_hints int not null default 0;

-- Every daily / sprint clear — the public leaderboard facts (names + times).
create table if not exists public.arena_sudoku_special_clears (
  id           bigint       generated always as identity primary key,
  attempt_id   bigint       not null unique references public.arena_sudoku_attempts(id) on delete cascade,
  special_id   int          not null references public.arena_sudoku_specials(id) on delete cascade,
  kind         text         not null check (kind in ('daily', 'sprint')),
  day          date         not null,                  -- the special's day (daily) / Monday (sprint)
  slot         int          not null,
  user_id      uuid         not null references public.profiles(id) on delete cascade,
  name         text         not null,
  final_ms     bigint       not null check (final_ms >= 0),
  elapsed_ms   bigint       not null check (elapsed_ms >= 0),
  penalty_ms   bigint       not null default 0,
  mistakes     int          not null default 0,
  hints        int          not null default 0,
  finished_at  timestamptz  not null default now(),
  constraint arena_sudoku_special_clears_once unique (special_id, user_id)
);
create index if not exists arena_sudoku_special_clears_board_idx
  on public.arena_sudoku_special_clears (special_id, final_ms, finished_at);
create index if not exists arena_sudoku_special_clears_user_idx
  on public.arena_sudoku_special_clears (user_id, kind, day);


-- ─────────────────────────────────────────────────────────────────────────────
-- RLS + table privileges (the 122 posture)
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.arena_sudoku_specials        enable row level security;
alter table public.arena_sudoku_special_secrets enable row level security;
alter table public.arena_sudoku_special_clears  enable row level security;

-- The catalogue is readable up to Melbourne TOMORROW (the "next puzzle" teaser)
-- and no further — there is nothing to learn from it, but nothing to gain
-- from a year of it either.
drop policy if exists "authenticated read sudoku specials up to tomorrow" on public.arena_sudoku_specials;
create policy "authenticated read sudoku specials up to tomorrow"
  on public.arena_sudoku_specials for select to authenticated
  using (day <= (now() at time zone 'Australia/Melbourne')::date + 1);

drop policy if exists "no client access to sudoku special secrets" on public.arena_sudoku_special_secrets;
create policy "no client access to sudoku special secrets"
  on public.arena_sudoku_special_secrets for select to authenticated using (false);

drop policy if exists "authenticated read sudoku special clears" on public.arena_sudoku_special_clears;
create policy "authenticated read sudoku special clears"
  on public.arena_sudoku_special_clears for select to authenticated using (true);

revoke all on table public.arena_sudoku_special_secrets from anon, authenticated;
revoke all on table public.arena_sudoku_specials        from anon;
revoke all on table public.arena_sudoku_special_clears  from anon;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_specials       from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_special_clears from authenticated;
grant select on table public.arena_sudoku_specials, public.arena_sudoku_special_clears to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- Views (security_invoker: public tables only, under the caller's own RLS)
-- ─────────────────────────────────────────────────────────────────────────────

-- Every clear of any kind as (player, Melbourne day). Ladder replays count.
create or replace view public.arena_sudoku_clear_days
with (security_invoker = on) as
select c.user_id, (c.finished_at at time zone 'Australia/Melbourne')::date as day, 'ladder'::text as source
  from public.arena_sudoku_clears c
union all
select s.user_id, (s.finished_at at time zone 'Australia/Melbourne')::date as day, s.kind as source
  from public.arena_sudoku_special_clears s;

-- Streaks by gaps-and-islands over the distinct clear days: each run of
-- consecutive days is an island. The CURRENT streak is the island ending today
-- or yesterday (a streak is only lost once a whole day passes without a
-- clear); the BEST is the longest island ever.
create or replace view public.arena_sudoku_streaks
with (security_invoker = on) as
with d as (
  select distinct user_id, day from public.arena_sudoku_clear_days
), g as (
  select user_id, day, day - (row_number() over (partition by user_id order by day))::int as grp from d
), isl as (
  select user_id, count(*)::int as len, max(day) as last_day from g group by user_id, grp
)
select user_id,
  coalesce(max(len) filter (where last_day >= (now() at time zone 'Australia/Melbourne')::date - 1), 0)::int as streak_days,
  max(len)::int  as best_streak,
  max(last_day)  as last_clear_day
from isl
group by user_id;

-- Rank on each daily / sprint puzzle (one clear per player per puzzle).
create or replace view public.arena_sudoku_special_ranks
with (security_invoker = on) as
select c.*,
  rank()   over (partition by c.special_id order by c.final_ms, c.finished_at)::int as pz_rank,
  count(*) over (partition by c.special_id)::int                                   as pz_players
from public.arena_sudoku_special_clears c;

-- The weekly sprint: per week × player, how many of the five are done and the
-- total; week_rank only for players with all five (fastest total, then who
-- finished first).
create or replace view public.arena_sudoku_sprint_totals
with (security_invoker = on) as
with t as (
  select c.day as week, c.user_id, max(c.name) as name, count(*)::int as done,
         sum(c.final_ms)::bigint as total_ms, max(c.finished_at) as completed_at
    from public.arena_sudoku_special_clears c
   where c.kind = 'sprint'
   group by c.day, c.user_id
)
select t.week, t.user_id, t.name, t.done, t.total_ms, t.completed_at,
  case when t.done >= 5 then
    (row_number() over (partition by t.week, (t.done >= 5) order by t.total_ms, t.completed_at, t.user_id))::int
  end as week_rank,
  (count(*) filter (where t.done >= 5) over (partition by t.week))::int as week_finishers
from t;

-- The winner of every ENDED week (Sunday 23:59 Melbourne has passed).
create or replace view public.arena_sudoku_sprint_winners
with (security_invoker = on) as
select t.week, t.user_id, t.name, t.total_ms, t.completed_at, t.week_finishers
  from public.arena_sudoku_sprint_totals t
 where t.week_rank = 1
   and t.week + 7 <= (now() at time zone 'Australia/Melbourne')::date;

revoke all on table public.arena_sudoku_clear_days     from anon;
revoke all on table public.arena_sudoku_streaks        from anon;
revoke all on table public.arena_sudoku_special_ranks  from anon;
revoke all on table public.arena_sudoku_sprint_totals  from anon;
revoke all on table public.arena_sudoku_sprint_winners from anon;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_clear_days     from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_streaks        from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_special_ranks  from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_sprint_totals  from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.arena_sudoku_sprint_winners from authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- Internal helpers (EXECUTE for nobody but the owner)
-- ─────────────────────────────────────────────────────────────────────────────

-- An attempt's penalty: +30 s a mistake, +60 s a hint — except hints a token paid for.
create or replace function public._sudoku_attempt_penalty(p_attempt public.arena_sudoku_attempts)
returns bigint
language sql immutable set search_path = public, pg_temp as $$
  select (coalesce(p_attempt.mistakes, 0) * 30000
        + greatest(0, coalesce(p_attempt.hints, 0) - coalesce(p_attempt.token_hints, 0)) * 60000)::bigint;
$$;

-- Is the attempt's puzzle still open? Ladder: always. Daily: only on its
-- Melbourne day. Sprint: only Monday..Sunday of its week.
create or replace function public._sudoku_live(p_attempt public.arena_sudoku_attempts)
returns boolean
language sql stable set search_path = public, pg_temp as $$
  select p_attempt.special_id is null or exists (
    select 1 from public.arena_sudoku_specials s
     where s.id = p_attempt.special_id
       and case when s.kind = 'daily'
                then s.day = (now() at time zone 'Australia/Melbourne')::date
                else (now() at time zone 'Australia/Melbourne')::date between s.day and s.day + 6 end);
$$;

-- The solution AS THIS ATTEMPT SEES IT: a ladder stage (canonical or
-- relabelled by its key), or a daily / sprint puzzle (always canonical).
create or replace function public._sudoku_solution(p_attempt public.arena_sudoku_attempts)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_attempt.special_id is null
    then (select public._sudoku_apply(s.solution, p_attempt.xform)
            from public.arena_sudoku_stage_secrets s where s.stage = p_attempt.stage)
    else (select x.solution from public.arena_sudoku_special_secrets x where x.special_id = p_attempt.special_id)
  end;
$$;

-- Streak facts + badges for one player (0s when they have never cleared).
create or replace function public._sudoku_streak_info(p_user uuid)
returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'streak_days', coalesce(s.streak_days, 0),
    'best_streak', coalesce(s.best_streak, 0),
    'last_clear_day', s.last_clear_day,
    'badges', to_jsonb(array(select t from unnest(array[3, 7, 14, 30, 100]) t
                              where t <= coalesce(s.best_streak, 0) order by t)),
    'next_badge', (select min(t) from unnest(array[3, 7, 14, 30, 100]) t where t > coalesce(s.streak_days, 0)))
  from (select 1) one
  left join public.arena_sudoku_streaks s on s.user_id = p_user;
$$;

-- What the client is allowed to know about an attempt. Never the solution,
-- never the symmetry key. (122's keys, plus mode / special / colours / tokens.)
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
    'server_now',   now()
  );
end;
$$;

-- Open the (only) attempt on a daily / sprint puzzle: canonical grid, no key.
create or replace function public._sudoku_special_new_attempt(p_user uuid, p_special int)
returns public.arena_sudoku_attempts
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_kind   text;
  v_puzzle text;
  v_row    public.arena_sudoku_attempts;
begin
  select sp.kind, se.puzzle into v_kind, v_puzzle
    from public.arena_sudoku_specials sp
    join public.arena_sudoku_special_secrets se on se.special_id = sp.id
   where sp.id = p_special;
  if v_puzzle is null then raise exception 'That puzzle is not ready yet'; end if;
  insert into public.arena_sudoku_attempts (user_id, stage, mode, special_id, attempt_no, kind, xform, puzzle, grid, notes)
  values (p_user, null, v_kind, p_special, 1, 'first', null, v_puzzle, v_puzzle, '[]'::jsonb)
  returning * into v_row;
  return v_row;
end;
$$;

-- A correct daily / sprint submit (validation already done by sudoku_submit):
-- the clear, the rank on that puzzle, the streak, and the sprint week so far.
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
    (attempt_id, special_id, kind, day, slot, user_id, name, final_ms, elapsed_ms, penalty_ms, mistakes, hints, finished_at)
  values
    (p_attempt.id, v_sp.id, v_sp.kind, v_sp.day, v_sp.slot, p_player.user_id, p_player.name,
     v_final, p_elapsed, p_pen, p_attempt.mistakes, p_attempt.hints, now());
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
-- Game RPCs, generalised by the attempt's mode
-- ─────────────────────────────────────────────────────────────────────────────

-- Restart stays a LADDER thing: a daily / sprint puzzle keeps one attempt and
-- one clock (a fresh clock would let a player study the grid, then reset).
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
     set status = 'restarted', ended_at = now()
   where id = v_a.id;
  update public.arena_sudoku_players
     set total_restarts = total_restarts + 1, updated_at = now()
   where user_id = v_p.user_id;
  v_a := public._sudoku_new_attempt(v_p.user_id, v_a.stage);
  return jsonb_build_object('ok', true, 'state', public._sudoku_payload(v_a));
end;
$$;

-- Autosave the board (grid + notes + highlighter colours) for resume anywhere.
drop function if exists public.sudoku_save(bigint, text, jsonb);
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
  return jsonb_build_object('ok', true, 'elapsed_ms', public._sudoku_elapsed(v_a),
    'penalty_ms', public._sudoku_attempt_penalty(v_a), 'server_now', now());
end;
$$;

-- Auto-check one placement (unchanged rules; + the closed-puzzle refusal).
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
    'mistakes', v_a.mistakes, 'penalty_ms', public._sudoku_attempt_penalty(v_a),
    'elapsed_ms', public._sudoku_elapsed(v_a), 'server_now', now());
end;
$$;

-- Reveal one cell (+60 s, max 3 per attempt). p_token = spend a hint token so
-- this hint is penalty-free — ladder attempts only, and only while the player
-- has one (never negative: the row is locked and a check constraint holds).
-- Default false, so a call without it behaves exactly as in 122.
drop function if exists public.sudoku_hint(bigint, int);
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
  return jsonb_build_object('ok', true, 'cell', p_cell, 'digit', v_digit::int,
    'hints', v_a.hints, 'hints_left', greatest(0, 3 - v_a.hints),
    'token_used', v_free, 'hint_tokens', v_left, 'token_hints', v_a.token_hints,
    'penalty_ms', public._sudoku_attempt_penalty(v_a),
    'elapsed_ms', public._sudoku_elapsed(v_a), 'server_now', now());
end;
$$;

-- Submit a full grid. Validation is shared; a daily / sprint clear goes to
-- _sudoku_finish_special, a ladder clear runs 122's settlement (progression,
-- penalty box, crown, medal) plus the hint-token reward and the streak.
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

  -- ── the ladder (122's settlement, unchanged, + tokens + streak) ──
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
    (attempt_id, user_id, name, stage, kind, first_clear, final_ms, elapsed_ms, penalty_ms, mistakes, hints, token_hints, finished_at, unlocked_at)
  values
    (v_a.id, v_p.user_id, v_p.name, v_a.stage, v_a.kind, v_first, v_final, v_elapsed, v_pen, v_a.mistakes, v_a.hints, v_a.token_hints, now(),
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
-- Ladder read RPCs — 122's outputs, keys only ADDED
-- ─────────────────────────────────────────────────────────────────────────────

-- The stage map's call. Streak now = any clear, Melbourne days (the view);
-- active attempts stay LADDER attempts (the map is the ladder).
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
                                                            'started_at', a.started_at) order by a.stage), '[]'::jsonb)
                 from public.arena_sudoku_attempts a
                where a.user_id = v_uid and a.status = 'active' and a.mode = 'ladder'),
    'server_now', now()
  );
end;
$$;

-- The overall ranking (122) + each row's current streak.
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
           'me', r.user_id = v_p.user_id) order by r.rank), '[]'::jsonb)
    into v_top
    from (select * from public.arena_sudoku_ranking order by rank
          limit greatest(1, least(coalesce(p_limit, 50), 200))) r
    left join public.arena_sudoku_streaks s on s.user_id = r.user_id;
  select jsonb_build_object('rank', r.rank, 'name', r.name, 'highest_stage', r.highest_stage,
                            'reached_at', r.reached_at, 'total_ms', r.total_ms, 'stages_cleared', r.stages_cleared,
                            'streak', coalesce(s.streak_days, 0))
    into v_me
    from public.arena_sudoku_ranking r
    left join public.arena_sudoku_streaks s on s.user_id = r.user_id
   where r.user_id = v_p.user_id;
  select count(*) into v_n from public.arena_sudoku_ranking;
  return jsonb_build_object('top', v_top, 'me', v_me, 'players', v_n);
end;
$$;

-- Personal stats (122) + streak badges, hint tokens, daily and sprint.
create or replace function public.sudoku_stats()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p   public.arena_sudoku_players;
  v_si  jsonb;
  v_out jsonb;
begin
  v_p := public._sudoku_player(0);
  v_si := public._sudoku_streak_info(v_p.user_id);
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
    'streak_days', (v_si ->> 'streak_days')::int,
    'best_streak', (v_si ->> 'best_streak')::int,
    'streak_badges', v_si -> 'badges',
    'next_badge', (v_si ->> 'next_badge')::int,
    'first_clear_at', (select min(finished_at) from public.arena_sudoku_clears where user_id = v_p.user_id),
    'last_clear_at',  (select max(finished_at) from public.arena_sudoku_clears where user_id = v_p.user_id),
    'rank', (select r.rank from public.arena_sudoku_ranking r where r.user_id = v_p.user_id),
    'hint_tokens', v_p.hint_tokens,
    'tokens_earned', v_p.tokens_earned,
    'tokens_spent', v_p.tokens_spent,
    'daily_played',  (select count(*) from public.arena_sudoku_attempts where user_id = v_p.user_id and mode = 'daily'),
    'daily_cleared', (select count(*) from public.arena_sudoku_special_clears where user_id = v_p.user_id and kind = 'daily'),
    'daily_gold',   (select count(*) from public.arena_sudoku_special_ranks where user_id = v_p.user_id and kind = 'daily' and pz_rank = 1),
    'daily_silver', (select count(*) from public.arena_sudoku_special_ranks where user_id = v_p.user_id and kind = 'daily' and pz_rank = 2),
    'daily_bronze', (select count(*) from public.arena_sudoku_special_ranks where user_id = v_p.user_id and kind = 'daily' and pz_rank = 3),
    'daily_best_ms', (select min(final_ms) from public.arena_sudoku_special_clears where user_id = v_p.user_id and kind = 'daily'),
    'sprint_weeks', (select count(*) from public.arena_sudoku_sprint_totals where user_id = v_p.user_id and done >= 5),
    'sprint_best_rank', (select min(week_rank) from public.arena_sudoku_sprint_totals where user_id = v_p.user_id),
    'sprint_wins', (select count(*) from public.arena_sudoku_sprint_winners where user_id = v_p.user_id)
  ) into v_out;
  return v_out;
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Daily challenge RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- Open (or resume) the daily puzzle of p_day (default: Melbourne today). The
-- clock starts HERE and never stops. Only today's puzzle can be played; a
-- player gets one attempt and one clear per day.
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
    return jsonb_build_object('ok', true, 'resumed', true, 'state', public._sudoku_payload(v_a));
  end if;
  v_a := public._sudoku_special_new_attempt(v_p.user_id, v_sp.id);
  return jsonb_build_object('ok', true, 'resumed', false, 'state', public._sudoku_payload(v_a));
end;
$$;

-- Everything the home card and the Daily tab need: today, tomorrow's teaser,
-- my status, the leader, the last 30 days and my streak.
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

-- One day's board: top 10 (medals = ranks 1..3), my row, and — only once the
-- day has CLOSED — its givens and my own final grid for the read-only view.
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
           'streak', coalesce(s.streak_days, 0), 'me', r.user_id = v_p.user_id)
           order by r.pz_rank, r.finished_at), '[]'::jsonb)
    into v_top
    from (select * from public.arena_sudoku_special_ranks where special_id = v_sp.id
          order by pz_rank, finished_at limit 10) r
    left join public.arena_sudoku_streaks s on s.user_id = r.user_id;
  select jsonb_build_object('rank', r.pz_rank, 'final_ms', r.final_ms, 'finished_at', r.finished_at,
                            'mistakes', r.mistakes, 'hints', r.hints)
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


-- ─────────────────────────────────────────────────────────────────────────────
-- Weekly sprint RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- Open (or resume) sprint puzzle p_slot (1 Basic … 5 Master) of the week that
-- holds p_week (default: this Melbourne week). Any order; one attempt each;
-- every puzzle's clock runs from the moment it is opened.
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
    return jsonb_build_object('ok', true, 'resumed', true, 'state', public._sudoku_payload(v_a));
  end if;
  v_a := public._sudoku_special_new_attempt(v_p.user_id, v_sp.id);
  return jsonb_build_object('ok', true, 'resumed', false, 'state', public._sudoku_payload(v_a));
end;
$$;

-- A sprint week: its five puzzles with my status and each puzzle's fastest,
-- the weekly total board (top 10, only players with all five are ranked),
-- my row, and the winners of the last eight ended weeks.
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
                   'rank', (select r.pz_rank from public.arena_sudoku_special_ranks r where r.special_id = sp.id and r.user_id = v_p.user_id)) end,
           'players', (select count(*) from public.arena_sudoku_special_clears c where c.special_id = sp.id),
           'top', (select coalesce(jsonb_agg(jsonb_build_object('rank', r.pz_rank, 'name', r.name, 'final_ms', r.final_ms,
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
           'me', t.user_id = v_p.user_id) order by t.week_rank), '[]'::jsonb)
    into v_top
    from (select * from public.arena_sudoku_sprint_totals where week = v_week and week_rank is not null
          order by week_rank limit 10) t
    left join public.arena_sudoku_streaks s on s.user_id = t.user_id;
  select jsonb_build_object('rank', t.week_rank, 'total_ms', t.total_ms, 'done', t.done, 'completed_at', t.completed_at)
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
-- Function privileges (the 112 / 115 / 122 posture)
-- ─────────────────────────────────────────────────────────────────────────────
-- internal helpers: nobody but the owner
revoke all on function public._sudoku_attempt_penalty(public.arena_sudoku_attempts)          from public, anon, authenticated;
revoke all on function public._sudoku_live(public.arena_sudoku_attempts)                     from public, anon, authenticated;
revoke all on function public._sudoku_solution(public.arena_sudoku_attempts)                 from public, anon, authenticated;
revoke all on function public._sudoku_streak_info(uuid)                                      from public, anon, authenticated;
revoke all on function public._sudoku_payload(public.arena_sudoku_attempts)                  from public, anon, authenticated;
revoke all on function public._sudoku_special_new_attempt(uuid, int)                         from public, anon, authenticated;
revoke all on function public._sudoku_finish_special(public.arena_sudoku_players, public.arena_sudoku_attempts, text, bigint, bigint)
                                                                                             from public, anon, authenticated;

-- user-facing RPCs: signed-in staff (and the service role), never anon
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
revoke all     on function public.sudoku_ranking(int)                       from public;
revoke execute on function public.sudoku_ranking(int)                       from anon;
grant  execute on function public.sudoku_ranking(int)                       to authenticated, service_role;
revoke all     on function public.sudoku_stats()                            from public;
revoke execute on function public.sudoku_stats()                            from anon;
grant  execute on function public.sudoku_stats()                            to authenticated, service_role;
revoke all     on function public.sudoku_daily_start(date)                  from public;
revoke execute on function public.sudoku_daily_start(date)                  from anon;
grant  execute on function public.sudoku_daily_start(date)                  to authenticated, service_role;
revoke all     on function public.sudoku_daily_overview()                   from public;
revoke execute on function public.sudoku_daily_overview()                   from anon;
grant  execute on function public.sudoku_daily_overview()                   to authenticated, service_role;
revoke all     on function public.sudoku_daily_board(date)                  from public;
revoke execute on function public.sudoku_daily_board(date)                  from anon;
grant  execute on function public.sudoku_daily_board(date)                  to authenticated, service_role;
revoke all     on function public.sudoku_sprint_start(int, date)            from public;
revoke execute on function public.sudoku_sprint_start(int, date)            from anon;
grant  execute on function public.sudoku_sprint_start(int, date)            to authenticated, service_role;
revoke all     on function public.sudoku_sprint_overview(date)              from public;
revoke execute on function public.sudoku_sprint_overview(date)              from anon;
grant  execute on function public.sudoku_sprint_overview(date)              to authenticated, service_role;

-- PostgREST: pick up the new / re-signed functions straight away
notify pgrst, 'reload schema';
