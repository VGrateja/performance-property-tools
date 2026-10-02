# Arena Sudoku — feature inventory for the pp-os port

This file describes everything the hub's Sudoku game does, so the pp-os port can rebuild it feature for feature. It describes the
build of 2026-09-28 (hub repo, migration 122). Sudoku is a stage race on a shared puzzle: 300 graded stages plus a stage-0 tutorial.
Everyone plays the same grid per stage. There is a per-stage top 5, an overall ranking by the highest stage cleared (ties go to
whoever got there first), and first-clear crowns, medals, ghost splits and X-Sudoku boss stages. The server is authoritative for the
clock, the solution and every judgement.

**Since 2026-09-30 (migration 124) it also has the twists** — a daily challenge, a colour highlighter, streak badges, hint tokens and a
weekly sprint — all described in **§10**. Where they change an earlier section, that section says so and points there.

**Since 2026-10-02 (migration 125) the clock stops only while the board is hidden** — the blind pause: a Pause button and key, an
automatic pause on leaving (tab hidden, page closed, the game's own exit) and on connection or power loss (a heartbeat), no penalty, times
still rank. The full rule set is **§4.3**; it replaces the 2026-09-29 rule "the clock never stops", and every section below describes the
125 build (history notes say what changed). There is no "no pause" instruction left for the port: build the pause as §4.3 says.

Source of truth in the hub repo:

| What | Path |
|---|---|
| Game page (all client code, one file) | `tools/arena-sudoku.html` |
| Migration (tables, views, RPCs, grants, group wiring) | `supabase/migrations/122_arena_sudoku.sql` |
| Migration: the twists (daily, sprint, streaks, tokens, colours — §10) | `supabase/migrations/124_arena_sudoku_twists.sql` |
| Migration: the blind pause (pause / resume / heartbeat, the reconcile rule — §4.3) | `supabase/migrations/125_arena_sudoku_pause.sql` |
| Generator + technique-grading solver + CLI (ladder, `--daily`, `--sprint`) | `scripts/generate-sudoku-stages.mjs` |
| Unit tests (`node --test`) | `scripts/generate-sudoku-stages.test.mjs` |
| Wiring | `shared/tool-registry.js`, `tools/arena.html`, `index.html` (the twists added no entry point outside the page) |
| Private, gitignored (never commit) | `scratch/sudoku-stages.json` (all solutions), `scratch/sudoku-specials.json` (every daily + sprint solution), `scratch/sudoku-master-seed.txt` (master seed), `scratch/_sudoku-*.mjs` (QA) |

---

## 1. Purpose and entry points

**Purpose.** This is Van's brief: "stage 1 to 100 or more; the ranking goes to who reaches the highest stage, and if two or more
are on the same stage, to who reached it first; light/dark; a typical sudoku; stage 0 tutorial; stage 1 basic, getting harder
and harder; everyone faces the exact same pattern per stage; per stage a top 5 of the fastest; add twists; take the best features of other
online sudoku games."

**Routes.**
- `tools/arena-sudoku.html`: the only page. It holds a home view (stage map, ranking, stats) and a game view, switched in-page.
- `?stage=N` preselects stage N on the map. `N=0` is the tutorial tile. An unknown N falls back to the default selection.
- `?tab=ranking` or `?tab=stats` opens that tab. Switching tabs rewrites the URL with `history.replaceState`: `?tab=ranking`,
  `?tab=stats`, or no query for Stages.
- Default selection on load: the tutorial if it isn't done, otherwise stage `min(highest_stage + 1, stage_count)`, scrolled into view.

**Registry key.** In `shared/tool-registry.js`, `TOOLS['arena-sudoku'] = { sec: 'arena', file: 'arena-sudoku.html', label:
'Sudoku' }`, and `'arena-sudoku'` is appended to `DEFAULT_BASELINE`. `DEFAULT_BASELINE` is the pre-migration fallback and must match
the `company_baseline` DB group.

**Group.** Migration 122 runs
`update hub_groups set tools = tools || '["arena-sudoku"]' where key = 'company_baseline' and not (tools ? 'arena-sudoku')`. That gives
every staff member access. Assigned admins inherit it through the baseline union. No other group row was touched.

**Access gates (four layers).**
1. `shared/auth-gate.js` redirects to the hub login when there is no Supabase session.
2. The group deep-link gate in `auth-gate.js` uses the registry key and bounces the user if `arena-sudoku` isn't in their allowed set.
3. An inline tier gate at the top of the page body allows `['dev','admin','leads','company']` and sends anyone else to `../`. It
   retries every 100 ms, up to 20 times, while `auth.js` hydrates. This list matches every other Arena page.
4. Server side, every RPC calls `_sudoku_player()`, which refuses any tier outside that list (§3).

**Arena landing card** (`tools/arena.html`).
- It is a card on the **main grid**, fourth of five: Typing Test, Chess, Scrabble, **Sudoku**, More games. Skribbl stays behind "More
  games" (Van's earlier decision).
- The grid column minimum dropped from 230 px to 210 px so the five cards fit one row at 1440 px.
- Card content:
  - icon: an outlined 3×3 grid SVG
  - badge: "New"
  - title: "Sudoku"
  - CTA: "Play ›"
  - `onclick`: `arena-sudoku.html`
- **Card stat** `#hub-tool-stat-sudoku` reads the view `arena_sudoku_ranking`
  (`select name, highest_stage, reached_at order by rank limit 500`). It shows "Top: **stage N** · M players", or "300 stages · first to
  climb" when there are no rows, or "300-stage ladder" on error.
- **Top of the leaderboards** gets a new row `.arena-top-rank-item.is-sudoku` with `#atr-sudoku` showing "**name** · stage N", or
  "Ladder open · first to climb". It has no background photo; the other games use `leaderboard-*.jpg` and no Sudoku image exists.
- **Highlights** feed. Two queries were added to `loadArenaHighlights()`:
  - `arena_sudoku_crowns` (last 10 by `cleared_at`) produces "**name** took the crown on Sudoku stage N" with icon key `👑`.
  - `arena_sudoku_clears` where `first_clear` and the stage is a multiple of 25 (≤ 1000), last 10, produces "**name** beat the
    Sudoku boss on stage N" with icon key `🔢`.

  Both use priority 1 (next to chess upsets) and the same 7-day freshness rule as the typing items. `AR_EMG` got two outlined glyphs:
  `👑` = crown path, `🔢` = 3×3 grid.
- The subtitle now reads "Typing, chess, scrabble and the new Sudoku ladder are live, and Skribbl — draw & guess — is under More games."

**Hub** (`index.html`), following the Skribbl pattern.
- Search palette entry:
  `{ key:'arena-sudoku', label:'Sudoku', kw:'arena game sudoku puzzle numbers logic stages ladder crown', icon:'🔢', run: navigateToTool('tools/arena-sudoku.html','Sudoku') }`.
- Arena window card:
  `{ key:'arena-sudoku', n:'Sudoku', icon:<3×3 grid svg>, t:'New', d:'A 300-stage ladder — everyone plays the same grid, top 5 per stage, crowns for first clears.' }`.
  It has no `statId`.

**Telemetry.** `shared/pp-telemetry.js` loads after `auth-gate.js`. The tool key is derived from the filename, so it is
`arena-sudoku`. No context params are whitelisted.

**Page chrome.** `PP_OS.initChrome({ name:'Sudoku', section:'arena', backHref:'../', actions:[{ id:'abArena', label:'Arena', title:'Back
to Arena', onClick: → 'arena.html' }] })`. The page also includes `<div class="wall scrim">`.

Script order in the page:
- In `<head>`: Montserrat (Google Fonts), `common.css`, `os-chrome.js`, `os-theme.css`, `fit-screen.js`.
- In the body: supabase-js 2.112.3 (jsdelivr, SRI), `supabase-client.js`, `tool-registry.js`, `error-reporter.js`, `auth.js`,
  `auth-gate.js`, `pp-telemetry.js`.

---

## 2. Data model

All objects live in `public` and all are created by migration 122. The migration is additive and re-runnable:
`create … if not exists`, `create or replace`, `drop policy if exists`.

### 2.1 `arena_sudoku_stages`: public stage catalogue (no puzzle, no solution)
| Column | Type | Default | Constraint |
|---|---|---|---|
| stage | int | — | **PK**, `check (stage between 1 and 9999)` |
| variant | text | `'classic'` | not null, `check (variant in ('classic','x'))` (x = X-Sudoku boss) |
| tier | text | — | not null (Basic / Medium / Hard / Expert / Master / Extreme) |
| tier_rank | int | — | not null, `check (tier_rank between 1 and 9)` (1..6 used) |
| techniques | text[] | `'{}'` | not null. Display labels of every technique the grader used, easiest first |
| hardest | text | — | not null. Key of the hardest technique (§5) |
| hardest_rank | int | — | not null (1..15) |
| clue_count | int | — | not null, `check (clue_count between 17 and 80)` |
| par_ms | int | — | not null, `check (par_ms > 0)` |
| difficulty | numeric | `0` | not null. Generator score |
| created_at | timestamptz | `now()` | not null |

### 2.2 `arena_sudoku_stage_secrets`: the secret half of each stage
| Column | Type | Default | Constraint |
|---|---|---|---|
| stage | int | — | **PK**, FK → `arena_sudoku_stages(stage)` on delete cascade |
| puzzle | text | — | not null, `check (puzzle ~ '^[0-9]{81}$')` (0 = blank, row-major) |
| solution | text | — | not null, `check (solution ~ '^[1-9]{81}$')` |
| seed | text | — | not null. The stage's derived generator seed (24 hex chars) |
| gen | jsonb | `'{}'` | not null. `{v, variant, target, lo, hi, tol, fan}`: the generator settings that reproduce the stage |

### 2.3 `arena_sudoku_players`: one row per player
The row is created on first RPC use by `_sudoku_player`.

| Column | Type | Default | Constraint / meaning |
|---|---|---|---|
| user_id | uuid | — | **PK**, FK → `profiles(id)` on delete cascade |
| name | text | — | not null. Display name = local part of `profiles.email`, set once at creation |
| tutorial_done_at | timestamptz | null | Set once by `sudoku_complete_tutorial` |
| highest_stage | int | `0` | not null. Highest stage **cleared** in order (first clears only) |
| reached_at | timestamptz | null | When that clear opened the next stage (clear time + penalties) |
| next_unlock_at | timestamptz | null | Penalty box: stage `highest_stage + 1` can't start before this |
| stages_cleared | int | `0` | not null. Distinct stages cleared |
| clears | int | `0` | not null. All clears, replays included |
| total_mistakes | int | `0` | not null. Summed on each clear |
| total_hints | int | `0` | not null. Summed on each clear |
| total_restarts | int | `0` | not null |
| streak_days | int | `0` | not null. **Legacy since 124**: still written, no longer read (§10.4) |
| best_streak | int | `0` | not null. Legacy since 124 |
| last_clear_day | date | null | AEST day of the last clear (`Australia/Brisbane`). Legacy since 124 |
| hint_tokens | int | `0` | not null, `check (hint_tokens between 0 and 5)`. Mig 124 (§10.5) |
| tokens_earned | int | `0` | not null. Mig 124 |
| tokens_spent | int | `0` | not null. Mig 124 |
| rl_tokens | real | `60` | not null. Rate-limit token bucket |
| rl_at | timestamptz | `now()` | not null. Last bucket update |
| created_at | timestamptz | `now()` | not null |
| updated_at | timestamptz | `now()` | not null |

### 2.4 `arena_sudoku_attempts`: one row per attempt
Reachable through RPCs only.

| Column | Type | Default | Constraint / meaning |
|---|---|---|---|
| id | bigint | identity (`generated always`) | **PK** |
| user_id | uuid | — | not null, FK → `profiles(id)` on delete cascade |
| stage | int | — | not null, FK → `arena_sudoku_stages(stage)` on delete cascade |
| attempt_no | int | — | not null. 1, 2, 3… per user×stage |
| kind | text | — | not null, `check in ('first','retry','replay')` |
| xform | jsonb | null | The symmetry key. **null = canonical grid** (attempt 1 only). **Never returned to clients** |
| puzzle | text | — | not null, `^[0-9]{81}$`. The givens as presented (shuffled when `xform` is set) |
| grid | text | — | not null, `^[0-9]{81}$`. Current entries, givens included |
| notes | jsonb | `'[]'` | not null. An array of 81 ints (bit d−1 = candidate d, 0..511). `[]` until the first save |
| status | text | `'active'` | not null, `check in ('active','cleared','restarted','abandoned')` (`abandoned` is defined but unused) |
| started_at | timestamptz | `now()` | not null. The server clock start (the moment Play is pressed). From here the clock runs whenever the board is showing (§4.3) |
| mistakes | int | `0` | not null |
| hints | int | `0` | not null |
| wrong_pairs | int[] | `'{}'` | not null. `cell*10 + digit` for each wrong pair already charged |
| hinted_cells | int[] | `'{}'` | not null. Cells revealed by hints (locked) |
| saves | int | `0` | not null |
| last_save_at | timestamptz | null | |
| finished_at | timestamptz | null | Set on a successful submit |
| ended_at | timestamptz | null | Set on restart |
| elapsed_ms | bigint | null | Set on clear: finished − started − paused_ms (the running time; pauses excluded, §4.3) |
| penalty_ms | bigint | null | Set on clear |
| final_ms | bigint | null | Set on clear: elapsed + penalty (the ranked time) |
| created_at | timestamptz | `now()` | not null |
| paused_at | timestamptz | null | Mig 125. When the current pause began; **null = the clock is running**. Set by `sudoku_pause` (`now()`) or by the reconcile rule (`:= last_seen_at`) |
| paused_ms | bigint | `0` | Mig 125. not null. Time banked by **closed** pauses, each floored to the ms (an open pause is not in it yet) |
| pauses | int | `0` | Mig 125. not null. Completed pauses (counted when the pause closes: Resume, or Restart of a paused attempt) |
| last_seen_at | timestamptz | null | Mig 125. The last heartbeat (or board activity / resume) while the clock ran. **null = never heartbeated** (a page from before 125): the reconcile rule does not apply to such an attempt |

Check `arena_sudoku_attempts_pause_check`: `paused_ms >= 0 and pauses >= 0` (mig 125, guarded `do` block).

**Pause history.** The first build (2026-09-28) had `paused_at`, `paused_ms` and `pauses`, a client-side pause and a "pause the other
attempts" rule; on 2026-09-29 Van removed them (the clock never stopped) and migration 122 drops those three columns with `alter table …
drop column if exists`. **Migration 125 adds them back under the same names** (plus `last_seen_at`) for the blind pause of §4.3 — so the
run order is 122 → 124 → 125, and **re-running 122 after 125 drops the pause columns again** (and `sudoku_resume(bigint)`) and restores 122's
function bodies; re-run 124 and then 125 to converge (the attempts' pause history would be gone; the clear rows keep their own copy). A port
should simply create the four columns.

Indexes:
- `arena_sudoku_attempts_one_active`: **unique** on `(user_id, stage) where status = 'active'`, so there is one active attempt per
  player per stage.
- `arena_sudoku_attempts_user_stage_idx` on `(user_id, stage, id desc)`.
- `arena_sudoku_attempts_stage_idx` on `(stage)`, the FK index.

**Mig 124** made this table serve the daily and the sprint too: `mode` (`'ladder'` default), `special_id`, `colors`, `token_hints`, and
`stage` became nullable (null for a daily / sprint attempt), with two new checks and a unique index — see §10.1.

### 2.5 `arena_sudoku_clears`: every successful clear (public leaderboard facts)
| Column | Type | Default | Constraint / meaning |
|---|---|---|---|
| id | bigint | identity | **PK** |
| attempt_id | bigint | — | not null, **unique**, FK → `arena_sudoku_attempts(id)` on delete cascade |
| user_id | uuid | — | not null, FK → `profiles(id)` on delete cascade |
| name | text | — | not null. Copied from `players.name` at insert |
| stage | int | — | not null, FK → stages on delete cascade |
| kind | text | — | not null, `check in ('first','retry','replay')` (the attempt's kind) |
| first_clear | boolean | — | not null. This player's first clear of this stage |
| final_ms | bigint | — | not null, `>= 0` |
| elapsed_ms | bigint | — | not null, `>= 0` |
| penalty_ms | bigint | `0` | not null |
| mistakes | int | `0` | not null |
| hints | int | `0` | not null |
| finished_at | timestamptz | `now()` | not null |
| unlocked_at | timestamptz | null | First clears only: `finished_at + penalty`, when the next stage opened |
| token_hints | int | `0` | not null. Mig 124: how many of the clear's hints a token paid for (§10.5) |
| pauses | int | `0` | not null. Mig 125: the attempt's completed pauses, copied at the clear (the ⏸ marker, §4.3) |
| paused_ms | bigint | `0` | not null. Mig 125: the attempt's banked pause time, copied at the clear. Times are **not** adjusted by it — `elapsed_ms` already excludes it |

Indexes: `(stage, final_ms, finished_at)` and `(user_id, stage)`.

### 2.6 `arena_sudoku_crowns`: first-clear crowns, written once, never moved
| Column | Type | Default | Constraint |
|---|---|---|---|
| stage | int | — | **PK**, FK → stages on delete cascade |
| user_id | uuid | null | FK → `profiles(id)` on delete **set null** (the crown survives account deletion by name) |
| name | text | — | not null |
| final_ms | bigint | — | not null |
| cleared_at | timestamptz | — | not null |

Index: `(user_id)`. Rows are inserted by `sudoku_submit` with `on conflict (stage) do nothing`.

### 2.7 Views
All three views use `with (security_invoker = on)` and read only the public `clears` table, under the caller's own RLS.

- **`arena_sudoku_best`**: `select distinct on (stage, user_id) stage, user_id, name, final_ms, elapsed_ms, penalty_ms, mistakes,
  hints, finished_at, kind, pauses, paused_ms from arena_sudoku_clears order by stage, user_id, final_ms, finished_at`. Each player's best
  clear per stage. (`pauses, paused_ms` appended by mig 125.)
- **`arena_sudoku_stage_ranks`**: the best columns, then
  `stage_rank = rank() over (partition by stage order by final_ms, finished_at)` and
  `stage_players = count(*) over (partition by stage)`, then (mig 125) `pauses, paused_ms`. A medal is `stage_rank` 1..3. Mig 125 lists
  every column explicitly: `create or replace view` may only append columns, so a `b.*` would have put the new ones before `stage_rank`.
- **`arena_sudoku_ranking`**: built from two CTEs.
  - `prog` = `distinct on (user_id)` over clears where `first_clear`, ordered by `user_id, stage desc, finished_at`. It gives
    `highest_stage = stage` and `reached_at = coalesce(unlocked_at, finished_at)`.
  - `tot` = `sum(final_ms)` and `count(*)` from `arena_sudoku_best` per user, giving `total_ms` and `stages_cleared`.

  Output: `rank = row_number() over (order by highest_stage desc, reached_at asc, user_id)`, then `user_id, name, highest_stage,
  reached_at, total_ms, stages_cleared`.

### 2.8 RLS policies
RLS is enabled on all six tables (and on the three tables migration 124 added — §10.1, §10.2).

| Table | Policy | Rule |
|---|---|---|
| stages | "authenticated read sudoku stages" | `for select to authenticated using (true)` |
| stage_secrets | "no client access to sudoku secrets" | `for select to authenticated using (false)` |
| players | "player reads own sudoku row" | `for select to authenticated using (user_id = (select auth.uid()))` |
| attempts | "no direct client access to sudoku attempts" | `for select to authenticated using (false)` |
| clears | "authenticated read sudoku clears" | `for select to authenticated using (true)` |
| crowns | "authenticated read sudoku crowns" | `for select to authenticated using (true)` |

No table has an insert, update or delete policy. Every write goes through SECURITY DEFINER RPCs running as the table owner.

### 2.9 Table and view grants
- `revoke all` on `arena_sudoku_stage_secrets` and `arena_sudoku_attempts` from `anon, authenticated`. A direct read is a
  **permission error (42501)**, not an empty result.
- `revoke all` on stages, players, clears and crowns from `anon`.
- `revoke insert, update, delete, truncate, references, trigger` on stages, players, clears and crowns from `authenticated`.
- The same two revokes apply to the three views: `revoke all from anon`, and the write privileges from `authenticated`.
- `service_role` keeps its default grants; the seeder uses it.

### 2.10 Privacy rules
These are load-bearing. Do not relax them in the port.
- The **solution**, the **puzzle** and the **generator seed** live only in `arena_sudoku_stage_secrets`. The puzzle is secret too:
  if clients could read stage n+1's grid before starting it, they could pre-solve it on paper with no clock running. The puzzle
  reaches a client **only through `sudoku_start`**, which starts the clock in the same call.
- The **symmetry key** (`attempts.xform`) never leaves the server. If a player had it, they could map a remembered canonical answer
  onto a shuffled replay. No RPC payload contains `solution` or `xform`. The E2E proved that no browser response ever contained
  a solution: 312 responses were scanned.
- The **master seed is private because the repo is public.** The committed generator is deterministic, so a committed seed would let
  anyone print every solution.
  - It lives in `SUDOKU_MASTER_SEED` (env or `.env`) or `scratch/sudoku-master-seed.txt` (gitignored).
  - Each stage's derived seed and settings are stored in `stage_secrets.seed` / `gen`, so any single stage can be regenerated
    (§5.9).
  - `scratch/sudoku-stages.json` contains every solution and must never be committed.

---

## 3. RPCs

Every function uses `set search_path = public, pg_temp`. EXECUTE is revoked from `PUBLIC` and `anon` on all of them. The 11
user-facing RPCs of 122 are `SECURITY DEFINER` and granted to `authenticated` and `service_role`. The 11 internal helpers are revoked from
`public, anon, authenticated`, so only the owner can run them. (Mig 124 added 5 RPCs and 7 helpers, mig 125 3 RPCs and 7 helpers, with the
same posture: 19 user-facing Sudoku RPCs in all.)

**The pause RPCs (mig 125).** `sudoku_pause`, `sudoku_resume` and `sudoku_heartbeat` — the blind pause of §4.3 — are documented in §3.3 and
§3.7. History: the first build (2026-09-28) had a `sudoku_pause(bigint)` / `sudoku_resume(bigint)` pair and a helper
`_sudoku_pause_others(uuid, bigint)` that paused every other attempt when one was opened; Van removed all three on 2026-09-29 and 122 still
carries `drop function if exists` for them. 125 brings back a **different** design: `sudoku_pause` takes the board along
(`(bigint, text, jsonb, jsonb)`; 125 drops the old one-argument signature first so the call is never ambiguous), there is a heartbeat, and
**nothing ever pauses another attempt** — `_sudoku_pause_others` stays gone. Calling a function that does not exist still returns PostgREST
`PGRST202` (HTTP 404).

**Every call on an attempt first reconciles** (mig 125): `_sudoku_attempt_for_update` — used by restart, save, check, hint, submit, pause,
resume and heartbeat — and the three *start* RPCs (which lock their own row) run `_sudoku_reconcile` right after locking the attempt, before
anything reads it. The rule is in §4.3.

Clients call the RPCs with `supabase.rpc(name, args)`, which maps to `POST /rest/v1/rpc/<name>` with the user's JWT. Expected game-flow
refusals return JSON `{ok:false, reason, …}`. Bad input and tampering raise exceptions.

### 3.1 Staff check and rate limiter: `_sudoku_player(p_cost real default 1) returns arena_sudoku_players`
Every RPC calls this first.
1. If `auth.uid()` is null, it raises **`Not signed in`** (errcode `28000`).
2. The caller's `profiles.tier` must be in `('dev','admin','leads','company')`. Otherwise it raises **`Sudoku is open to staff accounts
   only`** (`42501`).
3. It runs `insert into arena_sudoku_players (user_id, name) values (uid, split_part(email,'@',1)) on conflict do nothing`.
4. If `p_cost <= 0` (the read RPCs), it returns the row without locking it.
5. Otherwise it locks the row (`for update`). The **token bucket** is `tokens = least(60, rl_tokens + 6 × seconds since rl_at)`: 60
   burst, refilled at 6 per second. If `tokens < p_cost` it raises **`Slow down - too many moves in a short time`** (`P0001`, hint
   `rate_limited`). Otherwise it stores `rl_tokens = tokens − cost`, `rl_at = clock_timestamp()`.
   - Costs: `sudoku_save` 0.5. Overview, board, ranking and stats cost 0. Every other game RPC costs 1 — except (mig 125)
     `sudoku_heartbeat` and `sudoku_pause`, which cost **0** (no player-row lock, never refused: a refused pause would cost the player
     time), and `sudoku_resume`, which costs 1.
   - The E2E showed a burst of 90 concurrent checks had 27 refused.

### 3.2 Internal helpers
| Function | Kind | Behaviour |
|---|---|---|
| `_sudoku_band_perm() → int[]` | invoker, volatile | A random band-preserving permutation of 0..8: bands shuffled, rows within each band shuffled. 1-based array, position i+1 holds the value for index i |
| `_sudoku_xform_random(p_variant text) → jsonb` | invoker, volatile | Returns `{r:[9], c:[9], d:[0,…9 digits], t:0/1}` (§4.8) |
| `_sudoku_apply(p_grid text, p_x jsonb) → text` | invoker, immutable | Null `p_x` returns the grid unchanged. Otherwise `target(R,C) = d[S′(r[R], c[C])]`, where S′ is the transpose of S when `t=1` and d[0]=0 keeps blanks blank |
| `_sudoku_solution(p_attempt attempts) → text` | definer, stable (sql) | `_sudoku_apply(stage_secrets.solution, attempt.xform)`: the solution as this attempt sees it |
| `_sudoku_elapsed(p_attempt) → bigint` | invoker, stable | **Mig 125:** `greatest(0, floor(ms of (coalesce(finished_at, ended_at, _sudoku_pause_start(p), now()) − started_at)) − paused_ms)` — the running time: frozen at the pause start while paused, every closed pause subtracted. (122: pure wall clock, nothing subtracted.) Every caller — payload, save, check, hint, submit, the overviews — is pause-aware through it |
| `_sudoku_penalty(m int, h int) → bigint` | immutable | `m × 30000 + h × 60000` |
| `_sudoku_payload(p_attempt) → jsonb` | definer, stable | The client state object (§3.4) |
| `_sudoku_new_attempt(p_user uuid, p_stage int) → attempts` | definer | See `sudoku_start` below. It never touches any other attempt |
| `_sudoku_attempt_for_update(p_user uuid, p_attempt bigint) → attempts` | definer | Locks the caller's attempt. Anyone else's, or a missing one, raises **`Attempt not found`** (`P0002`). **Mig 125:** then returns `_sudoku_reconcile(row)` — the reconcile happens here, before any caller reads the row |
| `_sudoku_check_grid(p_attempt, p_grid text)` | invoker, stable | The grid must match `^[0-9]{81}$`, else **`A grid is 81 digits (0 = empty)`** (`22023`). Givens must be unchanged, else **`The given digits cannot change`** (`22023`). Hinted cells must equal the stored grid, else **`Hinted cells cannot change`** (`22023`) |
| `_sudoku_heartbeat_ms() → int` | immutable (sql) | Mig 125: `15000` — how often the page heartbeats while the board shows (returned in the payload, so the number is the server's) |
| `_sudoku_stale_after() → interval` | immutable (sql) | Mig 125: `45 seconds` — a heartbeating board silent for longer counts as paused from its last heartbeat (three missed beats) |
| `_sudoku_pause_start(p_attempt) → timestamptz` | invoker, stable (sql) | Mig 125: when the current pause began, or null while the clock runs: null if `status <> 'active'`; else `paused_at` if set; else `last_seen_at` if it is set and older than `_sudoku_stale_after()`; else null. The read-only half of the reconcile rule (overviews use it without writing) |
| `_sudoku_reconcile(p_attempt) → attempts` | definer | Mig 125: the reconcile rule, persisted. If the attempt is active, not paused, `last_seen_at` is set and `now() − last_seen_at > 45 s`: `paused_at := last_seen_at`. Returns the (updated) row. The caller holds the row lock |
| `_sudoku_touch(p_attempt bigint)` | definer (sql) | Mig 125: `last_seen_at = now()` on a running, active attempt **whose `last_seen_at` is already set** — board activity (save, check, hint, a wrong submit) counts as a heartbeat, but never switches the rule on for an old page's attempt |
| `_sudoku_paused_refusal() → jsonb` | immutable (sql) | Mig 125: `{ok:false, reason:'paused', message:'The game is paused - press Resume to show the board and run the clock again.'}` |
| `_sudoku_check_marks(p_notes jsonb, p_colors jsonb)` | immutable | Mig 125: `sudoku_save`'s notes / colours validation (same messages and `22023`), each argument optional — for the board a pause may carry |

### 3.3 User-facing RPCs
| Signature (returns jsonb) | Cost | Validates | Writes | Returns |
|---|---|---|---|---|
| `sudoku_complete_tutorial()` | 1 | staff check | `tutorial_done_at = coalesce(tutorial_done_at, now())`, `updated_at` | `{ok:true, tutorial_done:true}` |
| `sudoku_start(p_stage int)` | 1 | Stage exists, else raise **`Unknown stage`** (`22023`). Then: tutorial not done → `{ok:false, reason:'tutorial', message}`. `p_stage > highest_stage + 1` → `{ok:false, reason:'locked', message}`. An active attempt exists → lock it and return it; its clock has been running all along (`resumed:true`). `p_stage = highest_stage + 1` and `now() < next_unlock_at` → `{ok:false, reason:'penalty', unlock_at, message}` | `_sudoku_new_attempt`: the stage's secrets row must exist, else raise **`Stage % is not ready yet`**. `attempt_no = max + 1`. `kind = 'replay'` if the user has any clear of the stage, `'first'` if `attempt_no = 1`, else `'retry'`. `xform = null` for attempt 1, otherwise random for the variant. `puzzle = grid = _sudoku_apply(puzzle, xform)`, `notes = '[]'`. **Other attempts are left alone; their clocks keep running** | `{ok:true, resumed:bool, state}` |
| `sudoku_restart(p_attempt bigint)` | 1 | Own attempt (`P0002` otherwise). Must be `active`, else raise **`That attempt is already over`** (`P0001`) | Old attempt: `status = 'restarted'`, `ended_at = now()`. `players.total_restarts += 1`. Then a new attempt (retry or replay, **always shuffled**) whose clock starts at 0:00 | `{ok:true, state}` |
| `sudoku_save(p_attempt bigint, p_grid text, p_notes jsonb)` | 0.5 | Not active → `{ok:false, reason:'over'}`. `_sudoku_check_grid`. Notes must be a JSON array of length 81, else **`Notes are 81 numbers`**; every element an integer 0..511, else **`Notes are 81 numbers from 0 to 511`** (both `22023`) | `grid`, `notes`, `saves + 1`, `last_save_at` | `{ok:true, elapsed_ms, penalty_ms, server_now}` |
| `sudoku_check(p_attempt bigint, p_cell int, p_digit int)` | 1 | Not active → `{ok:false, reason:'over'}`. Cell 0..80 and digit 1..9, else **`A check is a cell 0-80 and a digit 1-9`** (`22023`). A given cell raises **`That cell is a given`** (`22023`) | If wrong **and** `cell*10+digit` isn't in `wrong_pairs`: `mistakes + 1` and the pair is appended. It does **not** write the digit into the grid | `{ok:true, correct, charged, mistakes, penalty_ms, elapsed_ms, server_now}`. Only right or wrong, never the answer |
| `sudoku_hint(p_attempt bigint, p_cell int)` | 1 | Not active → `{ok:false, reason:'over'}`. Cell 0..80, else **`A hint is for a cell 0-80`**. A given raises **`That cell is a given`** (`22023`). Already hinted → `{ok:false, reason:'hinted', message}`. `hints >= 3` → `{ok:false, reason:'no_hints', message}`. The *saved* grid already holds the right digit → `{ok:false, reason:'correct', message}` (no charge) | `hints + 1`, `hinted_cells ||= cell`, and the grid gets the digit (`overlay`) | `{ok:true, cell, digit, hints, hints_left, penalty_ms, elapsed_ms, server_now}` |
| `sudoku_submit(p_attempt bigint, p_grid text)` | 1 | Not active → raise **`That attempt is already over`** (`P0001`). `_sudoku_check_grid`. Any `0` left → `{ok:false, reason:'incomplete', empty}`. Grid ≠ the attempt's solution → `mistakes + 1`, `{ok:false, reason:'wrong', wrong:<count>, mistakes, penalty_ms}`: **only a count, never positions**. Human floor: `elapsed < 250 ms × (empties in the attempt's puzzle − hinted cells)` → `{ok:false, reason:'too_fast', message}` | See §3.5 | See §3.5 |
| `sudoku_overview()` | 0 | staff check | (creates the player row) | `{me:{name, tutorial_done, highest_stage, reached_at, next_unlock_at, stages_cleared, streak_days}, stage_count, mine:[{stage, best_ms, rank, players}], crowns:[{stage, name, mine}], players:{"<stage>": distinct clearers}, active:[{stage, attempt_id, kind, started_at}], server_now}`. `streak_days` is 0 if the last clear is older than yesterday (AEST) |
| `sudoku_stage_board(p_stage int)` | 0 | Stage exists, else **`Unknown stage`** (`22023`) | — | `{stage, top:[≤5 {rank, name, final_ms, finished_at, mistakes, hints, kind, me}], me:{rank, final_ms, finished_at, mistakes, hints} or null, crown:{name, final_ms, cleared_at, mine} or null, players}` |
| `sudoku_ranking(p_limit int default 50)` | 0 | Limit clamped to 1..200 | — | `{top:[{rank, name, highest_stage, reached_at, total_ms, stages_cleared, me}], me:{…} or null, players}` |
| `sudoku_stats()` | 0 | staff check | — | `{name, tutorial_done, highest_stage, reached_at, stages_cleared, clears, replays, gold, silver, bronze, crowns, par_stars, avg_ms, total_ms, total_mistakes, total_hints, total_restarts, streak_days, best_streak, first_clear_at, last_clear_at, rank}` |

**Migration 125 changes to this table** (the blind pause, §4.3 / §3.7): `sudoku_save`, `sudoku_check`, `sudoku_hint` and `sudoku_submit`
answer **`{ok:false, reason:'paused', message}`** while the attempt is paused — after their `over` and `closed` refusals, before anything
else (no charge, no write) — and their successful calls refresh `last_seen_at` (`_sudoku_touch`). `sudoku_start` (and the daily / sprint
starts) reconcile a re-opened attempt first and may return it **paused** (`state.paused = true`: the page shows the cover). Elapsed times
everywhere exclude pauses. `sudoku_restart` closes an open pause (banks it, counts it) before ending the attempt; the new attempt starts
running with every pause counter at 0 and `last_seen_at` null. `sudoku_overview().active[]` gained `elapsed_ms`, `paused` and `pauses`;
`sudoku_stage_board` rows and `me` gained `pauses`, `paused_ms`; `sudoku_ranking` rows and `me` gained `pauses`, `paused_ms` (sums over the
player's best clears, the ones that make up `total_ms`). Three RPCs are new: `sudoku_pause`, `sudoku_resume`, `sudoku_heartbeat` (§3.7).
No existing signature changed.

**Migration 124 changes to this table** (details in §10): `sudoku_save` gained `p_colors jsonb default null` (the highlighter) and
`sudoku_hint` gained `p_token boolean default false` (hint tokens) — the old signatures were dropped, and every older call still resolves.
`sudoku_save / check / hint / submit` also serve daily and sprint attempts and answer `{ok:false, reason:'closed'}` once such a puzzle has
closed; `sudoku_restart` refuses them. `sudoku_overview`, `sudoku_ranking` and `sudoku_stats` return extra keys (streaks, tokens, daily,
sprint), and `streak_days` there now comes from the streak view (Melbourne days, any clear). Five RPCs are new: `sudoku_daily_start`,
`sudoku_daily_overview`, `sudoku_daily_board`, `sudoku_sprint_start`, `sudoku_sprint_overview`.

### 3.4 The attempt state object (`_sudoku_payload`)
`{attempt_id, stage, attempt_no, kind, variant, shuffled (= xform is not null), puzzle, grid, notes, status, elapsed_ms, penalty_ms,
mistakes, hints, hints_left (= max(0, 3 − hints)), hinted_cells, wrong_cells, restarts, par_ms, server_now}` — plus mig 124's `mode`,
`colors`, `token_hints`, `hint_tokens`, `special` (§10.1) and **mig 125's pause fields**:
- `elapsed_ms` — the server's running time: `_sudoku_elapsed` (started_at → now, frozen while paused, every closed pause subtracted).
- `paused` — boolean: the clock is stopped right now (`_sudoku_pause_start` is not null). The page covers the board.
- `paused_at` — when the current pause began (null while running). For an outage this is the last heartbeat.
- `pauses` — completed pauses so far on this attempt (an open pause is counted when it closes).
- `paused_ms` — the time banked by those completed pauses.
- `heartbeat_ms` — `15000`: how often to heartbeat while the board shows. `stale_after_ms` — `45000`: the silence that counts as paused.

The board (puzzle, grid, notes, colours) is still returned while paused — the page hides it. [Considered: withholding it until Resume;
rejected — a cheater can resume, read and pause again in a second, so it buys nothing, and a page from before 125 would crash on a null grid.]
- `wrong_cells` lists the cells whose current grid digit is a charged wrong pair, so a resumed board shows the reds already paid for.
- `restarts` is the count of this user's `restarted` attempts on the stage.
- The object never includes the solution or the xform.

### 3.5 What a correct `sudoku_submit` does, in order
(Mig 125: before any of this, after the `over` / `closed` checks, a **paused** attempt is refused with `reason:'paused'`; the elapsed below
is the running time, pauses excluded; the 250 ms/cell floor is measured against it; the clear row gets the attempt's `pauses` and
`paused_ms`, and the answer carries both.)
1. Sets `elapsed = _sudoku_elapsed`, `pen = mistakes×30000 + hints×60000`, `final = elapsed + pen`.
2. Updates the attempt: `status='cleared'`, `grid`, `finished_at=now()`, `elapsed_ms`, `penalty_ms`, `final_ms`.
3. Sets `prev = min(final_ms)` of the player's earlier clears of the stage, `first_clear = (prev is null)`, and
   `unlock = now() + pen ms`.
4. Inserts into `arena_sudoku_clears`, with `unlocked_at = unlock` for first clears and null otherwise.
5. If `first_clear` and `stage = highest_stage + 1` (**progressed**): `highest_stage = stage`, `reached_at = unlock`,
   `next_unlock_at = unlock`.
6. Updates the player: `stages_cleared + (first_clear ? 1 : 0)`, `clears + 1`, `total_mistakes += mistakes`, `total_hints += hints`.
   Streak: a last clear today leaves it unchanged, a last clear yesterday adds 1, anything else resets it to 1. Then
   `best_streak = greatest(…)`, `last_clear_day = today` (AEST), `updated_at`.
7. Crown: `insert … on conflict (stage) do nothing`. `crown = FOUND`.
8. Reads `rank, players` from `arena_sudoku_stage_ranks`; `next_stage = min(stage) > this`.
9. Returns `{ok:true, stage, kind, final_ms, elapsed_ms, penalty_ms, mistakes, hints, rank, players, medal (1..3 or null), crown,
   first_clear, progressed, pb (= prev null or final < prev), prev_best_ms, best_ms, par_ms, par_beaten (= final ≤ par_ms),
   highest_stage, next_stage, next_unlock_at, server_now}`.

### 3.6 Error codes (summary)
| Code | Meaning |
|---|---|
| `28000` | Not signed in |
| `42501` | Not a staff tier. PostgREST also returns 42501 for anon RPC calls and for direct reads of the secret tables |
| `P0001` | Rate limited (hint `rate_limited`), attempt already over, or stage not ready |
| `P0002` | Attempt not found or not yours |
| `22023` | Invalid input: unknown stage, grid or notes shape, changed givens or hinted cells, cell or digit out of range, checking or hinting a given (also a board sent with `sudoku_pause` that fails those checks — the pause then does not happen) |
| `PGRST202` (HTTP 404) | PostgREST "Could not find the function" — any RPC that does not exist |

Game-flow refusals are JSON, not exceptions: `{ok:false, reason, message?}`. Reasons: `tutorial`, `locked`, `penalty` (start); `over` (the
attempt has ended — save / check / hint / pause / resume / heartbeat); `closed` (a daily / sprint past its window, §10.1); `hinted`,
`no_hints`, `correct` (hint); `incomplete`, `wrong`, `too_fast` (submit); `no_puzzle`, `not_yet`, `cleared` (daily / sprint starts); and
**`paused`** (mig 125) — *"The game is paused - press Resume to show the board and run the clock again."* — from `sudoku_save`,
`sudoku_check`, `sudoku_hint` and `sudoku_submit` while the attempt is paused (by the page or by the reconcile rule). Nothing is written
or charged on a `paused` refusal; the page covers the board and re-tries after Resume (a refused submit is re-sent automatically).
`over` / `closed` take precedence over `paused`.

### 3.7 The pause RPCs (mig 125)
All three are `SECURITY DEFINER`, `search_path` pinned, EXECUTE for `authenticated` + `service_role` only (anon → 42501), and work on the
caller's own attempt only (anyone else's → `P0002`). All three reconcile first (through `_sudoku_attempt_for_update`), then refuse an ended
attempt with `{ok:false, reason:'over'}` and a daily / sprint past its window with `{ok:false, reason:'closed', message}`. They serve
ladder, daily and sprint attempts alike (one attempts table).

| Signature (returns jsonb) | Cost | Behaviour | Returns |
|---|---|---|---|
| `sudoku_pause(p_attempt bigint, p_grid text default null, p_notes jsonb default null, p_colors jsonb default null)` | 0 | **If the clock is running:** when a board is sent it is validated exactly like `sudoku_save` (`_sudoku_check_grid` + `_sudoku_check_marks`; notes / colours may be null = keep) and saved (`grid`, `notes`, `colors`, `saves + 1`, `last_save_at`), then `paused_at = now()`. A board that fails validation raises `22023` and **nothing** happens (the pause does not land). **If already paused** (another tab, an earlier beacon, a reconciled outage): nothing changes and **the board is not saved** — no move lands while the clock is stopped. Idempotent; never rate-limited | `{ok:true, paused:true, paused_now (did this call start the pause), saved, paused_at, elapsed_ms (frozen), penalty_ms, pauses, paused_ms, server_now}` |
| `sudoku_resume(p_attempt bigint)` | 1 | **If paused:** `gap = floor(ms(now() − paused_at))` (floor, never round — a pause never hands back time), `paused_ms += gap`, `pauses + 1`, `paused_at = null`, `last_seen_at = now()`. **If running:** only `last_seen_at = now()` (a heartbeat). Resume of an outage pause banks the whole gap since the last heartbeat | `{ok:true, resumed (a pause was closed), paused_for_ms (gap, 0 if none), state:<the full payload §3.4>}` |
| `sudoku_heartbeat(p_attempt bigint)` | 0 | **If running:** `last_seen_at = now()` — the first heartbeat of an attempt switches the outage rule on for it. **If paused** (by this page, another tab or device, or the reconcile): nothing changes and the answer says so, so the page covers the board | `{ok:true, paused, paused_at, elapsed_ms, penalty_ms, pauses, paused_ms, heartbeat_ms, server_now}` — the page adopts `elapsed_ms` |

The page's unload beacon is a single keepalive `fetch` of `sudoku_pause` carrying the board: two separate requests (a save, then a pause)
could arrive pause-first, the save would be refused as `paused`, and the last move would be lost.

---

## 4. Game rules

### 4.1 Tutorial gate
Stage 1 and above need `players.tutorial_done_at`. Otherwise `sudoku_start` returns `reason:'tutorial'`. The tutorial is never ranked;
it is stored only as that timestamp.

### 4.2 Stage order
Stage n can start only if `n ≤ highest_stage + 1`. Cleared stages can be replayed at any time.

### 4.3 The clock: it stops only while the board is hidden
This is Van's decision of **2026-10-02** (migration 125), and it is load-bearing. It **replaces** the 2026-09-29 rule ("the clock never
stops once you've seen the grid"). A player asked for a pause; a pause can be a cheat (stop the clock, keep thinking), so the pause is
**blind** — **the clock stops only while the board is hidden** — and it is **automatic on leaving**: in Van's words, "exiting the tab or
exiting the game will pause it automatically, like if there's electric/internet interruption so it auto-pauses." **No penalty for pausing,
no untimed flag: times count for medals, crowns, par stars and every leaderboard exactly as before.** Van accepts the residual loophole —
photograph the board, then pause: "since this is a company setup, if they cheat there's a problem with the culture."

**The numbers are all the server's.**
- **Start.** `started_at` is the server `now()` at attempt creation, the moment Play is pressed (`sudoku_start` / `sudoku_daily_start` /
  `sudoku_sprint_start`). The puzzle arrives in the same response.
- **Elapsed** (every place the server computes time — check, hint, save, submit, the payload, the overviews, the clear rows):
  `(finished_at | ended_at | the pause start | now()) − started_at − paused_ms`, floored to the ms, minimum 0 (`_sudoku_elapsed`). While
  paused it is frozen at the pause start. It is **never taken from the client**.
- **Penalties unchanged:** +0:30 per charged wrong digit, +1:00 per paid hint, three hints per attempt; `final_ms = elapsed + penalties`.
  The 250 ms/cell floor (§4.10), the penalty box (§4.5) and every tamper rule (§4.11) are unchanged — the floor is now measured against
  the running time, so "pause, solve on paper, resume, type it in" still needs 250 ms of running clock per cell.

**1. Pause** — the Pause button beside the clock, or the key **P** (§7.3).
- The page hides the board **first, locally** (no network needed): the whole play area — timer row, ghost track, grid, notes, colours,
  candidates, the tools (Hint included), the digit and colour pads, the mini top 5 — is `visibility: hidden` (not drawn at all), input is
  refused, and the cover card sits over it (§7.2). The displayed clock freezes at once.
- Then `sudoku_pause(attempt, grid, notes, colors)`: the server saves the board it carries (if its clock was still running) and sets
  `paused_at = now()`. Idempotent: an already-paused attempt is left alone and **its board is not saved**.
- The cover shows the stage (or "Daily · <day>" / "Sprint · puzzle n" with the band chip), the elapsed time frozen (the race clock,
  elapsed + penalties, with "includes +m:ss of penalties" when there are any), **"Paused — the clock is stopped while the board is
  hidden"**, why it paused (left the page / left the game / connection lost / paused on another tab or device — blank for a manual pause),
  one **Resume** button, and "Press Resume (or P) to show the board and run the clock again. Pausing is free, and your time still ranks."
- **Nothing auto-resumes.** Returning to the tab, re-opening the stage, reloading the page or reconnecting all show the cover; only Resume
  (button or P) shows the board.

**2. Resume** — `sudoku_resume(attempt)`: `paused_ms += floor(now() − paused_at)`, `pauses + 1`, `paused_at = null`,
`last_seen_at = now()`; the page reveals the board, adopts the server's elapsed, restarts the heartbeat and saves any move made before
the pause that had not reached the server. If the server's board differs from a clean local one (another device moved meanwhile), the
page takes the server's.

**3. Auto-pause on leaving.** Each of these covers the board and pauses the server clock:
- `visibilitychange` → hidden (switching tabs or apps, minimising, locking a phone), `pagehide` (close, refresh, navigating away — the
  hub's back link and the app bar's Arena button included) and `beforeunload`: **one keepalive request** —
  `fetch('/rest/v1/rpc/sudoku_pause', {method:'POST', keepalive:true})` with the headers `apikey` and `Authorization: Bearer <cached access
  token>` (refreshed every 60 s; the pp-telemetry pattern; supabase-js alone may not complete on unload) — carrying the board, so the last
  move is saved and the clock stops in the same request. When the tab comes back, a beacon whose answer was never seen is confirmed with a
  normal `sudoku_pause` call.
- The game's own exit, **‹ Stages** (and "Today's board ›" / "Sprint board ›" from a game in progress): an awaited `sudoku_pause` with
  the board, then the map; a toast says "Paused at m:ss — the clock is stopped until you resume".
- Opening another puzzle happens from the map, so the one before is already paused. **No attempt is ever paused as a side effect of
  another** (the first build's `_sudoku_pause_others` stays gone): each ladder stage, daily and sprint puzzle has its own clock and pause.
- The next visit to that attempt shows the cover; the stage panel reads "Continue — paused at m:ss" (§7.1).

**4. Auto-pause on interruption** (power, internet, a crashed tab, a sleeping laptop — when no pause call can arrive):
- **The heartbeat.** While the board shows and the clock runs, the page calls `sudoku_heartbeat(attempt)` every `heartbeat_ms` (15 s,
  from the payload) — and once straight away when a running board opens. It stamps `last_seen_at` and answers with the server's elapsed,
  which the page adopts (so a throttled timer can never drift). Board activity (a save, check, hint or wrong submit) also refreshes
  `last_seen_at`. Cost 0 in the rate limiter, no player-row lock.
- **The reconcile rule.** Every server call on an attempt first reconciles (§3): if the attempt is active, not paused, `last_seen_at` is set
  and `now() − last_seen_at > 45 s` (`stale_after_ms`, three missed beats), the attempt becomes paused **from `last_seen_at`**
  (`paused_at := last_seen_at`). The pause is closed like any other when the player presses Resume — the whole gap since the last heartbeat
  is banked into `paused_ms` and counted as one pause — so **an outage stops the clock at the last heartbeat, not when the player comes
  back**, and the next visit shows the cover. Reads that don't write (`sudoku_overview`, `sudoku_daily_overview`,
  `sudoku_sprint_overview`) compute the same thing on the fly through `_sudoku_pause_start`. [Reading of the brief: "adds the gap to
  paused_ms, counts one pause" happens at Resume rather than at reconcile time — the same numbers, and it keeps "nothing auto-resumes".]
- **A gap of 45 s or less counts as play** — a blip that misses a beat or two pauses nothing, server-side.
- **Connection loss on the page.** The browser's `offline` event, or a heartbeat that fails on the network (no PostgREST code), covers the
  board at once ("Connection lost — the board stays hidden. Resume once you are back online.", Resume disabled as "Reconnecting…"). On the
  `online` event, or a retry every 5 s, the page sends `sudoku_pause` with the board; once it lands, Resume is offered ("The connection
  dropped, so the game paused itself."). The server's clock for that stretch follows the reconcile rule above.
- **The gate (backward compatibility).** `last_seen_at` stays **null until an attempt's first heartbeat or resume**, and the reconcile
  rule only applies once it is set. A page that never heartbeats — the 2026-09-30 page, still open or cached when 125 went live — keeps
  the never-stopping clock on its attempts and is never refused as `paused`. Skipping heartbeats can only cost a player time (the reconcile
  is a favour), so the gate opens no cheat. A port that ships the page and the database together can drop the gate and start every
  attempt with `last_seen_at = started_at`.

**5. Refusals while paused.** `sudoku_check`, `sudoku_hint`, `sudoku_save` and `sudoku_submit` answer `{ok:false, reason:'paused'}`
(§3.6) — no write, no charge. The page never sends them while covered; if one was in flight, or another tab or device paused the
attempt, the refusal covers the board (the move stays local and is saved after Resume; a refused submit is re-sent after Resume).

**6. Scope.** Ladder, daily and weekly-sprint attempts alike (one attempts table, `mode` column). A paused daily still belongs to its
Melbourne day: when the day ends while it is paused, the existing close rule applies — pause / resume / heartbeat / save / check / hint /
submit all answer `closed` (§10.1) and the page returns to the Daily tab. A sprint has a clock per puzzle, so a pause per puzzle.

**7. Transparency.** The attempt rows carry `pauses` / `paused_ms`, and each clear row copies them (`arena_sudoku_clears`,
`arena_sudoku_special_clears`). The finish card shows **"Paused 2× · 3:10"** when the attempt was paused (tooltip: the clock was stopped
that long while the board was hidden — it is not part of your time). Board rows whose clear was paused carry a small pause mark (⏸, drawn as
a two-bar glyph in the muted text colour) before the time, with the tooltip **"paused 2 times (3:10)"** ("paused once (0:42)" for one):
the stage top 5 (the stage panel and the in-game board use the same rows), the daily top 10, the sprint week board (summed over the five
clears), and the overall ranking (summed over the player's best clears — the ones that make up the total time). **Times are not adjusted.**
[Decision for Van: keep the marker, or drop it and show nothing.]

**8. Restart** still deals a shuffled grid with a fresh clock (ladder only; §4.8). A paused attempt's open pause is closed (banked and
counted) on the attempt that ends; the new attempt starts running at 0:00 with `pauses = 0`, `paused_ms = 0`, `last_seen_at = null` until
its first heartbeat. Replays work as before.

**9. What the first build got wrong (2026-09-28) and must not come back:** client-side time (every number is the server's), a pause that
leaves the board visible (the board is not even drawn while paused), and pausing "other" attempts as a side effect (nothing in §4.3 needs
it; several attempts run at once only if several boards are open at once, e.g. two windows side by side).

**Client display.** The clock shows the race time, `elapsed + penalties`, re-synced from every RPC response (each heartbeat included) and
ticking locally every 250 ms while running; frozen while paused. The note under it reads "Running — press P to pause", "Paused — the board
is hidden", "Stopped at the clear", or "The puzzle has closed". Re-opening a running attempt (open on another tab or device, or one from an
old page) says "Back to your grid — the clock is running (m:ss so far)"; a paused one opens on the cover with no toast. Tabs of the page in
the same browser share a `BroadcastChannel('pp-sudoku-pause')`: a tab that pauses an attempt tells the others, and one showing that attempt
covers at once (otherwise its next heartbeat would, within 15 s).

**Residual loopholes (accepted — deliberate cheating only).** Photographing the board, then pausing (Van's accepted case). Reading the
board from the page's memory or its network responses while the cover shows (the payload still carries the board — §3.4). Blocking only the
heartbeat requests with developer tools while keeping the board visible, then letting the reconcile backdate a pause to the last heartbeat —
the same class as the photograph (a normal player who loses the connection sees the cover at once). An outage of 45 s or less is counted.

### 4.4 Penalties
- Each **mistake** adds 30 s. Each **hint** adds 60 s.
- The ranked time is `final_ms = elapsed_ms + penalty_ms`.
- Penalties belong to the attempt, so a restart starts at zero.

### 4.5 The penalty box
After a first clear that moves the player up, the next stage opens at `clear time + penalty` (`players.next_unlock_at`), and
`reached_at` is set to the same instant. Replays never touch it.

Why it exists: penalties alone would only change per-stage times. Without the box, a player could guess-and-check through stages
using auto-check, or spend hints, and top the overall ranking, which runs on real time. The UI counts down with "Opens in m:ss" (§7).

### 4.6 Mistakes accounting
- With **auto-check** on (a setting, off by default), every placement calls `sudoku_check`.
- Each distinct wrong `(cell, digit)` pair is charged once; repeating the same wrong pair is free. Right digits are free.
- A **wrong full-grid submit** counts +1 mistake and returns only the number of wrong cells.
- Duplicate or conflict highlighting is client-side and free. The client never submits a grid with visible conflicts; a full grid
  with no conflicts is necessarily the unique solution.

### 4.7 Hints
- There are at most **3 per attempt**, at +60 s each.
- The server reveals the solution digit for the chosen cell, writes it into the saved grid and locks the cell. The client can't erase
  or change it, and `sudoku_save` / `sudoku_submit` refuse any change to it.
- A hint on a cell that already holds the right digit (per the saved grid) is refused, with no charge.

### 4.8 Restart and replay shuffle rules
- **Attempt 1** of a stage is the **canonical** grid, identical for every player.
- Every later attempt gets a random **symmetry**: a restart before the first clear (`kind='retry'`) or any replay after it
  (`kind='replay'`). The shuffled grid has the same logic, the same techniques and the same difficulty, but a remembered answer or a
  screenshot doesn't transfer.
- **Classic stages:** independent band-preserving permutations for rows (`r`) and columns (`c`): bands shuffled, then the rows or
  columns within each band. Plus a random digit relabelling `d = [0, perm(1..9)]` and a random transpose `t ∈ {0,1}`.
- **X-Sudoku bosses:** the diagonals must stay diagonals.
  - Rows come from a 24-element group. Pick a random permutation q of the top band and a random bit `swap`. Then
    `r[j] = (swap ? 6 : 0) + q[j]` and `r[8−j] = 8 − r[j]` for j = 0..2. With a random bit `mid`, `r[3] = mid ? 5 : 3`, `r[4] = 4`
    and `r[5] = 8 − r[3]`.
  - Columns are either `c = r` or the mirror `c[i] = 8 − r[i]`.
  - Relabel and transpose as for classic stages.
- **Mapping:** `target(R,C) = d[S′(r[R], c[C])]`, where S′ is transposed when `t=1`. The JS mirror is `applyXform` / `randomXform` in
  the generator.
- The SQL implementation was checked against all 300 stages: 0 invalid rows, columns, boxes or diagonals, clue counts preserved, and
  givens consistent with the transformed solution.
- **A restart** ends the attempt (`restarted`, `total_restarts + 1`) and starts a fresh shuffled attempt. The clock returns to 0:00 and
  mistakes and hints reset. The confirm dialog explains the shuffle.

### 4.9 Replays
- A replay creates a clear with `first_clear = false`. It can improve the player's best time, which feeds the top 5, medals and the par
  star.
- It **never** changes `highest_stage`, `reached_at` or `next_unlock_at`.

### 4.10 The 250 ms/cell guard
A clear is refused (`reason:'too_fast'`) when `elapsed_ms < 250 × (empty cells in the attempt's puzzle − hinted cells)`. Nobody types
that fast; a script does. Since mig 125 `elapsed_ms` is the running time (pauses excluded), so the floor also bounds "pause, solve on
paper, resume, type it in": the typing still needs 250 ms of running clock per cell.

### 4.11 Tamper handling
The following are all refused server-side:
- stage skipping
- a malformed grid or notes
- changed givens or hinted cells
- another player's attempt id
- a second submit of a cleared attempt
- direct table writes
- direct reads of the secret tables
- anon calls

---

## 5. Stages: the generator

The generator is `scripts/generate-sudoku-stages.mjs`: an ES module that exports its engine, with a CLI guarded by `import.meta.url`.
It uses no dependencies beyond Node built-ins, plus `@supabase/supabase-js` for `--apply` only. The CI syntax gate (`node --check`)
covers it.

### 5.1 Determinism
- The PRNG is `cyrb128(seedString)` → `sfc32`, with 12 warm-up draws (`rngFromSeed`). `shuffle` is Fisher–Yates.
- A **candidate seed** is `sha256('arena-sudoku|v1|' + master + '|' + variant + '|' + slot + '|' + k).hex.slice(0, 24)`, where slot
  is the stage number and `k` is the try index. `GEN_VERSION = 1`.

### 5.2 Geometry and solvers
- **Geometry.** Classic has 27 units (rows, columns, boxes). `x` adds the main diagonal and the anti-diagonal, 29 units in all.
  Peers are the cells that share any unit. Intersections are box × line pairs sharing 2+ cells; for X this includes the three boxes
  on each diagonal.
- **Counting solver** (`countSolutions(grid, variant, limit=2)`): an MRV depth-first search over per-unit digit bitmasks. It returns
  0 (contradiction), 1, or `limit`. **This is the uniqueness proof**, run for every stage.
- **Random complete grid** (`randomSolution`): the same MRV search with shuffled cell order and shuffled digit order.

### 5.3 Puzzle construction (`buildCandidate(seed, spec)`)
The spec is `{variant, target, lo, hi, tol=1, fan=10}`. `lo..hi` is the allowed rank range for the hardest technique; the clue count
must land within `±tol` of `target`.
- Holes are dug in **180°-rotational pairs**: cell i and cell 80−i for i = 0..40, with 40 as the centre. A removal is kept only if the
  counting solver still finds exactly one solution.
- **Basic band** (hi ≤ 2): dig down to the target count, then grade. Accept if the rank is in range and `|clues − target| ≤ tol`.
- **Harder bands:**
  1. Dig to a minimal puzzle and grade it. Reject if `rank < lo`, because adding clues only makes a puzzle easier.
  2. **Targeted add-back** (up to 40 steps). Each step grades up to `fan` removed clue pairs and scores each one: `0` if it lands in
     the band, `100` if it is still above the band, plus `|clues − target|`.
  3. Take the best pair. Never take a pair that drops the grade below `lo`.
  4. Stop with success when the puzzle is in the band and `|clues − target| ≤ tol`. Stop with failure if `clues > target + tol` or no
     pairs are left.

  Adding a correct clue keeps the solution unique. The final uniqueness check runs anyway.

### 5.4 Technique-grading solver (`grade(puzzle, variant, {solution})`)
The solver works on candidates and always applies the **easiest** technique that makes progress, one step at a time. The grade is the
**hardest** technique used on that path.

| rank | key | label (chip) | cost s | weight |
|---|---|---|---|---|
| 1 | naked-single | Naked single | 0 | 0.02 |
| 2 | hidden-single | Hidden single | 0 | 0.05 |
| 3 | naked-pair | Naked pair | 30 | 1.0 |
| 4 | hidden-pair | Hidden pair | 40 | 1.4 |
| 5 | naked-triple | Naked triple | 50 | 2.0 |
| 6 | hidden-triple | Hidden triple | 60 | 2.6 |
| 7 | pointing | Pointing pair | 25 | 1.2 |
| 8 | box-line | Box/line reduction | 30 | 1.5 |
| 9 | x-wing | X-Wing | 90 | 3.5 |
| 10 | xy-wing | XY-Wing | 120 | 4.5 |
| 11 | swordfish | Swordfish | 150 | 5.5 |
| 12 | colouring | Simple colouring | 180 | 6.5 |
| 13 | x-chain | X-Chain | 210 | 7.5 |
| 14 | xy-chain | XY-Chain | 240 | 8.0 |
| 15 | trial | Trial & error | 300 × depth | 12.0 |

How each technique works:
- **Subsets:** naked and hidden subsets of size 2 and 3, in any unit.
- **Intersections:** pointing is box → line (lines include the diagonals on X); box/line is line → box.
- **Fish:** X-Wing (2) and Swordfish (3), on rows and columns only.
- **XY-Wing:** a pivot plus two bivalue wings.
- **Simple colouring:** conjugate-pair components, with colour wrap (a colour that sees itself is false) and colour trap (an outside
  cell seeing both colours loses the digit).
- **X-Chain:** alternating strong/weak links on one digit, at least 3 links, `maxLinks = 7`, search budget 60 000 nodes.
- **XY-Chain:** a chain of bivalue cells, length ≥ 3, `maxLen = 8`, budget 60 000.
- **Trial & error:** tried only when every technique above is stuck. On bivalue cells, assume a digit and propagate with techniques 1–8.
  If the board breaks, that digit is eliminated. Depth 2 nests a depth-1 trial inside the hypothesis; the maximum depth is 2. A puzzle
  still stuck after that is rejected.
- **Audit:** when `solution` is supplied, any placement or elimination that contradicts it **throws**. A buggy technique can never grade
  a stage.

The output is `{ok, rank, hardest, tier, techniques[], counts{}, trialDepth, trialCount, difficulty, parSec, empties, solution}`.
- `tierOfRank`: ranks 1–2 → 1, 3–6 → 2, 7–9 → 3, 10–11 → 4, 12–14 → 5, 15 → 6.
- **Difficulty** = `Σ count × weight + 6 × trialDepth`.

**Par formula.** `parSec = 30 + empties × (3 + tier) + Σ_tech cost × (trial ? depth : 1) × (1 + 0.5 × (n − 1))`. The first use of a
technique counts at full cost and each repeat at half. It is ×1.1 for X-Sudoku and rounded up to 15 s. `par_ms = parSec × 1000`.

### 5.5 Stage plan (`BANDS`)
Each band's clue target is a linear ramp over the band (`targetClues`). Inside each sub-tier, stages are ordered by clues
**desc**, then rank asc, then difficulty asc. Each later sub-tier is capped at the previous sub-tier's lowest clue count, so the clue
count **never rises inside a band**. `maxTries = 25 000` per slot.

| Band | Stages | Tier | Hardest ranks | Clue ramp | Sub-tiers (from–to: ranks, tol, fan) |
|---|---|---|---|---|---|
| 1 | 1–20 | Basic | 1–2 | 46→36 | 1–20: 1–2, tol 1 |
| 2 | 21–60 | Medium | 3–6 | 35→29 | 21–45: 3–4, tol 2 · 46–60: 5–6, tol 2, fan 20 |
| 3 | 61–120 | Hard | 7–9 | 32→27 | 61–95: 7–8, tol 2 · 96–120: 9, tol 2, fan 20 |
| 4 | 121–200 | Expert | 10–11 | 31→26 | 121–170: 10, tol 2 · 171–200: 11, tol 2, fan 20 |
| 5 | 201–260 | Master | 12–14 | 30→25 | 201–220: 12 · 221–240: 13 (fan 20) · 241–260: 14, all tol 2 |
| 6 | 261–300 | Extreme | 15 | 28→24 | 261–300: 15, tol 2 |

**Boss stages.** Every **25th stage** (`isBoss(n) = n % 25 === 0`) uses variant `x`. Its allowed ranks are the whole band's range.
- It is fitted between its neighbours: clue window `[clues(n+1), clues(n−1)]`. For the last stage of a band the window is
  `[max(17, prev − 4), prev]`.
- `target` is the window's midpoint and `tol = max(1, ceil(width / 2))`.
- The seeds use variant `'x'`.

### 5.6 Stage records
Each record is `{stage, variant, tier, tier_rank, techniques (labels), technique_keys, hardest, hardest_rank, trial_depth,
clue_count, par_ms, difficulty, puzzle, solution, seed, gen:{v, variant, target, lo, hi, tol, fan}}`.

**`verifyRecords`** checks:
- stage numbering is contiguous from 1
- exactly one solution
- the solution is valid, diagonals included on bosses
- givens agree with the solution
- `clue_count` is correct
- the grade reproduces (hardest and rank)
- the rank sits inside its band and, for classic stages, its sub-tier
- every band is harder than all of the previous band
- the clue count never rises inside a band
- bosses are exactly the X stages
- par > 0

### 5.7 The seeded production set
It was built in 216 s and verified clean.

| Tier | Stages | Hardest technique: count | Clues | Par | Bosses |
|---|---|---|---|---|---|
| Basic | 1–20 | naked single 19, hidden single 1 | 46→36 | 3:00–3:30 | — |
| Medium | 21–60 | naked pair 19, hidden pair 7, naked triple 8, hidden triple 6 | 35→27 | 5:00–8:45 | 25, 50 |
| Hard | 61–120 | pointing 27, box-line 7, X-Wing 26 | 32→26 | 6:00–11:45 | 75, 100 |
| Expert | 121–200 | XY-Wing 52, Swordfish 28 | 32→24 | 8:30–15:30 | 125, 150, 175, 200 |
| Master | 201–260 | colouring 21, X-Chain 20, XY-Chain 19 | 31→24 | 10:30–23:15 | 225, 250 |
| Extreme | 261–300 | trial & error 40 (all depth 1) | 28→20 | 13:45–44:00 | 275, 300 |

- Boss grades: 25 naked pair, 50 hidden pair, 75 and 100 X-Wing, 125–200 XY-Wing, 225 colouring, 250 X-Chain, 275 and 300 trial.
- Stage 1 has 46 clues and a par of 3:00. Stage 300 has 20 clues and a par of 29:30.
- Stages showing each technique chip (a stage can show several): Naked single 300, Hidden single 280, Naked pair 187, Pointing pair
  174, XY-Wing 111, Hidden pair 101, Box/line 81, X-Wing 53, Naked triple 45, Simple colouring 41, Trial 40, XY-Chain 39, X-Chain 37,
  Swordfish 30, Hidden triple 13.

### 5.8 Commands
Run these from the hub repo root.

| Command | What it does |
|---|---|
| `node scripts/generate-sudoku-stages.mjs --out scratch/sudoku-stages.json [--count 300] [--seed <master>] [--quiet]` | Generates, verifies and prints the distribution. With no master seed available it **creates** `scratch/sudoku-master-seed.txt` (128-bit random) and says so |
| `node scripts/generate-sudoku-stages.mjs --verify <file>` | Re-proves uniqueness, re-grades every stage and checks the bands; prints the distribution; exit 1 on problems |
| `node scripts/generate-sudoku-stages.mjs --reproduce <file>` | Regenerates each stage from its stored `seed` + `gen` and compares byte for byte (all 300 reproduce) |
| `node scripts/generate-sudoku-stages.mjs --apply <file> [--force]` | Verifies first and refuses on any problem. Then upserts `arena_sudoku_stages` (metadata) and `arena_sudoku_stage_secrets` (puzzle, solution, seed, gen) in batches of 100, using the service role read from `.env` in-process. **Skips any stage that already has attempts** unless `--force`. Reports written, unchanged and skipped counts |

### 5.9 Where the seed lives
The generator looks in this order:
1. `--seed` on the command line
2. the env var `SUDOKU_MASTER_SEED`, also read from `.env`
3. `scratch/sudoku-master-seed.txt` (gitignored)

Per-stage seeds are in the private `stage_secrets` table. Never commit the master seed or `sudoku-stages.json`.

---

## 6. Ranking and rewards

- **Overall ranking.** Sorted by `highest_stage` **desc** (the highest stage cleared, in order), then `reached_at` **asc** (the server
  time the next stage opened, clear time + penalties), then `user_id`.
  - Columns: #, Player, Stage, Reached (date + time), Total time. Total time is the sum of the player's best `final_ms` over every
    cleared stage. Mig 125: when any of those best clears was paused, the total carries the pause marker (§4.3, rule 7) with the summed
    count and time; the order is untouched.
  - The player's own row is highlighted. If it falls outside the top 50 it is pinned below the table.
  - Players who have only done the tutorial don't appear. The page shows "Clear stage 1 to appear on the ranking."
  - Rule text on the page: "Highest stage cleared wins. On the same stage, whoever got there first ranks higher (server time,
    penalties included)."
- **Per-stage top 5.** Each player counts once, by their best clear (min `final_ms`; ties go to the earlier `finished_at`), ranked
  with `rank()`.
  - Rows show rank (a medal disc for 1–3), name (with "(you)" on your own row), time `m:ss.t`, and date (`d Mon`). Mig 125: a clear
    that was paused shows the small pause marker before its time — tooltip "paused 2 times (3:10)" — on the stage panel's top 5 and your
    pinned row (the daily top 10 and the sprint week board too, §10). Medals, crowns and ranks use the time as it is.
  - If your rank is above 5, a dashed separator is followed by your row.
  - Below the table: "N players have cleared this stage."
- **Crowns.** The first clear of a stage ever is written once and never moves. Since 2026-09-30 every crown is drawn as **one filled
  solid-gold shape** (§8). It appears:
  - on the map tile, top-right: on a stage you haven't cleared, whoever holds it (the "cleared by others" state); on your own cleared
    tile only when the crown is yours (§7.1)
  - in the stage panel: "**name** — first to clear, d Mon in m:ss.t", or "Your crown"; with no crown yet, "No one has cleared this
    stage yet — the first clear takes the crown."
  - as a gold game-header chip
  - as a gold badge with the count after each crown holder's name in the Ranking tab (§7.1)
  - on the completion screen: "First clear — the crown on stage N is yours for good"
  - in the Arena highlights (the 👑 emoji there, unchanged)
- **Medals.** Gold, silver and bronze go to stage ranks 1, 2 and 3 on best times. They are live, so a medal can be lost to a faster
  player. They show on map tiles (a disc on your cleared tiles), in the top 5, in the header chips, on the completion screen
  ("Gold — #1 of N on this stage") and in Stats ("held right now").
- **Par star.** A best time at or under the stage's `par_ms`. It counts in Stats as "Par stars", and the completion screen shows "Beat
  par (m:ss)".
- **Ghost splits** (a setting, on by default; hidden in the tutorial).
  - A 4 px track under the timer carries a vertical marker at each top-5 time, plus a **gold par marker**.
  - Scale = `max(1.12 × max(par, top-5 times, 60 s), 1.05 × current race time)`.
  - A marker dims once the race time passes it.
  - Labels are placed left to right only when at least 78 px from the previous label, truncated to 11 characters. Labels near the
    edges are anchored inward. Every marker has a hover title "name m:ss.t".
  - A fill bar shows your race time.
  - Line under the track, depending on the state:
    - normal: "Next ghost: **name m:ss.t** — m:ss to beat it"
    - no clears yet: "No clears yet — par is **m:ss**. The first clear takes the crown."
    - every ghost passed: "You're past every top-5 time — keep going."
- **Stats tab** (12 tiles):

  | Tile | Detail line |
  |---|---|
  | Highest stage | "reached <date time>", "stage 1 is open" or "tutorial first" |
  | Stages cleared | "N clears, M of them replays" |
  | Medals | the total, then "● N gold · ● N silver · ● N bronze" |
  | Crowns | "first clears" |
  | Par stars | "best time at or under par" |
  | Average time | "best time per stage" |
  | Total time | "sum of your bests" |
  | Overall rank | — |
  | Mistakes | "+0:30 each" |
  | Hints | "+1:00 each" |
  | Restarts | — |
  | Streak | "N days", with "best N" |

- **Header chips** on the home view: "Start with the tutorial", "All N stages cleared" or "Next: stage N"; "N cleared"; medal counts
  (only if you hold any); "N crowns" (a gold chip with the solid crown); "Ranked #N"; "N-day streak" (only above 1). Since mig 124 the
  streak chip shows from 1 day, and the card adds "N-day badge", "Sprint winner [×N]" and "N hint tokens" (§10.4–§10.6).
- **Streak timezone.** A day is an AEST day (`Australia/Brisbane`, no DST) with at least one clear. The current streak shows 0 once the
  last clear is older than yesterday. **Since mig 124:** Melbourne days (DST-aware) and clears of any kind — ladder, daily or sprint —
  computed by the `arena_sudoku_streaks` view (§10.4).
- **Display names.** The local part of `profiles.email` (for example `renz`), captured at first play, as on the Typing leaderboard.
  It stays unique by construction.

---

## 7. Client features (`tools/arena-sudoku.html`)

### 7.1 Home view
The home view has a hero (eyebrow "Performance Arena", title "Sudo**ku**" with the accent on "ku", a subtitle, and the header chips),
a segmented tab control (**Stages · Ranking · Stats**) and a **"How it works"** link.

**Stages tab.** A two-column layout: a scrollable map panel and a sticky stage panel (380 px wide). The map scrolls itself on desktop.
- **Map key** (Van 2026-09-30). The first row inside the map panel: four 14 px swatches drawn like the tiles, reading "Cleared by you ·
  Cleared by others · Open · Locked" (10.5 px, muted; the "others" swatch holds a tiny solid crown, the "locked" one a lock). One row
  on desktop; a 2 × 2 grid under 640 px.
- **Map groups.**
  - "Start here · Stage 0 · not ranked" holds a wide **Tutorial** tile showing "Stage 0" (the open-now look) or "Done ✓" (the
    cleared-by-you look).
  - Then one group per tier. Each header has a colour dot, the tier name, "a–b · blurb" (Singles only / Pairs and triples / Pointing
    pairs, box/line, X-Wing / XY-Wing and Swordfish / Colouring and chains / Trial and error), and a grid of tiles (`minmax(58px,1fr)`,
    7 px gap; 50 px and 6 px under 640 px). Headers wrap on narrow screens.
  - **The frontier cue.** The *frontier* is the highest stage anyone (you included) has cleared, from the overview: the max of your
    `highest_stage`, every `crowns[].stage` and every `players` key with a count. The band that holds it gets a pill at the right
    end of its header: a solid crown and "Cleared up to N" (gold text on a 13% gold tint, a gold hairline; tooltip "The highest stage
    anyone has cleared"). No pill while nobody has cleared anything.
- **Tile states.** Four states that read at a glance in both themes (Van 2026-09-30: "so on my POV I know right away until what stage
  has been cleared already"; "the crown needs to be fully colored … highlight the stages box that the player has cleared already"):

  | State | When | Look |
  |---|---|---|
  | (1) Cleared by you (`cleared`) | n ≤ your `highest_stage` | A filled Teal highlight: a vertical Teal gradient (36%→18% dark, 25%→12% light), a Teal border (90% / 80%) with a faint inner ring. Your best time `m:ss` in bold Teal (lighter on dark, deeper on light). Your medal disc top-left when your rank there is 1–3. The **solid gold crown top-right only when the first clear is yours** |
  | (2) Cleared by others (`others`) | n > your `highest_stage` and someone has cleared it (`players[n] > 0` or a crown) | Quieter: a faint gold tint (Yellow 9% dark / 13% light), a gold hairline (Yellow 52% / Yellow-700 55%) and the holder's **solid gold crown** top-right. While the stage is still locked for you the tile stays at full strength and only the number, lock, stripe and BOSS label dim (45%), so the run of cleared stages stands apart from the plain locked ones |
  | (3) Open now (`current`) | n = your `highest_stage` + 1 | The Arena pink border with the 2.4 s pulse (off under reduced motion). When others have cleared it too it also carries their crown and the gold tint; the pink border wins |
  | (4) Locked (`locked`) | beyond the open stage, and nobody has cleared it | Dimmed to 42% with a lock icon, as before |

  - They combine with: `active` (an attempt in progress: a pink dot top-left and "playing", or "paused" when its clock is stopped —
    mig 125, from `overview.active[].paused`), `sel` (the selected tile: a
    pink outline), `boss` (a dashed border in the state's colour, Teal 55% when plainly locked, plus a "BOSS" label) and `front` (the
    frontier tile: a short gold rule, 3 px wide and 64% of the tile's height, drawn in the grid gap right after it, so the edge of the
    cleared run reads even mid-row; none after stage 300).
  - Every tile keeps its tier-coloured stripe at the bottom, and tiles keep their size and grid.
  - A crown someone else holds is never drawn on your own cleared tile (the stage panel still names the holder); on any stage you
    haven't cleared it always shows.
  - The tooltip reads "Stage N · Tier [· Boss (X-Sudoku)]", then " · cleared by you in m:ss.t [· your crown]" or " · cleared by N
    player(s)", then " · the highest stage anyone has cleared" on the frontier tile.
  - Clicking any tile, locked ones included, selects it and loads its panel. The board is cached for 20 s.
- **Stage panel, tutorial:** a description, then "Start the tutorial" or "Replay the tutorial", with the note "Finish it once to open
  stage 1." or "Done — stage 1 is open."
- **Stage panel, stage N:**
  - "Stage N" with a tier chip (tier colour) and, on bosses, "Boss · X-Sudoku".
  - "C clues · par m:ss", plus " · both diagonals hold 1–9 too" on bosses.
  - Technique chips; each tooltip is a one-line explanation (§7.12).
  - The crown line (a solid gold crown on a gold tint), the top-5 table and the players line.
  - One action button, with a note under it:

    | State | Button | Note |
    |---|---|---|
    | Tutorial not done | "Finish the tutorial first" (disabled) | "Stage 0 opens the ladder." |
    | Attempt in progress, paused (mig 125 — the usual case after leaving) | "Continue — paused at m:ss" | "Your attempt is paused at m:ss — the clock is stopped and the board stays hidden until you press Resume." ("Your shuffled attempt …" on retries / replays). Uses `active[].elapsed_ms` and `active[].paused` from the overview |
    | Attempt in progress, running (open on another tab or device, or from a page before 125) | "Continue — clock running" | "Your attempt is still running (m:ss so far) — it may be open on another tab or device." |
    | Cleared | "Replay for a better time" | "Your best: m:ss.t · #r of n. Replays are shuffled and never change your ladder position." |
    | Current, penalty box running | "Opens in m:ss" (disabled; counts down every 500 ms and re-renders at 0) | "Serving penalty time from your last clear." |
    | Current | "Play stage N" | "The clock starts when you press Play and stops only while the board is hidden — Pause, or leaving the page, pauses it." |
    | Locked | lock icon + "Locked" (disabled) | "Clear stage X to move up." |

  - Countdowns correct for client/server clock skew, estimated from `server_now` minus half the round trip.

**Ranking tab.** The table from §6, loaded from `sudoku_ranking(50)`. Since 2026-09-30 a crown holder carries a gold badge after the
name: a solid crown and the count (tooltip "N crowns — first to clear"). Your own count comes from the overview's `mine` flags;
everyone else's is matched by the name the crown was recorded under, because ranking rows carry names, not ids. A player renamed
between two first clears can therefore be undercounted; a port should return `crowns` per row from the server instead.

**Stats tab.** The 12 tiles from §6, loaded from `sudoku_stats()`.

**"How it works" modal.** Eight bullets:
- **One rule** (rows, columns, boxes; bosses add the diagonals).
- **One ladder** (stage 0 tutorial; each stage opens when the previous is cleared; the same grid for everyone).
- **The clock is the server's** (mig 125): "It starts when you press Play and stops only while the board is hidden. Pause (or P) covers
  the board and stops the clock; leaving pauses it for you — closing the tab, switching away, going back to the map, or losing the
  connection. Resume shows the board and the clock runs on. Pausing is free and your time still ranks; rows with a pause carry a small
  pause mark. Restart deals a shuffled grid with a fresh clock."
- **Penalties** (auto-check +0:30 per wrong digit, hints +1:00, three per attempt; counted in your time and served before the next stage
  opens).
- **Per stage** (top 5; gold, silver and bronze; crowns for good; the par star).
- **Reading the map** (2026-09-30): "Teal tiles are the stages you've cleared, with your best time and medal. A gold crown marks a
  stage someone has cleared (on your own tile, only if the crown is yours), and a short gold rule sits after the highest stage anyone
  has cleared. Pink is the stage open for you now."
- **Replays and restarts** (improve your time; shuffled, so they can't be typed from memory).
- **Overall** (the highest stage leads; ties go to whoever got there first).

It closes with "Got it", a backdrop click or Esc.

### 7.2 Game view
**Game bar.**
- A "‹ Stages" button. It **pauses** the attempt (an awaited `sudoku_pause` carrying the board — nothing is lost) and returns to the map
  (mig 125; toast "Paused at m:ss — the clock is stopped until you resume").
- Title "Stage N" with a tier chip, or "Stage 0 · Tutorial".
- Chips:
  - "Boss · X-Sudoku" on bosses.
  - Technique chips, excluding naked and hidden singles. If a stage has only singles, it shows one "Singles" chip.
  - "Shuffled" on shuffled attempts, with the tooltip "Restarts and replays swap rows, columns and digits: same logic, same difficulty,
    but memory won't help."
  - A gold crown chip (`.sd-chip.gold`: gold text on a gold tint, the solid crown) with the holder's name, or "Your crown".
- A "Settings" button.

**Timer row.**
- A large race clock, `m:ss` or `h:mm:ss`, and beside it (mig 125) the **Pause** button — a pill with a two-bar pause glyph, "Pause" and
  a `P` key hint (`#sdPauseBtn`, title "Pause (P): the board is hidden and the clock stops until you resume"; the key hint is dropped on
  phones). It shows only on a live, timed board (not the tutorial, not after the clear). The 7 tools are unchanged. Under the clock a
  small line: "Running — press P to pause", "Paused — the board is hidden", "Stopped at the clear", "The puzzle has closed", or on the
  tutorial "Practice clock — nothing is timed here".
- On the right: "+m:ss penalties" in red, or "No penalties"; "N mistakes · H/3 hints"; "par m:ss". The tutorial shows
  "Tutorial · no penalties".
- The ghost track and the next-ghost line (§6) sit underneath.

**Board.**
- 9×9 cell buttons with 2 px box borders and 1 px cell borders. The board size `--bs` is `min(560px, 100vh − 260px)` on desktop.
- Digits scale with container-query units: value `100cqw/9 × .56`, notes `× .235`.
- Cell looks:
  - **given**: bold, ink colour.
  - **entry**: accent colour.
  - **hinted**: teal, with a small dot top-right; locked.
  - **bad**: auto-check marked it wrong; red digit and red tint.
  - **clash**: a digit repeated in a unit; red digit and a red underline bar (givens keep the ink colour but get the bar).
  - **sel**: accent fill with an inset accent ring.
  - **peer**: row, column and box tint.
  - **same**: every cell with the selected digit.
  - **dg**: on bosses, both diagonals are shaded teal, 17 cells.
  - Tutorial only: **focus** (amber tint) and **target** (a pulsing amber ring).
- A pop animation plays on placement. A shake plays when you try to edit a locked cell.

**The cover (mig 125).** While the attempt is paused, `#sdGame` carries `.is-paused`, which makes the whole play area (`.sd-play`: the
timer row, the ghost track, the board with every cell, note and colour, the tools, the Digits / Colours switch and both pads, the save
line and the mini top 5) `visibility: hidden` — laid out but **not drawn** — and the cover `#sdCover` sits over it (`.sd-playwrap` is the
positioned parent). The game bar above stays (title, chips, ‹ Stages, Settings: none of it shows the puzzle). The cover is a centred card
(`min(460px, 100%)` wide, 64 px from the top on desktop — `min(8vh, 64px)` — 18 px on phones; opaque `--sd-panel-solid`, the Arena line,
radius 18): a 54 px pink pause disc, the eyebrow "PAUSED", the title (the game bar's title with its chip), the frozen race clock (46 px,
38 px on phones) with "includes +m:ss of penalties" under it when there are penalties, **"Paused — the clock is stopped while the board is
hidden"**, the reason line (§4.3; red while the connection is lost), the primary **Resume** button (a play triangle + "Resume";
"Resuming…" while the call runs; disabled "Reconnecting…" while offline) and the foot "Press Resume (or P) to show the board and run the
clock again. Pausing is free, and your time still ranks." Input is refused while it shows: the board's pointer handler, every key except
P, and every tool / pad action check the paused flag. The tutorial has no pause (its clock is practice only).

**Tools (7)**, with their disabled states. On desktop they sit in a 4-column grid, with Restart spanning two columns in the second
row; on phones all 7 sit in one row. (Mig 124: while hint tokens are banked the Hint tool reads "Hint · N tokens" and takes Restart's
second column — on phones a gold mini badge; on a daily / sprint puzzle Restart is relabelled **Clear**; a "Digits | Colours" switch sits
between the tools and the pad — §10.3, §10.5.)

| Tool | Behaviour |
|---|---|
| Undo | Disabled when the undo stack is empty |
| Redo | Disabled when the redo stack is empty |
| Erase | Clears the selected cell |
| Notes | Toggle; highlighted when on |
| Auto | Auto-candidates toggle; highlighted when on |
| Hint | A badge shows hints left (∞ in the tutorial). Disabled when the attempt isn't active or no hints are left |
| Restart | Title "Restart: a shuffled grid with a fresh clock". Disabled in the tutorial |

**Pad.**
- Keys 1–9. Each shows "N left" (9 minus that digit's count on the board, wrong entries included), or "done" and dimmed at 0.
- The digits turn accent-coloured while notes mode is on.
- Tapping a key respects notes mode.

**Save line.** "Saved on the server" (or "Shuffled grid · saved on the server"), then "Saving…", "Saved", or "Not saved — retrying"
(retries every 3 s).

**Mini top 5.** A "Top 5 on this stage" panel, the same data as the ghosts, followed by a key-help line.

### 7.3 Keyboard
Keys are ignored while a modal is open or the focus is in an input.

| Key | Action |
|---|---|
| Arrow keys | Move the selection, wrapping within the row or column. With no selection, the centre cell is selected |
| 1–9 (top row or numpad; read from `event.code`, so Shift works) | Place the digit |
| Shift + 1–9 | Toggle a note |
| Backspace, Delete, 0 | Erase |
| N | Toggle notes mode |
| Ctrl/⌘+Z | Undo |
| Ctrl/⌘+Y or Ctrl/⌘+Shift+Z | Redo |
| H | Hint |
| C | Toggle the pad between Digits and Colours (mig 124). In Colours, 1–6 paint the selected cell and 0 / Backspace / Delete clear its colour |
| Esc | Close Settings, the rules or the confirm dialog, otherwise deselect |
| P | Mig 125: **pause** (covers the board, stops the clock); on the cover, P **resumes** (an explicit key — nothing resumes by itself). Not with Ctrl / ⌘ / Alt (Ctrl+P prints), not in the tutorial |

While the board is covered every key except P is ignored. **Esc is deliberately not a pause key**: it already deselects, and a player
would hide the board by accident [alternative: Esc pauses too]. Pointer input selects on `pointerdown` (with `preventDefault`), so it is
fast on touch. The in-game key-help line reads "… · H hint · P pause · Esc deselect".

### 7.4 Settings
There are 7 settings. They are stored per viewer in `localStorage['pp-sudoku-settings-v1']`, wrapped in try/catch, and are never
trusted by the server. The first build's `autoPause` ("Pause when I leave the tab") setting was removed 2026-09-29 and is **not** back:
since mig 125 pausing on leaving is a rule, always on (§4.3), not a preference. An old stored value is ignored.

| Key | Label | Default | Effect |
|---|---|---|---|
| autoCheck | Auto-check mistakes | **off** | Each placement goes to `sudoku_check`; a wrong digit turns red and costs +0:30 (a toast says "Wrong digit — +0:30" when charged) |
| hlArea | Highlight row, column and box | on | Peer tint |
| hlSame | Highlight matching digits | on | "same" tint, plus matching note digits in accent bold |
| conflicts | Show conflicts | on | "clash" marks; free |
| autoNotes | Clear notes automatically | on | Placing a digit removes it from the notes of all peers (row, column, box, and the diagonals on bosses) |
| ghosts | Ghost splits | on | Ghost track and next-ghost line |
| sound | Sound effects | **off** | WebAudio beeps: sine 520/660 Hz for a clear, square 150 Hz for a mistake |

### 7.5 Placement, notes and candidates
- **Placing a digit.**
  - With no cell selected, a toast says "Pick a cell first".
  - Placing on a given or hinted cell shakes the cell.
  - Placing the digit the cell already holds does nothing.
  - Placing clears the cell's own notes and, with autoNotes on, the digit from its peers' notes, all in the same undo step. It also
    clears any "bad" mark on the cell.
  - Then, if autoCheck is on, the placement is checked. Finally the page tests for completion.
- **Notes.** Notes mode is toggled with the Notes tool or N; Shift+digit adds a note directly. A note on a filled cell gives the toast
  "Clear the digit before adding notes". Notes are stored as 9-bit masks and render as a 3×3 mini-grid.
- **Auto-candidates** (the Auto toggle). Turning it on fills every empty cell's notes with its current legal candidates in one undo
  step, and shows a toast. While it's on, erasing a digit refills that cell's candidates. Turning it off leaves the notes as they
  are. Candidates are computed from every digit on the board, wrong entries included.
- **Undo and redo.** Each action records before and after snapshots (value + notes) of every cell it touched. The undo stack holds
  500 steps, and any new action clears redo. Undo and redo skip cells that have been locked since (by a hint), and redo re-checks for
  completion.
- **Conflicts.** A duplicate in any unit, diagonals included on bosses. A full board with a conflict shows the toast "The board is full
  but something repeats — look for the red marks" and is **not** submitted.
- **Auto-submit.** As soon as the board is full and conflict-free, the page calls `sudoku_submit`.

### 7.6 Hints (client side)
- **Target cell:**
  - the selected cell, if it isn't locked and is empty or marked wrong
  - otherwise the selected cell if it's filled and auto-check is off (the server will say if it's already right)
  - otherwise the empty cell with the fewest candidates
- The save is flushed before the hint call.
- **Explanation**, computed client-side from the board: "the only digit that fits this cell (naked single)", "the only place left for a
  D in row/column/box N / the diagonal (hidden single)", or "found with a harder technique on this stage".
- The toast reads "Hint: D at rRcC — <why> (+1:00)" and stays up for 5.2 s. A refused hint shows the server's message.

### 7.7 Autosave and resume
- **Autosave** fires 1 s after the last change: `sudoku_save(attempt, grid, notes)`. Saves are serialized, and a change made during a
  save queues another one. Mig 125: no save is sent while the board is covered (the pause carried the board; a move not yet saved is sent after Resume), and a
  save answered `paused` covers the board.
- **The keepalive pause (mig 125).** When the tab hides, on `pagehide` and on `beforeunload`, the page sends ONE keepalive
  `sudoku_pause` carrying the board (§4.3), so a move made just before a refresh or close is never lost **and** the clock stops in the same
  request. (Before 125 this was a keepalive `sudoku_save` and the clock kept running.)
- **Return to the tab.** The cover stays; a pause beacon whose answer was never seen is confirmed with a normal `sudoku_pause` call. The
  clock is re-synced by every heartbeat while the board runs (§4.3); there is no "re-sync through a save" any more.
- **Resume after leaving.** `sudoku_start` returns the active attempt on any device, with grid, notes, hinted cells, wrong cells, mistakes,
  hints and the elapsed time — normally **paused**, so the page opens on the cover; Resume shows the board. A running one (another tab or
  device, or an old page) toasts "Back to your grid — the clock is running (m:ss so far)". The map marks active attempts ("paused" /
  "playing"). Two devices writing at once is last-write-wins; on Resume a clean page takes the server's board if it differs ("Your board
  changed on another device — this is the latest").

### 7.8 Completion screen (modal)
- Confetti plays (§8).
- Eyebrow: "Stage cleared", "Boss defeated" on X stages, or "Replay cleared". Title: "Stage N · Tier".
- A large final time `m:ss.t`, with the breakdown "m:ss.t solving + m:ss penalties (M mistakes, H hints)" or "… · no penalties".
- Mig 125: when the attempt was paused, a muted line under the breakdown (`#sdDonePause`): the pause glyph and **"Paused N× · m:ss"**
  (N and the time from the submit answer's `pauses` / `paused_ms`; tooltip "The clock was stopped for m:ss while the board was hidden — it
  is not part of your time"). Hidden for an unpaused clear and for the tutorial. The same line shows on the daily / sprint completion.
- **Awards list**, each shown when it applies:
  - rank or medal ("Gold — #1 of N on this stage", or "#r of N on this stage")
  - crown ("First clear — the crown on stage N is yours for good"), on the gold card with the solid crown
  - "Beat par (m:ss)"
  - personal best ("New personal best — was X", or "Your best stays X"; only when an earlier best exists)
  - progression ("Stage N+1 is open", plus " after m:ss of penalty time" when there were penalties)
- **Buttons:**
  - "Stage map" returns home, refreshed.
  - "Next stage ›" appears only if this clear moved you up. It is disabled with "Opens in m:ss" while the penalty box runs, and
    counts down every 500 ms.

### 7.9 Tutorial (stage 0)
The tutorial runs entirely in the client on a fixed practice grid. It is never ranked and makes no server calls except the final
`sudoku_complete_tutorial`.
- Puzzle: `030678912602005340108342567859761403400853791713900850901537204280410635345286109`.
- Solution: `534678912672195348198342567859761423426853791713924856961537284287419635345286179`.
- Teaching cells (0-based index): A = 61 (r7c8, naked single 8), B = 10 (r2c2, hidden single 7 in the top-left box), C = 37 (r5c2,
  notes {2,6}), D = 38 (r5c3 = 6).

A coach card sits beside the board on desktop and below the pad on phones. It shows "Tutorial · step k of 11", a title, the body, a
line of feedback, progress dots, and Back / Next. Steps that wait for an action have no Next button; they advance 450 ms after the
action.

| # | Title | Waits for |
|---|---|---|
| 1 | One rule | Next. Row 5, column 8 and box 9 are highlighted |
| 2 | Select a cell | Selecting cell A (pulsing target) |
| 3 | A naked single | 8 in A. A wrong digit gets the nudge "Not quite — which digit is missing from its row, column and box?" |
| 4 | A hidden single | 7 in B, with the top-left box highlighted. Anything else gets "The 7 has only one home in that box — the glowing cell." |
| 5 | Notes | Notes 2 and 6 in C. Placing a digit in C gets "Use Notes for this one — turn on the pencil (N) first." |
| 6 | Notes clear themselves | 6 in D; notes mode is switched off on entry. The 6 disappears from C's note |
| 7 | The pad keeps count | 2 in C |
| 8 | The clock stops only while the board is hidden (mig 125; it was "The clock never stops") | Next (information only): "The clock starts when you press **Play**. Press **Pause** (or **P**) and the board is covered while the clock stops; **Resume** brings both back. Leaving pauses it for you — closing the tab, switching away, going back to the map or losing the connection. Pausing is free and your time still ranks. **Restart** deals a shuffled grid with a fresh clock. (This practice clock isn't timed.)" The tutorial itself has no Pause button |
| 9 | Mistakes and hints | Using a hint. It is free in the tutorial and explains itself ("…In a real stage that costs 1:00.") |
| 10 | How the ranking works | Next. Covers the top 5, medals, crowns, the overall rule and bosses |
| 11 | Finish the grid | The completed grid (local check; wrong digits are shown red) |

On the tutorial there is no penalty, the clock is local and cosmetic, the hint badge shows ∞, auto-check runs locally and free, and
Restart is disabled. The stage-0 panel describes the tutorial as covering "rows, columns and boxes, singles, notes, the pad, the
clock, mistakes and hints, and how the ranking works".

**Tutorial completion modal.** "Tutorial complete / Stage 0 · you're ready", the local time, "Not ranked — practice only.", an award
reading "Stage 1 is open…", and the buttons "Play stage 1 ›" and "Stage map".

The coach card closes when any real stage starts; a late step timer can't bring it back.

### 7.10 Other interface details
- **Toasts** appear bottom-centre (at the top on narrow screens) for 3.2 s by default. There is one live region
  (`role=status`, `aria-live=polite`).
- **Restart confirm:** "Restart stage N? Your board clears and the clock starts again from 0:00. The grid is shuffled — rows, columns
  and digits are swapped — so it plays exactly the same but can't be typed in from memory. Restarts so far: R." with Cancel / Restart.
- **Error states** in the map panel: "Database unavailable", "Could not load the stages", the overview error message, and "No stages
  yet — the stage set hasn't been seeded."

### 7.11 Themes and mobile layout
**Themes.** Dark is the default. Light mode is `[data-theme="light"]`, set by `os-chrome.js` from `localStorage['ppos-mode']`. Every
colour is a CSS variable redefined for light (§8). A global `[hidden]{display:none !important}` guard exists because class display
rules defeat the attribute.

**Responsive rules.**
- **≤ 1060 px:** the side panel is 330 px; the board is `min(520px, 100vh − 250px)`.
- **≤ 900 px:** a single column; the map no longer scrolls itself; the board is `min(560px, 100vw − 32px)` and centred, the controls
  match the board's width, and the stats grid has 2 columns.
- **≤ 640 px** (the phone layout; 390 px verified):
  - 16 px side padding
  - the 7 tools on one row, icons only
  - the pad as 9 keys on one row
  - clock 28 px; the game bar wraps
  - the ranking hides the Reached column
  - tiles at `minmax(50px,1fr)`
  - the tutorial coach sits after the pad, then the save line and the mini top 5
  - toasts at the top
  - completion time 40 px

  Verified: no horizontal overflow at 390 px and 1440 px (`fit-screen.js` zoom stays 1).

**Boot sequence.**
1. Wait for `window.sb`, up to 8 s.
2. Wait for the session, up to 9 s. With no session, stop; `auth-gate.js` redirects.
3. Cache the access token and start the 60 s refresh.
4. Read the stage metadata directly: `select stage, variant, tier, tier_rank, techniques, hardest, hardest_rank, clue_count, par_ms
   from arena_sudoku_stages order by stage`.
5. Call `sudoku_overview`, render the map and chips, then `sudoku_stats` quietly.
6. Select the default or deep-linked stage and apply `?tab=`.

### 7.12 Technique chip tooltips
- Naked single: "A cell where only one digit is still possible."
- Hidden single: "A digit that fits in only one cell of a row, column or box."
- Naked pair: "Two cells in a unit holding the same two candidates; those digits leave the rest of the unit."
- Hidden pair: "Two digits that fit only in the same two cells of a unit; those cells lose every other candidate."
- Naked triple: "Three cells in a unit whose candidates are three digits in all; those digits leave the rest of the unit."
- Hidden triple: "Three digits confined to the same three cells of a unit."
- Pointing pair: "Inside a box, a digit sits on one line only, so it leaves that line outside the box."
- Box/line reduction: "On a row or column, a digit sits in one box only, so it leaves the rest of that box."
- X-Wing: "A digit that fits in exactly the same two columns of two rows (or vice versa) leaves those columns elsewhere."
- XY-Wing: "A pivot cell {x,y} and two wings {x,z} and {y,z}: any cell seeing both wings cannot be z."
- Swordfish: "An X-Wing over three rows and three columns."
- Simple colouring: "Colour a digit's conjugate pairs in two colours; a colour that sees itself is false, a cell seeing both colours
  loses the digit."
- X-Chain: "An alternating chain of strong and weak links on one digit; cells that see both ends lose it."
- XY-Chain: "A chain of two-candidate cells; cells that see both ends lose the shared end digit."
- Trial & error: "At some point only a guess settles it: assume a candidate and follow it until it breaks."

### 7.13 The `window.__sudoku` QA hook
The hook is **read-only** with respect to the server; everything still goes through the RPCs and is validated there.

It exposes:
- `state()`, returning `{stage, attempt, grid, status, mistakes, hints, penaltyMs, elapsed, shuffled, tutorial, tutorialStep}` — mig 125
  adds `paused`, `pauseAck` (the server has confirmed the pause), `pauseWhy` (`manual` · `left` · `away` · `server` · `elsewhere` ·
  `offline` · `back`), `pauses`, `pausedMs`, `offline`, `heartbeating`
- `select(i)`, `input(d, asNote)`, `erase()`, `undo()`, `redo()`
- `hint()`
- `openStage(n)`, `startTutorial()`, `setTab(t)`, `selectStage(n, scroll)`
- `flushSave()`, `resyncClock()` (since 125: a forced heartbeat), `openSettings()`, `settings()`, `setSetting(k, v)`
- mig 125: `pause()`, `resume()`, `beat()` — the page's own Pause / Resume / heartbeat paths (the first build had a `pause()` /
  `resume()` pair too; it was removed on 2026-09-29 and is back with the blind pause)

Mig 124 added `openDaily`, `openSprint`, `selectDay`, `setPadMode`, `colour`, `loadEvents`, `daily()`, `sprint()` and more `state()` fields
(§10.7).

The E2E harness depends on it. It can be dropped in the port if pp-os QA drives the UI another way.

---

## 8. Assets and styling

- **Font.** Montserrat from Google Fonts, weights 300–900 plus italic 400. Numbers use `font-variant-numeric: tabular-nums`.
- **Brand colours used.**
  - Teal `#00A0B4`: hinted digits on dark, the boss chip, diagonal shading as `rgba(0,160,180,.10–.12)`, confetti, and (2026-09-30)
    the cleared-by-you tile: fill, border and time text.
  - Purple `#C445C4`: light-theme accent and entries, and the Expert tier.
  - Arena pink `#D373D3`: the dark-theme accent and entries, the Arena chrome; borders use `rgba(255,122,195,…)` as on every Arena page.
  - Yellow `#FFA91F`: gold medals, the par marker, the Hard tier, the tutorial coach (amber), focus/target tints, and (2026-09-30)
    the solid crown everywhere, the cleared-by-others tint and hairline, the frontier rule and the "Cleared up to N" pill. Yellow ramp
    steps: 300 `#FFC870` (gold text on dark), 700 `#E08A00` (the light-theme hairline, as `rgba(224,138,0,.55)`), 800 `#B87100`
    (the crown's edge on light), 900 `#8F5800` (gold text on light).
  - Green `#71B357`: the Basic tier. (It was also the cleared-tile tint until 2026-09-30; cleared-by-you is Teal now.)
  - Celestial Blue `#54A6DE`: the Medium tier.
  - Red `#E72347`: mistakes and clashes, penalties, the Master tier.
  - Bright Blue `#00C4F5`: the Extreme tier.
  - Light Gray `#D9D9D6`: silver in dark mode. Dark Gray `#63666A`: silver in light mode.
  - Dark Teal `#171B24`: given digits in light mode.
- **Bronze** has no brand swatch, so it is `color-mix(in srgb, #FFA91F 55%, #63666A)`: Yellow mixed with Dark Gray. Swap it for the
  official Yellow ramp step once the brand tokens are available.
- **Off-palette.** The light-theme hinted digit `#00839A` is a darker teal chosen for contrast on white. It should be replaced by the
  official Teal ramp step. The cleared-by-you time text uses `color-mix(in srgb, #00A0B4 55%, #fff)` (dark) and
  `color-mix(in srgb, #00A0B4 72%, #000)` (light) for the same reason: the brand tokens carry no Teal ramp yet.
- **CSS variables, dark (`:root`):**
  - Text and lines: `--sd-ink #e9eef7`, `--sd-mut rgba(233,238,247,.62)`, `--sd-faint rgba(233,238,247,.40)`,
    `--sd-line rgba(255,122,195,.26)`, `--sd-line-soft rgba(255,255,255,.08)`.
  - Surfaces: `--sd-panel rgba(15,23,42,.58)`, `--sd-panel-solid #141a28`, `--sd-board rgba(18,22,31,.86)`,
    `--sd-cell-line rgba(255,255,255,.09)`, `--sd-box-line rgba(255,255,255,.34)`.
  - Accents: `--sd-accent #D373D3`, `--sd-accent-soft rgba(211,115,211,.16)`, `--sd-teal #00A0B4`.
  - Digits: `--sd-given #F4F6F8`, `--sd-entry #D373D3`, `--sd-hinted #00A0B4`, `--sd-bad #E72347`, `--sd-ok #71B357`.
  - Highlights: `--sd-peer rgba(255,255,255,.05)`, `--sd-same rgba(211,115,211,.20)`, `--sd-sel rgba(211,115,211,.34)`,
    `--sd-diag rgba(0,160,180,.12)`, `--sd-focus rgba(255,169,31,.22)`.
  - Medals: `--sd-gold #FFA91F`, `--sd-silver #D9D9D6`, `--sd-bronze` (the mix above).
  - Map states (2026-09-30): `--sd-mine-bg linear-gradient(180deg, rgba(0,160,180,.36), rgba(0,160,180,.18))`,
    `--sd-mine-line rgba(0,160,180,.9)`, `--sd-mine-ink color-mix(in srgb, #00A0B4 55%, #fff)`, `--sd-oth-bg rgba(255,169,31,.09)`,
    `--sd-oth-line rgba(255,169,31,.52)`, `--sd-key-line rgba(233,238,247,.18)` (key swatch borders).
  - Crown: `--sd-crown #FFA91F`, `--sd-crown-edge #FFA91F`, `--sd-crown-ink #FFC870` (gold text: the pill, chips, badges).
- **CSS variables, light (`[data-theme="light"]`):**
  - Text and lines: `--sd-ink #0a1520`, `--sd-mut rgba(10,21,32,.64)`, `--sd-faint rgba(10,21,32,.42)`,
    `--sd-line rgba(255,122,195,.38)`, `--sd-line-soft rgba(23,27,36,.09)`.
  - Surfaces: `--sd-panel rgba(255,255,255,.80)`, `--sd-panel-solid #fff`, `--sd-board rgba(255,255,255,.96)`,
    `--sd-cell-line rgba(23,27,36,.13)`, `--sd-box-line rgba(23,27,36,.62)`.
  - Accents: `--sd-accent #C445C4`, `--sd-accent-soft rgba(196,69,196,.12)`.
  - Digits: `--sd-given #171B24`, `--sd-entry #C445C4`, `--sd-hinted #00839A`.
  - Highlights: `--sd-peer rgba(23,27,36,.05)`, `--sd-same rgba(196,69,196,.14)`, `--sd-sel rgba(196,69,196,.24)`,
    `--sd-diag rgba(0,160,180,.10)`, `--sd-focus rgba(255,169,31,.30)`.
  - Medals: `--sd-silver #63666A`.
  - Map states: `--sd-mine-bg linear-gradient(180deg, rgba(0,160,180,.25), rgba(0,160,180,.12))`, `--sd-mine-line rgba(0,160,180,.8)`,
    `--sd-mine-ink color-mix(in srgb, #00A0B4 72%, #000)`, `--sd-oth-bg rgba(255,169,31,.13)`, `--sd-oth-line rgba(224,138,0,.55)`,
    `--sd-key-line rgba(10,21,32,.18)`.
  - Crown: `--sd-crown #FFA91F`, `--sd-crown-edge #B87100`, `--sd-crown-ink #8F5800`.
- **Tier colours:** Basic `#71B357`, Medium `#54A6DE`, Hard `#FFA91F`, Expert `#C445C4`, Master `#E72347`, Extreme `#00C4F5`.
- **Logo.**
  - Dark theme: `assets/Reports/logo-color.png` (white wordmark). Light theme: `assets/Reports/logo-color-black.png`.
  - It is **36 px tall** (the brand minimum is 35 px digital) at opacity .92.
  - It is an in-flow footer at the end of the page wrapper (a flex column with `min-height: 100vh − app bar`), right-aligned to the
    content column. That puts it bottom-right and always **after** the content, never under it. Verified in both themes at 1440 and
    390 px.
- **Icons.** One outlined SVG set with `stroke: currentColor` (brand rule: one colour per set). Covers: undo, redo, erase, pencil,
  auto grid, bulb, restart, gear, back, lock, check, star, trophy, clock, arrow-up, boss ×. Mig 125 brings back a pause glyph — two
  rounded bars (`rect 5.5,4 4.5×16 r1.4` and `rect 14,4 4.5×16 r1.4`, viewBox 24) — and a play triangle for Resume, both **filled** in
  `currentColor` (one colour each, like the crown): on the Pause button, the cover disc, the finish-card line and the board marker.
- **Mig 125 classes:** `.sd-clockrow` (clock + Pause button), `.sd-pausebtn`, `.sd-playwrap` (the cover's positioned parent),
  `#sdGame.is-paused .sd-play { visibility:hidden }`, `.sd-cover` / `.sd-cover .card` (`.glyph`, `.eb`, `.clk`, `.clksub`, `.msg`,
  `.why` / `.why.warn`, `.foot`), `.sd-pzmark` (the board-row marker, 10 px, `--sd-mut`), `.sd-done-pause`. No new colour token: the cover
  uses `--sd-panel-solid`, `--sd-line`, `--sd-accent(-soft)`, `--sd-mut`, `--sd-faint` and `--sd-bad` (the connection-lost line). Page
  weight after 125: 197 KB (176 KB before), no new library.
- **The crown** is the one filled icon (Van 2026-09-30: "fully colored"), still a single colour: `svg.ico-crown` (viewBox 24) is a
  body path `M3.6 9l4.3 3.5L12 5.8l4.1 6.7 4.3-3.5-1.6 8.2H5.2z`, a base band (rect 4.9, 19.1, 14.2 × 2.4, rx 1.2) and three ball
  tips (circles at 3.6/8.7 r1.75, 12/5.3 r1.85, 20.4/8.7 r1.75). CSS fills it with `--sd-crown` and strokes it with `--sd-crown-edge`
  (1.3, round joins, `paint-order: stroke fill`), with selectors specific enough to beat the outline rules of chips, awards and
  buttons. It is used on tiles (14 px), the map key (9 px), the frontier pill and chips (12 px), the crown line (16 px), the ranking
  badge (12 px) and the completion card (18 px).
- **Confetti.** A full-screen canvas with 140 particles for 1.8 s in Teal, Pink, Yellow, Green and Celestial. It is skipped under
  `prefers-reduced-motion`.
- **Motion.** The page fades in (opacity only, never a transform on `body`). There are pulses on the current tile and the tutorial
  target, a cell pop and shake, and toast slides. Reduced motion disables the pulse.
- The page depends on `common.css`, `os-theme.css` and `os-chrome.js` (app bar and theme), and `fit-screen.js`.

---

## 9. QA harness

The scripts under `scratch/` are **gitignored**: they exist only on Van's machine. The committed test is
`scripts/generate-sudoku-stages.test.mjs`. Run everything from the hub repo root. The browser runs need the local static server on
`http://localhost:8123`, plus `.env` with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `HUB_TEST_EMAIL`, read in-process and never
printed.

| Script | How to run | What it proves |
|---|---|---|
| `scripts/generate-sudoku-stages.test.mjs` | `node --test scripts/generate-sudoku-stages.test.mjs` | 9 tests: the counting solver (unique, multiple and contradictory grids); geometry (27 / 29 units, X intersections); a deterministic PRNG and valid random grids (X diagonals included); known puzzles grade right (the Wikipedia example → naked single, AI Escargot → trial depth 2); the grader audit over 80 random puzzles, classic and X (no technique ever removes the true digit; at least 8 techniques exercised); `buildCandidate` is deterministic and honours its spec; symmetry transforms keep grids valid, puzzles unique and grades identical, classic and X; an end-to-end small set (30 stages incl. boss 25) builds, verifies and reproduces; **the seeded set** (when `scratch/sudoku-stages.json` or `SUDOKU_STAGES_FILE` exists): ≥ 300 stages, uniqueness on every stage, monotonic bands, clue ramps, valid X bosses, real chip labels. 9/9 pass |
| generator `--verify` / `--reproduce` | §5.8 | The stored set is sound, and every stage regenerates from its stored seed |
| `scratch/_sudoku-e2e.mjs` | `node scratch/_sudoku-e2e.mjs` (about 12.5 min). `--keep` skips cleanup; `--cleanup-only` just cleans | The full E2E. **286/286 in 748 s** in the final run of 2026-10-02 (after migration 125): the original 128 (twelve rewritten where they asserted the replaced "clock never stops" rule, or used a date-dependent cell — listed under the phases below; Phase C gained 4), Phase D 55, Phase E 59 (one new: the reload pauses the daily), **Phase F 39** (the blind pause, below), the catalogue check; pause shots in `pause\`. Before that, **242/242 in 628 s** in the final run of 2026-09-30 evening (after migration 124): the original **128** checks first and unchanged (128/128 in 387 s before the twists), then Phase D (55, the twists through the RPCs) and Phase E (58, the twists in the browser), and a catalogue-integrity check at cleanup (§10.9). Writes screenshots and `e2e-results.json` to `Desktop\arena-sudoku-qa\` (twist shots in `twists\`). Since the game went live it runs against a ladder with **staff on it**: checks are relative to the live data, real names never reach a log or a screenshot (below), and cleanup proves every staff row that existed before the run is still there |
| `scratch/_sudoku-map-shot.mjs` | `node scratch/_sudoku-map-shot.mjs` (about 1.5 min) | The four map states (2026-09-30) against the live ladder: the test account clears stages 1–2 through the real RPCs while staff have cleared 1–4, then every state is asserted in the DOM at dark/light × 1440/390 (classes, computed colours and opacity, medal and time, crowns only where they belong, the frontier pill on the right band, the gold rule sitting in the gap after the frontier tile only, the key's four labels and its 1-row / 2 × 2 layout, every crown filled `rgb(255,169,31)`). "Crown mine" and the completion crown can't happen live without taking a staff member's crown, so one extra pass rewrites the overview / stage-board / submit responses in the browser only (CDP Fetch) and its files carry `-patched`. Cleanup deletes the test account's rows and proves the staff rows are untouched. **57/57** |
| `scratch/_sudoku-twists-sql-smoke.mjs` | `node scratch/_sudoku-twists-sql-smoke.mjs mig\|nomig <out.sql> [real]`, then `supabase db query --linked -f <out.sql>` | Mig 124 (2026-09-30): a `begin … rollback` functional test run as the hub test account (`request.jwt.claims`), so nothing persists. `mig` inlines the migration (a dry run before applying); `real` uses the seeded catalogue instead of synthetic rows. Covers daily start / resume / tomorrow / yesterday / no puzzle / restart refused, colours saved + validated, tokens on daily ignored, the daily clear, overview + calendar + boards, closed-day refusals, a ladder token earned and spent, stats and ranking keys, the sprint start / clear / overview |
| `scratch/_sudoku-twists-smoke.mjs` | `node scratch/_sudoku-twists-smoke.mjs <outDir> [dark\|light] [width]` | Mig 124: a read-mostly signed-in boot (home, Daily tab, yesterday read-only, Sprint tab, Stats), counts page errors; deletes the player row the visit creates |
| `scratch/_sudoku-twists-play.mjs` | `node scratch/_sudoku-twists-play.mjs <outDir> [dark\|light] [width]` | Mig 124: a UI play-through for iteration — today's daily with colours, reload, Clear, finish, then the ladder Hint button with two banked tokens; writes and then deletes only the test account's rows |
| `scratch/_sudoku-map-preview.mjs` | `node scratch/_sudoku-map-preview.mjs <outDir> [clearer\|van]` | A design preview with no seeding: the overview response is rewritten into a synthetic scenario (Van's view: nothing cleared, staff up to 4; or the clearer's: 1–2 cleared, the crown mine on 1). Deletes the player row the visit creates |
| `scratch/_sudoku-namemask.mjs` | imported by the three browser scripts | Swaps every real staff name for "Staff A/B/…" at the **data layer**: every `/rest/v1/` response a test page receives is rewritten (CDP Fetch, response stage), so no re-render can bring a name back. (Masking the DOM after render raced the ghost line, which re-renders every tick; that is how one early 2026-09-30 shot showed a staff handle — deleted and re-shot.) Each shot is also refused if any real name is on the page |
| `scratch/_sudoku-live-state.mjs` | `node scratch/_sudoku-live-state.mjs` | Counts only, never a name: real players, clears per stage, the real frontier, crowns held, active attempts, and how many test rows exist |
| `scratch/_sudoku-boss-shot.mjs` | `node scratch/_sudoku-boss-shot.mjs` | Temporarily sets the test account's `highest_stage = 24` through the service role, then deletes all its Sudoku rows in `finally`. Proves boss stage 25 opens on the canonical X grid with both diagonals shaded (17 cells), the boss chip shows, a digit repeated **only on a diagonal** is flagged as a conflict, and there is no overflow in either theme at 1440 or 390. **16/16** (2026-09-30, `-v3` shots, names masked) |
| `scratch/_sudoku-xform-sql-test.sql` | `supabase db query --linked -f scratch/_sudoku-xform-sql-test.sql` | For all 300 stages: the SQL shuffle gives 0 invalid rows, columns, boxes or diagonals, preserved clue counts, and givens consistent with the transformed solution |
| `scratch/_syntax-gate.cjs` | `node scratch/_syntax-gate.cjs tools/arena-sudoku.html tools/arena.html index.html` | `vm.Script` compiles each inline `<script>` block, plus a strict UTF-8 and U+FFFD check. 0 errors |
| `scratch/_sudoku-node-check.cjs` | `node scratch/_sudoku-node-check.cjs tools/arena-sudoku.html` | Mig 125: extracts every inline `<script>` to a temp file and runs `node --check` on it (run after every edit). 3 scripts, 0 failed |
| `scratch/_sudoku-pause-sql-smoke.mjs` | `node scratch/_sudoku-pause-sql-smoke.mjs mig\|nomig` (runs `supabase db query --linked` itself) | Mig 125: a `begin … rollback` functional test as the hub test account (`request.jwt.claims`), nothing persists. `mig` inlines 125 (the dry run before applying), `nomig` tests the live database. `now()` is frozen in a transaction, so time passing is simulated by moving the attempt's timestamps back. 29 checks: fresh attempt keys; the never-heartbeated gate; the first heartbeat; pause with the board; the four `paused` refusals; a second pause doesn't save; frozen elapsed on re-open; `overview.active`; resume banks exactly 30 000 ms; 40 s silence counted; a 60 s outage reconciled from `last_seen_at`, frozen at the last heartbeat, resume banks 60 000; the clear (elapsed = wall − pauses, the clear row, the best view, the board, the ranking); `over` after a clear; restart banks an open pause and starts clean; a pause board that rewrites a given / has notes out of range raises 22023 and does not pause; a paused daily (re-open, overview, resume, clear, board); a sprint puzzle paused alone, its clear and the week total; a closed day. **29/29** both before and after applying |
| `scratch/_sudoku-pause-probe.mjs` | `node scratch/_sudoku-pause-probe.mjs <outDir> [dark\|light] [width]` | Mig 125 development probe: the test account on stage 1 in a real browser — the Pause button and the first heartbeat, P covers everything and the moves ride along, frozen clock, input refused, Resume banks the pause, a hidden tab's keepalive pause, the cover staying on return, the offline cover and reconnect, ‹ Stages, re-opening on the cover, a navigation's keepalive pause with the last move; deletes the test account's rows. **14/14** (dark 1440, light 390) |
| `scratch/_sudoku-fn-parity.mjs` | `node scratch/_sudoku-fn-parity.mjs <live.json> 122.sql 124.sql 125.sql` (live.json = `pg_proc` names + `md5(prosrc)` from `supabase db query`) | Mig 125: every live `sudoku*` / `_sudoku*` function body equals the latest migration that defines it. 32/32 before 125, **42/42** after |
| `scripts/check-static.mjs` | `node scripts/check-static.mjs` (the repo CI) | `node --check` on every `shared/` and `scripts/` JS file, and no broken local refs |
| advisors | `supabase db advisors --linked --type security` | Only `authenticated_security_definer_function_executable` (WARN): 11 for the Sudoku RPCs after 122, 16 after 124, **19 after 125** (the three pause RPCs), which is expected (84 project-wide, all the same lint). No anon, search_path, RLS or definer-view findings; the seven new 125 helpers are not exposed |
| `scratch/_sudoku-bots-gone.mjs` | `node scratch/_sudoku-bots-gone.mjs` | No throwaway `sudoku-qa-*` auth users remain |
| probes | `_sudoku-probe.mjs`, `_sudoku-hist.mjs`, `_sudoku-rare.mjs`, `_sudoku-tutorial-design.mjs`, `_sudoku-smoke.mjs` | Development probes: yields per band, grade histograms, rare-technique yields, the search that found the tutorial grid, a boot smoke test |

**E2E phases** (`_sudoku-e2e.mjs`).
- **Phase A, security and fairness through the RPCs.** Two throwaway staff accounts, `sudoku-qa-a@…` and `sudoku-qa-b@…`, are created
  with the admin API and signed in with random passwords held in-process. The phase proves:
  - anon refused (42501)
  - secret and attempt tables unreadable (42501)
  - no puzzle or solution column on the stage table
  - direct writes refused; helpers not callable
  - the tutorial gate and the stage-skip refusal
  - a canonical first attempt, with no solution or xform in the payload, resuming the same attempt
  - save refusals (bad grid, changed givens, bad notes, someone else's attempt)
  - check: wrong charged once, right free, given and out-of-range refused
  - (mig 125, rewritten) **the pause RPCs exist** — `sudoku_pause`, `sudoku_resume`, `sudoku_heartbeat` on a missing / someone else's
    attempt refuse with `P0002`, and anon is refused (until 125 this check asserted `PGRST202`, function not found)
  - **the clock runs with nobody calling** on a never-heartbeated attempt (what a pre-125 page makes): re-opening it after 3.2 s of
    silence shows ≥ 3.1 s more elapsed, and `paused` is false
  - the hint is correct (+60 s) and can't repeat
  - incomplete refused; a wrong full grid returns only a count (+1 mistake)
  - an instant clear refused (the floor)
  - a clear stores server times and penalties and takes the crown
  - the penalty box holds; a cleared attempt can't be resubmitted
  - a replay is shuffled (`applyXform` of the canonical puzzle), clears with the relabelled solution, doesn't progress, and sets a PB
  - the rate limit throttles a 90-call burst
- **Live-data rules (2026-09-30).** Staff hold the crowns on stages 1–4, so a bot's first clear of stage 1 must leave the crown with
  its first clearer; stage player counts include the staff clearers; ranking checks look at the test rows' relative order; and the
  Arena card's leader is whoever leads the live ranking.
- **Phase B, leaderboard setup.** Bot B clears stage 1 and opens stage 2.
  - **Opening another stage never stops a clock.** Bot B opens a stage-1 replay two seconds in and re-opens stage 2 1.5 s later. The
    stage-2 clock gained ≥ 3.4 s, and both clocks are running at once. (Still true after 125: nothing pauses another attempt, and the
    bots never heartbeat.)
  - A restart proves the shuffle and the restart count, and bot B clears stage 2.
  - Bot A waits out its 90 s penalty box and clears stage 2 later. The ranking puts B above A on the same stage (earlier `reached_at`).
- **Phase C, the browser**, as the hub test account. Sign-in: a service-role `generateLink` magic link, then `verifyOtp` in the page;
  no token is ever printed. The phase covers:
  - the map draws 301 tiles; no overflow
  - the tutorial through the UI, with the note auto-clear and the clock step (mig 125: "stops only while the board is hidden", Pause / P,
    leaving pauses it, Restart's fresh clock); completion stored
  - Settings has 7 options with no auto-pause toggle (auto-pause is a rule, not a setting); the 7 tools are unchanged; the Pause button
    sits by the clock and the cover is hidden while playing (mig 125)
  - stage 1 on the canonical grid; auto-check turned on through Settings; the wrong digit shown red; a hint
  - (mig 125, rewritten from "P does nothing") **P pauses**: the cover hides the whole board (no cell, note or pad drawn) and the clock
    freezes; **P again resumes** from where it stopped
  - **navigating away for 3 s** (to the Arena page and back): the panel offers "Continue — paused at m:ss", re-opening shows the cover
    first, and after Resume the same attempt and grid come back with the time away **not** counted (mig 125; it was "counted")
  - **a refresh straight after a move**, too fast for the 1 s autosave: the keepalive pause on pagehide carried the digit; the page
    re-opens on the cover and the reload time is not counted; the notes come back exactly as they were on screen (mig 125: the pause
    carries the whole board, so a hint's own peer-note clean-up is saved too — before, that clean-up was never saved and the refresh
    brought an old note back, which the check expected)
  - finishing through the UI (the last cell only after the floor has run — the floor counts running time); the server elapsed is
    finish − start − paused_ms to the ms; three pauses (P, away, refresh) on the attempt and on the clear row; the finish card says
    "Paused 3× · m:ss"; penalties applied; the modal shows the server time; Next waits out the penalty box
  - the stage top 5 (the faster bot outranks you; the crown shows the first clearer; mig 125: my paused clear carries the marker
    "paused 3 times (m:ss)")
  - the ranking order; the stage-2 countdown, then the unlock, on the same canonical grid the bots got
  - tampering from the page (skip, bad shape, rewritten givens, direct secret reads)
  - no solution in any browser response; no page errors
  - **the four map states** after the first clear, against the live ladder: my stage teal with no crown while a staff member holds
    it; stage 2 open now and already cleared by others (pink + their crown); stages ahead that others cleared in the gold state; the
    first stage nobody has cleared plain locked; the pill "Cleared up to N" (N from the database) and exactly one gold rule; the key's
    four labels; every crown filled solid gold; the gold crown chip in the game bar; the ranking's crown badges
  - layouts in dark and light at 1440 and 390 (replays through the UI; logo placement)
- **Wiring phase.** The Arena landing page shows 5 cards on one row, the Sudoku card stat, the top-of-the-leaderboards row and the crown
  highlights, and the card opens the game. The hub shows Sudoku in the Arena window (a real dock click), and the hub search finds
  Sudoku.
- **Phase D, the twists through the RPCs** (mig 124, after every original phase so their checks see the ladder exactly as before) and
  **Phase E, the twists in the browser** (dark / light × 1440 / 390; a third bot, `sudoku-qa-c@…`, signs in in its own browser context)
  — the full list is in §10.9. The two phases share one block scope so no name can clash with the original phases. Since mig 125 an
  attempt left earlier re-opens on the cover, so the browser flows press Resume first (`resumeIfPaused`), the floor helpers count running
  time only, and the main tab is brought to the front before it plays (a background tab is "hidden" — headless too — and pauses itself).
  The 2026-09-30 colour check used a fixed cell 4 as "a given"; on 2026-10-02 cell 4 is the daily's third empty cell, so the check now
  uses the first given.
- **Phase F, the blind pause** (mig 125; after every earlier phase, in the same block scope) — listed under "Phase F" below.
- **Cleanup** always runs, in `finally`. It deletes every crown, clear, attempt and player row of the five accounts (the pause facts
  live on those rows) and deletes the four throwaway auth users (`sudoku-qa-a…d`), then checks that no test row is left and that **every staff row that existed before the run still exists**
  (by primary key, per table). Staff rows are never written: every write is a test account's own RPC call or a delete filtered by a
  test account's id. While a run is going, the test accounts show on the stage 1–2 boards for a few minutes.

**Phase F, the blind pause** (mig 125, 2026-10-02; after Phases A–E so their checks see the game as before).
- **F1, through the RPCs** — bot A's open stage-1 replay from Phase A (never heartbeated): the payload's pause keys (`heartbeat_ms`
  15 000, `stale_after_ms` 45 000) and `last_seen_at` null; the first heartbeat stamps it; a pause that carries the board saves it and
  stops the clock; **3.2 s later the server elapsed is identical to the millisecond**; save / check / hint / submit refused `paused` (with
  the message); a second pause neither changes anything nor saves its board, and the refused check / hint charged nothing; resume banks
  ≥ 3.2 s (floored), counts one pause and the clock goes on from where it stopped (± 0.4 s); 1.2 s later it shows +1.2 s; **an outage** —
  the bot's own `started_at` / `last_seen_at` moved back 60 s through the service role — the next save is refused `paused`, `paused_at`
  equals `last_seen_at`, the elapsed is frozen at the value of the last heartbeat (± 5 ms), and resume banks the whole ≥ 60 s gap as one
  more pause; 40 s of silence (under 45 s) is counted as play; the clear's elapsed = finish − start − paused_ms (± 2 ms) and the clear row
  carries pauses 2 and the banked time. **The gate:** bot B's stage-1 replay from Phase B (never heartbeated, silent for minutes) is never
  auto-paused or refused. **Restart** of a paused attempt banks the open pause on the old one and starts the new one at 0:00 with zeroed
  counters and `last_seen_at` null. **Sprint:** bot A's fifth puzzle pauses alone (the four cleared untouched), its clear carries the
  pause, and the week board sums it. **Daily:** a fourth bot, `sudoku-qa-d@…` (the others had cleared today's), pauses today's daily — it
  re-opens paused, the overview says so — and its clear, clear row and the day's board row carry the pause. **Marker data:** bot D's
  stage-1 first clear with a pause shows `pauses` / `paused_ms` on the stage board's `me` row and the ranking's `me` row, and every row has
  the keys.
- **F2, in the browser** (the test account) — dark 1440: the map tile reads "paused" and the panel "Continue — paused at m:ss"; the
  cover shows the stage, the frozen time, the message and one Resume, with **nothing of the puzzle drawn** (0 visible cells, notes,
  pad keys, tools, ghost markers, mini-board rows — computed `visibility`); no overflow, the logo rule; Resume; **a real tab switch**
  (opening another tab makes this one hidden, headless too) pauses it by itself, covered here and paused on the server; the other tab
  opens the same attempt on the cover; back on the first tab the cover stays and the pause is confirmed; a `BroadcastChannel` message
  from another tab covers the board at once; a synthetic `visibilitychange` → hidden covers it and the keepalive pause lands; stage 2
  finished with its pauses → the finish card "Paused N× · m:ss" equals the clear row; the stage top 5 marks my row "paused N times
  (m:ss)"; the ranking row carries the marker. Light 1440: stage 3 paused with the Pause button, cleared, the finish card and the marker.
  Phones (dark / light 390): stage 4 on the cover; light 390 also loses the connection (`setOfflineMode`) — covered at once, Resume
  disabled "Reconnecting…" — and comes back: the pause reaches the server and Resume is offered. No solution in any response.

**Screenshots** go to `Desktop\arena-sudoku-qa\`: 01 and 11 map; 02, 02b and 13 tutorial; 03 tutorial notes; 04 settings; 05 and
14 mid-game with notes and highlights; 07 and 16 completion; 08 and 12 top 5; 09 and 17 ranking; 10 stats; 18 logo at the page bottom;
19 Arena landing; 20 hub window; 21 boss; 22 map states; 23 map with the crown mine; 24 stage panel crown; 25 ranking crowns;
26 game-bar crown chip; 27 completion crown.
- **v1 files** (no suffix) are the first build and include 06 and 15 "paused". **v2 files** (`-v2` suffix, 2026-09-29) are the no-pause
  build, with no paused screen.
- **v3 files** (`-v3` suffix, 2026-09-30) are the four-state map build with solid crowns, taken on the live ladder with every staff
  name shown as "Staff A/B/…". 22 is the map for a player who has cleared 2 stages while staff have cleared 4 (dark and light, 1440
  and 390). 23, 26 and 27 carry `-patched` (browser-only response rewrites, no database write). 19 and 20 were not re-shot in v3:
  those pages carry other games' staff names and did not change, so the v2 files stand.
- 02b-tutorial-clock-step-v2 shows the "clock never stops" tutorial step of the 2026-09-29 build; the `-v4` file of the 2026-10-02 run
  (re-taken by every E2E run) shows the blind-pause step.
- **`pause\`** (mig 125, 2026-10-02): `p01-cover-dark-1440` / `p01-cover-light-1440` (the cover), `p02-finish-pauses-dark-1440` /
  `-light-1440` (the finish card with "Paused N× · m:ss"), `p03-board-marker-dark-1440` / `-light-1440` (the stage top 5 with the
  marker on my row), `p03b-ranking-marker-dark-1440`, `p04-cover-mobile-dark-390` / `-light-390` (the phone cover),
  `p05-offline-light-390` (the connection-lost cover). Staff names are masked as in every other shot.

---

## 10. The twists (migration 124, 2026-09-30)

Van approved the twists on 2026-09-30 (brief `hub-arena-sudoku-twists.md`, plan `PLAN-sudoku-twists.md`, both on his Desktop): a daily
challenge, a colour highlighter, streak badges, hint tokens, a weekly sprint and, optionally, Killer-cage bosses. The first five are built,
applied and verified; the Killer cages are a plan only (§10.8). Every rule Van had settled at the time still held: **the clock never stops after Play** (replaced on 2026-10-02 by the blind pause, §4.3 —
it applies to the daily and the sprint too);
**penalties, not strikes** (+0:30 a wrong digit, +1:00 a hint, three hints per attempt, every puzzle completable); **the crown is the first
clear and gold is the best time**; stage order; one grid per stage; the per-stage top 5; the server clock and server-side penalties; every
write through an RPC; the ranking by highest stage, then who got there first. The ladder behaves exactly as before (the original E2E checks
run first and unchanged, §10.9).

Source of truth: `supabase/migrations/124_arena_sudoku_twists.sql` (applied live 2026-09-30 with `supabase db query --linked -f`, then
re-run once to prove it converges), `scripts/generate-sudoku-stages.mjs` (`--daily`, `--sprint`), its tests, `tools/arena-sudoku.html`,
and the private, gitignored `scratch/sudoku-specials.json` (all daily and sprint solutions — never commit it).

### 10.1 What changed underneath (shared by all five)
**One attempts table, generalised by mode.** Instead of a second set of tables and ~500 duplicated lines of RPCs, `arena_sudoku_attempts`
learned which kind of puzzle an attempt belongs to:

| Column | Type | Default | Meaning |
|---|---|---|---|
| mode | text | `'ladder'` | `check (mode in ('ladder','daily','sprint'))` (`arena_sudoku_attempts_mode_check`) |
| special_id | int | null | FK → `arena_sudoku_specials(id)` on delete cascade. Set for daily / sprint attempts |
| stage | int | — | **Now nullable**: null for daily / sprint attempts |
| colors | jsonb | `'[]'` | The highlighter: 81 ints 0..6 (§10.3) |
| token_hints | int | `0` | How many of the attempt's hints a token paid for (§10.5) |

- `arena_sudoku_attempts_target_check`: ladder ⇔ `stage` set and `special_id` null; daily / sprint ⇔ `stage` null and `special_id` set.
- `arena_sudoku_attempts_token_hints_check`: `0 ≤ token_hints ≤ hints`.
- Unique index `arena_sudoku_attempts_one_special (user_id, special_id) where special_id is not null`: one attempt per player per daily or
  sprint puzzle, ever. Index `arena_sudoku_attempts_special_idx (special_id)`.
- Existing rows took the default `mode = 'ladder'`; nothing else about them changed.

Every game RPC takes an attempt id, so `sudoku_save`, `sudoku_check`, `sudoku_hint`, `sudoku_restart` and `sudoku_submit` now serve any
mode; only *opening* a puzzle needed new RPCs (`sudoku_daily_start`, `sudoku_sprint_start`). Helpers:
- `_sudoku_solution(attempt)` — the stage's secret through the attempt's xform, or the special's secret (always canonical).
- `_sudoku_live(attempt) → boolean` — ladder always; a daily only on its Melbourne day; a sprint puzzle Monday..Sunday of its week.
- `_sudoku_attempt_penalty(attempt) → bigint` — `mistakes × 30 000 + max(0, hints − token_hints) × 60 000`. It replaced
  `_sudoku_penalty(m, h)` everywhere an attempt is at hand (that function still exists, unchanged).
- `_sudoku_special_new_attempt(user, special)` — attempt 1, kind `'first'`, xform null, puzzle = grid = the special's givens.
- `_sudoku_finish_special(player, attempt, grid, elapsed, pen) → jsonb` — the daily / sprint settlement (§10.2, §10.6).
- `_sudoku_streak_info(user) → jsonb` — §10.4.
All seven are `set search_path = public, pg_temp` with EXECUTE revoked from `public, anon, authenticated`.

**The payload (`_sudoku_payload`)** keeps every 122 key and adds `mode`, `colors`, `token_hints`, `hint_tokens` (the player's bank) and
`special` (null on the ladder, else `{id, kind, day, slot, tier, tier_rank, techniques, clue_count, closes_at}`). For a special `stage` is
null and `variant` / `par_ms` come from the catalogue; `penalty_ms` uses `_sudoku_attempt_penalty`. Still never the solution or the xform.

**Closed puzzles.** After their status check, `sudoku_save`, `sudoku_check`, `sudoku_hint` and `sudoku_submit` return
`{ok:false, reason:'closed', message:'This puzzle has closed - its board is read-only now.'}` when `_sudoku_live` is false.

**Signature changes.** Dropped and re-created in the same transaction, with defaults so every older call (named arguments, the old page's
keepalive beacon included) still resolves:
- `sudoku_save(p_attempt bigint, p_grid text, p_notes jsonb, p_colors jsonb default null)`
- `sudoku_hint(p_attempt bigint, p_cell int, p_token boolean default false)`

Re-running 122 after 124 would put back 122's bodies and signatures; re-running 124 afterwards converges again.

**Other 122 objects touched** (`create or replace`, keys only added): `sudoku_restart` (refuses daily / sprint attempts, `P0001`
"Only ladder stages restart - a daily or sprint clock never resets"), `sudoku_overview` (`me` + `best_streak`, `streak_badges`,
`hint_tokens`, `sprint_wins`; `streak_days` now from the streak view; `active` filtered to `mode = 'ladder'`), `sudoku_ranking` (each row +
`streak`), `sudoku_stats` (+ `streak_badges`, `next_badge`, `hint_tokens`, `tokens_earned`, `tokens_spent`, `daily_played`,
`daily_cleared`, `daily_gold / silver / bronze`, `daily_best_ms`, `sprint_weeks`, `sprint_best_rank`, `sprint_wins`), `sudoku_submit`.
`players` gained `hint_tokens int 0 check 0..5`, `tokens_earned int 0`, `tokens_spent int 0`; `clears` gained `token_hints int 0`.

**Legacy columns.** `players.streak_days / best_streak / last_clear_day` are still written by the ladder submit exactly as in 122 (Brisbane
days, ladder clears only), but nothing reads them any more; the streak view is the truth (§10.4). A port can drop them.

**Melbourne time.** Every day and week boundary is `(now() at time zone 'Australia/Melbourne')::date`, DST included: the sprint week that
holds Sunday 2026-10-04 (DST starts that morning) closes at Monday 00:00 AEDT = Sunday 13:00 UTC. Countdown targets come from the server
as timestamps, e.g. `next_at = ((today + 1)::timestamp at time zone 'Australia/Melbourne')`.

**Security.** RLS on the three new tables; the secrets table has a deny-all policy and every privilege revoked from `anon, authenticated`
(a direct read is 42501); the catalogue and the clears are readable by staff only; no table has an insert / update / delete policy. The
five new views are `security_invoker = on` over public tables. `supabase db advisors --linked --type security` after 124: only
`authenticated_security_definer_function_executable` (WARN), 16 for Sudoku (122's 11 + the 5 new RPCs), and no other finding in the project.

### 10.2 Daily challenge
**Rules.**
- One puzzle per Melbourne calendar day, the same canonical grid for everyone (no shuffle key), outside the ladder: no tutorial gate, no
  stage order, no penalty box, no crown.
- Monday–Wednesday are **Medium** (pairs and triples, hardest ranks 3–6), Thursday–Sunday **Hard** (intersections and X-Wing, ranks 7–9).
  Par is always between 6:00 and 10:00.
- Playable only on its day: before it, `not_yet`; after it, `closed` — including an attempt still open at midnight, whose board goes
  read-only from then on.
- One attempt and one clear per player per day. There is **no restart** — a fresh clock would let a player study the grid and then reset.
  The page's **Clear** wipes entries, notes and colours while the clock keeps running.
- The clock starts when the puzzle is opened (server `started_at`) and, since mig 125, stops only while its board is hidden (§4.3; a paused
  daily still belongs to its day and closes at midnight like any open one). Same penalties, the same 250 ms/cell floor, the same
  count-only wrong submit. Hint tokens do not apply (§10.5).
- The day's board: top 10 by `final_ms`, then `finished_at` (`rank()`); gold, silver and bronze are the day's ranks 1–3, live like stage
  medals.
- A day's givens, and the player's own final grid, are shown only once the day has closed. Solutions never leave the server.
- The catalogue is readable up to Melbourne tomorrow only (RLS): the tomorrow teaser shows its band and par, nothing further ahead.

**Data model.**
- `arena_sudoku_specials` — the public catalogue, shared with the sprint: `id int identity PK`, `kind ('daily'|'sprint')`, `day date`,
  `slot int 1..5` (daily: 1), `variant`, `tier`, `tier_rank`, `techniques text[]`, `hardest`, `hardest_rank`, `clue_count`, `par_ms`,
  `difficulty`, `created_at`; `unique (kind, day, slot)`; checks: a daily is slot 1, a sprint row's day is a Monday. RLS: authenticated
  `select` where `day <= Melbourne today + 1`; anon revoked; writes revoked.
- `arena_sudoku_special_secrets` — `special_id` PK/FK (cascade), `puzzle ^[0-9]{81}$`, `solution ^[1-9]{81}$`, `seed`, `gen jsonb`.
  Deny-all RLS and all privileges revoked from `anon, authenticated`.
- `arena_sudoku_special_clears` — `id identity`, `attempt_id` unique FK (cascade), `special_id` FK (cascade), `kind`, `day` (the special's
  day), `slot`, `user_id` FK (cascade), `name`, `final_ms`, `elapsed_ms`, `penalty_ms`, `mistakes`, `hints`, `finished_at`;
  `unique (special_id, user_id)`; indexes `(special_id, final_ms, finished_at)` and `(user_id, kind, day)`. Kept apart from
  `arena_sudoku_clears` so the ladder views stay untouched. RLS: staff read all.
- View `arena_sudoku_special_ranks`: every special clear + `pz_rank = rank() over (partition by special_id order by final_ms, finished_at)`
  + `pz_players`.

**RPCs.**

| Signature (returns jsonb) | Cost | Behaviour | Returns |
|---|---|---|---|
| `sudoku_daily_start(p_day date default null)` | 1 | null = Melbourne today. No catalogue row → `no_puzzle`. A future day → `not_yet` (+ `opens_at`). An attempt already cleared → `cleared` (+ `final_ms`). A past day → `closed`. An active attempt → resumed, its clock running all along. Otherwise a new attempt | `{ok, resumed, state}` or `{ok:false, reason, message, …}` |
| `sudoku_daily_overview()` | 0 | — | `{today, next_at, puzzle:{id, day, tier, tier_rank, par_ms, clue_count, techniques, variant} \| null, my:{status 'none'\|'active'\|'cleared', attempt_id, started_at, elapsed_ms (active only), final_ms, rank, medal}, players, leader:{name, final_ms, me} \| null, tomorrow:{day, tier, tier_rank, par_ms} \| null, calendar:[30 × {day, has_puzzle, tier, tier_rank, par_ms, status null\|'active'\|'played'\|'cleared', final_ms, rank, medal, players}] oldest first, streak:{…§10.4}, server_now}` |
| `sudoku_daily_board(p_day date default null)` | 0 | No puzzle → `{day, has_puzzle:false}`. A future day → `{day, has_puzzle:true, future:true, opens_at}` (nothing else) | `{day, has_puzzle, is_today, closed, id, tier, tier_rank, par_ms, clue_count, techniques, top:[≤10 {rank, name, final_ms, finished_at, mistakes, hints, streak, me}], me:{rank, final_ms, finished_at, mistakes, hints} \| null, players, my_status 'none'\|'active'\|'played'\|'cleared', givens (closed days only), my_grid (closed days I played), server_now}` |

A correct daily submit (`sudoku_submit` runs the shared validation, then `_sudoku_finish_special`): the attempt becomes `cleared` with the
server times; one `special_clears` row; the player's `updated_at`; the ladder counters (`clears`, `total_*`) are not touched. It returns
`{ok:true, mode:'daily', kind:'first', special:{id, kind, day, slot, tier, tier_rank}, final_ms, elapsed_ms, penalty_ms, mistakes, hints,
rank, players, medal, par_ms, par_beaten, streak_days, best_streak, new_badge, next_at, sprint:null, server_now}`.

**Generator and seeding (where the seed lives).**
- The same private master seed as the ladder: `SUDOKU_MASTER_SEED` (env or `.env`) or `scratch/sudoku-master-seed.txt`. The generator
  refuses to mint a new master for daily / sprint puzzles.
- Per-candidate seed `sha256('arena-sudoku|daily|v1|' + master + '|' + day + '|1|' + k).hex.slice(0, 24)`. Bands:
  `DAILY_BANDS.medium = {ranks 3–6, target 27 clues, tol 2, fan 20}`, `hard = {ranks 7–9, 27, 2, 20}`; a candidate whose par falls outside
  360–600 s is skipped. Classic grids only; exactly one solution by the counting solver; the stored `seed` + `gen {v, kind, variant, target,
  lo, hi, tol, fan, par}` rebuild it byte for byte.
- Commands (repo root):
  - `node scripts/generate-sudoku-stages.mjs --out scratch/sudoku-specials.json --daily 2026-09-29 401 --sprint 2026-09-28 58 [--quiet]`
    — 691 puzzles in 24 s, verified as it writes.
  - `--verify scratch/sudoku-specials.json` · `--reproduce …` · `--apply …` — the three existing modes recognise a daily / sprint file by
    its records' `kind`. `--apply` uses the service role from `.env` in-process, upserts the catalogue on `(kind, day, slot)` then the
    secrets, leaves identical rows alone and skips a row whose puzzle would change once anyone has an attempt on it (unless `--force`).
- `verifySpecials` checks: kind and slot rules; each key once; no repeated grid; consecutive days in the weekday rhythm; sprint weeks keyed
  by Monday with slots 1–5; classic; exactly one solution; a valid solution; givens agree; clue count; the grade and the par reproduce; the
  hardest rank inside the band; the par inside the window.
- **Seeded 2026-09-30:** 401 days, 2026-09-29 → 2027-11-03. Medium 173 (naked pair 78, hidden pair 77, naked triple 13, hidden triple 5),
  Hard 228 (pointing 174, box/line 38, X-Wing 16); clues 29 → 25; par 6:00–8:15 (Medium), 6:15–10:00 (Hard). 2026-09-29, the day before
  launch, is seeded on purpose so a read-only "yesterday" exists from the first day. **Top up before 2027-11-03** with a later
  `--daily <from> <count>` run (existing days are left as they are).

**Client surfaces.**
- **Home:** an events strip between the hero and the tabs. The "Today's puzzle" card: a date tile, the band chip, par, a medal disc when
  top 3, a status line (the day's clearers and fastest, or "Your clock is running — m:ss so far" live, or "Cleared in m:ss.t · #r of n
  today") and a live countdown "Next puzzle in h:mm:ss". Button: "Play today's puzzle" / "Continue — clock running" (mig 125: "Continue — paused" with the status
  line "Paused at m:ss — the clock is stopped.", the time taken from `my.elapsed_ms` / `my.paused`, not from `started_at`) / "Today's board".
  A click anywhere else on the card opens the Daily tab.
- **Daily tab** (`?tab=daily`, `&day=YYYY-MM-DD` preselects a day): the rules line; the today box (weekday, band, clues, par, status,
  tomorrow's band and the countdown, Play / Continue); the **Last 30 days** calendar — a Monday-first 7-column grid, max 520 px wide, cells:
  no puzzle (dimmed, disabled), not played (plain), played (pink border), active (pink dot), cleared (teal fill + time), today (pink ring),
  selected (outline), a medal disc for ranks 1–3, the band's stripe. The side panel shows the selected day: title and band, "clues · par ·
  today / closed", technique chips; on a closed day a lock note and a read-only mini board (its givens, or my own grid if I played); the top
  10 (medal discs, streak chips, my row pinned below when outside it); the players line; Play / Continue on today.
- **Game:** title "Daily · Wed 30 Sept" + band chip; chips "Closes at midnight" and the techniques (or "Singles"); the Restart tool reads
  **Clear** ("Clear your entries — the clock keeps running"; confirm "Clear the board?"); the mini board is "Today's top 5" and feeds the
  ghosts; the save line "Daily puzzle · saved on the server".
- **Completion:** "Daily puzzle cleared" / "Daily · <day> · <band>"; the time and breakdown; awards: the medal or "#r of n today", "Beat
  par", the streak (or "New badge — a N-day streak, yours for good"), "The next daily opens in h:mm:ss"; buttons "Stage map" and
  "Today's board ›".
- **Closed mid-game:** when the server answers `closed` (or the page's clock passes `closes_at` and a resync confirms it) the board
  freezes, a toast explains, and the page returns to the Daily tab.

### 10.3 Colour highlighter
- A client-side solving aid (Cracking the Cryptic style): six colours and None (no colour). 1 Yellow `#FFA91F`, 2 Green `#71B357`, 3 Teal `#00A0B4`,
  4 Celestial Blue `#54A6DE`, 5 Red `#E72347`, 6 the neutral gray (Light Gray `#D9D9D6` on dark, Dark Gray `#63666A` on light). Purple is
  left out on purpose: it would read as the selection tint. Fills are translucent tokens `--sd-c1…6` (dark .52 / .52 / .56 / .52 / .50 /
  .32, light .40 / .36 / .32 / .34 / .26 / .28). The brand's ramp steps aren't in this repo; a port should use their light steps.
- **Toggled from the pad:** a "Digits | Colours" switch above the pad (key **C**). In Colours the pad becomes seven keys (six swatches +
  None; 4 columns on desktop, one row on phones); keys 1–6 paint, 0 / Backspace / Delete clear, the same colour again clears. Any cell
  can be coloured, givens and hinted cells included. The pad returns to Digits at the start of every game.
- **Rendering:** an inset box-shadow (`.cfx` + `.cf1`…`.cf6`) sits above the row/column/same-digit tints and below the digit, the notes
  and the red marks; a selected coloured cell keeps its true colour with a 3 px accent ring.
- **Undo / redo** include colours (every snapshot carries `c`). Clear on a daily / sprint wipes them; a ladder Restart deals a new attempt
  with none.
- **Saved like notes:** `sudoku_save(…, p_colors)` — 81 ints 0..6, else `22023` "Colours are 81 numbers" / "… from 0 to 6"; null keeps the
  stored colours; the keepalive beacon sends them too. Stored in `attempts.colors`, returned in the payload. No judgement ever reads them
  (the E2E clears a daily with colours still on the board).
- The tutorial allows colours locally (not saved).

### 10.4 Streak badges
- A streak is consecutive **Melbourne** days with at least one clear of any kind — a ladder stage, a replay, a daily or a sprint puzzle —
  dated by `finished_at`. (122 counted ladder clears on Brisbane days; the two agree until DST starts on 2026-10-04.)
- The **current** streak is the run that ends today or yesterday (a streak is lost only once a whole day passes without a clear). The
  **best** is the longest run ever.
- **Badges** at 3, 7, 14, 30 and 100 days are earned by the best streak and kept for good. `next_badge` is the next threshold above the
  current streak.
- Views (security_invoker): `arena_sudoku_clear_days` (a `union all` of clears and special clears → `user_id, day, source`) and
  `arena_sudoku_streaks` (gaps and islands: `day − row_number() over (partition by user_id order by day)` groups consecutive days →
  `streak_days`, `best_streak`, `last_clear_day`). `_sudoku_streak_info(user)` →
  `{streak_days, best_streak, last_clear_day, badges:[…], next_badge}`, zeros for someone who never cleared.
- Outputs: `sudoku_overview().me` (`streak_days`, `best_streak`, `streak_badges`); `sudoku_stats()` (`streak_days`, `best_streak`,
  `streak_badges`, `next_badge`); the `streak` of every ranking row and every daily / sprint board row; both submit paths return
  `streak_days`, `best_streak` and `new_badge` (the highest threshold this clear crossed, from the best streak before and after it).
- Client: player-card chips "N-day streak" (gold, flame) and "N-day badge" (the best one earned, the title lists them all); a flame chip
  with the current streak on ranking rows and on the daily / sprint boards; the Stats tile "Streak" (days · best · next badge at N) and a
  strip of five medallions (earned: a solid gold ring; not yet: dashed); completion awards "New badge — a N-day streak, yours for good" or
  "N-day streak — clear anything tomorrow to keep it going".

### 10.5 Hint tokens
- **Earned:** +1 for every ladder stage **first-cleared** with zero hints, capped at 5 banked. Replays and retries after a clear earn
  nothing (otherwise stage 1 could be farmed); daily and sprint clears earn nothing. `token_earned = first_clear and hints = 0 and bank < 5`.
- **Spent:** `sudoku_hint(…, p_token => true)` on a **ladder** attempt with a token makes that hint free: `token_hints + 1`, the bank − 1,
  `tokens_spent + 1`. It still counts toward the three-per-attempt ceiling. With no token, or on a daily / sprint, the hint costs the usual
  +1:00 and reports `token_used:false`. `_sudoku_player(1)` locks the player row for the whole call, and the check constraint
  `arena_sudoku_players_hint_tokens_check (0..5)` refuses a negative or a sixth token even to a direct write.
- The ranked time and the penalty box use `_sudoku_attempt_penalty` (paid hints only); `arena_sudoku_clears.token_hints` records the free ones.
- Outputs: payload `hint_tokens`, `token_hints`; hint `{…, token_used, hint_tokens, token_hints}`; ladder submit `{…, token_earned,
  hint_tokens, token_hints}`; `sudoku_overview().me.hint_tokens`; `sudoku_stats()` `hint_tokens`, `tokens_earned`, `tokens_spent`.
- Client: the page sends `p_token: true` whenever the attempt is a ladder one and the bank is above 0 — tokens are spent automatically.
  The Hint tool reads **"Hint · N tokens"** and takes Restart's second grid column while tokens are banked; on phones (icons only) a gold
  mini badge with N sits top-left of the bulb. Toast "Hint: D at rRcC — why (a token paid for it — no penalty · N left)"; timer line
  "H/3 hints (T free)"; breakdown "(…, T free with a token)"; completion award "Hint token earned for a clear with no hints — N banked…";
  player-card chip "N hint tokens"; Stats tile "Hint tokens N/5 · earned · spent".

### 10.6 Weekly sprint
**Rules.**
- A sprint week runs Monday 00:00 to Sunday 23:59, Melbourne. Its key is the Monday (`day`), its label the ISO week
  (`to_char(day, 'IYYY-"W"IW')`, e.g. 2026-W40).
- Five puzzles, one per band: 1 Basic, 2 Medium, 3 Hard, 4 Expert, 5 Master (Extreme is left out). Classic, canonical, the same for everyone.
- Any order. Each puzzle's clock starts when that puzzle is opened and (mig 125) stops only while its board is hidden — a pause per
  puzzle; resume any time during the week. One attempt per puzzle
  and no restart (Clear, as on the daily). The same penalties; tokens don't apply.
- One total per player: the sum of the five `final_ms`, penalties included. Only players with all five are ranked (`row_number` by the
  total, then the time of their fifth clear, then user id); the others are "still racing".
- The **Sprint winner** is rank 1 of an **ended** week. It is derived from the clears (nothing is stored), so it is kept for good.
- Puzzles are open only during their week (the next week is `not_yet`, a past week `closed`).

**Data model.** Catalogue rows in `arena_sudoku_specials` (kind `'sprint'`, day = the Monday, slots 1–5), secrets in
`arena_sudoku_special_secrets`, clears in `arena_sudoku_special_clears`. Views: `arena_sudoku_sprint_totals` (`week, user_id, name, done,
total_ms, completed_at, week_rank` — null unless `done = 5` — and `week_finishers`) and `arena_sudoku_sprint_winners` (`week_rank = 1` and
`week + 7 <= Melbourne today`).

**RPCs.**

| Signature (returns jsonb) | Cost | Behaviour | Returns |
|---|---|---|---|
| `sudoku_sprint_start(p_slot int, p_week date default null)` | 1 | A slot outside 1..5 raises `22023` "A sprint puzzle is slot 1-5". `p_week` is any day of the week (normalised to its Monday); null = this week. No row → `no_puzzle`; a future week → `not_yet` (+ `opens_at`); cleared → `cleared`; a past week → `closed`; active → resumed; otherwise a new attempt | as `sudoku_daily_start` |
| `sudoku_sprint_overview(p_week date default null)` | 0 | A future week → `{week, future:true, starts_at}` | `{week, iso_week, starts_at, ends_at, is_current, closed, slots:[5 × {slot, id, tier, tier_rank, par_ms, clue_count, techniques, my:{status, attempt_id, started_at, final_ms, elapsed_ms (active), rank} \| null, players, top:[≤5 {rank, name, final_ms, me}]}], top:[≤10 {rank, name, total_ms, done, completed_at, streak, me}], me:{rank, total_ms, done, completed_at} \| null, finishers, racers, winners:[the last 8 ended weeks {week, iso_week, name, total_ms, finishers, me}], my_wins, server_now}` |

A sprint clear (via `_sudoku_finish_special`) also returns `sprint:{done, total_ms, rank, finishers, slots:5, ends_at}`.
`sudoku_overview().me.sprint_wins`; `sudoku_stats()` `sprint_weeks` (weeks with all five), `sprint_best_rank`, `sprint_wins`.

**Generator.** `SPRINT_SLOTS`: Basic `{ranks 1–2, 38 clues, tol 1, par 150–300 s}`, Medium `{3–6, 30, 2, fan 20, 270–480}`, Hard `{7–9,
29, 2, 20, 360–600}`, Expert `{10–11, 28, 2, 20, 480–840}`, Master `{12–14, 27, 2, 20, 600–1200}`. Seed
`sha256('arena-sudoku|sprint|v1|' + master + '|' + isoWeek + '|' + slot + '|' + k)`; `--sprint <from> <weeks>` starts at the Monday of
`from`'s week. **Seeded:** 58 weeks, 2026-W40 (Mon 2026-09-28) → 2027-W44 (Mon 2027-11-01): Basic (naked single 51, hidden single 7; par
3:30), Medium (5:15–7:15), Hard (6:15–9:15), Expert (XY-Wing 57, Swordfish 1; 8:30–13:30), Master (colouring 22, X-Chain 12, XY-Chain 24;
11:00–19:45). A week's pars add up to roughly 35–50 minutes. Top up with the daily (same run).

**Client surfaces.**
- **Home:** the "Weekly sprint · Week N" card: five pips (teal cleared, pink running), "k of 5 done", the total and rank once complete, the
  leader, "Ends in Nd hh:mm"; button "Play the sprint" / "Continue the sprint" / "Sprint board" (all open the tab).
- **Sprint tab** (`?tab=sprint`): the rules; a line with the week's dates, the end countdown and my progress; five cards (tier stripe,
  "Puzzle n", tier, clues · par, "Not started" / "Clock running — m:ss" live (mig 125: "Paused at m:ss" while paused, the time from `my.elapsed_ms`) /
  "Cleared in m:ss.t · #r", the fastest, Play / Continue;
  5 columns on desktop, 3 at ≤ 1060 px, 2 on phones); "Sprint winners" for the last eight ended weeks ("The first winner is crowned when
  this week ends…" until then); the side board "This week's board": top 10 by total with medal discs and streak chips, my row pinned as
  "You · k/5", "N finished · M still racing".
- **Game:** title "Sprint · puzzle n" + tier chip; chips "Week N · n of 5" and the techniques; Clear; the mini board "Fastest on this sprint
  puzzle"; completion "Sprint puzzle cleared" with the rank on that puzzle, par, "k of 5 done · m:ss so far" or "Sprint complete — total
  m:ss.t · #r of n this week", the streak; buttons "Stage map" and "Sprint board ›".
- Player-card chip "Sprint winner [×N]" (gold trophy); the Stats tile "Sprints" (weeks with all five · wins · best rank).

### 10.7 Other client changes
- Tabs: **Stages · Daily · Sprint · Ranking · Stats**; `?tab=daily|sprint` deep links.
- A 1 s ticker drives every countdown (`data-cd-at`) and running clock (`data-run-from`), reloads the overviews when a day or week turns
  over, and asks the server (via a save) when an open daily / sprint passes its `closes_at`.
- Leaving a daily / sprint game ("Today's board ›", "Sprint board ›", "‹ Stages") saves, loads the fresh overviews first and then
  switches to that tab once, so the board never flashes stale data. "Stage map" goes back to the Stages tab as on the ladder.
- "How it works" gained five bullets after the original eight: Daily puzzle, Weekly sprint, Streaks, Hint tokens, Colours.
- Keyboard: **C** toggles Digits / Colours; in Colours 1–6 paint and 0 / Backspace / Delete clear.
- `window.__sudoku` (still read-only toward the server — every action is the UI's own path): `state()` adds `mode`,
  `special {id, kind, day, slot}`, `colors` (an 81-character string), `colourMode`, `hintTokens`, `tokenHints`; new `openDaily(day)`,
  `openSprint(slot, week)`, `selectDay(day)`, `setPadMode(on)`, `colour(k)`, `loadEvents()`, `daily()`, `sprint()`.
- Unchanged on purpose: the 7 tools (Restart is relabelled Clear on a daily / sprint), the 7 settings, the tutorial's 11 steps, the map.
- Weight: the page is 176 KB (120 KB before); no new library.
- New CSS tokens: `--sd-c1…6`, `--sd-sw6`; classes `.sd-events/.sd-ev`, `.sd-cal/.sd-cd`, `.sd-mini`, `.sd-spz`, `.sd-badges/.sd-badge`,
  `.sd-rkstreak`, `.sd-padmode`, `.sd-cpad/.sd-ckey`, `.sd-tool .tk/.tkb`.

### 10.8 Killer-cage bosses — planned, not built
The brief made this optional and last ("only if 1–5 are done, verified and documented"; "if you cannot finish cleanly, leave the code out
and describe the plan"). It was not started, so there is no Killer code anywhere. The plan, for Van or the pp-os port (about 2–3 days):
1. **Scope.** The bosses at stages 100, 200 and 300 become Killer X-Sudoku: X-Sudoku rules plus cages — each cage shows a sum, and a digit
   can't repeat inside a cage. Everything else about a boss (canonical first attempt, crown, medals) is unchanged.
2. **Data.** `arena_sudoku_stages.variant` gains `'killer-x'`; the cages are part of the puzzle, so they are secret until Play:
   `arena_sudoku_stage_secrets.cages jsonb` (`[{sum, cells:[…]}]`), returned by `_sudoku_payload` for the attempt.
3. **Shuffles.** A digit relabelling changes cage sums, so a Killer retry / replay may only use the geometric symmetries that keep both
   diagonals (the 24-element row group × the column choice × transpose, with `d` = identity: 96 variants — still enough to defeat typing
   from memory). `_sudoku_xform_random` and `randomXform` get a `'killer-x'` branch; `_sudoku_apply` maps cage cells with the same
   row/column maps.
4. **Generator.** Build a solution, partition it into connected cages of 2–5 cells with no repeated digit, then dig givens symmetric as now;
   the counting solver gets cage constraints (per-cage used-digit masks + precomputed digit-combination masks per (sum, size)); the grader
   gets Killer techniques (cage combinations, the rule of 45 innies/outies) as new ranks inside the band, or boss grading would be wrong;
   `verifyRecords` checks cage sums against the solution and uniqueness with cages. Regenerate only those three stages (`--apply` skips a
   stage anyone has an attempt on — today staff are at stage 4, so decide before anyone reaches 100).
5. **Server validation.** Unchanged: the full-grid comparison with the (unique) solution already judges a Killer grid; the 250 ms floor
   holds.
6. **Client.** Cage outlines (dashed inner borders) with the sum in each cage's top-left cell; conflicts for a repeat in a cage or a cage
   whose filled digits exceed its sum; notes auto-clear inside the cage; a "BOSS · Killer" tile label; a rules bullet; no tutorial change.

### 10.9 QA (2026-09-30)
- **Unit tests** `node --test scripts/generate-sudoku-stages.test.mjs`: **14/14** (the original 9 + calendar helpers, daily determinism /
  bands / par window / reproduce, sprint weeks, `verifySpecials` negative cases, the seeded specials file).
- **Generator**: `--verify` and `--reproduce` clean for the 300 stages and the 691 daily / sprint puzzles.
- **Migration**: dry-run inside `begin … rollback` first, then a rolled-back functional smoke (`scratch/_sudoku-twists-sql-smoke.mjs`),
  applied, re-applied (converges), smoke re-run against the seeded catalogue.
- **The E2E** `node scratch/_sudoku-e2e.mjs`: **242/242 in 628 s** (final run, 2026-09-30 evening, Melbourne 22:33–22:43). The
  original **128** checks (Phases A, B, C, wiring, the layout passes and the two cleanup checks) run first and unchanged, so the ladder is
  proven exactly as before; Phase D adds **55** RPC checks, Phase E **58** browser checks, and cleanup one catalogue-integrity check.
  - **Phase D (RPC):** the catalogue (yesterday / today / tomorrow + five sprint slots; readable up to tomorrow only; no puzzle or
    solution column; secrets 42501; anon refused; no direct clear writes; the new helpers not callable) · the daily (canonical grid, no
    solution in the payload, resume with the clock running, tomorrow `not_yet`, yesterday `closed`, no puzzle, off the ladder map, restart
    refused) · colours (saved, 0–6 and length validated, a save without colours keeps them, back on resume) · tokens (2 and 1 banked from
    Phase B's first clears; ignored on the daily; free, free, paid, then the 3-hint ceiling; the clear's penalty = the paid minute, the
    penalty box likewise; no token for a clear with hints; the cap at 5; the check constraint refuses −1 and 6; the ledger) · the day's
    clears and board (server time + penalties, one clear per day, ordering, medals, faster-first, no givens while open) · a closed day
    (save / check / hint / submit all `closed`; the read-only board shows givens, never the solution) · the calendar and the tomorrow
    teaser · the sprint (any order, canonical grids, parallel clocks, slot 6 / next week / unseeded week / restart refused, the week so
    far on every clear, one total = the five times, only finishers ranked, ordered, no winner before the week ends) · the Sprint winner on
    an ended week (a rolled-back SQL test: the fastest finisher wins, four of five is never ranked, the badge on the winner's stats /
    overview / winners list, not on the runner-up's, nothing left behind) · **streak arithmetic** on a scripted sequence of backdated clears
    for bot C: none → 0/0; D-3, D-2 → 0/2; + D-1 → 3/3 [3]; + D-8…D-5 → 3/4 [3]; + D-4 → 8/8 [3, 7]; a second D-4 → unchanged;
    + D-13…D-9 → 13/13 [3, 7]; (Phase E: today's daily in the browser → 14/14 [3, 7, 14] with "New badge — a 14-day streak");
    + D-60…D-31 → 14/30 [3, 7, 14, 30]; + D-160…D-61 → 14/130 [3, 7, 14, 30, 100]. The backdated rows are deleted straight after.
  - **Phase E (browser):** dark 1440 as the test account — the event cards (band, par, a ticking countdown), the five tabs with the map
    intact, the calendar ending today with no tomorrow cell, yesterday read-only (its givens on the mini board, no Play), the daily played
    through the UI (canonical grid, game bar, colours by key and by pad incl. a given, saved on the server, undo / redo, reload restores
    digits + colours, Clear keeps the clock, a +1:00 hint, the completion screen, the clear stored with colours still on the board, the
    board / calendar / card after), the Hint button "Hint · 2 tokens" and a free token hint (server ledger 2 → 1), the Sprint tab (five
    bands, bot B ranked, bot A racing), sprint puzzle 1 through the UI, the player card, Stats tiles and badges, the ranking streak chip,
    the rules; light 1440 as bot C in its own browser context — the same surfaces, its daily crossing 14 days in the browser, all five
    badges earned; dark 390 and light 390 as the test account — every tab, sprint puzzles 2–5 through the UI (the fifth completes the week
    and ranks it), the phone token badge; no overflow and the logo rule on the new screens; no solution (stage, daily or sprint) in any of
    the browser's REST responses; no page errors.
  - **Cleanup** deletes every row of the four accounts and the three throwaway users; checks that no test row is left, that every staff
    row that existed before still does, and that the catalogue is exactly 401 daily + 290 sprint puzzles with 691 secrets.
- **Screenshots** `Desktop\arena-sudoku-qa\twists\` — `t01` home + event cards · `t02` Daily tab + calendar · `t03` yesterday read-only ·
  `t04` a game with colours · `t05` the Clear confirm · `t06` the daily completion (light: with the 14-day badge) · `t07` after the clear ·
  `t08` "Hint · 2 tokens" (phones: the badge) · `t09` a token hint used · `t10` Sprint tab · `t11` sprint completion (`-complete-light-390`:
  the whole week) · `t12` Sprint tab after a clear · `t13` Stats + badges (`-all-light-1440`: all five) · `t14` ranking with streak chips ·
  `t15` rules — each in the layouts listed above (39 files). The original set was re-shot on this build with the `-v4` suffix
  (`-v3` kept).
- **Advisors** `supabase db advisors --linked --type security`: only `authenticated_security_definer_function_executable` WARN — 16 for
  Sudoku (11 + 5 new) — and nothing else in the project.

---

## 11. Known gaps and proposed twists

**Known gaps and caveats.**
- **External solvers can't be prevented.** A player can type any grid into an outside solver. The design removes in-game shortcuts
  (pre-scouting, restart scouting, replay memorization, hint or guess progression, instant scripted clears), not deliberate cheating.
- **No realtime.** Boards load when a stage is opened and ghosts load at stage start, so a clear by someone else mid-game isn't pushed
  live.
- **No Sudoku "Live now" entry** on the Arena page, because attempts are private by design. The hub Arena card has no stat line (it
  follows the Skribbl pattern).
- **Attempts never expire.** An abandoned active attempt stays active indefinitely — since mig 125 normally **paused** (the page pauses on
  leaving, or the reconcile does 45 s after the last heartbeat); one from a pre-125 page keeps running until the new page opens it.
  `status 'abandoned'` exists but nothing sets it, and there is no sweeper. That is harmless, because only finished attempts rank.
- **The blind pause's residual loopholes** (accepted by Van, 2026-10-02 — §4.3): photographing the board, then pausing; reading the board
  from the page's memory or its responses while covered; blocking only the heartbeat requests so the reconcile backdates a pause. All are
  deliberate cheating; an honest player never gains. An outage of 45 s or less is counted as play. (Until 2026-10-02 there was no pause at
  all, so a stage left open overnight carried the night in its time.)
- **A paused attempt stays paused** indefinitely, like an abandoned one (no sweeper). Harmless: only finished attempts rank.
- **The cover hides the board, not the data**: the payload still carries the grid while paused (§3.4); withholding it was considered and
  rejected (resume → read → pause takes a second, and an old page would crash on a null grid).
- **Two windows side by side** on one attempt can both show the board (neither is hidden), both heartbeat, and the clock runs. Tabs in
  one window cannot: the hidden one pauses, and the tab channel covers the other.
- **A pre-125 page** (still open or cached when 125 went live) never heartbeats, so its attempts keep the never-stopping clock until the
  new page opens them (§4.3, the gate). Once the new page is everywhere this is moot.
- **No admin tools** to void a clear, reset a player or move a crown. Only SQL through the service role.
- **Hint explanations** detect only naked and hidden singles; anything else says "found with a harder technique".
- **Two devices** on one attempt are last-write-wins for grid and notes; the clock stays correct because it is server-side.
- **The tutorial's solution is in the page.** That is intended, since the tutorial is never ranked.
- The `leads` tier is still allowed. It is retired with zero members, but it is kept to match every other Arena gate.
- **Colours still to swap:** the light-theme hinted teal `#00839A`, the cleared-by-you teal text mixes and the bronze mix, all pending
  the official ramp steps.
- **Ranking crown badges match by name** (2026-09-30). Ranking rows carry names, not ids, so another player's crown count is matched on
  the name recorded with each crown; a rename between first clears undercounts. A port should return `crowns` per ranking row.
- **The frontier is client-side** (the overview's crowns and per-stage player counts). A port could return it from the server.
- `CLAUDE.md`'s tool list has not been updated to mention `arena-sudoku.html` (it carried the owner's uncommitted work at build time).
- Generating the full set takes about 3.6 minutes. Rare exact grades (Swordfish ≈ 0.2% of candidates) drive most of that time.

**Gaps that came with the twists (mig 124).**
- **The catalogue runs out.** Dailies are seeded to 2027-11-03 and sprints to 2027-W44. Top up before then with one generator run
  (`--daily <from> <count> --sprint <from> <weeks>`, then `--apply`); nothing alerts when it gets close.
- **Daily / sprint attempts past their window stay `active`** forever (like abandoned ladder attempts). Harmless: they are refused as
  `closed` and never rank.
- **No realtime** on the day's or the week's board either; the overviews reload when a game ends, a tab opens or a day turns over.
- **Tokens are spent automatically** by the page when banked (no "save it for later" choice). The server takes `p_token`, so a port can
  offer the choice without a migration.
- **The Arena landing page has no daily / sprint entry** (the brief kept everything inside the Sudoku page). The arena's old "Daily —
  coming soon" idea could now link to `arena-sudoku.html?tab=daily`.
- **Legacy streak columns** on `arena_sudoku_players` are still written and never read (§10.1).
- **Highlighter colours** are base accents at an alpha, pending the brand's ramp steps.
- **Page weight** grew from 120 KB to 176 KB.

**Proposed twists, with their status.**
| Twist | Status |
|---|---|
| Daily challenge | **Built 2026-09-30** (§10.2) |
| Colour highlighter (Cracking the Cryptic style) | **Built 2026-09-30** (§10.3) |
| Streak badges | **Built 2026-09-30** — 3 / 7 / 14 / 30 / 100 days, any clear (§10.4) |
| Hint tokens | **Built 2026-09-30** — earned by a zero-hint first clear, not by beating par; free within the 3-hint cap, not beyond it (§10.5) |
| Weekly sprint | **Built 2026-09-30** — five fresh puzzles Basic → Master, not 10 shuffled stages (§10.6) |
| Killer-cage bosses (stages 100, 200, 300) | **Planned, not built** (§10.8) — about 2–3 days |

---

## 12. Changelog

- 2026-09-28 — initial build
- 2026-09-29 — The clock never stops after Play: Pause, the auto-pauses and the one-clock-at-a-time rule removed (Van: closes the solve-it-outside loophole)
- 2026-09-30 — The stage map's four states (Van): cleared by you (a filled teal tile, your time and medal, the crown only when it's yours), cleared by others (a gold hairline and their solid crown, kept bright while locked), open now (pink), locked (dimmed); the frontier ("Cleared up to N" on its band, a gold rule after that tile); a map key; a "Reading the map" rule; every crown now one filled solid-gold shape (tiles, key, chips, stage panel, completion) plus crown badges in the ranking
- 2026-09-30 — twists: daily challenge, colour highlighter, streak badges, hint tokens, weekly sprint (migration 124; the Killer-cage bosses are planned, not built — §10.8)
- 2026-10-02 — blind pause: the clock stops only while the board is hidden; auto-pause on leaving the tab, closing the game and connection loss (heartbeat); no penalty, times still rank (Van)
