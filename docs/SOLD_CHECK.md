# Sold Check — runbook

Sold Check (`tools/sold-check.html`, in the Vault) is the register of every property Performance Property has bought for a client.
For each property it holds the market, address, purchase date and price, whether it is still **held** or **sold**, and the
client, advisor and lead originator details. A scheduled **sold check** looks for recent sales and listings and records what it
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
| Import a workbook | — | yes |
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

## 3. Adding and editing by hand

**Add property** opens a form for every register field. Market and address are required. If the address is already in the
register, the form says so and offers **Open it**. **Edit** and **Delete** are at the foot of a property's drawer. Delete asks
first and also removes that property's check history.

## 4. The scheduled sold check

Run it monthly, or whenever Van sets the schedule. It is a Claude session on Van's machine, in this repo, with `.env` present.
Later it could be a Cotality Property Monitor feed instead.

### Steps

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

### Prompt for the scheduled session

> You are running the monthly Sold Check for the Performance Property hub, in the repo
> `C:\Users\vandolf_performancep\repos\Supabase - Performance Internal Tool`. Read `docs/SOLD_CHECK.md` §4 first and follow it
> exactly.
> 1. Run `node scripts/sold-check/pending.mjs --days=30 --limit=60` and read `scratch/sold-check/pending.json`.
> 2. For each property, search its address plus "sold" on realestate.com.au, domain.com.au and onthehouse.com.au. Open the
>    matching property page, and decide sold / listed / not_sold / unknown. Only a sale after `purchase_date` counts as sold.
>    Match the unit number exactly. When a page refuses automated reads or you cannot be sure it is the same property, record
>    `unknown` with a one-line reason. Never guess `not_sold`.
> 3. Write all entries to `scratch/sold-check/results.json` in the format of §4 step 2, with the source URL and a confidence for
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
- **Addresses leave the hub only as search terms.** The scheduled session reads addresses from `pending.json` and searches them on
  public sites. Client names and HubSpot links are never in that file.
- **The register holds client names and HubSpot links.** Every signed-in user who can open the tool can read them. If that is too
  wide, Van can limit reads to editors (a one-line policy change in migration 126's pattern).
