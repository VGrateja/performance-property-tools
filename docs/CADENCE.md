# Cadence — handover note

**Purpose**: a custom internal tool for the **Property Management department**, currently a placeholder on the hub while requirements are being scoped with the PM department head.

This note brings a fresh Claude session up to speed so you can pick up where the previous one left off without re-asking Vandolf what was already decided.

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
