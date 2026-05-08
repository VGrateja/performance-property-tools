# Cadence — build journal & handover note

**Purpose**: a custom internal tool for the **Property Management department**, currently a placeholder on the hub while requirements are being scoped with the PM department head.

This note brings a fresh Claude session up to speed so you can pick up where the previous one left off without re-asking Vandolf what was already decided.

## How to use this document

This is **both** a handover note (read top-to-bottom for the full context of what Cadence is, why, and where it is now) **and** a running journal (the "Journal" section at the bottom captures every meaningful decision, change, or blocker with dates, so the evolution of the tool is preserved).

**Rules for any Claude or human working on Cadence:**

1. **Read this whole doc before doing anything.** Skip nothing. Most of the surprises are in the "Things NOT to do" section.
2. **After every working session, append an entry to the Journal section at the bottom.** Even tiny changes — a CSS tweak, a copy-edit, a renamed function — are worth a one-line entry. The entry should record:
   - What was decided / changed
   - Why (the reasoning, not just the action)
   - Which files were touched
   - What's blocking us from going further (if anything)
3. **If a decision contradicts something earlier in this doc**, update the relevant section *and* note the change in the Journal so the diff is traceable. Don't let stale advice live alongside fresh advice.
4. **Use chronological order in the Journal** (oldest entry at the top, newest at the bottom). New entries append; never edit historical entries except to fix typos.
5. **Date every entry as `YYYY-MM-DD`.** The system clock is the source of truth — check it via the harness's date context if unsure.

The intent: any Claude session can pick up Cadence cold, read this doc, and know exactly where things stand without Vandolf having to re-explain context.

---

## TL;DR

- Hub card **Cadence** already exists, hidden from everyone except `vandolf@performanceproperty.com.au` and `lindsay@performanceproperty.com.au` (the PM head).
- The card opens a placeholder alert (`navigateToCadence()`) — the tool itself isn't built yet.
- A scoping questionnaire has been sent to Lindsay. **Wait for her answers before designing.**
- Once requirements arrive, the path is to build a small, custom workflow tracker in the same architectural style as the existing tools — *not* to clone Monday.com or Airtable.

---

## What Cadence is meant to be

A lightweight internal workflow board for the Property Management team. Tracks the recurring rhythms of PM work — likely inspections, maintenance, lease renewals, compliance checks, owner communications, etc., but the actual scope is determined by Lindsay's answers, not assumed.

The tool is **inspired by** Monday.com and Airtable, but the explicit instruction from Vandolf is:

> "Use them as inspiration. Just like what I did with Online Reports — the idea is from Looker Studio and I just added the features that I need. Creating your own system is more flexible compared to using one that someone else created."

Translation: cherry-pick concepts that fit, don't try to clone the products.

### Concepts worth borrowing (when scope is clear)

| From Monday.com | From Airtable |
|---|---|
| Kanban view (cards in status columns) | Typed columns (text, date, select, checkbox, person, etc.) |
| Status as colored pill, not free-text | Multiple **views** of the same data |
| Drag cards between status columns | Filtered / sorted views per user role |

### Concepts to skip in MVP

Calendar, Gantt, formulas, multi-select, attachments, automations, public form view. Add only when Lindsay's actual workflow demands them.

---

## Naming rationale (don't second-guess unless Vandolf asks)

The name **Cadence** was chosen deliberately. Reasons:

1. PM work is fundamentally rhythmic (inspections every X months, monthly owner statements, annual lease renewals, recurring compliance windows). "Cadence" names that recurring beat.
2. Active verb-flavored noun — people naturally say "what's our cadence on X?" — the tool name fits inside normal sentences.
3. Musical / military origin (Latin *cadere*, to fall — the beat at the end of a phrase) gives it gravitas without being stuffy.
4. It scales beyond PM if the tool ever grows (any recurring workflow has a cadence).
5. Avoids real-estate naming clichés (Estate, Manor, Holdings, Property, Asset). The site is already on performanceproperty.com.au — more "property" words would be redundant.
6. Distinct from existing tool names but matches their shape: short, evocative, single noun (Property Clock, Online Reports, Demand Score, Documents, Presentation, Cadence).

There is a Salesloft product called Cadence, but it's sales-engagement software — different industry, no confusion risk for PM staff.

---

## Current state in the codebase

### Hub card
**File**: `index.html`
**Location**: just before the Tier-4-allowed Lite Online Reports pill.
**Class**: `.cadence-card` (plus the standard `.hub-tool-card.nav-pill`).
**Icon**: 🎼 (musical staff — fits the name).
**Badge**: `is-wip` variant — "🚧 In Scoping" in amber.
**Click handler**: `navigateToCadence()` — currently pops a "Coming soon — being scoped with the PM team" alert.

### Visibility gating

The card is **email-gated, not tier-gated**. Lindsay (the PM head) is not a Tier 1 admin (her email is not in `ADMIN_EMAILS`); the standard tier system would either show the card to all Tier 2 staff or hide it from Lindsay. Neither works.

Implementation in `index.html`:

```js
const CADENCE_EMAILS = [
  'vandolf@performanceproperty.com.au',
  'lindsay@performanceproperty.com.au'
];
function applyCadenceVisibility() {
  let email = '';
  try { if (typeof getCurrentUserEmail === 'function') email = (getCurrentUserEmail() || '').toLowerCase(); } catch (_) {}
  const allowed = email && CADENCE_EMAILS.indexOf(email) >= 0;
  document.body.classList.toggle('cadence-allowed', !!allowed);
}
```

Plus CSS:

```css
.cadence-card { display: none !important; }
body.cadence-allowed .cadence-card { display: flex !important; }
```

`applyCadenceVisibility()` is called from `watchHubReveal()`'s `tryUpdate()` so it runs on login, bfcache restore, and every body-class mutation.

To grant access to a new email, add it to `CADENCE_EMAILS` lowercase. Removal: same list.

---

## What's pending (DO THIS FIRST)

A scoping questionnaire was emailed to Lindsay. **Don't start building until her answers arrive.** The questions are deliberately structured so the answers cascade into a build plan:

1. What's the main thing the board would track? (maintenance / inspections / lease renewals / arrears / compliance / etc.)
2. Who would use it day-to-day, roughly how many people?
3. What does a single "card" represent? (one job / one property / one inspection / etc.)
4. What information would each card need? (rough fields)
5. What "stages" does a typical item move through? (the kanban columns)
6. What views would be useful? (kanban / table / calendar / other)
7. Are there existing tools (PropertyMe, TAPI, Inspect Real Estate, Inspection Express, REIWA/REISA) this should replace or talk to?
8. What's the most painful thing the team does today that this should fix?
9. Any non-negotiables? (mobile / photos / owner notifications / audit log / etc.)
10. Volume estimate (10s / 100s / 1000s of cards; how many added per week?)

When her answers come back, ground the design in those — don't pre-suppose the workflow.

---

## Architectural fit

When you do build, the tool should follow the existing patterns:

| Concern | Pattern |
|---|---|
| Frontend | Static HTML page in `tools/cadence.html`, loaded from the hub via `navigateToTool('tools/cadence.html', 'Cadence')` |
| Backend | New table(s) in Supabase. Apply RLS the same way `clock_state` / `reports_state` etc. do — see `supabase/migrations/001_init.sql` for the existing pattern. |
| Auth | Reuse `shared/auth.js` + `shared/auth-gate.js` — already loaded by every tool. Tier checks via `isAdmin()`, `getCurrentUserEmail()`, etc. |
| Real-time | Supabase Realtime if multiple users will edit the same board concurrently. Handful of lines: subscribe to changes, update the local view. |
| Chrome | Floating Back-to-Hub + Theme + (if needed) View/Edit toggle, matching the Documents / Presentation pattern. CSS lives in the tool page itself; the existing `.pp-back-to-hub` and `.cl-theme-toggle`-style buttons are good references. |
| Storage shape | Probably a `cadence_boards` table + a `cadence_items` table. JSONB column for per-board column config (so adding new column types doesn't need DDL changes). |

---

## Suggested MVP scope (only when Lindsay's answers arrive)

The earlier sketch — for reference only, not a commitment:

**Day 1**: Supabase schema (`cadence_boards` + `cadence_items` tables) + Boards landing page with one default board hardcoded. Table view, add/edit/delete items. Text + status columns only.
**Day 2**: Kanban view toggle. Drag cards between status columns.
**Day 3**: Custom column types — date, checkbox, person (linked to `profiles`), long-text. Inline editing.
**Day 4**: Filter + sort on table view. Color-coded status. Real-time sync via Supabase Realtime.
**Day 5**: Multi-board support (create / rename / delete). Per-board column configuration UI.
**Day 6–7**: Polish — empty states, keyboard shortcuts, audit log, mobile-friendly table.

**Total**: ~5–7 days for an MVP that's a proper M+A-flavoured board, customisable per workflow.

If Lindsay's needs are narrower than the above, drop features. If broader, add only what the actual workflow requires — same discipline as Online Reports.

---

## Things NOT to do

- Don't build before Lindsay responds. Building generic infrastructure based on guesses is the trap of cloning a product.
- Don't change the visibility model from email-gated to tier-based without Vandolf's nod — Lindsay is not a Tier 1 admin and the gate has been deliberately scoped.
- Don't rename the tool. Cadence was picked deliberately (see rationale above) and Vandolf has signed off on it.
- Don't expand the audience by default. If someone else needs access, add their email to `CADENCE_EMAILS` explicitly — visibility creep is a security smell.
- Don't try to clone Monday.com or Airtable. The whole point is to build the 5–10% of those tools that fit PM, not 100% of either.

---

## When the time comes to swap the placeholder

Three changes hand-in-hand:

1. Build `tools/cadence.html` with chrome + the actual board UI.
2. In `index.html`, change `navigateToCadence()` from the alert to:
   ```js
   function navigateToCadence() {
     navigateToTool('tools/cadence.html', 'Cadence');
   }
   ```
3. On the card markup, swap the `is-wip` badge from "🚧 In Scoping" to whatever makes sense (e.g. "Beta" or just remove the badge entirely once stable). Drop the "Being scoped" line from the description.

That's it. The visibility gate keeps working unchanged.

---

## Journal

Append a new entry under this section after every meaningful working session. Oldest at the top, newest at the bottom. Date as `YYYY-MM-DD`.

### 2026-05-07 — Tool conceived; placeholder card on hub

**Context:** Vandolf asked whether building a Monday.com-style board inside the existing tools site was feasible. After back-and-forth, the decision was to build a custom tool inspired by Monday.com + Airtable concepts but scoped to whatever the Property Management team actually needs — same approach Online Reports took with Looker Studio. Lindsay (PM department head) is the customer; she's not yet replied to the scoping questionnaire.

**Decisions:**
- **Name:** `Cadence`. Selected for the recurring-rhythm metaphor of PM work (inspections, lease renewals, monthly statements). Full rationale in the "Naming rationale" section above.
- **Visibility model:** email allowlist (`CADENCE_EMAILS`), not tier-based. Lindsay isn't a Tier 1 admin and the standard tier system would either over-share or hide her out. Card hidden from everyone whose email isn't in the list — including Saskia / Shaene / Paul (the other Tier 1 admins).
- **Build phase:** **blocked on Lindsay's questionnaire answers.** No code written yet beyond the hub placeholder. Designing the column / view set without her input is a known trap.

**Changes:**
- `index.html` — added `<button class="hub-tool-card nav-pill cadence-card">` markup just before the Lite Online Reports pill. Icon 🎼, badge `is-wip` "🚧 In Scoping".
- `index.html` (script) — added `CADENCE_EMAILS` allowlist + `applyCadenceVisibility()` + `navigateToCadence()` (currently pops a "Coming soon — being scoped" alert).
- `index.html` (CSS) — `.cadence-card` hidden by default; `body.cadence-allowed .cadence-card` reveals it.
- `applyCadenceVisibility()` is invoked from `watchHubReveal()`'s `tryUpdate()` so it re-runs on login, bfcache restore, and every body-class mutation.
- `docs/CADENCE.md` — created (this file). Initial commit: `53381e8`.

**Files touched:** `index.html`, `docs/CADENCE.md`.

**Blockers / Next:**
- Waiting on Lindsay's reply to the 10-question scoping email Vandolf sent. The questions are listed in the "What's pending" section above. Until those answers arrive, do NOT start building the actual tool.
- When Lindsay responds, design the data model + first board's columns from her answers, *not* from any pre-built generic schema.

**Out of scope for this entry:** the full M+A-inspired MVP scope (boards / typed columns / kanban + table views / real-time sync). That's the suggested-MVP plan further up; it kicks in only after requirements arrive.

### 2026-05-07 — Hub becomes a 2-page slider; Cadence moves to a "Property Management Tools" page

**Context:** Vandolf wanted the Cadence card to live on a separate hub page (not next to the main analytics tools), reachable via an Instagram-carousel-style horizontal slide. A pull-tab on the left edge of the hub — visible only to allowed users — switches to the PM page.

**Decisions:**
- **Slider model:** two `.hub-tools` sections inside a flex `.hub-pages-track` (200% wide). `body.hub-pm-active` toggles `transform: translateX(-50%)` to slide page 2 in. Easing matches the rest of the app (`cubic-bezier(0.22, 1, 0.36, 1)`, 0.55s).
- **Visibility:** the two pull-tab nav buttons (`.hub-page-nav-left` "Property Management Tools", `.hub-page-nav-right` "Performance Tools") are gated on `body.cadence-allowed` AND the opposite page state. So an allowed user sees exactly one tab — the one taking them to the OTHER page. Non-allowed users never see either; the PM page is unreachable.
- **Folder rename:** the working folder was also renamed `performance-property (migration)` → `Performance Internal Tool` and moved to the desktop root. Git remote unchanged.

**Changes:**
- `index.html` — wrapped `<section class="hub-tools" id="hubToolsGrid">` in `<div class="hub-pages-slider"><div class="hub-pages-track">…</div></div>`. Moved the Cadence card OUT of `#hubToolsGrid` into a new sibling `<section class="hub-tools hub-tools-pm" id="hubToolsGridPm">` with its own header (`Department Tools · Property Management`).
- `index.html` (CSS) — added `.hub-pages-slider`, `.hub-pages-track`, page-2 header styles, `.hub-page-nav-left/right` pull-tab styles + visibility rules. `prefers-reduced-motion` zeroes the transitions.
- `index.html` (JS) — added `setHubPage('pm' | 'main')` that toggles `body.hub-pm-active`. `applyCadenceVisibility()` updated to also clear `hub-pm-active` when access is revoked, so an unallowed user is never stranded on the PM page.

**Files touched:** `index.html`, `docs/CADENCE.md` (this entry).

**Blockers / Next:**
- Still waiting on Lindsay's questionnaire reply. The slider is live but the PM page only contains the Cadence placeholder.
- When Lindsay's answers arrive and we build the actual Cadence tool, the PM page is already there as a home for it.

**Notes for future-Claude:**
- The PM page (`#hubToolsGridPm`) is the right place to drop any new PM-only tools that surface later. Just add another card to that section — same `.hub-tool-card` markup as the rest of the hub. The card will inherit the same email-allowlist visibility because the whole page is unreachable to anyone outside `CADENCE_EMAILS`.
- If you want a per-tool email allowlist *within* the PM page (e.g. some tools visible to Lindsay only, others to Lindsay + a deputy), add another body class + per-card CSS gate. Don't reuse `body.cadence-allowed` for that.

### 2026-05-08 — Pull-tab visual tuning

**Context:** Iterated on the look of the slider's pull-tab nav buttons after the initial 2-page slider landed. User wanted the affordance to "whisper" — soft curve, no filled box, blends into the gradient — and over a few rounds dialed in size, vertical anchor, and edge offset.

**Decisions:**
- **No box.** Background, border, and box-shadow all dropped. Just colored text + curved SVG sweep, with opacity doing the "blend into gradient" work (0.42 idle → 0.92 hover).
- **Curve, not chevron.** Replaced the polyline `<` with a quadratic-bezier `<path d="M 11 4 Q 1 22 11 40">` (mirrored on the right tab). Reads as a soft sweep rather than a sharp angle.
- **Vertical anchor:** `top: 48%`. The slider takes the height of the taller page (page 2 has a header above its cards), so straight 50% lands a touch below page 1's actual mid-line. 48% nudges the tab up so it reads as sitting in the row gap between row 1 (Clock / Runway / etc.) and row 2 (Documents / Online Reports / etc.).
- **Horizontal anchor:** asymmetric per user's eye — `left: 8px` on the PM tab, `right: 5px` on the return tab. Both pushed deep into the empty gradient space outside the centered cards.
- **Sized up from the first pass:** SVG 14×44 → 22×64, font 10.5px → 12.5px, stroke 1.6 → 2, letter-spacing 2.2 → 2px, padding/gap bumped a touch. Reads cleanly without competing with the cards.

**Changes:**
- `index.html` (CSS) — `.hub-page-nav` size + position + curve styling iterated. Final values committed in this entry.
- `index.html` (CSS) — split the old `.hub-pages-slider` into `.hub-pages-slider` (full-width frame, just a position-relative anchor) + `.hub-pages-clip` (the 1240px-max-width centered container with `overflow-x:hidden`). Tabs anchor to the frame so they can extend out into the gradient space; the cards still center inside the clip.
- `index.html` (markup) — wrapped `.hub-pages-track` in a new `.hub-pages-clip` div to support the split above.
- SVG path swapped from polyline chevron to quadratic-bezier curve (`M 11 4 Q 1 22 11 40`, mirrored as `M 3 4 Q 13 22 3 40` for the right tab).

**Files touched:** `index.html`, `docs/CADENCE.md` (this entry).

**Notes for future-Claude:**
- If the slider gains more rows on either page, `top: 48%` will need re-tuning. The ad-hoc fix is to bump the percentage so the visible tab still lands in the row gap on page 1.
- The asymmetric left/right offset (8px / 5px) was deliberate — user explicitly tuned by eye. Don't "fix" it back to symmetric without checking with Vandolf.
