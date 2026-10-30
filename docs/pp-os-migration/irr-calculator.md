# IRR Calculator — feature note for the pp-os port

A Vault tool: what our clients' purchases actually returned. Median IRR, CAGR, return and hold period across the properties
they have sold, a register you can filter and sort, a growth comparison against the Cotality medians, a per-deal
calculation, and the RP Data sold check that drives the bookmarklets. Ported 2026-10-28 from the standalone build at
`pp-research.github.io/tools/irr-breakdown.html`, which Shaene had been running against her own Supabase project, and
refreshed from that build on 2026-10-30.

It is NOT connected to Sold Check. Both tools hold a register of client purchases and both drive an RP Data bookmarklet, but
they keep separate data and answer different questions — Sold Check asks "has this sold?", the IRR Calculator asks "what did
it return?". Merging the two registers was considered and deliberately deferred: see **Not done** below.

| What | Path |
|---|---|
| The tool | `tools/irr-calculator.html` |
| Its engine (XIRR, the realised-deal model) | `tools/irr-breakdown-engine.js` |
| Suburb → council lookup, for the register's spell-check and the vs-Council view | `tools/suburb-lga.js` |
| Cotality council medians, 38 Greater Adelaide/Brisbane councils, monthly from 1980-03 | `tools/lga-median.js` |
| The Apps Script source the sold-check modal links to | `tools/sheet-endpoint.gs.txt` |
| Tables + RLS | `supabase/migrations/131_irr_calculator.sql` |
| Registry / hub | `shared/tool-registry.js` key `irr-calculator` (sec `vault`); `index.html` Vault APPS card + search entry |

The engine and the three data files sit beside the page rather than in `shared/`, like `client/adelaide-returns-math.js` —
nothing else uses them, and it keeps them out of the shared-asset stamping cycle.

---

## 1. Data model (migration 131)

Three tables, like `126_sold_check.sql`: the thing, what people did to it, and the one setting that belongs to the team
rather than to a browser.

**`public.irr_book`** — `id text primary key` (one row per capital-city book: `adelaide`, `brisbane`, …) · `body jsonb not
null` · `updated_at timestamptz` · `updated_by text`.

`body` is the whole register as the tool already stores it: `properties[]`, the assumptions block, a rev stamp. Archived and
outside-of-advice entries are **in** that array, carrying `outside` and `outsideReason` — `shareBody()` writes them, so the
row is complete and a CSV export (which only ever holds the visible, filtered rows) is not. The document shape is unchanged
from the standalone build, so the move is a copy rather than a migration of content.

`shareBody()` rebuilds each property from the explicit `SHARE_FIELDS` list, so that list **is** the schema: a field missing
from it is a field deleted from the book the next time anyone saves. It carries `name`, `category`, `ptype`,
`purchasePrice`, `purchaseDate`, `soldPrice`, `soldDate`, `soldVerified`, `soldLink`, `soldCheck`, `note` and the
`outside` / `outsideReason` pair. Only the per-entry `savedAt` is deliberately browser-local.

> **This is the one thing to understand before editing `shareBody()`.** Until 2026-10-29 the list omitted `ptype`,
> `soldVerified`, `soldLink` and `soldCheck`, and every save pushed a shared copy without them; the next `applyShared()`
> replaced the local copy wholesale. That silently erased the property type from all 372 typed properties, and `soldLink`
> is still empty across the whole book as a result. Adding a field to the entry shape without adding it to `SHARE_FIELDS`
> does not make it browser-local — it makes it disappear.

**`public.irr_log`** — `id bigint identity` · `at timestamptz default now()` · `who text` · `action text` · `property text`
· `detail text`, indexed on `at desc`. The tool appends `{ who, action, property, detail }` and reads the latest 300. It is
a separate table because the book is overwritten on every save, so a log kept inside it would be erased by the next edit.
`detail` stays `text` rather than `jsonb`: the tool writes a JSON string for some actions and a plain sentence for others,
and the History tab parses the former to find a property's city.

**`public.irr_config`** — `key text primary key` · `value text` · `updated_at timestamptz` · `updated_by text`. One row,
key `rpdata_exec`: the `/exec` address of the Apps Script behind the sold-check sheet, so whoever sets it up sets it up
once for everyone instead of each person pasting it into their own browser.

Reads are writers-only here too, and for a sharper reason than the book's: that address **is** the capability. Anyone
holding it can append rows to the sheet without signing in to anything. The tool only ever reads the row when
`canWrite === true`, so the policy and the code agree exactly.

The tool treats this table as optional — both call sites catch the error and fall back to this browser's own copy, and the
sold-check panel says so — so a project without it degrades to per-browser configuration rather than failing.

- Trigger `trg_irr_book_touch`: `updated_at := now()`, `updated_by := jwt email`. Matches
  `sold_check_properties_touch()` rather than `touch_updated_at()`, which writes `auth.uid()`.
- Writes: `irr_calculator_can_write() = is_writer() OR has_tool_role('irr-calculator', 'editor')` — the scorecards / sold-check
  tool-scoped pattern, so a Viewer can be given edit rights inside this one tool.
- **Reads are writers only.** The body carries real client addresses and purchase prices. `sold_check_properties` holds the
  same addresses under read-for-any-authenticated; these tables start narrower so that widening them is a decision someone
  makes rather than one inherited by copying a pattern. To open the book and the log to all signed-in staff, the
  `"irr book read"` and `"irr log read"` policies become `using (true)` and nothing else changes. `irr_config` should
  **not** be widened with them — see above.
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

- 2026-10-30 — Refreshed from the standalone build, which had moved on 60 kB since the port. Adds the **Growth comparison**
  tab (Performance Property against the Cotality capital-city and council medians, three methods, houses/units/all), the
  register's **vs Market** and **vs Council** views, a copy-address button, and the `shareBody()` fix described under
  **Data model**. Adds `tools/lga-median.js` (the council medians the comparison reads — referenced by the page and
  previously missing from the port, so the council views would have shipped dead), `tools/sheet-endpoint.gs.txt` (linked
  from the sold-check modal; static checks caught the dangling link), and `public.irr_config` to migration 131 (the tool
  reads and writes it; the migration did not create it).
- 2026-10-28 — Ported: the tool, its engine and suburb file, migration 131, the registry key, the Vault card and the hub
  search entry.
