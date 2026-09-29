# Arena Sudoku — feature inventory for the pp-os port

This file describes everything the hub's Sudoku game does, so the pp-os port can rebuild it feature for feature. It describes the
build of 2026-09-28 (hub repo, migration 122). Sudoku is a stage race on a shared puzzle: 300 graded stages plus a stage-0 tutorial.
Everyone plays the same grid per stage. There is a per-stage top 5, an overall ranking by the highest stage cleared (ties go to
whoever got there first), and first-clear crowns, medals, ghost splits and X-Sudoku boss stages. The server is authoritative for the
clock, the solution and every judgement.

Source of truth in the hub repo:

| What | Path |
|---|---|
| Game page (all client code, one file) | `tools/arena-sudoku.html` |
| Migration (tables, views, RPCs, grants, group wiring) | `supabase/migrations/122_arena_sudoku.sql` |
| Generator + technique-grading solver + CLI | `scripts/generate-sudoku-stages.mjs` |
| Unit tests (`node --test`) | `scripts/generate-sudoku-stages.test.mjs` |
| Wiring | `shared/tool-registry.js`, `tools/arena.html`, `index.html` |
| Private, gitignored (never commit) | `scratch/sudoku-stages.json` (all solutions), `scratch/sudoku-master-seed.txt` (master seed), `scratch/_sudoku-*.mjs` (QA) |

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
| streak_days | int | `0` | not null |
| best_streak | int | `0` | not null |
| last_clear_day | date | null | AEST day of the last clear (`Australia/Brisbane`) |
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
| started_at | timestamptz | `now()` | not null. The server clock start (the moment Play is pressed). The clock never stops after this |
| mistakes | int | `0` | not null |
| hints | int | `0` | not null |
| wrong_pairs | int[] | `'{}'` | not null. `cell*10 + digit` for each wrong pair already charged |
| hinted_cells | int[] | `'{}'` | not null. Cells revealed by hints (locked) |
| saves | int | `0` | not null |
| last_save_at | timestamptz | null | |
| finished_at | timestamptz | null | Set on a successful submit |
| ended_at | timestamptz | null | Set on restart |
| elapsed_ms | bigint | null | Set on clear: finished − started (pure wall clock) |
| penalty_ms | bigint | null | Set on clear |
| final_ms | bigint | null | Set on clear: elapsed + penalty (the ranked time) |
| created_at | timestamptz | `now()` | not null |

There are **no pause columns**. The first build had `paused_at`, `paused_ms` and `pauses`. Since 2026-09-29 migration 122 no longer
creates them and drops them with `alter table … drop column if exists`, so re-running the file converges any project that still has
them. Do not add a pause to the port (§4.3).

Indexes:
- `arena_sudoku_attempts_one_active`: **unique** on `(user_id, stage) where status = 'active'`, so there is one active attempt per
  player per stage.
- `arena_sudoku_attempts_user_stage_idx` on `(user_id, stage, id desc)`.
- `arena_sudoku_attempts_stage_idx` on `(stage)`, the FK index.

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
  hints, finished_at, kind from arena_sudoku_clears order by stage, user_id, final_ms, finished_at`. Each player's best clear per stage.
- **`arena_sudoku_stage_ranks`**: `arena_sudoku_best.*` plus
  `stage_rank = rank() over (partition by stage order by final_ms, finished_at)` and
  `stage_players = count(*) over (partition by stage)`. A medal is `stage_rank` 1..3.
- **`arena_sudoku_ranking`**: built from two CTEs.
  - `prog` = `distinct on (user_id)` over clears where `first_clear`, ordered by `user_id, stage desc, finished_at`. It gives
    `highest_stage = stage` and `reached_at = coalesce(unlocked_at, finished_at)`.
  - `tot` = `sum(final_ms)` and `count(*)` from `arena_sudoku_best` per user, giving `total_ms` and `stages_cleared`.

  Output: `rank = row_number() over (order by highest_stage desc, reached_at asc, user_id)`, then `user_id, name, highest_stage,
  reached_at, total_ms, stages_cleared`.

### 2.8 RLS policies
RLS is enabled on all six tables.

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
user-facing RPCs are `SECURITY DEFINER` and granted to `authenticated` and `service_role`. The 11 internal helpers are revoked from
`public, anon, authenticated`, so only the owner can run them.

**Removed 2026-09-29:** `sudoku_pause(bigint)`, `sudoku_resume(bigint)` and the helper `_sudoku_pause_others(uuid, bigint)`. The
migration now carries `drop function if exists` for all three. Calling a removed RPC returns PostgREST **`PGRST202`** ("Could not find
the function", HTTP 404). Nothing in the port may bring them back (§4.3).

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
   - Costs: `sudoku_save` 0.5. Overview, board, ranking and stats cost 0. Every other game RPC costs 1.
   - The E2E showed a burst of 90 concurrent checks had 27 refused.

### 3.2 Internal helpers
| Function | Kind | Behaviour |
|---|---|---|
| `_sudoku_band_perm() → int[]` | invoker, volatile | A random band-preserving permutation of 0..8: bands shuffled, rows within each band shuffled. 1-based array, position i+1 holds the value for index i |
| `_sudoku_xform_random(p_variant text) → jsonb` | invoker, volatile | Returns `{r:[9], c:[9], d:[0,…9 digits], t:0/1}` (§4.8) |
| `_sudoku_apply(p_grid text, p_x jsonb) → text` | invoker, immutable | Null `p_x` returns the grid unchanged. Otherwise `target(R,C) = d[S′(r[R], c[C])]`, where S′ is the transpose of S when `t=1` and d[0]=0 keeps blanks blank |
| `_sudoku_solution(p_attempt attempts) → text` | definer, stable (sql) | `_sudoku_apply(stage_secrets.solution, attempt.xform)`: the solution as this attempt sees it |
| `_sudoku_elapsed(p_attempt) → bigint` | invoker, stable | `greatest(0, floor(ms of (coalesce(finished_at, ended_at, now()) − started_at)))`. Pure wall clock, with nothing subtracted |
| `_sudoku_penalty(m int, h int) → bigint` | immutable | `m × 30000 + h × 60000` |
| `_sudoku_payload(p_attempt) → jsonb` | definer, stable | The client state object (§3.4) |
| `_sudoku_new_attempt(p_user uuid, p_stage int) → attempts` | definer | See `sudoku_start` below. It never touches any other attempt |
| `_sudoku_attempt_for_update(p_user uuid, p_attempt bigint) → attempts` | definer | Locks the caller's attempt. Anyone else's, or a missing one, raises **`Attempt not found`** (`P0002`) |
| `_sudoku_check_grid(p_attempt, p_grid text)` | invoker, stable | The grid must match `^[0-9]{81}$`, else **`A grid is 81 digits (0 = empty)`** (`22023`). Givens must be unchanged, else **`The given digits cannot change`** (`22023`). Hinted cells must equal the stored grid, else **`Hinted cells cannot change`** (`22023`) |

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

### 3.4 The attempt state object (`_sudoku_payload`)
`{attempt_id, stage, attempt_no, kind, variant, shuffled (= xform is not null), puzzle, grid, notes, status, elapsed_ms (server wall
clock since started_at), penalty_ms, mistakes, hints, hints_left (= max(0, 3 − hints)), hinted_cells, wrong_cells, restarts, par_ms,
server_now}`. There is no `paused` field.
- `wrong_cells` lists the cells whose current grid digit is a charged wrong pair, so a resumed board shows the reds already paid for.
- `restarts` is the count of this user's `restarted` attempts on the stage.
- The object never includes the solution or the xform.

### 3.5 What a correct `sudoku_submit` does, in order
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
| `22023` | Invalid input: unknown stage, grid or notes shape, changed givens or hinted cells, cell or digit out of range, checking or hinting a given |
| `PGRST202` (HTTP 404) | PostgREST "Could not find the function": calling the removed `sudoku_pause` or `sudoku_resume` |

---

## 4. Game rules

### 4.1 Tutorial gate
Stage 1 and above need `players.tutorial_done_at`. Otherwise `sudoku_start` returns `reason:'tutorial'`. The tutorial is never ranked;
it is stored only as that timestamp.

### 4.2 Stage order
Stage n can start only if `n ≤ highest_stage + 1`. Cleared stages can be replayed at any time.

### 4.3 The clock: it never stops once you've seen the grid
This is Van's decision of 2026-09-29, and it is load-bearing. With a pause, a player could see the grid, stop the clock, solve it
outside the game, then resume and type it in. So from Play to submit the time is **wall clock, whatever happens**. The only exits are
finishing, or **Restart**, which deals a shuffled grid with a fresh clock.
- **Start.** `started_at` is the server `now()` at attempt creation, which happens the moment Play is pressed (`sudoku_start`). The
  puzzle arrives in the same response.
- **Elapsed.** `floor(ms(coalesce(finished_at, ended_at, now()) − started_at))`, minimum 0, with **nothing subtracted**. It is computed
  server-side at every call and returned as `elapsed_ms`. It is **never taken from the client**.
- **There is no pause.** No RPC, no column, no button, no key, no setting, no auto-pause. The clock keeps running when:
  - the player leaves the game view (the "Stages" button flushes the save and returns to the map)
  - the tab is hidden or the page is closed or refreshed
  - the player opens another stage
  - the laptop sleeps
- **Several clocks can run at once.** Opening, re-opening or starting a stage never touches any other attempt. Each active attempt's
  clock runs from its own `started_at`.
- **Nothing is lost when leaving.** When the tab hides (`visibilitychange`) and on `pagehide` (close or refresh), the client sends a
  keepalive POST of `sudoku_save` if the board has unsaved changes. The request is `fetch(url, {keepalive:true})` to
  `/rest/v1/rpc/sudoku_save` with the headers `apikey` and `Authorization: Bearer <cached access token>`. The token is refreshed every
  60 s; this is the same pattern as `pp-telemetry`. There is no pause beacon.
- **Client display.** The clock shows the race time, `elapsed + penalties`.
  - It is re-synced from every RPC response's `elapsed_ms` and ticks locally every 250 ms. Hidden tabs keep counting, because
    `performance.now()` keeps advancing.
  - When the tab becomes visible again, the client **re-syncs with the server** through `sudoku_save` (current board). That corrects
    for a sleeping laptop or a throttled background tab. If that returns `over` (the attempt was cleared or restarted in another tab),
    the client says so and returns to the map. `sudoku_start` is deliberately not used for this, because re-opening a stage cleared
    elsewhere would deal a new replay.
  - Re-opening a stage whose attempt is still active returns it with its full elapsed time, and the toast says "Back to your grid —
    the clock kept running (m:ss so far)".

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
that fast; a script does.

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
    cleared stage.
  - The player's own row is highlighted. If it falls outside the top 50 it is pinned below the table.
  - Players who have only done the tutorial don't appear. The page shows "Clear stage 1 to appear on the ranking."
  - Rule text on the page: "Highest stage cleared wins. On the same stage, whoever got there first ranks higher (server time,
    penalties included)."
- **Per-stage top 5.** Each player counts once, by their best clear (min `final_ms`; ties go to the earlier `finished_at`), ranked
  with `rank()`.
  - Rows show rank (a medal disc for 1–3), name (with "(you)" on your own row), time `m:ss.t`, and date (`d Mon`).
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
  (only if you hold any); "N crowns" (a gold chip with the solid crown); "Ranked #N"; "N-day streak" (only above 1).
- **Streak timezone.** A day is an AEST day (`Australia/Brisbane`, no DST) with at least one clear. The current streak shows 0 once the
  last clear is older than yesterday.
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

  - They combine with: `active` (an attempt with its clock running: a pink dot top-left and "playing"), `sel` (the selected tile: a
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
    | Attempt in progress | "Continue — clock running" | "You opened this stage m:ss ago — the clock has been running ever since." For shuffled attempts: "This shuffled attempt started m:ss ago — …". Uses `active[].started_at` from the overview |
    | Cleared | "Replay for a better time" | "Your best: m:ss.t · #r of n. Replays are shuffled and never change your ladder position." |
    | Current, penalty box running | "Opens in m:ss" (disabled; counts down every 500 ms and re-renders at 0) | "Serving penalty time from your last clear." |
    | Current | "Play stage N" | "The clock starts when you press Play and never stops — leaving, refreshing or opening another stage keeps it running." |
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
- **The clock is the server's**: "The clock starts when you press Play and never stops — leaving, refreshing or opening another stage
  keeps it running. Restart deals a shuffled grid with a fresh clock."
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
- A "‹ Stages" button. It flushes the save and returns to the map; **the clock keeps running**.
- Title "Stage N" with a tier chip, or "Stage 0 · Tutorial".
- Chips:
  - "Boss · X-Sudoku" on bosses.
  - Technique chips, excluding naked and hidden singles. If a stage has only singles, it shows one "Singles" chip.
  - "Shuffled" on shuffled attempts, with the tooltip "Restarts and replays swap rows, columns and digits: same logic, same difficulty,
    but memory won't help."
  - A gold crown chip (`.sd-chip.gold`: gold text on a gold tint, the solid crown) with the holder's name, or "Your crown".
- A "Settings" button.

**Timer row.**
- A large race clock, `m:ss` or `h:mm:ss`, with a small line under it: "Running since Play — it never stops", "Stopped at the clear",
  or on the tutorial "Practice clock — nothing is timed here".
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

There is **no pause cover and no paused board state**. The board is always visible while an attempt is open.

**Tools (7)**, with their disabled states. On desktop they sit in a 4-column grid, with Restart spanning two columns in the second
row; on phones all 7 sit in one row.

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
| Esc | Close Settings, the rules or the confirm dialog, otherwise deselect |

There is **no P (pause) shortcut** any more; P does nothing. Pointer input selects on `pointerdown` (with `preventDefault`), so it is
fast on touch.

### 7.4 Settings
There are 7 settings. They are stored per viewer in `localStorage['pp-sudoku-settings-v1']`, wrapped in try/catch, and are never
trusted by the server. The first build's `autoPause` ("Pause when I leave the tab") setting was removed 2026-09-29; an old stored value
is ignored.

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
  save queues another one.
- **Keepalive save.** When the tab hides and on `pagehide`, the page sends a keepalive `sudoku_save` if there are unsaved changes, so a
  move made just before a refresh or close is never lost. This is the only thing that happens on leaving; **the clock is not stopped**.
- **Return to the tab.** The page re-syncs the clock through `sudoku_save` (§4.3).
- **Resume.** `sudoku_start` returns the active attempt on any device, with grid, notes, hinted cells, wrong cells, mistakes, hints and
  the full elapsed time; the clock kept running. The toast says "Back to your grid — the clock kept running (m:ss so far)". The map
  marks active attempts, several of which can be running. Two devices writing at once is last-write-wins.

### 7.8 Completion screen (modal)
- Confetti plays (§8).
- Eyebrow: "Stage cleared", "Boss defeated" on X stages, or "Replay cleared". Title: "Stage N · Tier".
- A large final time `m:ss.t`, with the breakdown "m:ss.t solving + m:ss penalties (M mistakes, H hints)" or "… · no penalties".
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
| 8 | The clock never stops | Next (information only): "The clock starts when you press **Play** and **never stops** — leaving, refreshing or opening another stage keeps it running. There is no pause. **Restart** deals a shuffled grid with a fresh clock. (This practice clock isn't timed.)" |
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
- `state()`, returning `{stage, attempt, grid, status, mistakes, hints, penaltyMs, elapsed, shuffled, tutorial, tutorialStep}` (no `paused`)
- `select(i)`, `input(d, asNote)`, `erase()`, `undo()`, `redo()`
- `hint()`
- `openStage(n)`, `startTutorial()`, `setTab(t)`, `selectStage(n, scroll)`
- `flushSave()`, `resyncClock()`, `openSettings()`, `settings()`, `setSetting(k, v)`

`pause()` and `resume()` were removed with the pause feature.

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
  auto grid, bulb, restart, gear, back, lock, check, star, trophy, clock, arrow-up, boss ×. (The pause icon went with the Pause
  button.)
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
| `scratch/_sudoku-e2e.mjs` | `node scratch/_sudoku-e2e.mjs` (about 7 min). `--keep` skips cleanup; `--cleanup-only` just cleans | The full E2E. **128/128 in 387 s** in the final run (2026-09-30; details below). Writes screenshots and `e2e-results.json` to `Desktop\arena-sudoku-qa\`. Since the game went live it runs against a ladder with **staff on it**: checks are relative to the live data, real names never reach a log or a screenshot (below), and cleanup proves every staff row that existed before the run is still there |
| `scratch/_sudoku-map-shot.mjs` | `node scratch/_sudoku-map-shot.mjs` (about 1.5 min) | The four map states (2026-09-30) against the live ladder: the test account clears stages 1–2 through the real RPCs while staff have cleared 1–4, then every state is asserted in the DOM at dark/light × 1440/390 (classes, computed colours and opacity, medal and time, crowns only where they belong, the frontier pill on the right band, the gold rule sitting in the gap after the frontier tile only, the key's four labels and its 1-row / 2 × 2 layout, every crown filled `rgb(255,169,31)`). "Crown mine" and the completion crown can't happen live without taking a staff member's crown, so one extra pass rewrites the overview / stage-board / submit responses in the browser only (CDP Fetch) and its files carry `-patched`. Cleanup deletes the test account's rows and proves the staff rows are untouched. **57/57** |
| `scratch/_sudoku-map-preview.mjs` | `node scratch/_sudoku-map-preview.mjs <outDir> [clearer\|van]` | A design preview with no seeding: the overview response is rewritten into a synthetic scenario (Van's view: nothing cleared, staff up to 4; or the clearer's: 1–2 cleared, the crown mine on 1). Deletes the player row the visit creates |
| `scratch/_sudoku-namemask.mjs` | imported by the three browser scripts | Swaps every real staff name for "Staff A/B/…" at the **data layer**: every `/rest/v1/` response a test page receives is rewritten (CDP Fetch, response stage), so no re-render can bring a name back. (Masking the DOM after render raced the ghost line, which re-renders every tick; that is how one early 2026-09-30 shot showed a staff handle — deleted and re-shot.) Each shot is also refused if any real name is on the page |
| `scratch/_sudoku-live-state.mjs` | `node scratch/_sudoku-live-state.mjs` | Counts only, never a name: real players, clears per stage, the real frontier, crowns held, active attempts, and how many test rows exist |
| `scratch/_sudoku-boss-shot.mjs` | `node scratch/_sudoku-boss-shot.mjs` | Temporarily sets the test account's `highest_stage = 24` through the service role, then deletes all its Sudoku rows in `finally`. Proves boss stage 25 opens on the canonical X grid with both diagonals shaded (17 cells), the boss chip shows, a digit repeated **only on a diagonal** is flagged as a conflict, and there is no overflow in either theme at 1440 or 390. **16/16** (2026-09-30, `-v3` shots, names masked) |
| `scratch/_sudoku-xform-sql-test.sql` | `supabase db query --linked -f scratch/_sudoku-xform-sql-test.sql` | For all 300 stages: the SQL shuffle gives 0 invalid rows, columns, boxes or diagonals, preserved clue counts, and givens consistent with the transformed solution |
| `scratch/_syntax-gate.cjs` | `node scratch/_syntax-gate.cjs tools/arena-sudoku.html tools/arena.html index.html` | `vm.Script` compiles each inline `<script>` block, plus a strict UTF-8 and U+FFFD check. 0 errors |
| `scripts/check-static.mjs` | `node scripts/check-static.mjs` (the repo CI) | `node --check` on every `shared/` and `scripts/` JS file, and no broken local refs |
| advisors | `supabase db advisors --linked --type security` | Only `authenticated_security_definer_function_executable` (WARN), 11 of them for the Sudoku RPCs, which is expected. It was 13 before the two pause RPCs were dropped on 2026-09-29. No anon, search_path, RLS or definer-view findings |
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
  - **the removed RPCs** `sudoku_pause` and `sudoku_resume` return `PGRST202` (function not found)
  - **the clock runs with nobody calling**: re-opening the attempt after 3.2 s of silence shows ≥ 3.1 s more elapsed, and the
    payload has no `paused` field
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
    stage-2 clock gained ≥ 3.4 s, and both clocks are running at once.
  - A restart proves the shuffle and the restart count, and bot B clears stage 2.
  - Bot A waits out its 90 s penalty box and clears stage 2 later. The ranking puts B above A on the same stage (earlier `reached_at`).
- **Phase C, the browser**, as the hub test account. Sign-in: a service-role `generateLink` magic link, then `verifyOtp` in the page;
  no token is ever printed. The phase covers:
  - the map draws 301 tiles; no overflow
  - the tutorial through the UI, with the note auto-clear and the clock step saying the clock never stops; completion stored
  - Settings has 7 options with no auto-pause, and there are 7 tools with no Pause button and no paused board
  - stage 1 on the canonical grid; auto-check turned on through Settings; the wrong digit shown red; a hint
  - pressing **P does nothing**: the clock keeps running and the board stays visible
  - **navigating away for 3 s** (to the Arena page and back): the panel offers "Continue — clock running", the same attempt and grid
    come back, and the clock gained ≥ 3 s
  - **a refresh straight after a move**, too fast for the 1 s autosave: the keepalive save on pagehide kept the digit, and the clock
    kept running
  - finishing through the UI; the server elapsed is pure wall clock (finish − start) and includes the time away; penalties applied; the
    modal shows the server time; Next waits out the penalty box
  - the stage top 5 (the faster bot outranks you; the crown shows the first clearer)
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
- **Cleanup** always runs, in `finally`. It deletes every crown, clear, attempt and player row of the three accounts and deletes the
  throwaway auth users, then checks that no test row is left and that **every staff row that existed before the run still exists**
  (by primary key, per table). Staff rows are never written: every write is a test account's own RPC call or a delete filtered by a
  test account's id. While a run is going, the test accounts show on the stage 1–2 boards for a few minutes.

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
- 02b-tutorial-clock-step-v2 shows the new "clock never stops" tutorial step.

---

## 10. Known gaps and proposed twists

**Known gaps and caveats.**
- **External solvers can't be prevented.** A player can type any grid into an outside solver. The design removes in-game shortcuts
  (pre-scouting, restart scouting, replay memorization, hint or guess progression, instant scripted clears), not deliberate cheating.
- **No realtime.** Boards load when a stage is opened and ghosts load at stage start, so a clear by someone else mid-game isn't pushed
  live.
- **No Sudoku "Live now" entry** on the Arena page, because attempts are private by design. The hub Arena card has no stat line (it
  follows the Skribbl pattern).
- **Attempts never expire.** An abandoned active attempt stays active, with its clock running, indefinitely. `status 'abandoned'`
  exists but nothing sets it, and there is no sweeper. That is harmless, because only finished attempts rank.
- **No pause, by design** (Van, 2026-09-29). A stage left open overnight carries the night in its time. The remedy is Restart (a shuffled
  grid with a fresh clock) or a replay after the first clear. A tired player can't bank time, and the solve-it-outside loophole stays
  closed.
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

**Proposed twists (not built), with effort estimates.**
| Twist | Effort |
|---|---|
| Killer-cage boss every 50th stage (cage sums; the generator, solver and board need cage units and rendering) | about 2–3 days |
| Weekly sprint board: 10 fixed shuffled stages, one leaderboard per week | about 1 day |
| Hint tokens earned by beating par (spend beyond the 3-per-attempt cap) | about 0.5–1 day |
| Streak badges at 7 and 30 days (the data already exists) | about 0.5 day |
| Daily challenge, filling the Arena "Daily — coming soon" slot | about 1 day |
| Colour highlighter tool, client only (Cracking the Cryptic style) | about 1 day |

---

## 11. Changelog

- 2026-09-28 — initial build
- 2026-09-29 — The clock never stops after Play: Pause, the auto-pauses and the one-clock-at-a-time rule removed (Van: closes the solve-it-outside loophole)
- 2026-09-30 — The stage map's four states (Van): cleared by you (a filled teal tile, your time and medal, the crown only when it's yours), cleared by others (a gold hairline and their solid crown, kept bright while locked), open now (pink), locked (dimmed); the frontier ("Cleared up to N" on its band, a gold rule after that tile); a map key; a "Reading the map" rule; every crown now one filled solid-gold shape (tiles, key, chips, stage panel, completion) plus crown badges in the ranking
