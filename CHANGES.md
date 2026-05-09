# Changes

A running notepad for future Claude sessions — architecture, conventions,
and the trickier patterns that aren't obvious from the code. Read this
before making changes; it captures the **why** behind decisions so you
don't accidentally undo them.

> **Companion to `MEMORY.md`** (in `~/.claude/projects/.../memory/`).
> MEMORY.md auto-loads each session and stores short rules. This file
> is the long-form complement: history, architecture, and gotchas.

---

## TL;DR for the next session

1. **Don't auto-push.** User verifies offline first; only commit/push when explicitly told. (Memory: `feedback_no_auto_push.md`.)
2. **Cadence is owned by another Claude session.** Do not edit Cadence code, hub tile, or its docs from this session. (Memory: `feedback_cadence_owned_elsewhere.md`.)
3. **Tier model:** 0 = dev, 1 = admin, 2 = company, 3 = client, 4 = guest. **Only tier 0/1 can write to cloud.** Edit modes are gated on writer tier; tier 2-4 are read-only everywhere. RLS uses `is_writer()`.
4. **Supabase pattern:** singleton-row tables (`id = 1`) with a single `payload jsonb` column. RLS = anyone authenticated reads, only writers update/insert. See `supabase/migrations/001_init.sql` and `002_presentations_library.sql`.
5. **Layout overrides for evolving data shapes:** when a tool's saved-state schema gains a new field, write an `_ensureSubsections` / `_applyLayoutOverrides` style migration that runs on every load and mutates old shapes idempotently. Don't break existing user data.
6. **Theme toggle lives only on login + hub.** Per-tool toggles were removed 2026-05-09; CSS scaffolding kept so they're restorable. (Memory: `project_per_tool_theme_toggle_removed.md`.)
7. **D.Robbins accessibility:** `body.user-d-robbins` swaps cyan → navy on specific elements. He's tier-2 (not admin); the body class is set in `shared/auth.js` `applyAccessRestrictions()`. (Memory: `project_drobbins_accessibility.md`.)
8. **Performance Property Arena is in preview.** Email-allowlisted to `vandolf@performanceproperty.com.au` only. Hub pull-tab + tool pages all gated on `ARENA_EMAILS`. Will open up to wider tiers later.

---

## Architecture overview

### Top-level layout

```
performance-property/
├── index.html                Hub: login + landing + tool cards + at-a-glance widgets
├── shared/
│   ├── auth.js               Auth, tier gating, hub widget population
│   ├── auth-gate.js          Redirects tool pages to / if not signed in
│   ├── theme.js              Light/dark toggle (writes data-theme to <html>)
│   ├── common.css            Brand tokens, hub styles, frosted backgrounds
│   ├── color-picker.css/.js  Shared swatch picker (auto-attaches to <input type="color">)
│   └── supabase-client.js    window.sb — browser-side supabase-js wrapper
├── tools/
│   ├── property-clock.html
│   ├── runway-demand.html
│   ├── demand-score.html
│   ├── online-reports.html
│   ├── whitepapers-strategies.html  ("Documents" tool)
│   ├── presentations-library.html   (folder/card library — sister of Documents)
│   ├── presentation.html             (slide-deck builder)
│   ├── arena.html                    (Performance Property Arena landing — preview)
│   └── arena-typing.html             (Arena: typing test — preview)
├── supabase/migrations/      SQL schema + RLS
└── docs/
    ├── CADENCE.md            Owned by other Claude — don't touch
    └── SUPABASE_MIGRATION.md
```

Each tool page is a self-contained HTML file (no build step). Shared
behavior lives in `shared/`. Cloud sync is per-tool: each tool reads/
writes its own singleton row.

### Hub (`index.html`)

- Animated gradient + drifting blurred orbs (`pp-cycle-dark` / `pp-cycle-light` keyframes in `common.css`).
- Tool cards gated by tier (`.tier1-only`, `.results-card`, etc.).
- Presentation tile opens a **modal chooser** (`#presentationsModal`) with two pills: "Create a Presentation" → `tools/presentation.html`, "Presentations" → `tools/presentations-library.html`.
- "At a glance" stat tiles (`.hub-stat`) auto-update via `populateHubWidgets()` in `shared/auth.js`:
  - **Months of History:** calendar math (Jan 2025 baseline).
  - **Current Edition:** quarter from current month.
  - **Latest Data:** reads `localStorage['ppa-runway-latest']` (Runway tool writes it on load).
  - **Regions Tracked:** reads `localStorage['ppa-demand-markets']` (Demand Score writes it on load).
- Light-mode tiles use frosted-glass treatment (`backdrop-filter: blur() saturate()` + low-opacity bg).

### Auth & tier gating

`shared/auth.js`:
- `TIER0_USERNAME` / `PASS` — dev login.
- `ALLOWED_DOMAIN` — `@performanceproperty.com.au` for tier 1.
- `ADMIN_EMAILS` — explicit list for tier 2 (company-wide named admins).
- `ADMIN_NAMES` — name-display lookup keyed by email. **Does not grant tier permissions.** Just maps email → first name for the welcome message.
- `applyAccessRestrictions()` — toggles `body.tier-N` classes and per-user classes (e.g. `body.user-d-robbins`).
- `getAccessLevel()` returns `'dev' | 'admin' | 'company' | 'client' | 'guest'`. Writers = `dev | admin`.

Tools check writer status to gate edit affordances. Non-writers get
`body.<tool>-readonly` class and the edit toolbar/buttons hide via CSS.
JS also forces `_editMode = false` for these tiers so they never enter
edit mode even if they bypass UI.

### Supabase

Singleton-row tables — one row per "thing", `id = 1` primary key, all
state in a single `payload jsonb`. The RLS pattern across tables:

```sql
create policy "authenticated read X"
  on public.X for select to authenticated using (true);

create policy "writers update X"
  on public.X for update to authenticated using (public.is_writer());

create policy "writers insert X"
  on public.X for insert to authenticated with check (public.is_writer());
```

Tables in production:
- `documents_state` — Documents tool (sections + lastEdited).
- `presentations_state` — Presentations Library (parallel singleton, separate edit timeline from Documents).
- `presentation_state` — Presentation slide-deck builder (custom decks, overlays, slideBgs, **themes**, **deckActiveTheme**).
- `online_reports_state` — Online Reports tool.

`is_writer()` is a SQL function that returns true if the auth'd user's
row in `public.profiles` has tier 0 or 1. See `001_init.sql`.

### Cloud sync pattern

Every tool follows the same shape:

```js
// On boot
loadFromLocal();        // localStorage cache for offline
hydrateFromCloud();     // overrides local with cloud (or pushes local up if cloud empty)

// On every state mutation
saveToLocal();          // immediate
scheduleCloudSave();    // debounced ~800ms via _scheduleXCloudSave
```

The debounce avoids hammering the API during continuous edits (a slider
drag, a typing burst). Local writes are immediate so a refresh shows
the latest local state without round-tripping cloud.

---

## Conventions / Memory

### Don't auto-push to GitHub Pages

User verifies locally before any commit/push. **Wait for an explicit
"push" or "commit" before running git push.** This is the strongest
recurring rule. See `feedback_no_auto_push.md`.

### Cadence is owned elsewhere

Another Claude session is working on the Cadence project. **Do not
edit:** Cadence code, the hub Cadence tile, or `docs/CADENCE.md`. If
the user asks about Cadence, explain that another session owns it.
See `feedback_cadence_owned_elsewhere.md`.

### David Robbins accessibility (project memory)

For `d.robbins@performanceproperty.com.au` only:
- Welcome name = "David"
- Cyan text (#5cc8e0 / #00b6cb) → navy (#000080) on:
  - `.welcome-message` accent
  - `.ws-col-head` (Documents column headers)
  - `.month-display` (Runway month chip)
  - `.hub-stat-num` numbers
- Mechanism: `applyAccessRestrictions()` adds `body.user-d-robbins`; CSS overrides scoped to that body class so all other users see standard cyan.
- He's **tier-2 (company)**, not admin. Don't grant edit access. The body class is purely a visual override.

### Per-tool theme toggle removed (2026-05-09)

Stripped from all 7 tools; only login + hub keep their toggles. CSS
rules left intact so re-adding the `<button>` markup brings them back
instantly. Restore steps in `project_per_tool_theme_toggle_removed.md`.

### Performance Property Arena is allowlist-gated (2026-05-09)

Staff entertainment area. Currently in **preview** — only visible to
`vandolf@performanceproperty.com.au`. Three layers of gating:

1. **Hub pull-tab** — `body.arena-allowed` set by `applyArenaVisibility()`
   in `index.html` based on `ARENA_EMAILS` array. CSS hides the right-edge
   "Performance Property Arena" tab unless that class is present.
2. **`tools/arena.html`** and **`tools/arena-typing.html`** — each page has
   an inline `<script>` that mirrors `ARENA_EMAILS` and `location.replace`s
   to the hub if the signed-in email isn't on the list. Uses a brief poll
   so it doesn't false-positive while `auth.js` is still hydrating
   `sessionStorage` from the Supabase session.
3. **Database** — `arena_typing_scores` is RLS-readable by anyone authed,
   but writes are constrained to `user_id = auth.uid()`.

To open it up: expand `ARENA_EMAILS` in `index.html` AND in both tool
pages (three lists, keep them in sync), or replace the email check with a
tier check (e.g. `getAccessLevel()` permits company+).

**Don't import this allowlist from `CADENCE_EMAILS`** — Arena and Cadence
are separate previews with separate audiences, and the lists are
intentionally allowed to drift.

### Recently-used colors are shared across tools

The shared color picker (`shared/color-picker.js`) writes recent picks
to `localStorage['ppa-recent-colors']`. Pick a color in Property Clock,
open Presentation, and the recents list shows your earlier pick.

---

## Tools — current state

### Property Clock (`tools/property-clock.html`)

- ECharts-based clock diagram with Smooth + Workforce overlays.
- PDF export uses html2canvas + jsPDF. **HD download = scale 3 + JPEG q0.95 + compress:true.** Higher scales corrupt PDFs in some browser viewers.
- PDF filename has a random 5-letter + 2-digit suffix:
  `Clock_diagram_Smooth&Workforce_Edition_<month>_<year>-<rand>.pdf`
- Custom-text overlay system stored in localStorage (no cloud sync for that).
- Color inputs (Smooth, Workforce, custom text) use the shared swatch picker.

### Runway v Demand (`tools/runway-demand.html`)

- Live data tool. Pulls forecast tables from a Google Sheet via Apps Script.
- Caches latest month string under `localStorage['ppa-runway-latest']` so the hub's "Latest Data" tile can read it without loading the full dataset.
- Embed mode (`body.embed-mode`) hides chrome for Looker Studio embedding.
- Light-mode `.month-display` gets the D.Robbins navy override.

### Demand Score (`tools/demand-score.html`)

- Region-by-region demand-score grid (lots of cells, lots of charts).
- On load, caches `markets.length` to `localStorage['ppa-demand-markets']` so the hub's "Regions Tracked" tile can read it.

### Online Reports (`tools/online-reports.html`)

- The biggest tool by far (~14,000 lines).
- Looker-Studio-style report pages with REGION_CLUSTERS, side TOC, pager.
- Edit mode lets writers add custom-text overlays and shape decorations per page.
- Mobile bar replaces the desktop pager on `<1200px` (no edit on mobile).
- Color inputs (bg, shape fill/stroke, custom text) use the shared swatch picker.

### Documents — Whitepapers & Strategies (`tools/whitepapers-strategies.html`)

- Folder/card library of links to research, training, etc.
- Hierarchical: folders → sections → cards. Each card has icon + title + URL + status badge.
- Each section can be `layout: 'columns' | 'grid'` with optional `gridCols`. The renderer keys layout to section ID via `_applyLayoutOverrides` so old saved data picks up new layout choices on load.
- Edit mode (tier 0/1) toggles a View/Edit pill at top-right.
- "Research Links" section has an inline search bar with a fly-forward animation: the matching card scales up to center with a blurred backdrop. Esc returns it.
- Editable "Current Edition" pill (research updated quarterly).
- Selling/Buying Slides was **removed** from this tool and lives in Presentations Library now. `_ensureSubsections` strips it from existing user data on load.

### Presentations Library (`tools/presentations-library.html`)

- Sister tool of Documents — same shape, separate Supabase row (`presentations_state`), separate edit timeline.
- Four folders: **Buying/Selling Slides** (split grid: Selling left / Buying right, 3 per row), **Strategy Presentations** (5 per row, square cards with full status workflow), **Client Presentations**, **Partner Presentations**.
- Strategy cards have icon at top + title below + 7-line description clamp + status pill + date — explicit user spec, do not flatten.
- Region icons match Online Reports' REGION_CLUSTERS via `_iconForTitle()`.
- Buying/Selling search uses the same fly-forward animation as Documents.

### Presentation — slide-deck builder (`tools/presentation.html`)

- The most complex tool. Picker → deck-open with thumbnail rail + slide stage + edit toolbar.
- **Edit mode = writer tier only.** Body classes: `pres-deck-open`, `pres-edit-mode`, `pres-readonly`, `pres-fullscreen`, `pres-text-selected`, `pres-cell-focused`, `pres-theme-panel-open`.
- Slide template fns in `SLIDES` constant. `{ fn: 'blank', custom: true }` is the user-added variant.
- **Overlays + bgs are stored under composite keys: `<deckId>/<slideIdx>`.** When inserting/deleting slides, `shiftSlideStorageUp` / `shiftSlideStorageDown` re-key everything at and after the index. Don't forget to call these.
- **Themes (added 2026-05-09):** full-slide snapshots saved org-wide via `presentation_state.payload`. New keys: `themes` (array) and `deckActiveTheme` (map). When you insert a slide and the deck has an active theme, the new slide gets the theme's overlays + bg cloned. Existing slides are never touched (explicit UX choice — don't change this without asking).
- **Set as Theme:** right-click any slide thumbnail in edit mode → "Set as Theme" → prompt for name → snapshot saves to cloud.
- **Theme button** in edit toolbar opens the right-side `.pres-theme-panel`. Click a card to make it active for the deck; click again to clear; X to delete.
- **Edit-only slide ops (added 2026-05-09):** "+" thumbnail tile, right-click add/delete/set-as-theme menu, and Delete/Backspace slide deletion are all gated behind `_editMode`. Viewers can't mutate decks.
- Undo/Redo buttons are hidden globally; Ctrl+Z / Ctrl+Y still work via keyboard handler.
- Per-tool theme toggle was removed (see "Per-tool theme toggle removed" above).

### Performance Property Arena (`tools/arena.html` + `tools/arena-typing.html`)

Staff entertainment area; **preview, allowlist-gated** (see the Arena
allowlist convention above). Entered via a right-edge pull-tab on the
main hub page (mirrors the left-edge Cadence pull-tab pattern but uses
its own `body.arena-allowed` class — the two gates don't share state).

- **Landing (`tools/arena.html`)** — three game cards: Typing Test
  (live), Chess (Coming soon), More games (Coming soon). The "Coming
  soon" cards are visually de-emphasised (`.arena-card.is-soon`,
  `opacity:.62`, no hover lift) so the live game is the obvious CTA.
- **Typing Test (`tools/arena-typing.html`)** — monkeytype-inspired:
  - 15 / 30 / 60 second modes; three word lists (English, Real Estate,
    Code). Real Estate list is hand-curated property/listing jargon —
    branded fun, not generic English.
  - Hidden `<input>` captures keystrokes; on each `input` event we diff
    against the target word and mutate only the affected `<span>`s (no
    full re-render). Allows backspacing into the previous word, matches
    monkeytype behaviour.
  - Live stats (time + WPM) hidden until first keystroke. Click anywhere
    in the feed wrap to refocus. Out-of-focus blurs the feed + shows a
    "Click or press any key to start" prompt.
  - Results panel: net WPM, raw WPM (no accuracy penalty), accuracy,
    consistency. **Consistency** = `100 × (1 − stddev/mean)` of
    per-second net WPM, clamped to [0, 100]. Steady pace ≈ 100%.
  - Each completed run inserts one row into `arena_typing_scores`. The
    leaderboard panel below the results queries top 10 filtered by
    `mode_seconds + word_list` and joins to `profiles` via the FK
    relationship name (`profiles:user_id(email, full_name)`) for
    display names. Self-row is highlighted with `tr.is-self`.
  - **`Tab + Enter`** restarts. The `Tab` press intentionally arms a
    one-shot listener for `Enter`, so a stray Tab press alone doesn't
    nuke a run.
- **Schema** — `supabase/migrations/003_arena.sql`:
  ```sql
  arena_typing_scores (
    id, user_id, wpm, raw_wpm, accuracy, consistency,
    mode_seconds, word_list, chars_correct, chars_incorrect,
    duration_ms, completed_at, created_at
  )
  ```
  Two indexes: `(user_id, completed_at desc)` for per-user history,
  `(mode_seconds, word_list, wpm desc)` for leaderboard queries.
  RLS: any authed user reads, users insert their own, writers can
  delete (the leaderboard is more interesting if everyone's stuck with
  their honest best — users **cannot** delete their own rows).

---

## Shared modules

### `shared/color-picker.js` + `.css` (added 2026-05-09)

Auto-attaches to every `<input type="color">` on page load. Replaces it
with a circular swatch button that opens a popover with:
- **Presets** — 24 hard-coded brand-aligned colors
- **Recently Used** — last 16, persisted under `localStorage['ppa-recent-colors']` (shared across tools)
- **Hex input** — Enter or blur to apply
- **Custom…** — spawns a *throwaway* native color input to open the OS dialog

The original color input is hidden with `display:none`. Existing tool
event listeners (`tpColor.addEventListener('input', ...)`, `oninput="applyColors()"`, etc.) still work because we set the input's value
and dispatch synthetic `input` + `change` events.

**Critical bug to avoid:** the throwaway input for "Custom…" must be marked `data-pp-swatch-skip` *before* insertion into DOM, otherwise the MutationObserver auto-attaches the swatch picker to it and `display:none` blocks the OS dialog from opening.

Wired into: `presentation.html`, `property-clock.html`, `online-reports.html`. Each just needs:

```html
<link rel="stylesheet" href="../shared/color-picker.css">
<script src="../shared/color-picker.js" defer></script>
```

### `shared/auth.js`

`populateHubWidgets()` is the entry point for the at-a-glance hub stats:
- `_hubMonthsOfHistory()` — calendar math from Jan 2025.
- `_hubCurrentEdition()` — quarter from current month.
- `_hubLatestMonthFromCacheOrFormula()` — reads `ppa-runway-latest`, falls back to "previous month" formula.
- `_hubRegionsFromCacheOrFallback(N)` — reads `ppa-demand-markets`, falls back to passed-in default.

### `shared/theme.js`

Tiny module — just toggles `data-theme="light"` on `<html>` and persists
to localStorage. Called by `PP_toggleTheme()` from the hub and login
page only (per-tool toggles removed).

---

## Recurring patterns

### Frosted glass

Used for cards, popovers, and chrome. Combine:
```css
background: rgba(15, 23, 42, 0.92);
backdrop-filter: blur(14px) saturate(140%);
-webkit-backdrop-filter: blur(14px) saturate(140%);
```
Light-mode override:
```css
[data-theme="light"] .X {
  background: rgba(255, 255, 255, 0.92);
  /* same blur/saturate */
}
```

### Right-side floating panels

Pattern: `position: fixed; top: 68px; right: 14px; width: ~250px; max-height: calc(100vh - 200px); overflow-y: auto;` with frosted glass. Toggled by a body class like `body.pres-text-selected .pres-text-panel { display: block }`. The Theme panel uses `body.pres-theme-panel-open`.

### Body-class gating

Tier and feature flags ride on body classes set by JS:
- `body.tier-N` (where N is 0-4)
- `body.user-d-robbins` (per-user)
- `body.<tool>-edit` / `body.<tool>-readonly`
- `body.pres-edit-mode`, `body.ws-edit`
- `body.pres-fullscreen`, `body.embed-mode`

Then CSS uses `body.X .Y { ... }` or `body:not(.X) .Y { display:none }` for visibility. **No JS branching needed** to show/hide chrome.

### Shape-evolution migrations

When a tool's saved-state schema gains a new field, write a function
that runs on every load and idempotently transforms old data:

```js
function _ensureSubsections() {
  data.sections.forEach(s => {
    if (!s.subsections) s.subsections = WS_DEFAULTS[s.id]?.subsections || [];
    // ... etc
  });
}
```

Same idea for `_applyLayoutOverrides` — keys layout/kind metadata to section IDs so cached pre-feature data picks up new chrome.

### Per-user accessibility overrides

Add a body class like `body.user-d-robbins`, then scope CSS overrides:
```css
body.user-d-robbins .ws-col-head {
  color: #000080;
  border-bottom-color: rgba(0,0,128,0.30);
}
```
Other users never see the rule, so no global impact.

### Outside-click + ESC to close

Pattern for popovers/panels:
```js
document.addEventListener('click', (ev) => {
  if (!isOpen) return;
  if (popover.contains(ev.target)) return;
  closePopover();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && isOpen) closePopover();
});
```
Watch out for nested popovers — when the swatch picker opens inside the
cell-popover or bg-editor, `pop.addEventListener('click', e => e.stopPropagation())` keeps the parent's outside-click handler from
closing both. See `color-picker.js`.

---

## Logic gotchas

### Slide overlay storage shifting

When you insert/delete a slide in Presentation, the storage keys for
slides AT or AFTER the index need to shift. Forgetting this causes
overlays to "follow the wrong slide" after edits. Helpers:
`shiftSlideStorageUp(deckId, idx)`, `shiftSlideStorageDown(deckId, idx)`. Always call before/after `slides.splice()`.

### Color picker change events fire continuously

Native `<input type="color">` fires `input` events as the user drags
through colors and `change` only on commit. Our shared color picker
preserves this by dispatching synthetic events when a swatch is
clicked (both `input` and `change` so existing listeners fire). The
"Custom…" path uses a throwaway input that drives the same events.

### Theme thumbnails need the parent in DOM

`_renderThemeThumb()` reads `canvas.parentNode.clientWidth` inside a
`requestAnimationFrame` callback to compute the scale ratio. The card
must be appended to the panel before rAF fires; we do this by inserting
the card to the list at the end of each iteration.

### `display:none` blocks `.click()` on native color inputs

The OS color dialog refuses to open when the input is hidden via
`display:none`, `visibility:hidden`, or `pointer-events:none`. The
shared color picker works around this by spawning a fresh input on the
fly, with a 1×1 footprint at `top:0; left:0; opacity:0` — interactable
enough for the browser, invisible to the user.

### Custom decks vs built-in decks

Built-in decks live in the hardcoded `DECKS` const. Mutations to them
are session-only (page reload restores from source). User decks live
in `_customDecks` → localStorage → cloud. Save with `saveActiveDeckIfCustom()` which no-ops on built-ins.

### Presentation `presentation_state` payload schema

```js
{
  customDecks:     [...]  // user-created decks
  overlays:        {}     // map of "<deckId>/<slideIdx>" → overlay array
  slideBgs:        {}     // map of "<deckId>/<slideIdx>" → CSS background string
  themes:          [...]  // [{ id, name, slide:{fn,overlays,bg}, createdBy, createdAt }]
  deckActiveTheme: {}     // map of "<deckId>" → "<themeId>"
}
```
JSONB column — no migration needed when adding new top-level keys.

### `ADMIN_NAMES` is for display only

Adding an email there does **not** grant tier 1. It's just a
{email → first name} lookup for the welcome message. Real tier
membership comes from `TIER0_USERNAME`, `ALLOWED_DOMAIN`, and
`ADMIN_EMAILS` checks.

### Hub calendar math uses local time

`_hubMonthsOfHistory()` and `_hubCurrentEdition()` use `new Date()`,
which reads the browser's local timezone. This is intentional — the
"current edition" is whichever quarter the user is in *right now*.

### Selling/Buying Slides was moved out of Documents

If you see references to it in old code or memory, that's the legacy
location. It now lives in Presentations Library exclusively. The
Documents tool actively strips it on every load via `_ensureSubsections`.

### `light:host(...)` doesn't exist — use `[data-theme="light"]`

This codebase doesn't use shadow DOM. Light-mode overrides everywhere
use `[data-theme="light"] .selector { ... }`. Don't reach for
`:host()` or media queries — `theme.js` is the source of truth.

---

## File-update checklist for common tasks

### Adding a new color picker to a tool
1. Add `<link rel="stylesheet" href="../shared/color-picker.css">` and `<script src="../shared/color-picker.js" defer></script>` to the `<head>`.
2. Use a normal `<input type="color">` — the picker auto-attaches.

### Adding a new tier-gated feature
1. Read tier in JS via `getAccessLevel()`.
2. Set a body class in `applyAccessRestrictions()` if you need CSS-level gating.
3. Hide UI via `body:not(.<feature>-allowed) .<element> { display: none }`.
4. Force JS state to "off" for non-writers so they can't bypass via console.

### Adding a new tool
1. Create `tools/<name>.html` — copy structure from an existing tool.
2. Include `shared/common.css`, `shared/theme.js`, `shared/auth.js`, `shared/auth-gate.js`, `shared/supabase-client.js`.
3. Add a card to `index.html` under the appropriate tier gate.
4. If it has cloud state: new SQL migration `00X_<name>.sql`, copy the singleton-row pattern from `002_presentations_library.sql`, RLS uses `is_writer()`.

### Restoring per-tool theme toggle
See `project_per_tool_theme_toggle_removed.md`. CSS is intact — paste
the `<button id="...-theme-toggle">` block back after the Back-to-Hub
`</a>` in each tool's HTML.

---

## Recent feature work — chronological summary

(Most recent first. For commit history, use `git log`.)

### Performance Property Arena — typing test preview (2026-05-09)
- New staff entertainment area, accessible from the hub via a right-edge pull-tab labelled "Performance Property Arena". Mirrors the Cadence left-tab pattern but uses its own `body.arena-allowed` class + `ARENA_EMAILS` allowlist (only `vandolf@` for now).
- `tools/arena.html` — landing with three cards: Typing Test (live), Chess (Coming soon), More games (Coming soon).
- `tools/arena-typing.html` — monkeytype-style typing test. 15/30/60s modes, English / Real Estate / Code word lists, live WPM/time, char-level highlighting, backspace into previous word, Tab+Enter restart, results panel with net WPM, raw WPM, accuracy, consistency. Top-10 leaderboard filtered by mode + word list, joined to `profiles` for display names; self-row highlighted.
- `supabase/migrations/003_arena.sql` — `arena_typing_scores` table + two indexes (per-user history, leaderboard) + RLS (read=any-authed, insert=own-row, delete=writers-only). **The migration must be run before scores will save — the page handles the empty-table case but shows "Save failed" until then.**
- Both tool pages have an inline allowlist gate that `location.replace`s non-Arena users back to the hub. The list is duplicated in three places (`index.html` + both pages) — when opening up access, update all three.

### Presentation copy/cut/paste/duplicate overlays (2026-05-09)
- Added internal clipboard for overlays in `tools/presentation.html`. `Ctrl+C / Ctrl+X / Ctrl+V / Ctrl+D` plus right-click menu (Copy / Cut / Duplicate / Paste) on every overlay type (text, shape, image, table, embed). Top-right toast confirms each op.
- Paste lands at +40px offset, clamped to slide bounds. Protected embeds get a Copy-only menu (no cut / duplicate).
- Copy-to-Slides picker labels simplified to numbers only (was "1. Blank", "2. Blank", …; now "1", "2", …).

### Presentation themes + edit-mode gating + shared color picker (2026-05-09)
- Added Theme system to Presentation — full-slide snapshot, org-wide via cloud payload, picked theme applies to new slides only.
- Right-click "Set as Theme" + Theme button in edit toolbar + right-side panel.
- Gated slide add/delete to edit mode (CSS hides "+" tile, JS guards right-click menu and Delete/Backspace).
- Built `shared/color-picker.js` — replaces every native color input with a circular swatch button + popover (presets + recents + hex + Custom…). Recents shared across tools via `localStorage['ppa-recent-colors']`.
- Removed per-tool theme toggle from all 7 tools (kept hub + login).

### Auto-updating hub at-a-glance + frosted tiles (2026-05-09)
- Calendar-math `_hubMonthsOfHistory()` and `_hubCurrentEdition()`.
- Runway and Demand Score cache their stats to localStorage on load; hub reads them with fallbacks.
- Light-mode tiles get frosted-glass treatment; welcome subtitle gets explicit light-mode color override.

### David Robbins per-user accessibility (2026-05-08)
- `body.user-d-robbins` set in `applyAccessRestrictions()` for `d.robbins@performanceproperty.com.au`.
- Cyan → navy color overrides on welcome message accent, `.ws-col-head`, `.month-display`, `.hub-stat-num`.
- Tier-2, NOT admin.

### Buying/Selling Slides search + SVG search icon fix
- Inline search bar with fly-forward animation: matching card scales up to center with blurred backdrop. Esc returns it.
- Search icon switched from emoji to inline SVG with explicit per-theme stroke color (emoji rendered inconsistently).

### Light-mode card frosting + Research Links search
- All card surfaces in Documents and Presentations Library got frosted-glass treatment in light mode (low opacity bg + backdrop-filter blur).
- Research Links got the fly-forward search UX first; later ported to Buying/Selling.

### Presentations Library + Strategy card iterations
- New tool forked from Documents; new Supabase table `presentations_state`.
- Strategy cards: 5-per-row square grid, icon-above-title layout, status workflow, region icons mirroring Online Reports.
- Buying/Selling: split grid (Selling left, Buying right), 3 per row.

### Documents tool overhaul
- Status badges fixed on flat sections.
- View/Edit toggle moved to top-right.
- Subtitles removed.
- Editable "Current Edition" pill matches `.hub-tool-badge` styling.
- Column layout for subsections.
- "Others" subsection added (Research Links only).
- Dates visible on cards.

### Property Clock PDF improvements
- Random-suffix filenames so multiple downloads don't collide.
- HD PDF fix: scale 4 + lossless PNG was too large and corrupted in browser viewers; switched to scale 3 + JPEG q0.95 + compress:true.

---

## Things to be skeptical of when reading this file later

- **Memory snapshots go stale.** Before recommending a function/file from this doc, verify it still exists with `git grep` or by reading the file.
- **Schema changes happen.** If you see references to fields not in the current code, they may have been renamed or moved. Trust the code over the doc.
- **Tier rules are the most stable thing in the codebase.** If something contradicts the tier model, the something is wrong.
- **The user has strong opinions.** If a design choice in this doc looks suboptimal, it was probably an explicit user request — confirm before "improving" it.
