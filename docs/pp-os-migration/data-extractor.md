# Data Extractor — feature note for the pp-os port

Pick places (any suburb in Australia, or a research market), pick data points, pick how far back, and download a
spreadsheet that is ready to hand on. Built on the hub first (Van, 2026-11-13: "do this in hub for now") and ported to
pp-os on 2026-11-16. This note records what a pp-os port must copy. It is not a full description of the tool.

Source of truth in the hub repo: `tools/data-extractor.html`. Registry key `data-extractor` (sec `analytics`); it has a
tile on the hub dock and a search entry in `index.html`. It was a button in the Data Forge bar until 2026-11-13, then a
Vault card until 2026-11-18.

## Why it was rebuilt

Saskia, 2026-11-12: George needs "our VR and rent data on a suburb level" for rental appraisals. The data was in the
Vault but only reachable through the old extractor, which was hard to use. Van: give it its own card, make it easy, and
make the export a finished product.

## What a suburb can and cannot show

- **Rent, yield, rental listings, prices, sales** are held by suburb (Cotality Market Trends, monthly from July 2018).
- **Vacancy is not published by suburb.** Cotality gives it by capital city and by council area only. The tool shows the
  reading for the council area a suburb sits in, labelled "Vacancy rate (council area)", and says so on screen, in the
  sheet footnote and on the About sheet. Do not relabel it as a suburb figure.
- Council-area vacancy is kept from August 2026 for every council (about 410 with a reading). The 28 regional research
  markets go back to January 2019, taken from the series the Demand Score already used. A suburb in a council with no
  reading simply has no vacancy column.

## The three steps

1. **Where?** A switch at the top, **Suburbs** or **Research markets**, because the two kinds of place hold different
   data. Suburbs is the default, with the caret in its search box on load: suburb name or postcode, and "richmond vic"
   narrows to a state (a research market whose name matches is listed too). Research markets is the list of 45 to
   tick; it says that a market is not split into its suburbs. Both kinds can be picked together. Search does not
   filter on property type, because Docklands and Southbank have unit rows only.
2. **What data?** Empty until a place is picked ("Add a place in step 1 first"), then it lists only what the picked
   places hold (Van, 2026-11-13). A suburb data point is listed when at least one picked suburb has a figure for it,
   in any month, for houses or units; council vacancy when a picked suburb's council has a reading; a market series
   when at least one picked market holds it (`rdp_metric_coverage`). So each new place is looked up before step 2
   offers anything: a suburb's rows, its council's vacancy, a market's list of series.
   - Quick picks (Rental appraisal, Prices and growth, Sales and listings) show only when the places hold at least
     one of their points, and are lit when every point they can show is ticked. Clicking one ticks its whole list,
     including points no picked place holds, so a place added later shows its share without another click. Clicking
     it again takes the list off. Two can be combined.
   - Suburb data is grouped into five topics with a Houses / Units / Both switch.
   - When only markets are picked, the Suburb data heading stays, with one line saying to add a suburb and a link
     that opens the suburb search.
3. **How far back?** Latest only, All history, or "Last N years" with N typed into a box (1 to 99). The box applies
   on a click, on typing or on Enter, not on focus alone, and keeps its number while another choice is on. Rental
   appraisal puts 1 in it. The window hangs off the latest reading, or off today when a series runs into the future
   (dwelling pipeline, population projections).

The result is live: no Preview button. The ticks, property type, period and typed number of years are remembered in
`localStorage` (`pp_dx_prefs_v2`); places are not. A remembered tick for a data point the current places do not hold
is kept, but it is neither listed nor exported.

## Data it reads (all live, read-only)

| Source | What |
|---|---|
| `forge_cl_suburbs` | level `suburb`: 34 metrics a month, houses and units. Keyed by `state` + `name_key` |
| `forge_cotality` row `lga_vacancy_history` | `data.lgas[<key>].months['YYYY-MM'] = { h:{vr,rent}, u:{vr,rent} }`, vacancy in PERCENT |
| `forge_cotality` row `cl_start_medians` | `data.suburbs[<key>] = { h:['YYYY-MM', price], u:[…] }` and `data.lgas[<key>] = { name, h, u }`: the first 12-month median on record for each suburb and council area, from the 1980 to 2018 history |
| `forge_cl_suburbs` level `lga` | a council area's 12-month median by month, read only for the council-area long-term growth rate |
| `rdp_regions` | the 45 research markets (36 markets, states, Australia) |
| `rdp_metric_catalog` (mig 086) | label and unit of each market series |
| `rdp_metric_coverage` (mig 137) | which markets each series covers, with frequencies and span |
| `rdp_raw_series` | the market series themselves |

Council key (`lgaKey`): `state + '_' + council name`, lower case, anything that is not a letter or digit becomes `_`
("VIC", "Greater Geelong" gives `vic_greater_geelong`). The same rule lives in three places and must stay identical:
the tool, the Data Forge upload (`saveLgaVacancy` in `tools/data-forge.html`) and `scripts/build-lga-vacancy-history.mjs`.
The tool asks PostgREST for only the councils it needs (`data->lgas-><key>`), so the whole row is never downloaded.

## How the council vacancy gets there

- The monthly Cotality drop includes `CSTDAT15969_CustomMT_LGA_<date>.csv`: every council's vacancy and 3-month rent.
  The Data Forge rent and vacancy upload used to keep our 28 regional markets and drop the rest. It now also merges
  every council into `lga_vacancy_history` (merge-only, never blocks the upload). The `rentvacancy` row and everything
  that reads it are unchanged.
- The row was seeded once with `node scripts/build-lga-vacancy-history.mjs --write` (dry run without the flag). The
  script stops if an export and the stored 28-market series disagree for a month they share.

## Rules worth keeping

- **One grid feeds the screen, the workbook and the CSV**, so what is on screen is what is downloaded. On screen only,
  state and postcode fold into the suburb cell and an "As at" column that is the same for every row moves to the
  subtitle.
- **Market series periods are keyed by where the period starts** (a quarter's first month, a year's January). Sources
  file the same quarter under different months, which used to print each quarter twice.
- **Each frequency is its own block** on a market sheet (Year, Quarter, Month side by side, each with its own date
  column). One shared axis buries yearly figures under monthly rows.
- **A column with nothing in it is dropped and named in a footnote**, never exported empty. The same goes for a place
  with nothing in any column of a "Latest figures" sheet.
- **Column widths come from measuring the text** in Arial (canvas `measureText`), not from counting characters: bold
  and wide letters need more room than a count allows. An indented cell needs about 26 px around its text, a plain
  one 8 px. A year under a heading is written as a number, or Excel flags it "number stored as text".
- **Every Forge percentage is a fraction** (0.052 is 5.2%); the one exception is `gp_share_pct`. Council vacancy is
  stored as a percent and divided by 100 on the way in.
- **NT postcodes** are stored without their leading zero ("810"). The tool searches the short form and shows "0810".

## The downloads

- **Excel** (ExcelJS 4.4.0 from jsDelivr with SRI, loaded on first download): a "Latest figures" sheet (two when
  suburbs and markets are mixed), one sheet per place with the history, and "About this data" (what each data point
  measures, source, how often it updates). Arial; logo; title and context line; a coloured band per data family with the
  same colours as the screen; frozen header and first column; no gridlines; months as real dates; a column never
  narrower than its widest figure or longest word; landscape, one page wide, header rows repeat, page numbers.
- **CSV**: one row per value (place, place type, state, postcode, council area, property type, topic, data point,
  period, value, unit). Percentages as percent numbers. Periods as `2026-08`, `2026-Q3`, `2026`.
- Family colours are brand accents or steps of their tone ramps. Rent, prices, people, rates and jobs keep the colours
  Van approved on 2026-07-31.

## How the long-term growth rate works

Added 2026-11-17 because an advisor wanted the Suburb Scoring "Fixed House LT CAGR" for two places the tool does not
score (Tailem Bend SA 5260 and Mount Barker SA 5251). Van's call: offer it in the Extractor for any suburb and leave
Suburb Scoring alone.

- **The rule** is Suburb Scoring's: yearly compound growth from the EARLIEST 12-month median on record to the month
  shown, `(median now / first median)^(12 / months between) − 1`, blank under 8 years (96 months). It is worked
  out in the tool for every month (`ltRate`, `sVal`); nothing is stored but the starting point.
- **Two data points**, both under Price growth: "Long-term growth rate" (the suburb's own history) and "Long-term growth
  rate (council area)". The council one exists for two reasons: some suburbs have no history of their own (Tailem
  Bend), and Suburb Scoring itself scores Adelaide and Melbourne suburbs by council. Like every data point, each is
  offered only where the picked suburb has a figure.
- **Where the start comes from:** the Forge holds suburb medians from July 2018 only. The earlier months are in a
  one-off CoreLogic extract, CSTDAT4294, monthly from January 1980 to June 2018: 12 suburb files and one council file,
  about 4.6 GB, on the shared drive under "CoreLogic files / Historic". They are kept outside the repo
  (`~/Downloads/corelogic-history`). `node scripts/build-cl-start-medians.mjs --write` reads all 7.6 million rows and
  stores one thing per place and type: the first month with a median, and that median. The history is closed, so this
  ran once and needs no monthly step.
- **Keys:** a suburb is `lgaKey(state, name_key)` ("SA", "MOUNT BARKER|5251" gives `sa_mount_barker_5251`). A council is
  `lgaKey(state, canonLga(name))`: the name without its "(DC)" / "(C)" / "(SA)" suffix, "The", "and", "Shire", "Regional"
  or "City", because Cotality has spelled one council three ways since 2018 ("The Coorong (DC)", "The Coorong",
  "Coorong"). `canonLga` lives in the tool and in the build script and must stay identical. The council's monthly
  median is read from `forge_cl_suburbs` level `lga` under every spelling.
- **Coverage (August 2026):** 6,161 suburbs and 502 of 524 council areas have a start. Of the 4,658 suburbs with a
  house median today, 4,478 (96%) have their own. The 22 council areas without one are remote NT, QLD and WA shires.
- **It will not always equal the Suburb Scoring tile.** In Melbourne, Sydney, Ballarat, Bendigo and Geelong the tool
  stops the window at the market's peak; the Extractor always runs to the month shown. The tool's stored Adelaide values
  came from Saskia's workbook: recalculating five Adelaide councils with this rule landed within 0.34 points of them.
  In South Australia sales records start in January 1993, so a first median can rest on 10 to 25 sales.
- It is a different measure from Cotality's own "Annual growth rate (20 years)", which only looks back 20 years and
  read about a point lower for both places.

## What the port needs

- The long-term growth rate: a home for the starting medians (one store key, like the council vacancy one; copy the
  hub's `cl_start_medians` row, about 374 KB of JSON, since the history never changes), the council-level rows of
  `forge_cl_suburbs` readable by council name, and the `canonLga` rule.

- `forge_cl_suburbs` and the market series in the pp-os database (pp-os already records `forge_cl_suburbs` monthly).
- A home for council-area vacancy: the hub keeps it in one `forge_cotality` row. The pp-os Cotality parser would need to
  keep every council from the LGA file, not only the research markets.
- A per-market coverage query (the hub uses the `rdp_metric_coverage` view).
- Staff reach it by group: the hub key is `data-extractor`; a group must have it ticked. Every table it reads is already
  open to any signed-in user.

## Checks (hub, in `scratch/`)

`_dx-drive.mjs` (the whole flow, both themes, three screen sizes), `_dx-edge.mjs` (odd searches, unit-only suburbs,
councils with no vacancy), `_dx-hub-check.mjs` (card, search, Forge bar), `_dx-forge-lga-check.mjs` (the upload keeps
the 28-market list unchanged and matches the seeded row), `_dx-samples.mjs` (sample downloads), `_dx-van-case.mjs`
(Van's three cases: markets only, a state with none of the quick-pick data, and the typed number of years),
`_dx-clipcheck.mjs` (lays a workbook out the way Excel does and lists any cell that would be cut off), `_dx-lt-check.mjs` (the
long-term growth rate: Mount Barker's own and council figures against the history, Tailem Bend with only its council's,
the monthly table, the workbook, the 8-year rule; both themes).

## Changelog

- 2026-11-13: rebuilt. Own Vault card and search entry; the Data Forge bar button removed. Three-step picker with quick
  picks, live result, "Latest figures" tab. Council-area vacancy for every council (`lga_vacancy_history`, seeded for
  August 2026, with history from 2019 for the 28 regional markets). Market data limited to what the picked markets hold
  (`rdp_metric_coverage`, mig 137). Excel export moved from xlsx-js-style to ExcelJS; CSV added. Fixed along the way:
  quarters printed twice when two sources dated them differently; suburbs with unit rows only could not be found.
- 2026-11-13, after the first real use: Van ticked two markets from the "browse" list, found no suburb options, and
  asked where the suburb level was. Step 1 is now a Suburbs / Research markets switch with the caret in the suburb
  search, and step 2 keeps a Suburb data heading that says how to get it. His download also showed three flaws, all
  fixed: a name cut short ("New South Wale") because widths were counted in characters, now measured; an empty row
  for a market with no data, now left out and footnoted; Excel's "number stored as text" flag on every year under a
  heading, now written as numbers.
- 2026-11-13, Van's second review: step 2 lists nothing until a place is picked, then only what the picked places
  hold. He had picked New South Wales and clicked Rental appraisal and Sales and listings, and nothing showed: the
  state holds none of those series, so those quick picks are no longer offered for it. Step 3 lost its fixed
  "1 year" and "5 years" buttons for "Last N years" with a typed number (an old remembered "1" or "5" comes back as
  that number). Found on the way: a click on the thin edge of the step 3 control read `data-period` off `<html>`,
  where the page shell keeps day or night, and the result stopped updating until a period button was clicked.
- 2026-11-17, long-term growth rate: an advisor needed the Suburb Scoring "Fixed House LT CAGR" for Tailem Bend SA 5260
  and Mount Barker SA 5251, which the tool does not score. Van chose to offer it here for any suburb. Two new data
  points under Price growth, "Long-term growth rate" and "Long-term growth rate (council area)", measured from the
  first median on record. The starting medians come from the CoreLogic 1980 to 2018 history, loaded once into
  `forge_cotality` row `cl_start_medians` by `scripts/build-cl-start-medians.mjs`. Mount Barker houses: 7.06% for the
  suburb, 6.78% for the council area. Tailem Bend has no history of its own, so only its council area shows: 7.96%.
- 2026-11-18, out of the Vault: Van asked for the Data Extractor to move "from Vault to Advisor Tools" on the hub and in
  pp-os. The hub has no section of that name, so he chose a tile on the dock, straight after Videos, with the Vault card
  removed, and chose that every staff member sees it (the key goes into the Company Baseline group when this goes
  live; before that only Admins and the Pre Due Diligence Team held it). The registry section moved from `vault` to
  `analytics`: left under `vault`, a group holding the key is shown the Vault icon with nothing behind it. The dock is
  sized for twelve tiles instead of eleven, because an admin now sees twelve and the last one fell off the edge at
  1440 and 1280 wide. The page says "Analytics" where it said "The Vault". Check: `scratch/_dx-dock-check.mjs`.
