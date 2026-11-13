# Data Extractor — feature note for the pp-os port

A Vault tool: pick places (any suburb in Australia, or a research market), pick data points, pick how far back, and
download a spreadsheet that is ready to hand on. Hub only for now (Van, 2026-11-13: "do this in hub for now"). This note
records what a pp-os port must copy. It is not a full description of the tool.

Source of truth in the hub repo: `tools/data-extractor.html`. Registry key `data-extractor` (sec `vault`); it has a Vault
window card and a search entry in `index.html`. Until 2026-11-13 it was only a button in the Data Forge bar.

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

1. **Where?** One search box: suburb name, postcode, or market. "richmond vic" narrows to a state. Markets can also be
   ticked from a list. Search does not filter on property type, because Docklands and Southbank have unit rows only.
2. **What data?** Quick picks (Rental appraisal, Prices and growth, Sales and listings) add their data points and can be
   combined; clicking one again takes its points off. Suburb data is grouped into five topics with a Houses / Units /
   Both switch. Market data only lists what the picked markets actually hold (`rdp_metric_coverage`).
3. **How far back?** Latest only, 1 year, 5 years, all history. The window hangs off the latest reading, or off today
   when a series runs into the future (dwelling pipeline, population projections).

The result is live: no Preview button. The last set of data points, property type and period is remembered in
`localStorage` (`pp_dx_prefs_v2`); places are not.

## Data it reads (all live, read-only)

| Source | What |
|---|---|
| `forge_cl_suburbs` | level `suburb`: 34 metrics a month, houses and units. Keyed by `state` + `name_key` |
| `forge_cotality` row `lga_vacancy_history` | `data.lgas[<key>].months['YYYY-MM'] = { h:{vr,rent}, u:{vr,rent} }`, vacancy in PERCENT |
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
- **A column with nothing in it is dropped and named in a footnote**, never exported empty.
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

## What the port needs

- `forge_cl_suburbs` and the market series in the pp-os database (pp-os already records `forge_cl_suburbs` monthly).
- A home for council-area vacancy: the hub keeps it in one `forge_cotality` row. The pp-os Cotality parser would need to
  keep every council from the LGA file, not only the research markets.
- A per-market coverage query (the hub uses the `rdp_metric_coverage` view).
- Staff reach it by group: the hub key is `data-extractor`; a group must have it ticked. Every table it reads is already
  open to any signed-in user.

## Checks (hub, in `scratch/`)

`_dx-drive.mjs` (the whole flow, both themes, three screen sizes), `_dx-edge.mjs` (odd searches, unit-only suburbs,
councils with no vacancy), `_dx-hub-check.mjs` (card, search, Forge bar), `_dx-forge-lga-check.mjs` (the upload keeps
the 28-market list unchanged and matches the seeded row), `_dx-samples.mjs` (sample downloads).

## Changelog

- 2026-11-13: rebuilt. Own Vault card and search entry; the Data Forge bar button removed. Three-step picker with quick
  picks, live result, "Latest figures" tab. Council-area vacancy for every council (`lga_vacancy_history`, seeded for
  August 2026, with history from 2019 for the 28 regional markets). Market data limited to what the picked markets hold
  (`rdp_metric_coverage`, mig 137). Excel export moved from xlsx-js-style to ExcelJS; CSV added. Fixed along the way:
  quarters printed twice when two sources dated them differently; suburbs with unit rows only could not be found.
