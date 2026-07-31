# CLAUDE.md — Performance Property Analytics Hub

Orientation + working rules for this repo. Read once per session; the
`README.md` is from the early architecture (Netlify, 3 tools) and is
**out of date** — trust this file over it.

## What this is

A **static, no-build multi-tool web app** for Performance Property staff
(Australian property research). Hand-authored HTML/CSS/JS, one large
self-contained HTML file per tool, shared code in `shared/`. Served from
**GitHub Pages** (`VGrateja/performance-property-tools`) at
**tools.performanceproperty.com.au** (`CNAME` + `.nojekyll`). All dynamic
state lives in **Supabase** (project `cannojsxduvlewimwoxa`).

There is **no bundler, transpiler, or framework**. Edit a file, commit,
GitHub Pages redeploys. The only Node code is `scripts/` (one-off
maintenance + the monthly PDF renderer) — `package.json` deps exist for
that alone, not the site.

## Architecture at a glance

- **Frontend:** vanilla JS + inline `<style>`/`<script>` per tool.
  Third-party libs (ECharts, D3, html2canvas, jsPDF, Leaflet, Lucide,
  supabase-js) load per-page from CDN — only on pages that need them.
- **DB client:** `shared/supabase-client.js` creates `window.sb` with the
  in-page **anon** key. That key is intentionally public; security is
  **Row-Level Security**, never client-side checks. Never add a service-role
  key to any browser file.
- **Auth:** Supabase Auth. `shared/auth.js` mirrors the signed-in profile
  into `sessionStorage` so the rest of the code can gate UI synchronously;
  `shared/auth-gate.js` redirects un-signed-in users off tool pages.

## Access model — two axes (recalibrated 2026-07-25, mig 089)

**GROUPS = access** (which tools your hub shows) · **ROLES = permission**
(can you edit or only view). Both sit on `public.profiles`.

### Roles (`profiles.tier` + `public.tool_roles`)

| tier | who | default role |
|---|---|---|
| `dev` | Vandolf | Editor everywhere + view-as + Groups/Roles panel |
| `admin` | Saskia / Shaene / Paul | **Editor** (global writer) |
| `company` (labelled "Staff") | other `@performanceproperty.com.au` | **Viewer** (view + download, no edit) |
| `client` / `guest` | external | dormant — **zero members**; view-only if ever used |

- **Per-tool exceptions live in `public.tool_roles`** (`user_id`, `tool_key`,
  `role='editor'`): a Viewer can be granted Editor *inside one tool* without
  becoming a global admin. SQL check: `public.has_tool_role(tool, role)`.
  Example: Marilou = Viewer + `scorecards:editor` (RLS via
  `scorecard_can_write() = is_writer() OR has_tool_role('scorecards')`;
  the tool's client gate is `scWriter()` in scorecards.html).
  Reads: own rows or writers; writes: **dev only** (like `set_user_team`).
  Managed from the dev-only Groups/Roles panel (People tab role chips).
- **Default-role changes** (Dev ↔ Admin ↔ Staff) also happen in that panel via
  the dev-only `set_user_tier` RPC (mig 090). Internal tiers only; the DB
  refuses to demote the **last remaining developer** (lockout guard).
- **The `leads` tier is RETIRED** (mig 089): its visibility became a group
  (Marilou `team='leads'` → baseline + Scorecards) and its Scorecards write
  became the `tool_roles` grant above. The string is still legal in the CHECK
  constraint but nothing assigns it; legacy `leads` branches in auth.js /
  index.html / mig 080 are dead-but-harmless fallbacks.
- **D.Robbins is `company` (Staff), NOT admin** — he declined the admin role
  (2026-06-29). Never list him among the admins; the live DB (profile tier,
  `handle_new_user` trigger, `is_writer()`) is already correct.
- Global writes require `is_writer()` (dev/admin) — enforced by RLS, so a UI
  bug or leaked anon key can't write. Tool-scoped writes go through a
  tool-scoped predicate (the `scorecard_can_write()` pattern) — copy that
  pattern when a new tool needs role-based editing.
- `tier1-only` CSS class hides elements for tier 2+; `applyAccessRestrictions()`
  applies it on load. `isViewOnly()` = client/guest.
- **Registration is OFF** (`REGISTRATION_ENABLED = false`) — internal tool.
- Tier names are strings; display language is now **Editor/Viewer** (roles),
  but DB strings stay `dev`/`admin`/`company`/`client`/`guest` on purpose —
  renaming them would churn RLS, the signup trigger, view-as and CSS classes.

### Staff GROUPS (teams) — visibility axis on top of tiers (mig 081)

- `hub_groups` table (key/name/tools jsonb/sort) + `profiles.team` drive
  **which tools the hub shows** — cards, dock icons, search, pins, and a
  deep-link bounce in `auth-gate.js`. **Rights are untouched**: tier keeps
  doing writes/RLS exactly as above. Allowed set =
  `union(company_baseline, group tools)`; dev always sees all; ADMINS and
  LEADS are assignable too (an assigned admin sees their group's toolset;
  unassigned admin = all; leads always adds the `leads` row on top of any
  team); `team` null company = baseline only; client/guest keep the legacy
  tier gating.
- Registry of tool keys: `shared/tool-registry.js` (`PP_TOOL_REGISTRY`).
  Its `DEFAULT_BASELINE` is the pre-migration fallback and must stay in
  LOCKSTEP with the 081 `company_baseline` seed. New tool = add a registry
  key + `key:` on its APPS entry; Van ticks it into groups via the panel.
- Dev-only **Groups panel** in the hub menubar (`openGroupsAdminModal`):
  assign people (`set_user_team` RPC, dev-only) + tick tools per group.
- Resolver: `ppResolveAllowedTools()` in `shared/auth.js` (non-blocking,
  sessionStorage-cached `pp_allowed_tools_v1`); sync reads via
  `ppAllowedState()` / `ppToolAllowed(key)` / `ppSectionAllowed(sec)`.
  Everything FAILS OPEN to the legacy tier gates when unresolved — the hub
  renders today's UI pre-migration and for externals.
- Group visibility application must stay SYMMETRIC (the hub-freeze rule):
  `applyGroupVisibility()` runs for every tier and writes dock-icon
  ATTRIBUTES (`data-grp-on/off`), never body classes. Card rows get
  `.grp-on` at build time to lift the per-card tier CSS gates.
- Dev view-as supports groups (`setViewAs('company', teamKey)` →
  `pp_view_team`); `pp_view_as` itself stays a plain tier string — tools
  parse it.

## The tools (`tools/`)

Hub (`index.html`) is 4 swipeable pages: **analytics** (default), **pm**,
**arena**, **vault**. Tools:

- `online-reports.html` — ~474KB; the most complex tool at runtime (and 2nd
  largest file, after `presentation.html`). 36 regional property reports
  + an in-browser **edit system** (text/shape/image overlays, page-bg editor,
  side-TOC reorder/rename, undo/redo, backup/sync/audit). Per-region state in
  `reports_state`. Most edit logic now lives in **`shared/report-edit.{js,css}`**
  (extracted so the research reports reuse it).
- `national-report.html`, `commercial-report.html` — "Research Reports". Use
  the shared edit module; data from their own Apps Script feeds; ECharts.
- `property-clock.html`, `runway-demand.html`, `demand-score.html` — live
  market-data analytics.
- `runway-workbook.html` — scenario modelling (Vault).
- `presentation.html` (builder, ~607KB — the largest tool file)
  + `presentations-library.html` (deck library).
- `whitepapers-strategies.html` — Documents.
- `cadence.html` — team workflow board (Supabase-backed, realtime + notify).
- `arena.html`, `arena-typing.html`, `arena-chess.html`, `arena-scrabble.html` —
  games with leaderboards; chess/scrabble are online multiplayer via RPCs.

## Shared modules (`shared/`)

- `auth.js` / `auth-gate.js` — auth + tier gating (above).
- `supabase-client.js` — `window.sb` + `sbCurrentProfile()`.
- `report-edit.js` / `report-edit.css` — the report editor (text/shape/image
  overlays, page-bg, TOC, modals, download modal, sync, audit, auto-zoom).
  Shared by national/commercial; the regional tool keeps its own inline copy.
- `theme.js` — `PP_setTheme` / `PP_toggleTheme` (light/dark, `data-theme`).
- `common.css`, `color-picker.{js,css}`.

## Supabase (`supabase/`)

- **`migrations/`** — 29 files, numbered. `001_init.sql` is the core:
  `profiles` (+ `handle_new_user` trigger, `current_tier()`, `is_writer()`),
  single-row JSONB state tables (`clock_state`, `presentation_state`,
  `documents_state`) and `reports_state` (one row **per region** — the
  research reports write here under slugs `national` / `commercial`). RLS:
  any authenticated user reads; only writers write. Later migrations add
  Arena, Cadence, storage buckets + the `online-reports` storage lockdown
  (028, bucket is private — fetch via short-lived signed URLs).
- **`functions/`** — `notify-cadence`, `notify-clock`, `notify-scorecards`.
  There is **no AI/LLM function**: the AI Concierge and the report editor's
  "✨ Draft" button were both removed 2026-07-31 and the `ai-concierge`
  function was undeployed. Don't reintroduce an LLM dependency without asking.
- `supabase/.temp/` is machine-local (gitignored).

## Data pipelines

- **Live data:** Google Apps Script web apps return JSON; source kept in
  `scripts/apps-script-*.js`. Tools fetch on boot (a Refresh button re-runs it).
- **Monthly PDFs:** `.github/workflows/render-online-reports.yml` (cron, 12th
  of month) runs `scripts/render-reports.mjs` → Puppeteer signs in as the
  `pdf-renderer` service account, opens each report at
  `?region=<slug>&exportMode=1[&lite=1]`, captures native `page.pdf()`,
  uploads to the `online-reports` Storage bucket (`<YYYY-MM>/<slug>.pdf`).
  Tools download cache-first (the "Cached <date>" pill) and fall back to live
  html2canvas+jsPDF. **Any new report chrome must be added to the chrome-strip
  list in `render-reports.mjs`** (both the DOM-removal array and the
  `display:none` stylesheet) or it leaks into cached PDFs.

## Repo layout

```
index.html              hub (login + 4 swipeable tool pages)
tools/                  one HTML file per tool
shared/                 auth, supabase client, report-edit, theme, css
supabase/migrations/    numbered SQL (apply via dashboard SQL editor)
supabase/functions/     Deno Edge Functions
scripts/                Apps Script source, render-reports.mjs, seeds, cleanups
assets/Reports/         report cover images, logos, chart/data assets
docs/                   BUG.md, CADENCE.md, ONLINE_REPORTS_RENDERER.md, etc.
.github/workflows/      monthly PDF render
```

## Working rules (important — follow these)

- **Answer short and direct.** Keep explanations simple and to the point —
  no long or complicated write-ups unless the user asks for detail.
- **Challenge before building (Van's standing request, 2026-07-18).** When a
  requested approach has a materially better alternative, a hidden cost, a
  security/perf/data risk, or conflicts with an earlier decision or rule —
  say so FIRST in a short paragraph (what you'd do instead and why), then
  follow Van's call without sulking. Don't rubber-stamp; equally, don't
  relitigate settled decisions (check history first) and don't nag on
  trivial/reversible choices — just build those. A one-line "going with X;
  considered Y, rejected because Z" is often enough. For a deep on-demand
  stress-test of a specific decision, Van can run `/challenge-decision`.
- **Never `git push` without an explicit go-ahead** ("push it" / "ship it" /
  "go live"). Local commits are fine on request, but the user previews changes
  in their offline copy first. Don't auto-commit or auto-prompt to ship after
  an edit during iteration.
- If on `main`, that's the deploy branch — be deliberate. There's also an
  `auth-migration` branch.
- **Don't end Supabase-touching work with a "want me to apply this to
  Supabase?" prompt or deploy checklist.** Migrations/RLS/data scripts are
  reviewed and applied by the user on their own schedule.
- **Hub boot path must stay symmetric across tiers.** Never write an
  `apply*Visibility` / gating function as one-tier-only — widen to
  dev/admin/company and CSS-gate the content. A one-tier-only gate has caused
  multi-hour hub freezes before.
- **There is no AI in this product any more** (removed 2026-07-31, Van's call:
  chat widget, ✨ Draft, Edge Function and the Groq key all gone). Don't
  propose adding an LLM feature back unless asked.
- When porting between the regional tool and the research reports, match the
  regional **exactly** (fonts, paddings, colors, modal layouts) — the user
  compares pixel-for-pixel. `online-reports.html` is the source of truth for
  look-and-feel.
- Org policy (admin-set): if real PII, client data, credentials, or
  confidential business docs appear, **stop, flag, and refuse to process** —
  ask for anonymized placeholders first.

## Gotchas

- No build/test step. To verify, open the page in a browser (it needs a real
  HTTP server, not `file://` — sessionStorage/CDN/Supabase break on `file://`).
  `node --check shared/report-edit.js` is the quick JS syntax gate.
- **Cache-bust shared assets after editing anything in `shared/`.** GitHub Pages
  + browsers cache `shared/*.css` / `shared/*.js`, so a returning visitor sees
  the OLD file after a deploy — the live site looks different from the local copy
  until the cache expires. The user reviews the offline copy and expects online
  to match it exactly. Fix: every `shared/*` `<link>`/`<script>` carries a
  `?v=<content-hash>`; **run `node scripts/stamp-shared-assets.mjs` from the repo
  root whenever you change a shared file, before committing** (it re-hashes and
  rewrites the query strings in index.html + tools/*.html; idempotent, touches
  only query strings). Skipping this re-introduces the offline≠online gap.
- Windows shell: this repo is on Windows; prefer the dedicated file tools.
  Git warns "LF will be replaced by CRLF" — harmless.
- `reports_state` page IDs (p1, p2, …) overlap between regional and research
  reports but mean different content — the sync UI warns about this on purpose.
- **GitHub Pages does NOT auto-build on push for this repo** (legacy build
  from `main`). After pushing to `main`, kick a build:
  `gh api -X POST repos/VGrateja/performance-property-tools/pages/builds`,
  then it deploys in ~1–2 min.
- Past mojibake incidents: UTF-8 saved as Windows-1252 (incl. 4-byte emoji).
  Be careful editing files with emoji/curly-quote content.

## Brand

All UI, documents, and copy follow the Performance Property brand.
Rules: `.claude/skills/performance-property-brand/SKILL.md` (copied from the
brand repo `Performance-Property/performance-property-brand`; re-copy to update).

This repo deviates from TEAM_SETUP.md's submodule/npm consumption **on
purpose** — do not "fix" it: the brand repo is private, so a submodule breaks
the GitHub Pages build (Pages only fetches public submodules) and an npm git
dependency breaks every Actions workflow's `npm install`. The site is also
static/no-build, so nothing could import `brand.css` anyway. Instead the
palette is applied natively: `shared/os-theme.css` + `shared/common.css` are
the in-repo token layer (Teal #00A0B4, Dark Teal #171B24, Montserrat — see
the skill for the full rules). Revisit literal token consumption after the
Vercel migration.

- Never introduce a NEW brand color/font by hand — check the skill; if it
  isn't in the palette, that's a brand-repo PR conversation, not a local hex.
- Logos: use the repo's existing `assets/` logo files; never redraw/recolor.
  The canonical set lives in the brand repo under `assets/logos/`.
