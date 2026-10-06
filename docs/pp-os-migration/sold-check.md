# Sold Check — feature note for the pp-os port

The hub's Sold Check (`tools/sold-check.html`, Vault section, built 2026-10-06) is the register of every property bought for a
client. It has an import from the city "Total Purchases" workbooks, manual add and edit, and a queue of sold checks that a
scheduled checker fills and a person verifies. The tool never decides on its own that a property has sold: a checker result is a
candidate until a person confirms it.

The ask. Saskia (29 Sep 2026): "a tool where Ben, Rachel or Shaene can upload all our properties we have bought for clients, and
the tool will check them all and return any that have been sold recently … select what sold period we want to search for — 1 month,
3 month, 6 month, 1 year, or return the most recent date of sale at all for all properties." Van (6 Oct 2026): record the data,
let the team add properties by hand, and run new properties on a schedule to see whether they have sold.

Source of truth in the hub repo:

| What | Path |
|---|---|
| The tool (all client code, one file) | `tools/sold-check.html` |
| Tables, RLS, key trigger, confirm RPC | `supabase/migrations/126_sold_check.sql` |
| Checker scripts | `scripts/sold-check/pending.mjs`, `scripts/sold-check/record.mjs` (+ `_env.mjs`) |
| Runbook (the schedule, the session prompt, caveats) | `docs/SOLD_CHECK.md` |
| QA scripts + the synthetic fixture (gitignored) | `scratch/sold-check/` |
| Registry / hub entries | `shared/tool-registry.js` key `sold-check` (sec `vault`); `index.html` Vault APPS card + search entry |

**LOCKSTEP.** `scKey()` in the page must stay identical to `public.sold_check_key()` in migration 126. The DB trigger is
authoritative (it rewrites `address_key` on every insert and update). The page copy exists only so the import preview can tell
new properties from existing ones.

---

## 1. Data model (migration 126)

### 1.1 `public.sold_check_properties` — the register

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `market` | text not null | the city as the workbook names it (Toowoomba, Adelaide, Rockhampton …) |
| `address` | text not null | non-blank check |
| `address_key` | text not null **unique** | set by trigger from `address` (§1.3) |
| `purchase_price`, `purchase_date` | numeric, date | |
| `status` | text not null default `held` | `held` · `sold` · `unknown` |
| `sold_price`, `sold_date` | numeric, date | |
| `client_name`, `hubspot_url`, `advisor`, `lead_originator`, `comments` | text | from the Not Sold sheet |
| `sales_agent`, `agency` | text | Rockhampton's Not Sold sheet |
| `listing_url`, `property_type`, `land_m2`, `sales_advisory` | text, text, numeric, boolean | from the Sold sheet (`Link`, `Type`, `Land`, `Sales Advisory`) |
| `source` | text not null default `manual` | `import` · `manual` · `qa` |
| `import_file` | text | the file name of the last import that touched the row |
| `created_at`, `created_by`, `updated_at`, `updated_by` | timestamptz / text | `*_by` = the editor's email (text, not a uuid) |

Index `(market, status)`. Trigger `trg_sold_check_properties_touch` (before insert or update) sets `address_key` and, on update,
`updated_at`. The trigger does not use `touch_updated_at()`, because that function writes `auth.uid()` into `updated_by`.

### 1.2 `public.sold_check_results` — what a checker found, what a person decided

`id` uuid pk · `property_id` → properties (on delete cascade) · `checked_at` timestamptz default now() · `checked_by` text not
null (`schedule`, `manual`, or an email) · `run_id` text · `verdict` (`sold` · `listed` · `not_sold` · `unknown`) · `sale_date` ·
`sale_price` · `source_url` · `confidence` (`high` · `medium` · `low`) · `notes` · `reviewed_at` · `reviewed_by` · `review`
(`confirmed` · `rejected`). Index `(property_id, checked_at desc)`. There is no runs table: a run is the set of results that share
a `run_id`.

### 1.3 The address key

Lower-case; commas become a space; periods are dropped; spaces around `/` are removed, so `2 / 15` and `2/15` give the same key
and the unit and street numbers are kept; runs of spaces collapse to one; the result is trimmed. Street types are not expanded
(`St` stays `st`). Example: `"  2 / 15  Fake St., Testville,QLD  4000 "` → `2/15 fake st testville qld 4000`.

## 2. Access

- **Read:** any signed-in user (`to authenticated using (true)` on both tables). The hub page is reached through the `sold-check`
  group tick (auth-gate). Dev and unassigned admins see it automatically.
- **Write** (insert, update and delete on both tables): `public.sold_check_can_write()` = `is_writer() OR
  has_tool_role('sold-check','editor')`. This is a `security definer` sql function in the `scorecard_can_write()` pattern. Van
  grants Ben and Rachel editor rights from the Roles panel without making them admins.
- **anon:** nothing (grants revoked).
- **Client gate:** `S.canw` is true when the view-as tier is dev or admin, or when the user has a `tool_roles` row for
  `sold-check` editor. A dev or admin viewing as staff sees the viewer page. Writer-only elements carry `data-writer-only` and are
  shown by `body.sc-canw`. RLS is the real gate: QA showed a viewer's direct insert is refused (42501), `sold_check_confirm`
  raises "editors only", and an update touches 0 rows.

## 3. The import (in the browser; the file never leaves the page)

SheetJS 0.18.5 from cdnjs, `cellDates: true`. The same build writes the XLSX export.

- **Sheets by name** (letters only, case-insensitive): `summary…` → market; `…totalpurchases` → Total; `…notsold` → Not Sold;
  `…sold` → Sold. Anything else (Advisor instructions, IRR / Breakdown / RBA helper sheets) is ignored. `RKH- Not Sold` and other
  oddly spaced hyphens work.
- **Market:** the Summary page's A1 with " Summary" stripped. Fallback: the file name's first word.
- **Header row:** the first row (within the first 60) holding `Property` and a header starting `Purchase Price`. Columns map by
  normalised header text (letters and digits only), and the first occurrence wins, so stray far-right copies are ignored.
  Fallback seen in one real workbook: if the header row has no `Property` cell but has Purchase Price and Purchase Date, and the
  cell just left of Purchase Price is blank, that column is the address.
- **Header map:** Property → address · Purchase Price · Purchase Date · Sold/Sale Price · Sold/Sale Date · Client Name · Hubspot…
  → hubspot_url · Advisor · Lead Originator · …comments → comments · Sales Agent · Agency · Link… → listing_url · Type ·
  Land… → land_m2 · Sales Advisory. Hold period, ROI and CAGR columns are ignored (the tool computes them).
- **Cell rules:**
  - Money is a number or text such as `$1,234,567`, `450k` or `1.2m`.
  - Dates can be real date cells, rounded to the nearest local day; Excel serials; or typed `d/m/yyyy`, `d-m-yy`, `dd/mmm/yyyy`,
    `d mmm yyyy` or `yyyy-mm-dd`. Dates are read day-first. A typed date that is impossible day-first (`5/23/2019`) is read
    month-first, and a zero-padded 3-digit month (`011`) is read as 11.
  - Placeholders become blank: `Not sold`, `Unknown`, `n/a`, `-`, `TBC` and similar.
  - Links come from the cell's hyperlink target first, then its text. Only `http(s)` or a bare domain path is kept, so `n/a`
    becomes blank.
  - `Yes`/`No` → boolean. Land → the leading number (`607 m2` → 607).
- **Rows:**
  - A row with an empty Property cell is skipped. This covers blank rows and the CAGR-only rows.
  - A row whose Property is a single word with no digit is skipped as a totals or summary label.
  - A row **fails** (it is not imported, and the preview lists its sheet, row number and column name only) when Purchase Price,
    Purchase Date or Land cannot be read, or when the address has several words but no number.
  - On the Not Sold sheet, the sold columns are ignored and the status is `held`.
  - On the Sold and Total sheets, text in Sold Price or Sold Date that is neither a price nor a date is read as blank and counted
    in the preview ("read as blank"). It is not a failure.
  - Status: on the Sold sheet, a row with a sold price or date is `sold`, otherwise `unknown`. On the Total sheet, the same test
    gives `sold`, otherwise `held`.
- **One record per property in the file:** Sold is read first, then Not Sold, then Total Purchases. A property on both Sold and
  Not Sold is `sold`, and its empty fields are filled from the Not Sold row. A Total Purchases row whose property is already on
  Sold or Not Sold is ignored and is never a failure. Total Purchases only adds properties neither sheet lists.
- **Against the register (upsert by `address_key`):**
  - **New** rows are inserted (`source='import'`, `import_file`, `created_by` / `updated_by` = the editor).
  - **Updated** rows change only the fields where the file has a value that differs. An empty cell never blanks a stored value,
    and a `sold` property is never moved back to held or unknown.
  - **Unchanged** rows are left alone.
  - Updates are sent as upserts on `address_key` in chunks of 200, carrying the full merged row. `created_*` and `source` are left
    as they were, and the stored address text is kept.
- **Preview first, always:** it shows the file, market, property count, a sheets table (header row, rows parsed, failed,
  properties taken), the new / updated / unchanged / failed counts and the failed-row list. Nothing is written until **Import N
  properties** is clicked. After an import, the result counts show and another file can be chosen.

Real workbook preview counts (6 Oct 2026; nothing written): Toowoomba 63 new · Adelaide 555 new · Rockhampton 110 new · 0 failed in
each. Adelaide: 16 properties appear on both its Sold and Not Sold sheets, and they import as sold. Rockhampton: its Total Purchases
sheet adds one address that does not match its Sold or Not Sold spelling. Check it for a duplicate after the import.

## 4. Screens

- **Header:** eyebrow, title, intro, and stat tiles (properties, held, sold, unknown, markets, to verify). Tabs: Register ·
  Verify (with a count badge) · Checks.
- **Register:**
  - Filters: market, status, advisor, address search (raw text or normalised key).
  - **Sold period:** Any · 1 / 3 / 6 / 12 months · All sold · Most recent sale. "Sold within N months" means status sold and
    `sold_date ≥ today − N months` (calendar months). "Most recent sale" lists every property by `sold_date` descending, with
    unsold properties last.
  - Columns: Market · Address · Purchased (date over price) · Status chip · Sold (date over price) · Hold · ROI · CAGR · Advisor ·
    Lead originator · Last check (date and verdict chip). Click a header to sort; blanks sort last.
  - Hold = (sold − purchase days) / 365.25. ROI = sold / purchase − 1. CAGR = (sold / purchase)^(1 / hold) − 1. These show on
    sold rows only; ROI also shows without dates when both prices exist.
  - Export CSV (UTF-8 with BOM) and XLSX of the visible rows, in this column order: Market, Address, Purchase date, Purchase
    price, Status, Sold date, Sold price, Hold (years), ROI %, CAGR %, Advisor, Lead originator, Last check, Last check verdict.
- **Drawer** (row click, or `?id=<uuid>`):
  - It shows Purchase, Sale (with hold, ROI and CAGR), Client and team (HubSpot as a link), Comments, Check history (newest first,
    with review state), and Record (source, import file, added and edited by).
  - Writers also get Edit, Delete (with a confirm; results cascade) and **Record a check by hand**, which inserts a result with
    `checked_by` = the editor's email. A sold or listed result goes to the Verify queue.
- **Add / Edit** (the drawer form): every register field. Market and address are required. Money accepts `$` and commas. The
  status select offers held, sold and unknown. A duplicate `address_key` is refused before saving, with the existing row offered
  through **Open it**. A `23505` from the database gets the same message.
- **Verify:** results where `verdict in ('sold','listed')` and `review is null`, newest first. Each card shows the property, what
  was found (chips, date, price, source link, notes) and when and by whom it was checked. Writers get these actions:
  - **Confirm sold** calls the RPC `sold_check_confirm(result, date, price)`. The date and price can be edited first. The result
    becomes `confirmed` and the property becomes `sold` with that date and price.
  - **Confirm listed** confirms the result. The property stays held and `listing_url` is filled if it was empty.
  - **Reject** is a plain update: `review='rejected'` and `reviewed_*`.
  - Viewers see the cards read-only.
- **Checks:** one row per run, grouped by `run_id`. Results without a run id are grouped by day and checker and labelled "By
  hand, <date>". Columns: Run · When · Checked by · Checked · Candidates (sold + listed) · Not sold · Unknown · Confirmed /
  rejected. Click a run to list its results.
- **QA mode:** `?qa=1` tags every row the page writes `source='qa'` and shows a "QA mode" pill. It is used only by the QA
  scripts. Cleanup deletes `source='qa'`.

## 5. `sold_check_confirm(p_result uuid, p_sale_date date, p_sale_price numeric)`

The function is `security invoker`, so both updates run under the caller's RLS.

1. It checks `sold_check_can_write()`.
2. It loads the unreviewed result and refuses any verdict other than sold or listed.
3. For **sold**: the result becomes `review='confirmed'`, with `reviewed_at`, `reviewed_by` = the JWT email, and the
   date and price coalesced into the result. The property becomes `status='sold'`, with `sold_date` and `sold_price` coalesced and
   `updated_by` set.
4. For **listed**: the result is confirmed, and `listing_url` is filled if it was empty.

## 6. The scheduled checker

- `node scripts/sold-check/pending.mjs [--days=30] [--market=X] [--limit=N] [--out=path] [--include-unknown]
  [--include-awaiting]`
  - It lists held properties never checked, or last checked more than N days ago: never-checked first, then the oldest check.
  - It leaves out properties with an unreviewed sold or listed result.
  - It writes `[{ id, market, address, listing_url, purchase_date }]` to the out file (default
    `scratch/sold-check/pending.json`). There are no client names and no HubSpot links.
  - It prints counts only.
- `node scripts/sold-check/record.mjs <results.json> [--run-id=…] [--dry-run]`
  - It validates each `{ id, verdict, sale_date, sale_price, source_url, confidence, notes }` and inserts results with
    `checked_by='schedule'` and one run id (default `sched-<yyyymmdd>-<hhmm>` UTC).
  - It skips invalid entries, reporting their position and reason. It never changes a property.
- Both scripts read `.env` in-process (service role) and print counts only. The steps, the prompt for the scheduled session and
  the caveats are in `docs/SOLD_CHECK.md`.

## 7. Decisions taken (Van can reverse any of these)

1. The tool is named "Sold Check" and sits in the Vault. *[Alternative: Analytics.]*
2. Read = any signed-in user; write = writers + a `sold-check` editor grant. *[Alternative: limit read to the grant too, since the
   register holds client names and HubSpot links.]*
3. A checker never changes a status; a person confirms it. *[Alternative: auto-confirm high-confidence results.]*
4. The address key keeps the unit and street numbers and drops only punctuation. *[Alternative: full street-type expansion, St =
   Street.]*
5. Manual rows and imports share one table and one key. A re-import never blanks a value and never moves sold back to held.
6. A confirmed **listed** result does not mark the property sold. It keeps the property held and saves the listing link.
7. A row with an unreadable purchase price, purchase date or land, or an address with no number, **fails** and is not imported. The
   preview names the sheet, row and column so the team can fix the sheet and import again. Text in the sold columns of held rows
   reads as blank and is not a failure.
8. A property on both the Sold and Not Sold sheets imports as sold.
9. `pending.mjs` skips properties that already have a result waiting for verification.
10. The page uses the cdnjs SheetJS 0.18.5 build for both the import and the XLSX export (no header styling). Loading the
    `xlsx-js-style` build too would clash on `window.XLSX`.

## Changelog

- 2026-10-06 — built: migration 126 (two tables, `sold_check_key`, `sold_check_can_write`, `sold_check_confirm`), the tool
  (register, sold periods, drawer, add / edit / delete, import with preview, verify queue, checks tab, CSV / XLSX export), the
  two checker scripts and the runbook. QA used synthetic data only; the three real workbooks were previewed (counts only), not
  imported.
