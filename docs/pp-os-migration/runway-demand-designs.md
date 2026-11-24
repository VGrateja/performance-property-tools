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
- **Runway numbers** stay hidden unless the advisor checkbox is ticked, in every design (tick labels, the clock's rim
  percentages and feet, the hover card's runway line, the numbers table and the "PP variable rate" line).
- **Themes:** A and C follow the light/dark switch; B is dark in both, as designed.

## How the clock fits the tool's numbers (Sample C)

Since 2026-11-19 the dial is read the research lead's way (it was the handover's `clock_xy`, the scatter turned 45°):

- **Runway runs around the dial.** 12 o'clock is no runway left (the peak) and 6 o'clock is 120% or more, so an hour
  is 20 points (`clockAngle`). The rim carries the twelve hours; with runway numbers on it carries the runway each hour
  stands for instead (0% at 12 to 120%+ at 6). The scale is absolute: it does not follow the Smooth / Workforce
  midpoint, and a runway under 0 sits at 12, over 120 at 6.
- **Demand runs toward the centre.** The rim track is −20 and the innermost 80 (`clockRadius`), so the stronger a
  market, the shorter its lap. Rings at 0, 30 (the threshold, dashed), 50 and 70 are numbered along the 4:30 line.
- **Which side of 12.** Runway alone cannot say whether a market is approaching its peak or past it, and this tool
  holds no price series (its runway also moves when the borrowing assumptions do: from September 2026 every market's
  runway rose at once, so "runway rising = prices falling" would put 35 of 36 house markets past the peak). So the
  side is the research team's own call: the hour each market is recorded at on the **Property Clock**
  (`clock_state.payload.houses / units`, one small read, open to every signed-in user). After 12 and up to 6 is past
  the peak (right half); otherwise before it (left half). The clock's single "ALBURY-WODONGA" unit entry serves both
  markets. Until the read arrives, if it fails, or for a market the clock does not list, the market is drawn before
  the peak and the chart says so under the left column.
- **Limits to know.** Only the SIDE is taken from the Property Clock; the hour here comes from runway, so the two
  clocks do not show the same hour for a market. The Property Clock hour as it stands today is used for every month,
  so trails and playback never change side.
- **The four phases** are now the sectors a market stands in (top Selling window, right Correction, bottom Value, left
  Momentum; boundaries at 30% and 90% of runway), so the bezel counts and the hover card's phase follow the dial, not
  the four quarters of the scatter. The hover card adds "Side of the peak" with the Property Clock hour behind it.
- **Guide lines:** hovering a dot (and, for up to six highlighted markets, always) draws a dashed line out to the rim
  (its runway, the figure only with numbers on) and a dashed arc round its ring to the demand scale (its demand).
  Figures that would print on top of each other are spaced out in order.
- **Numbers panel:** with markets highlighted, the left column swaps "How to read it" for a table: market, demand
  score, 12-month demand change, and runway % with numbers on.

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
- 2026-11-19: Sample C remapped on research feedback: runway round the dial (12 = none left, 6 = 120% or more),
  demand toward the centre, and the side of 12 read from the Property Clock (see the section above for why runway
  cannot decide it). The two diagonal axes, the rim clamp and its chevrons, and `RVDD.clampStats()` are gone;
  `RVDD.clock()` reports the scales and what was read. Check 11 added to `scratch/_rvd-designs-check.mjs` (every
  dot on the formula for House and Unit, sides as the Property Clock has them, the rim with numbers off and on, and
  the Property Clock unreachable).
- 2026-11-19, later: **Sample A approved** by the research lead; the switch goes to production so it can be shown to
  the advisers before it replaces the Original. The Original stays the default. The dropdown now offers Original and
  Sample A only, still for dev and admin only. Samples B and C were not taken up: they left the dropdown, a remembered
  B or C is ignored, and they open by address only (`?design=b`, `?design=c`); their code is kept, unused by the
  dropdown. When Sample A becomes the default, B and C and the dropdown can be removed together.
- 2026-11-23: **Investment Committee approved** (relayed by the research lead): Sample A and Option A (fixed benchmark,
  `dsA`) are now the only design and the only method, for every viewer. The Design and Demand Method dropdowns, the
  Original, Samples B and C (with the clock's Property Clock reading) and Option B are removed from the page; Option B's
  `dsB` is still written by the builder. Embeds (`?embed=1`, decks and B/S slides) now show Sample A + Option A;
  `?design=` and a remembered `ppa-rvd-design` no longer do anything. `render()` is now `RVDD.render()`; the page's own
  `#chart` svg stays built but hidden (its `runwayAxisLabel` text and `runwayTickMid` are still read by
  `shared/rvd-designs.js`). The deck capture in `shared/bss-slides.js` now waits for `#rvddChart path.rvdd-dot` (it
  waited for the Original's `circle.city-dot`). Checks: `scratch/_rvd-designs-check.mjs` (12 of 12) and
  `scratch/_rvd-admin-reveal.mjs` rewritten for the new behaviour.
- 2026-11-24 (Davey via Saskia, meeting 2026-11-24: "the default when you open up the runway is that this is ticked
  on"): the unlabelled advisor tick box `#showRunwayAxis` now starts **ticked**, so the runway axis labels, the bottom
  legend and the hover card's runway figure show on every open (markup `checked`, and the boot block sets
  `checked = true` / `applyShowRunwayAxis(true)`); unticking still hides them. pp-os: OS's Runway v Demand has the same
  reveal and needs the same default. Check: `scratch/_rw-rvd-probe.mjs`; `scratch/_rvd-designs-check.mjs` now
  asserts the default and unticks before its "off" probe.
