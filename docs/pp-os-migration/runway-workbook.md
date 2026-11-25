# Runway workbook (`tools/runway-workbook.html`) — migration note

The Runway tool: how far each market's median price sits below what local incomes can borrow, under rate scenarios.
OS has its own port under Advisory; this note records hub changes it must follow.

## Changelog

- 2026-11-24 (Davey via Saskia, meeting 2026-11-24: the ranked list "goes 1 2 3 4" across two sides; "make it all go
  down"): the **All markets** list (`#rwOv .ovgrid`) is still sorted by runway, but now fills the left column top to
  bottom, then the right (`grid-auto-flow: column`, `grid-template-rows: repeat(var(--ovrows), auto)`, with
  `--ovrows = ceil(markets / 2)` set where the list is drawn). Below 880px wide it is one column, in rank order, as
  before. pp-os: the OS Runway screen's market list needs the same column order. Check: `scratch/_rw-rvd-probe.mjs`
  (36 markets: 1-18 down the left, 19-36 down the right at 1440; one column at 700).
- 2026-11-25 (Davey via Van: "Davie wants the list of runways at the bottom to just be one long list, not two"): the
  **All markets** list (`#rwOv .ovgrid`) is now ONE column at every width, in runway order (`grid-template-columns: 1fr`);
  the 11-24 two-column fill and `--ovrows` are gone. pp-os: the OS Runway Workbook's market list should be one long
  list too. Check: `scratch/ppa-tools-cycles/probe-rwb-list-1125.mjs` (one column, 36 rows top to bottom in runway order).
