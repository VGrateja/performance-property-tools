# Sold Check — runbook

Sold Check (`tools/sold-check.html`, in the Vault) is the register of every property Performance Property has bought for a client.
For each property it holds the market, address, purchase date and price, whether it is still **held** or **sold**, and the
client, advisor and lead originator details. A **sold check** on RP Data looks for recent sales and listings and records what it
finds. A person then **verifies** each find. Nothing is marked sold until a person confirms it.

- Data: `public.sold_check_properties` (the register) and `public.sold_check_results` (checks and their review), both from
  migration 126.
- pp-os feature note (data model, rules, decisions): `docs/pp-os-migration/sold-check.md`.

## 1. Who can do what

| | Viewer (any signed-in staff who can open the tool) | Editor |
|---|---|---|
| See the register, filters, sold periods, record drawer, check history | yes | yes |
| Export CSV / XLSX | yes | yes |
| Add, edit, delete a property | — | yes |
| Import a workbook or the IRR Calculator register | — | yes |
| Check on RP Data (build the bookmark), upload RP Data results | — | yes |
| Confirm / reject in the Verify queue, record a check by hand | — | yes |

**Editors** are dev and admin, plus anyone with a `sold-check` editor grant. Van sets the grant in the hub's Roles panel (People
tab, role chips). The database enforces this (`sold_check_can_write()`); the page only hides the buttons.

**Who sees the tool:** Van ticks `sold-check` into the right groups in the Groups panel. A new tool is invisible to assigned
admins and to staff groups until it is ticked.

## 2. Importing the purchase workbooks

1. Open Sold Check → **Import** → **Choose file**, and pick one city workbook (for example "Toowoomba - Total Purchases.xlsx").
   The file is read in your browser and is not uploaded anywhere.
2. Read the **preview**. It shows the market (from the Summary page), each sheet and its header row, rows parsed, rows that failed
   and properties taken, and the counts **new / updated / unchanged / failed**. Nothing has been saved yet.
3. A **failed** row is not imported. The preview names its sheet, row number and the column that could not be read (an unreadable
   purchase price, purchase date or land, or an address with no street number). Fix the cell in the workbook and import again
   later. The import adds what is missing and leaves the rest alone.
4. Click **Import N properties**. The result line shows what was saved. Choose the next workbook, or close.

What an import does and never does:

- It reads the **Not Sold** and **Sold** sheets first. **Total Purchases** only adds a property neither sheet lists.
- It matches properties by a normalised address: lower-case, punctuation dropped, unit and street numbers kept.
  `2/15 Fake St, Testville` and `2 / 15 Fake St. Testville` are the same property.
- A re-import changes a field only when the file has a value for it. **An empty cell never blanks the register**, and **a sold
  property is never moved back to held**.
- Notes typed into the Sold Price or Sold Date columns of held rows (anything that is not a price or a date) are read as blank.
  The preview counts them.

Preview counts of the three workbooks on 6 Oct 2026 (nothing imported): Toowoomba 63 new, Adelaide 555 new, Rockhampton 110 new,
0 failed. After importing Rockhampton, search for a duplicate: its Total Purchases sheet holds one address that does not match its
Sold or Not Sold spelling.

### The IRR Calculator register (.json)

Shaene's IRR Calculator keeps its own register of every capital (one JSON document, the `body` of her `irr_book` row). The same
**Import** dialog reads it: choose the `.json` file instead of a workbook. It accepts the body (`{ "properties": [...] }`), the
row (`{ "id": ..., "body": {...} }`) or the SQL editor's one-row copy (`[{ "body": {...} }]`).

How it maps: `name` → address · `category` (the capital city) → market · `purchasePrice` / `purchaseDate` → purchase price / date
· a sale only when the entry has **both** `soldPrice` and `soldDate` → status sold with that date and price · `note` → comments.
`outside` entries (set outside of advice) are skipped, as her checker skips them. Nothing else in the body maps (her `id`,
`outsideReason` and the `assumptions` block are ignored).

The rules are the workbook's (preview first, upsert by address, an empty value never blanks a field, sold never goes back to held),
plus three that suit a register spelt by another hand:

- An address the register does not hold exactly is also looked up in one canonical spelling (Road = Rd, state and postcode
  dropped, unit and number kept), so `22 Example Rd Testville SA 5000` updates `22 Example Road, Testville`. The preview counts
  these as "spelt differently". If two register rows share that spelling, the entry fails instead of guessing.
- The capital city is the market of a **new** property only. A property already in the register keeps its market.
- A held entry says nothing about the status of a property already in the register (an `unknown` stays `unknown`).

An entry **fails** (listed by its position in the file) when it has no address, no street number, no capital city, or a purchase or
sale value that cannot be read. Imported rows are `source='import'`, with the file name as `import_file`.

**How Shaene exports it.** Her tool has no JSON export or backup button (its **Export CSV** writes the visible rows with computed
columns, not the register document). She copies the document from her own Supabase project instead: Supabase dashboard → her
project → **SQL editor** → run

```sql
select body from public.irr_book where id = 'adelaide';
```

then **Export → Copy as JSON** on the result, paste it into a text editor and save it as `irr-register.json`. She sends that file
to the editor who imports it (not over chat: it holds client addresses and prices). Only Shaene runs this, on her project.

## 3. Adding and editing by hand

**Add property** opens a form for every register field. Market and address are required. If the address is already in the
register, the form says so and offers **Open it**. **Edit** and **Delete** are at the foot of a property's drawer. Delete asks
first and also removes that property's check history.

## 4. The sold check

Run it monthly. The **primary** checker is the RP Data run (§4.1): an editor runs it in their own browser, signed in to RP Data
with their own licensed login. It replaced the scheduled public-site session on 13 Oct 2026 (it came from Shaene's IRR
Calculator). The CLI path (§4.2) stays as a secondary option.

### 4.1 On RP Data (primary)

The bookmark drives RP Data's own search box the way a person would: it types the address, picks the suggestion that is this
property, opens it and reads the **Last Sold on** line and the listing status. It runs only in your browser and sends nothing
anywhere: no register, no config and no Google Sheet. Each property it checks carries only its register id, market, address
and purchase date (no client names, HubSpot links or prices).

1. **Build.** Sold Check → **Checks** tab → **Check on RP Data**. It lists held properties not checked in the last 30 days
   (change the days, or pick one market), never-checked first. It leaves out properties checked recently and ones with a find
   waiting in Verify. These are the same rules as `pending.mjs`.
2. **Drag.** Show the bookmarks bar (Ctrl+Shift+B) and drag the teal button onto it. A long list comes as several buttons,
   "(1 of 3)" and so on, because Chrome struggles with one very long bookmark. Run them one after another. Clicking the button in
   the hub does nothing; it only runs on RP Data.
3. **Sign in.** Open `rpp.corelogic.com.au` and sign in as yourself.
4. **Click** the bookmark. A panel opens bottom-right and counts as it goes: about 8–10 seconds a property, with a 45-second rest
   every 20 (Shaene's pacing). 300 properties take about 50 minutes. Each property counts as a property view on your RP Data
   plan.
5. **Keep the tab in the foreground.** Chrome pauses background tabs and the run stalls. Use another window for other work.
6. **Stop / resume.** **Stop** in the panel stops after the current property (typing `stopCheck = true` in the console does
   the same). Every answer is kept in that browser as it comes, so clicking the same bookmark again, later or on another day,
   skips what it has done and carries on.
7. **Download.** **Download results CSV** in the panel, at any point, gives everything this bookmark has answered so far. The
   columns are `id, verdict, sale_date, sale_price, source_url, confidence, notes, checked_at`.
8. **Upload.** Sold Check → Checks → **Upload RP Data results** → choose the CSV. The preview shows sold / listed / not sold /
   unknown / skipped, and each skipped row with its line and reason (the same checks as `record.mjs`: a register id, a known
   verdict, a `YYYY-MM-DD` date, a number price, an http link, high/medium/low confidence, a date-time `checked_at`, no repeat of
   an id or of a result already recorded). **Record N results** inserts one result per row as run `rpdata-<yyyy-mm-dd>` (`-2`,
   `-3` for a second upload that day), with `checked_by` = your email and `checked_at` = when RP Data was read. It never changes a
   property. The next build leaves the uploaded properties out. Delete the used bookmark from the bar.
9. **Verify** the sold and listed finds in the Verify tab (§5).

How the bookmark decides:

- **sold:** RP Data's last sale is **newer** than our purchase date. The result carries the sale date, the price (empty when RP
  Data withholds it) and the RP Data record link. Confidence is **high** when RP Data gave one suggestion and it matched the
  address including the unit. It is **medium** when that one exact match was among several suggestions, and **low** when only
  the street type differed or the sale is within 90 days of our purchase date (it may be our purchase recorded on another date).
- **listed:** For Sale, Under Offer, Under Contract or Auction now. The status and last advertised date are in the notes. For
  Rent and Withdrawn are not listings.
- **not sold:** the last sale **is** our purchase (the same date).
- **unknown:** anything else, with the reason in the notes: no suggestion; no suggestion that matches; several that match; a unit
  block (the register has no unit number and RP Data offers units at that street number, or a different unit), with the
  candidates named; a page that did not open; no sale on record; a last sale before our purchase date; no purchase date. It
  never guesses not sold, and it never takes a neighbour's sale.

Not verified yet: the bookmark has been tested against a mock of RP Data's page shapes, never on RP Data itself. On the first
real run, watch the first few results. If every result is unknown with "no suggestion matched", RP Data writes its suggestions
differently from the mock, and the address match in `rpPick()` needs adjusting.

### 4.2 The CLI / scheduled session (secondary)

The older path: a Claude session on Van's machine, in this repo, with `.env` present, searching public sites. Use it when nobody
with an RP Data login can run §4.1. Later it could be a Cotality Property Monitor feed instead.

#### Steps

1. **Get the work list.**
   `node scripts/sold-check/pending.mjs --days=30`
   This writes `scratch/sold-check/pending.json`: held properties never checked or last checked 30+ days ago, never-checked first.
   Each entry is `{ id, market, address, listing_url, purchase_date }`, with no client names and no HubSpot links. Properties
   with a find still waiting in the Verify queue are left out.
   - Options: `--market=Toowoomba`, `--limit=40` for a smaller batch, `--include-unknown` to also check `unknown` properties,
     `--out=<path>`.
2. **Check each property.**
   - Search the address plus "sold" on realestate.com.au, domain.com.au and onthehouse.com.au.
   - Open the property's own page and read either a "Sold on <date> for $X" line or a current listing.
   - Only a sale **after** the purchase date counts. The purchase itself also shows as a sale on these sites.
   - Record one entry per property in `scratch/sold-check/results.json`:
     `{ "id": "<id from pending.json>", "verdict": "sold" | "listed" | "not_sold" | "unknown", "sale_date": "YYYY-MM-DD" or null, "sale_price": 612000 or null, "source_url": "https://…" or null, "confidence": "high" | "medium" | "low", "notes": "one line" }`
   - `sold`: a sale after the purchase date, with its date and price where shown. Confidence is high when the page clearly
     matches the address (unit number included).
   - `listed`: currently for sale. Put the listing link in `source_url`.
   - `not_sold`: the property page was read and shows no sale since the purchase date.
   - `unknown`: nothing could be read, such as a page that refuses automated reads, no matching page, or an ambiguous unit. Say
     why in `notes`.
3. **Record the results.**
   `node scripts/sold-check/record.mjs scratch/sold-check/results.json --run-id=sched-<yyyy-mm-dd>`
   It prints counts only. Entries with a bad id, verdict, date, price or link are skipped, with their position and reason listed.
   It never changes a property's status.
4. **Hand over.** Tell Van and the editors how many results are waiting in the Verify tab. They confirm or reject each one in the
   tool.

#### Prompt for the scheduled session

> You are running the monthly Sold Check for the Performance Property hub, in the repo
> `C:\Users\vandolf_performancep\repos\Supabase - Performance Internal Tool`. Read `docs/SOLD_CHECK.md` §4.2 first and follow it
> exactly.
> 1. Run `node scripts/sold-check/pending.mjs --days=30 --limit=60` and read `scratch/sold-check/pending.json`.
> 2. For each property, search its address plus "sold" on realestate.com.au, domain.com.au and onthehouse.com.au. Open the
>    matching property page, and decide sold / listed / not_sold / unknown. Only a sale after `purchase_date` counts as sold.
>    Match the unit number exactly. When a page refuses automated reads or you cannot be sure it is the same property, record
>    `unknown` with a one-line reason. Never guess `not_sold`.
> 3. Write all entries to `scratch/sold-check/results.json` in the format of §4.2 step 2, with the source URL and a confidence for
>    each.
> 4. Run `node scripts/sold-check/record.mjs scratch/sold-check/results.json --run-id=sched-<today>`.
> 5. Reply with the counts only: checked, sold, listed, not_sold, unknown, and how many now wait in the Verify tab. Do not paste
>    addresses into the reply.
>
> Rules:
> - Never change a property's status yourself; confirmation is a person's job in the tool.
> - Never print, log or send `.env` values or any credential.
> - Never commit or push.
> - The two JSON files live in `scratch/` (gitignored) and must stay there.

## 5. Verifying (people, in the tool)

The **Verify** tab lists each `sold` or `listed` find that nobody has reviewed yet, newest first. The tab shows a count badge.

- **Confirm sold:** check the source link first. Edit the sold date and price if the page shows something different, then confirm.
  The property becomes **sold** with that date and price, and hold period, ROI and CAGR appear in the register.
- **Confirm listed:** the property is on the market. It stays **held**, and the listing link is saved on the property.
- **Reject:** the find is wrong or is a different property. The property is unchanged, and the reject is kept in its check
  history.

The **Checks** tab lists every run (by run id): when it ran, how many properties it checked, how many candidates it found, and
how many were confirmed or rejected. Click a run to see its results.

## 6. Caveats

- **A verdict is a candidate until a person confirms it.** Listing sites mix up units in the same block, show the purchase sale
  itself, and lag by weeks.
- **Pages that refuse automated reads are `unknown`, not `not_sold`.** A missing page is not proof that a property has not sold.
- **The sold period filters use the confirmed `sold_date`.** A find waiting in the Verify queue does not count until it is
  confirmed.
- **Addresses leave the hub only as search terms.** The RP Data bookmark carries addresses (with register id, market and
  purchase date) and types them into RP Data. The scheduled session reads them from `pending.json` and searches public sites.
  Client names, HubSpot links and prices are in neither.
- **The bookmark and its answers stay in that browser.** The bookmark itself holds the addresses, and Chrome syncs bookmarks to
  the signed-in Google account. Its answers sit in RP Data's site storage in that browser. Delete the bookmark once its results
  are uploaded.
- **An RP Data source link opens only for RP Data users.** Confirming an RP Data listing saves that record link on the property
  as its listing link.
- **The register holds client names and HubSpot links.** Every signed-in user who can open the tool can read them. If that is too
  wide, Van can limit reads to editors (a one-line policy change in migration 126's pattern).
