# Market cycles — feature note for the pp-os port

Hub page: `tools/market-cycles.html`. Built 2026-11-17 for the client presentation Saskia and David are giving
(first version, under review; not ported).

## Why it exists

The presentation opens on the state of the market. Saskia asked for two charts as its second and third pages:

1. **The biggest falls.** A chart in the style of one going around from Coolabah Capital: the five biggest falls in
   capital city home values since 1980, each from its own peak, with the 2026 fall on top. The point is hopeful:
   it looks bad, and every earlier fall was followed by a recovery.
2. **The fastest-growing capital.** David wants the familiar "race" of capital cities overtaking each other, but on
   long-term growth rate instead of dollar value, to show that the leading capital keeps changing. Saskia asked for
   two versions to choose between: long term, and rolling 10 years.

## What it shows

- `?view=falls`: one line per fall, months since the peak across, peak = 100 up. Each line stops when values are
  back at the peak, or at 30 months. The current fall is the thick amber line. Right: the legend, with each fall's
  depth, months to the low and months back to the peak. Below: three figures, then the last 3 months as a yearly
  rate for each of the five capitals and the five together. The title, the amber line under it and the figures are
  all worked out from the data; when values are at a peak the page says so and draws no current fall.
- `?view=growth`: eight bars that re-sort as the years run (press play, or drag the slider), Melbourne in teal and
  Darwin in amber because those are the markets the presentation is about. Under it, a strip naming the leader of
  each year. A switch picks "Rolling 10 years" (default) or "Long term".
- `?embed=1` draws one view at exactly 1280 x 720 with no app bar. `?theme=light|dark` picks the ground (an embed
  is dark by default; the page on its own follows the OS shade). `?mode=long` and `?play=1` set the growth view's
  switch and start it playing.

## Data it reads (live, read-only)

| Source | What |
|---|---|
| `forge_cotality` row `cl_capital_history` | The eight capitals, houses and units, monthly January 1980 to June 2018: `data.cities[<City>][H|U] = { avm, n, med12 }`, one array entry per month from `data.from` |
| `forge_cl_suburbs` level `capital` | The same three figures from July 2018 (`metrics.avm`, `metrics.props`, `metrics.med12`) |

The history row was written once by `node scripts/build-cl-capital-history.mjs --write` from
`CSTDAT4294-CapitalCities_1980-2018.csv` (shared drive, "CoreLogic files / Historic"; kept outside the repo in
`~/Downloads/corelogic-history`). The history is closed, so there is no monthly step: a new Cotality month arrives
in `forge_cl_suburbs` and the page picks it up.

## Rules worth keeping

- **The falls are measured on our own series, not Cotality's hedonic index.** The series is the median estimated
  value (AVM) of all dwellings in Sydney, Melbourne, Brisbane, Adelaide and Perth, houses and units, chained month
  to month with each leg weighted by its value times its dwelling count the month before. It tracks the published
  index closely on the two biggest falls (2017-19: ours -9.1% over 19 months, Cotality's -8.6% over 19; 2022-23:
  ours -9.9% over 9 months, Cotality's -8.1% over 9) and less well on the early ones, because estimated values
  start in 1980 for Sydney, Melbourne and Brisbane only, 1983 for Perth and 1993 for Adelaide. The footnote says so.
- **It ends where our data ends.** Coolabah's chart used Cotality's daily index to 12 November 2026 and called 2026
  the worst fall on record (-8.8%). Our monthly files run to August 2026, where the fall is -4.6%, four months in.
  The page does not claim "worst ever"; it says what the data shows. The headline changes by itself as months arrive.
- **July 2018 is bridged.** It is the first month of the Forge's own files and its estimated values sit well off
  the months either side (Sydney houses 986k, 1,098k, 974k). Left alone it reads as a false peak.
- **A zero is a blank.** The history file writes 0 for the months before a capital's valuations begin.
- **1980 is not a peak.** A fall whose "peak" is in 1980 is the start of the series and is left out.
- **Growth uses the 12-month median sale price of houses**, the measure behind the Data Extractor's long-term
  growth rate. Rolling: the 10 years to each December. Long term: from the capital's first median on record, shown
  once there are 8 years of it (the Suburb Scoring rule). A capital appears when it has enough history, so the
  early years have fewer bars.
- A near tie (a quarter of a point) is described as a tie, not a ranking.

## In the presentation builder

`tools/presentation.html` lists both under Add embed ("Biggest falls since 1980", "Fastest-growing capital"). They
go in at the full slide (`EMBED_KINDS` entries with `full: true`, 1280 x 720).

## What the port needs

- A home for the 1980 to 2018 capital history (one store key; copy the hub row, 139 KB).
- The capital-level rows of `forge_cl_suburbs` (pp-os already keeps them).
- The page's arithmetic as a contracts module with tests: the chained index, the falls, the two growth rates.

## Checks (hub, in `scratch/`)

`_mc-check.mjs` drives both views as slide embeds in both grounds and compares every figure with
`_pres-charts/analyse.mjs`, which joins the history file and the Forge by itself. `_pres-embed-check.mjs` confirms
the builder lists the two embeds and loads without an error.

## Not checked yet

- Inserting the embed into a real deck and presenting it (needs an editor account; the check does not write to a deck).
- How an embed behaves in a deck's PDF or JPG export.

## Changelog

- 2026-11-17: first version, for Saskia's review before Thursday's planning session. Two views, an embed mode, the
  history row, the two entries in the presentation builder. Open with Saskia: whether to source Cotality's hedonic
  index so the falls match the published figures; long term or rolling 10 years for the growth chart; the AFR chart
  it was modelled on was described in the meeting but not seen.
- 2026-11-18: live, and in the Vault. Van asked for it to be pushed and made available in the Vault: a Vault window
  card and a search entry in `index.html`, both shown to whoever can open the Vault. The tool has NO registry key on
  purpose: the page is embedded in slides, and a key would let the page gate turn away a staff member presenting a
  deck when their group does not hold it. So the page opens for any signed-in staff member, and the card cannot be
  ticked per group. The app bar says "The Vault".
- 2026-11-18, later: it has a registry key after all. Van could not find it in Staff Groups and asked for every tool
  to be tickable there. Key `market-cycles` (sec `vault`) on the card and the search entry, so a group sees them only
  when ticked. The slide embed stays open to everyone: the registry entry carries `embedOpen`, and the page gate
  (`shared/auth-gate.js`) lets a page with that flag load when it is opened with `?embed=1`. Opened on its own, the
  page turns away a staff member whose groups do not hold the key. Median Prices got its key (`median-prices`) in the
  same change; until then both cards showed to whoever could open the Vault.
- 2026-11-18, polish (Van, with feedback passed on by Saskia). Fastest-growing capital: one colour per capital in the
  bars and in the year-by-year strip (tokens `--syd` to `--cbr` on `.cy`, a step of the brand tone ramps each, a set per
  ground; the Melbourne teal / Darwin orange / grey scheme is gone), and a Speed control beside the slider (Slow 2.4 s a
  year, Normal 0.9 s, Fast 0.45 s; `?speed=slow|normal|fast` presets it for a slide; changing it mid-run carries on from
  the year showing). Both charts: less text. Falls lost its paragraph and its three tiles (their facts are in the one
  line under the title: how far, how it compares at the same stage, how long the five took to regain their peak); the
  legend lines, the pace row, the footnotes and the growth subtitle are shorter; no label is set in spaced capitals.
  Nothing about the figures changed. Check: `node scratch/_pres-charts/analyse.mjs && node scratch/_mc-check.mjs` (32).
