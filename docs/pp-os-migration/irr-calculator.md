# IRR Calculator — feature note for the pp-os port

A Vault tool: what our clients' purchases actually returned. Median IRR, CAGR, return and hold period across the properties
they have sold, a register you can filter and sort, a per-deal calculation, and the RP Data sold check that drives the
bookmarklets. Ported 2026-10-28 from the standalone build at `pp-research.github.io/tools/irr-breakdown.html`, which Shaene
had been running against her own Supabase project.

It is NOT connected to Sold Check. Both tools hold a register of client purchases and both drive an RP Data bookmarklet, but
they keep separate data and answer different questions — Sold Check asks "has this sold?", the IRR Calculator asks "what did
it return?". Merging the two registers was considered and deliberately deferred: see **Not done** below.

| What | Path |
|---|---|
| The tool | `tools/irr-calculator.html` |
| Its engine (XIRR, the realised-deal model) | `tools/irr-breakdown-engine.js` |
| Suburb → LGA lookup, for the register's spell-check | `tools/suburb-lga.js` |
| Tables + RLS | `supabase/migrations/131_irr_calculator.sql` |
| Registry / hub | `shared/tool-registry.js` key `irr-calculator` (sec `vault`); `index.html` Vault APPS card + search entry |

The engine and the suburb file sit beside the page rather than in `shared/`, like `client/adelaide-returns-math.js` — nothing
else uses them, and it keeps them out of the shared-asset stamping cycle.

---

## 1. Data model (migration 131)

Two tables, like `126_sold_check.sql`: the thing, and what people did to it.

**`public.irr_book`** — `id text primary key` (one row per capital-city book: `adelaide`, `brisbane`, …) · `body jsonb not
null` · `updated_at timestamptz` · `updated_by text`.

`body` is the whole register as the tool already stores it: `properties[]`, the assumptions block, a rev stamp. Archived and
outside-of-advice entries are **in** that array, carrying `outside` and `outsideReason` — `shareBody()` writes them, so the
row is complete and a CSV export (which only ever holds the visible, filtered rows) is not. The document shape is unchanged
from the standalone build, so the move is a copy rather than a migration of content.

Three per-property fields never reach the book at all, in either build: `soldVerified`, `soldLink` and the per-entry
`savedAt`. `shareBody()` drops them, so they are browser-local and always have been.

**`public.irr_log`** — `id bigint identity` · `at timestamptz default now()` · `who text` · `action text` · `property text`
· `detail text`, indexed on `at desc`. The tool appends `{ who, action, property, detail }` and reads the latest 300. It is
a separate table because the book is overwritten on every save, so a log kept inside it would be erased by the next edit.
`detail` stays `text` rather than `jsonb`: the tool writes a JSON string for some actions and a plain sentence for others,
and the History tab parses the former to find a property's city.

- Trigger `trg_irr_book_touch`: `updated_at := now()`, `updated_by := jwt email`. Matches
  `sold_check_properties_touch()` rather than `touch_updated_at()`, which writes `auth.uid()`.
- Writes: `irr_book_can_write() = is_writer() OR has_tool_role('irr-calculator', 'editor')` — the scorecards / sold-check
  tool-scoped pattern, so a Viewer can be given edit rights inside this one tool.
- **Reads are writers only.** The body carries real client addresses and purchase prices. `sold_check_properties` holds the
  same addresses under read-for-any-authenticated; this table starts narrower so that widening it is a decision someone makes
  rather than one inherited by copying a pattern. To open it to all signed-in staff, the `"irr book read"` policy becomes
  `using (true)` and nothing else changes.
- No DELETE policy: a book is renamed or emptied from the UI, never dropped.
- Added to the `supabase_realtime` publication (guarded), because the tool subscribes to `postgres_changes` so one person's
  edit reaches another's open tab without a reload.

## 2. What the port changed

Everything below is the difference between the standalone build and this one. The tool's own behaviour — the engine, the
register, the overview, the sold check — is untouched.

- **Head and chrome.** `os-chrome.js` + `os-theme.css`, `PP_OS.initChrome({ name: 'IRR Calculator', section: 'vault' })`, and
  the usual Vault script set (supabase-client, tool-registry, desktop-pins, auth, auth-gate, pp-telemetry, fit-screen).
- **The theme block is gone.** os-chrome owns the shade, and its legacy bridge is the convention this stylesheet already
  used — dark = no `data-theme` attribute, light = `data-theme="light"` — so both token sets work unchanged. The page's own
  pre-paint theme script, the moon/sun button and the logo-variant swap all went with it.
- **Sign-in is gone.** It had its own email+password dialog against its own project. `auth-gate.js` now bounces anyone not
  signed in, and the appbar signs them out.
- **The Supabase client is the hub's.** It used to call `createClient()` with its own URL and key from a
  `supabase-config.js` beside the page; it now uses `window.sb`.
- **The write gate changed meaning.** It was "any session can write" — true of a project whose only users were the three
  people who had the password. It is now dev/admin or the `irr-calculator` editor grant, asked on the client only so the UI
  can disable what RLS would refuse.
- **`connectShare()` removed** — the Claude artifact-runtime path the tool was first built in (`window.claude`), dead here
  and setting `canWrite` from a different authority.

## 3. Not done

- **The registers are still separate.** `sold_check_properties` (one row per property, typed columns) and `irr_book` (one
  jsonb document per city) hold overlapping addresses. Unifying them means deciding where the IRR Calculator's
  `outside` / `outsideReason` flags and its ten assumptions live, neither of which the Sold Check schema has a home for.
  Sold Check's Import already reads this tool's JSON export, so the manual path still works in the meantime.
- **The RP Data bookmarklet still reads the standalone project.** It fetches `supabase-config.js` from pp-research at run
  time to get the URL and key. In the hub that is the wrong book; it needs the hub's URL and anon key substituted at build
  time the way `__SHEET_URL__` already is. **Until that is done the bookmarklets belong to the pp-research copy, not this
  one.**
- **The Google Sheet is still the sold check's store.** Results go to an Apps Script `/exec` endpoint rather than into
  Supabase. Sold Check's `sold_check_results` + Verify queue is the obvious destination if these ever converge.

## 4. Known gaps

- A new key needs a Groups tick (Van) before admins assigned to a group, or staff, see the Vault card.
- The standalone build at `pp-research.github.io/tools/irr-breakdown.html` still exists and still works. Until it is retired
  there are two copies, and only one of them is the real register — decide which before anyone else is pointed at this.
- The data has to be copied across: the book one row per city, and the change log as a table. Neither goes through a
  CSV export of the register — that only ever holds the visible, filtered rows.

## Changelog

- 2026-10-28 — Ported: the tool, its engine and suburb file, migration 131, the registry key, the Vault card and the hub
  search entry.
