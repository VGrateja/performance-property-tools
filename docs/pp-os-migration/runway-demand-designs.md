# Runway v Demand: Design dropdown (Original / Sample A / B / C)

Hub only. Van, 2026-11-18: "Do this in the hub only." Not to be ported unless Van asks. The three samples are the
redesign mockups in the Runway v Demand handover (Desktop, `Runway v Demand handover/`), under review.

## What it is

A **Design** dropdown in the tool's control row picks how the chart is drawn:

| Option | Handover name | Mockups |
|---|---|---|
| Original (default) | the chart as it is today | — |
| Sample A | Refined classic: four filled zones, captions in the corners, rent-growth words on the right | 01 to 05 |
| Sample B | Corner brackets: dark card, coloured corner brackets, dashed thresholds | 06 to 10 |
| Sample C | The clock: the same two scores drawn as the property clock (dial, bezel, four phases) | 11 to 15 |

Only the chart inside the card (and the legend row under it) changes. Every control stays where it is and works in all
four: House / Unit / Combined, Highlight Regions (Select All, Clear, Smooth, Workforce, search), Demand Method, Wage
Growth, Trail Length, Trail Lines, Speed, the runway-numbers checkbox, Play, the timeline, Download HD PDF / JPEG,
Manage Pushed Months, the hover card, embeds.

- **Who sees it:** dev and admin (revealed by the same pass as Manage Pushed Months). Staff see no dropdown and get
  the Original. `?design=a|b|c|original` in the URL picks a design for anyone.
- **Remembered:** the dropdown choice is kept in `localStorage['ppa-rvd-design']`; the URL wins over it.
- **Embeds (slides):** always the Original and no dropdown, unless the embed URL itself carries `&design=`.
- **Runway numbers** stay hidden unless the advisor checkbox is ticked, in every design (tick labels, the clock's spoke
  percentages and feet, the hover card's runway line, the numbers table and the "PP variable rate" line).
- **Themes:** A and C follow the light/dark switch; B is dark in both, as designed.

## How the clock fits the tool's numbers (Sample C)

The mapping is the handover's `clock_xy` (the scatter rotated 45° so the two threshold lines cross at the hub), which
keeps two straight, linear axes inside the dial:

- **10:30 to 4:30 is the demand axis** (demand rises toward 10:30, 30 at the hub): a tick every 10 points with the
  likely-rent words at 70 (10%+), 50 (5%+), 10 (flat) and −10 (falling).
- **1:30 to 7:30 is the runway axis** (more room toward 7:30, the midpoint at the hub): a tick every 20 runway points;
  the percentages appear only with runway numbers on. Both scales follow the midpoint (60, 40 Smooth, 70 Workforce).
- **Guide lines:** hovering a dot (and, for up to six highlighted markets, always) draws two dashed lines parallel to the
  spokes to each axis, with the value at each foot (the runway foot only with numbers on).
- **Numbers panel:** with markets highlighted, the left column swaps "How to read it" for a table: market, demand
  score, 12-month demand change, and runway % with numbers on.
- **Rim:** a market further out than the rim is pinned just inside it with a small outward chevron. The divisors are
  fixed across months. The handover's 55 (runway) / 40 (demand) put 83 of 828 house points and 226 of 828 unit points
  (Jan 2025 – Nov 2026, midpoint 60) past the rim, so they were widened to **80 / 55**, which leaves 1 house and 7 unit
  points clamped (`RVDD.clampStats()` in the console recounts).

## Where

| What | Path |
|---|---|
| The three designs, label placement, hover card, clock maths | `shared/rvd-designs.js` (`window.RVDD`) |
| The hook (first line of `render()`), the dropdown, embed hide, dev/admin reveal | `tools/runway-demand.html` |
| Checks (puppeteer, staff test account) | `scratch/_rvd-designs-check.mjs` (gitignored) |

`render()` keeps all of its code; its first line hands over to `RVDD.render()` while a sample is chosen. The samples
draw into a second `<svg id="rvddChart">` inside `.chart-wrap`, so the © line, the month label and the html2canvas
export are the Original's. Every score is read through the page's own accessors (`getData`, `getRunwayValue`, the
`ds` the Demand Method switch maps, `runwayTickMid`); nothing is re-derived.

Labels: a port of the handover's `place_labels` (eight positions at growing distances, scored, most-crowded first,
eight passes, 1px leader when detached, identical points side by side), measuring text in the browser. Two additions
so every month reads clean: any overlap carries a fixed cost on top of the area cost, and a label still overlapping
after the eight passes searches a finer grid for the nearest clear spot.

Export: the svg is rasterised by html2canvas as an image, which cannot see webfonts, so the samples embed the latin
Montserrat faces (fetched once from Google Fonts, as the page already does) under a private family name. Without that
fetch the export falls back to a system sans, as the Original's export does today.

## Changelog

- 2026-11-18: built (uncommitted, for Van's local review). `node scratch/_rvd-designs-check.mjs`: 22 of 22 pass.
  The Original's `#chart` markup is byte-identical to HEAD in 13 states (and the check fails against a deliberately
  broken copy); each sample draws one dot per market the Original draws; label overlaps 0 in every month, House and
  Unit, for all three (1280, 1440 and 1920 wide); render 70–120 ms a month on average.
- 2026-11-18, later: Sample B has a light ground. The handover mocks it dark only; the owner asked for light after
  seeing it stay dark in the light theme. `TK.b` is now `{ dark, light }` read through `tkB()`; the light palette is
  derived (white and inks from the refined classic light tokens, the four quarters as darker steps of the brand
  ramps), not taken from a mockup.
- 2026-11-18, later: trails in Samples A, B and C are smooth curves through the monthly positions (Catmull-Rom,
  `drawTrails`), as mockup 03 draws them; they were straight segments. The markers stay on the true positions.
  A faded market name that a highlighted trail runs through is hidden (`segHitsBox`), as the mockup shows only the
  names clear of the paths. `node scratch/_rvd-designs-check.mjs`: 22 of 22 after both changes.
- 2026-11-18, later: every trail carries its monthly dots and its start ring, also with nothing highlighted (they
  were drawn for highlighted markets only). The start-month label stays with highlighted markets.
