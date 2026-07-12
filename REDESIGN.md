# Performance OS — redesign tracker

**Branch:** `os-redesign` (this worktree folder) · **Preview:** http://localhost:8124
**Current design stays on:** http://localhost:8123 + VS Code Live Server (5500) — folder `Supabase - Performance Internal Tool`, branch `main`. GitHub Pages deploys `main` only, so nothing here goes live until the final merge.

**Rules of the project** (locked): visual language from `pp-os.html` + `pp-os-app-template.html` · never modify tool logic / calculations / Supabase calls / tier gating / export code · every export path wraps capture in `PP_OS.exportFlat()` · mode lives in `localStorage['ppos-mode']` and behaves identically everywhere · one tool per session · vanilla JS, no build step.

## Status

| # | Page | Section | Reskinned | Exports verified | Tier verified | Notes |
|---|------|---------|-----------|------------------|---------------|-------|
| 0 | `index.html` (login → welcome → desktop) | Desktop | ✅ S1 | n/a | ☐ Van (real login, all tiers via view-as) | Login glass card on day-cycle sky (no sun/moon — verified day+night screenshots); welcome reskin; menubar + widgets + dock + windows; carousel removed. Auth/tier JS untouched |
| 1 | `tools/demand-score.html` | Analytics | ✅ S2 | n/a (print styles only — untouched) | ☐ Van | **Pilot.** Token-layer re-point + uniform header; hero logo (−77KB base64), back pills + dead toggle retired; accent teal→coral; data colors (houses/units/tiers/map) unchanged |
| 2 | `tools/traffic-lights.html` | Vault | ✅ S3 | n/a | ☐ Van | Token re-point + uniform header; back/vault pills + logo topbar retired; accent teal→violet; signal colors untouched; glass cards |
| 3 | `tools/vr-projection.html` | Vault | ✅ S3 | n/a | ☐ Van | Token re-point + uniform header; accent cyan→violet, “current” marker→blue (kept distinct from forecast); bands untouched |
| 4 | `tools/runway-workbook.html` | Analytics | ✅ S4 | n/a | ☐ Van | Token re-point + uniform header; accent cyan→coral; runway bands + WG-toggle violet untouched; assumptions editor intact |
| 5 | `tools/data-forge.html` | Vault | ✅ S5 | n/a | ☐ Van | Vault violet accent pair via --pp-cyan/--pp-violet re-point (charts read the vars at runtime — auto-follow); orbs→wallpaper; status/health + up/dn colors untouched; no auth-gate (unchanged; home grid renders signed-in — pre-existing, control-tested) |
| 6 | `tools/suburb-selection-data.html` | Vault | ✅ S4 | n/a | ☐ Van | common.css family: --pp-cyan→violet + wall; A/B/C/D rating colors untouched; no auth-gate (unchanged) |
| 7 | `tools/data-architecture.html` | Vault | ✅ S4 | n/a | ☐ Van | Accent→violet; ALL node-type/status colors untouched; drawer .scrim renamed .drawer-scrim (collided with the OS wallpaper class; id/JS untouched) |
| 8 | `tools/property-clock.html` | Analytics | ✅ S9 | ☐ JPEG ☐ PDF vs :8123 baseline | ☐ Van | **MAX-CONSERVATIVE**: uniform header + wallpaper ONLY — no accent re-hue, no font swap (Montserrat re-pinned; body color re-pinned `var(--text)`); `bakeClockLogo()` + export code byte-identical; clock stage untouched |
| 9 | `tools/runway-demand.html` | Analytics | ✅ S9 | ☐ JPEG ☐ PDF vs :8123 baseline | ☐ Van | **MAX-CONSERVATIVE**: header + wallpaper only — Roboto kept, `.chart-wrap` (the exported node) untouched; flex-body appbar stretch fix (`align-self:stretch` + full-bleed margins) |
| 10 | `tools/cadence.html` | PM | ✅ S6 | n/a | ☐ Van (realtime + notify) | --cad-* re-point to PM green; success/danger + card-status colors untouched; realtime/notify logic untouched |
| 11 | `tools/tenant-summary.html` | PM | ✅ S6 | ✅ paper brand asserted + print PDF captured; ☐ Van real one-pager | Chrome PM green; **#summaryPaper re-pins PP brand (cyan/navy/logo)** — owner output untouched; print block untouched |
| 12 | `tools/scorecards.html` | People | ✅ S7 | n/a | ☐ Van — incl. company-tier solo view + sign-off | People pink/violet; rating bands (green/amber/red/gold) + donut/heatmap untouched; privacy/tier gating untouched |
| 13 | `tools/results.html` | People | ✅ S7 | n/a | ☐ Van | --pp-cyan→People accent; in-tool ‹All results backs kept; hub back pill retired for the uniform header |
| 14 | `tools/arena.html` | Arena | ✅ S8+ | n/a | ☐ Van | REBUILT to the ORIGINAL hub-arena presentation (Van): compact stat cards (LIVE badges, top-score lines, watermark) + Live Now / Highlights / Top of the Leaderboards, powered by the hub’s loaders ported verbatim (+60s refresh); tier gate untouched |
| 15 | `tools/arena-typing.html` | Arena | ✅ S8 | n/a | ☐ Van | + Arena action button in header |
| 16 | `tools/arena-chess.html` | Arena | ✅ S8 | n/a | ☐ Van (live match) | Board/piece colors untouched; + Arena action button |
| 17 | `tools/arena-scrabble.html` | Arena | ✅ S8 | n/a | ☐ Van (live match + tile drag) | Tile/board colors + opacity-only body guard untouched; no fit-screen (unchanged); + Arena action button |
| 18 | `tools/whitepapers-strategies.html` | Docs | — | n/a | — | |
| 19 | `tools/online-reports.html` | Docs | — | ☐ download modal ☐ monthly PDF | — | **CHROME ONLY** — report pages excluded; add new chrome to `render-reports.mjs` strip lists |
| 20 | `tools/national-report.html` | Docs | — | ☐ | — | CHROME ONLY |
| 21 | `tools/commercial-report.html` | Docs | — | ☐ | — | CHROME ONLY; no theme.js today (dark-fixed) |
| 22 | `tools/presentations-library.html` | Present | — | n/a | — | |
| 23 | `tools/presentation.html` | Present | — | ☐ deck render | — | **Builder CHROME only** — slide content excluded |
| 24 | `shared/concierge.js` widget | (all) | — | n/a | — | Own session |
| — | `tools/present-chart-lab.html` | — | excluded | — | — | Dev utility, dark-only |

## Decisions log

- **2026-07-12 · Session 0.** Discovery approved. Desktop-first (index.html reskin — auth/tier/session logic stays byte-identical). Report + presentation *interiors* excluded — chrome only, last. Design system lives in `shared/` (not `assets/`) so `stamp-shared-assets.mjs` cache-busts it automatically. **Theme bridge:** `os-chrome.js` mirrors shade → legacy `data-theme` + `pp-theme` + `pp-theme-change` so un-reskinned pages stay in sync throughout the rollout; reskinned pages drop `theme.js` (single writer). Login design: no sun/moon — glass login card floating on the live period wallpaper (Van 2026-07-12). Six tiers (not four): dock/windows gate per tier, boot stays symmetric across tiers (hub-freeze rule). `fit-screen.js` zoom: mount OS chrome outside zoomed containers, decide per tool. Fonts Figtree + DM Mono via Google Fonts `<link>` per page.
- Dock sections (7 + reserved): Analytics · Vault · PM · Arena · Docs · Present · People — accents/glyphs registered in `os-chrome.js` `SECTIONS`.

- **2026-07-12 · Session 1 (desktop shell).** index.html reskinned via asserted transform (14 splices; celestial toggle + 4-page carousel removed, −20KB). Kept byte-identical: all auth/tier JS, login form ids/flows, modals (reports cluster / presentations / pending approvals), search palette logic, arena loaders, watchHubReveal, navigateToTool (wrapped only to record “Jump back in” recents). Dock = 7 sections; **PM + Vault CSS-gated to dev/admin/leads** (same fail-closed pattern) + nav-gated via `_hubIsStaff()` in openWin; Scorecards/Users-Presentations/Cadence rows reuse the existing gate classes. Windows carry the live ids (clockEditionBadge, forgeWarn→dock badge, arena feeds — loaders re-fire on window open). **fit-screen.js removed from the desktop only** (viewport-fit layout; CSS zoom breaks dock/window rect math). Tour copy updated to dock/appearance wording. hs-* at-a-glance ids live in the static widgets so auth.js populates them. **Headless verification:** signed-out boot fully green (login glass day+night screenshots in main folder `scratch/os-login-*.png`); signed-in desktop can’t be validated headless — a fake-session boot wedges headless Chrome identically on the OLD design (8123 control) → pre-existing environment artifact, so parity holds; real-browser sign-in testing = Van’s script below.

- **2026-07-12 · UNIFORM HEADER STANDARD (Van).** Every tool wears the identical OS app bar via `PP_OS.initChrome`: **← Desktop · section-gradient icon · tool name · section chip · (optional tool-specific action buttons) · appearance · clock.** No per-tool logos, heroes with brand marks, or ad-hoc back/theme buttons — branding lives on the desktop + login. Tool-specific extras are allowed as app-bar `actions` when their bindings are static, otherwise they stay in-page (Demand Score keeps Refresh/Push in-page — they're state-bound).
- **2026-07-12 · Session 2 (pilot: Demand Score).** Reskin pattern proven for token-based tools: **re-point the tool's own token layer** (`--ds-*`) at the OS palette + swap chrome — zero logic changes. 16 asserted transforms; −79KB (embedded hero logo base64 removed). Surfaces stay OPAQUE (OS-hued) because sticky table cells must occlude — glass = app bar/wallpaper/overlays only. Data-language colors intentionally kept: houses blue / units violet, tier greens→reds, smooth/workforce dots, dark Leaflet card. Action accent re-hued teal `#00b6cb` → Analytics coral (asserted counts). Two minimal JS string edits, stated: hero logo `h("img")` pair removed; nothing else. Back button preserves the tool's outbound overlay (`navigateToHub`). Headless: gate redirect ✓; skin verified via gate-aborted signed-out run (fake-session wedge = pre-existing env artifact — OLD tool control-tested identical); light+dark screenshots ✓. Error-card colors are hardcoded dark (polish-sweep item).

- **2026-07-12 · Session 3 (Vault wave 1/3): traffic-lights + vr-projection.** Both small enough to pair (42KB+29KB, both recently built). Direct-edit reskin (no transform script needed): head swap (os-chrome + os-theme + Figtree), token re-point to Vault violet, wall + initChrome replacing pp-toolnav/topbar, glass upgrade on cards. VR marker distinction preserved (current=blue vs forecast=violet). Headless: full TL UI verified via baked-DATA fallback (rows/dots/summary/accents both shades, screenshots); VR chrome+tokens+graceful sign-in message verified.

- **2026-07-12 · Session 4 (Vault wave 2/3): runway-workbook + suburb-selection-data + data-architecture.** Asserted batch transforms (22 steps). Gotcha logged: a tool defining its own `.scrim` class collides with the OS wallpaper div (`.wall.scrim`) — opacity:0/z-index wars; fix = rename the TOOL’s class (element id + JS untouched). Self-collision gotcha: inserted payload text must not contain the patterns later count-swapped. Headless: all 3 verified (appbar/chip/wall z-order/fonts/accents; data-architecture full map — 29 nodes, master cyan + status colors preserved).

- **2026-07-12 · Session 5: data-forge (282KB).** 10 asserted transforms. The tool’s charts/sparklines read `--pp-cyan`/`--pp-violet` from computed style with hex fallbacks — re-pointing the tokens re-hues every canvas/SVG automatically (fallback hexes swapped too). Harness learning: aborting supabase simulates network-death and trips paths prod never hits — for gate-less tools test with LIVE anon traffic; and CONTROL-TEST 8123 before chasing “regressions” (signed-out empty grid = pre-existing).

- **2026-07-12 · Session 6 (PM wave): cadence + tenant-summary.** PM green accents. Tenant one-pager treated as CLIENT OUTPUT: `#summaryPaper` re-pins the PP brand tokens inside the paper while the tool chrome re-points — pattern for any tool that RENDERS a branded document. Both tools keep guarded `navigateToHub` back behaviour. **Harness lesson (caught by post-checks): a transform helper must mutate ONE source of truth — an fn(x,…) parameter shadowing the closure wrote a stale original back while logging ok; fixed T() to closure-only + has() checks. Always confirm a real `git diff --stat` after a transform.**

- **2026-07-12 · Session 7 (People wave): scorecards + results.** People pink/violet accents. Scorecards: rating-band + donut/heatmap colors asserted untouched; privacy/tier logic untouched (Van verifies company-tier solo view + 3-party sign-off). Results: first tool with NO legacy back pill — uniform header added fresh.

- **2026-07-12 · HOTFIX (Van-reported): OS kit scoped under .** The kit’s generic class names (.seg/.chip/.table/.toast/…) were GLOBAL and collided with tools’ own classes — Scorecards’ td.seg picked up the kit’s padded glass box + flex display, fattening the Always/Partial/No controls and stacking the Self-assessment/Achieved columns. All Layer-5 selectors now require a  ancestor (os-preview wraps accordingly); probe-verified: bare .seg receives zero kit styles, kit intact inside the wrapper. RULE: kit classes only apply inside  wrappers.

- **2026-07-12 · Session 8 (Arena wave): arena + typing + chess + scrabble.** Arena pink chrome; game/board/tile colors untouched (scrabble has zero accent-cyan — its palette is all game data). Games get an **Arena action button** in the uniform header (static binding). Gotchas: (1) arena pills were NOT body-top — blind in-place chrome injection nested the wall/appbar and initChrome’s insertBefore threw; os-chrome now guards (anchors to the wall only when it’s a direct body child, else prepends); (2) naive `indexOf('<body')` hit the literal text “<body>” inside scrabble’s CSS comments — anchor on a REAL tag (`
<body>`) when relocating blocks in big files.

- **2026-07-12 · Session 9 (Analytics export pair): property-clock + runway-demand.** These two produce client-facing JPEG/PDF exports, so the reskin is **maximum-conservative**: head swap + wallpaper + uniform header and NOTHING else — no accent re-hue, no Figtree (fonts re-pinned: clock Montserrat + `color:var(--text)`, runway Roboto — os-theme's global `body{font-family:var(--ui);color:var(--tx)}` would otherwise shift exported text metrics/hues). Loading-overlay card gradients left as-is (never captured). New gotcha: **a centered flex-column body turns the sticky appbar into a shrink-to-fit flex item** — fix `.appbar{align-self:stretch;margin:-24px -16px 18px}` (stretch + cancel body side padding = full-bleed bar, body padding preserved so `.chart-wrap` width is unchanged). Headless (gate-abort recipe): both pages full-render with correct bar/wall/fonts and interiors pixel-faithful; exports must be Van-verified **side-by-side vs :8123** (same region/month → JPEG + PDF from both servers should be identical).

## Open issues

- **Arena Live Now / Highlights content differs from the original (Van, deferred).** Loaders machine-diffed as logic-identical; session-gated boot applied (158760c) — still differs per Van. Next: side-by-side screenshots of 8123 vs 8124 panels at the same moment to pinpoint (data-dependent).

## Session protocol

1. Work happens **in this worktree** only; `main` stays clean for hotfixes.
2. Before starting: `git merge main` (pull in anything shipped on main since last session).
3. One tool per session → update the Status table → end with a click-by-click test script for Van at :8124.
4. Any session touching `shared/` runs `node scripts/stamp-shared-assets.mjs` before commit.
5. Export-capable tools: capture "before" files into `baselines/` (from the CURRENT design) **before** reskinning, and diff after.
6. Ship day (end of project): final `git merge main` → merge `os-redesign` into `main` → stamp → push → post-ship export + monthly-PDF check.

## Infrastructure

| What | Where |
|---|---|
| New design preview | http://localhost:8124 ← this folder (`Desktop\PP-OS-Redesign`), auto-starts at logon (task “Performance Tools - OS Redesign Server”, `scratch/serve-redesign.vbs` in the main folder) |
| Current design | http://localhost:8123 (task “Performance Tools - Local Server”) + VS Code Live Server :5500 — main folder, branch `main` |
| Kit demo | http://localhost:8124/os-preview.html — renders the extracted design system without touching any tool |
