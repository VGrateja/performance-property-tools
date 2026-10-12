# Demand Score — feature note for the pp-os port

This note records Demand Score changes that the pp-os port must copy. It is not a full description of the tool.

Source of truth in the hub repo:

| What | Path |
|---|---|
| The dashboard, the scoring engine (`PP_DEMAND_ENGINE`) and the compare view | `tools/demand-score.html` |
| The Cotality rent/vacancy upload in Data Forge | `tools/data-forge.html` (`parseRvCsv`, `saveRentVacancy`, `appendRvHistory`) |
| The monthly Cotality series, first built from the exports | `scripts/build-cotality-rvd-history.mjs` → `forge_cotality` id `cot_rentvacancy_history` |

## Units use unit vacancy (fixed 2026-10-13)

On the Cotality basis, each market's vacancy and rent come from `cot_rentvacancy_history.regions[slug][YYYY-MM]`, with
`h` and `u` each holding `{ vr, rent }`. The month used is the latest Cotality drop's month end. Rent three years ago is read
from the same series, 36 months back.

The bug. The series was built once and stopped at 2026-06, and nothing added later months to it. The 10 Oct drop carries
July, so July was missing for every market. The dashboard then fell back to the drop row for vacancy, and the Forge upload
had been dropping the unit vacancy rows. So every Units-tab market was scored on its HOUSE vacancy. For example, Bunbury
units went from 2.99% (unit) to 1.01% (house) and scored +37; Coffs Harbour units scored +27. Rent growth also fell back to
the annual series.

The fix, in three parts:

- **The Data Forge upload** keeps the unit vacancy (`vacUnit`). It is scaled from a fraction to a percent with the same
  rule as the house figure.
- **After saving**, the upload merges the drop's month into `cot_rentvacancy_history`. It only adds to existing markets,
  and keeps any value the drop doesn't have. Keys use the dashboard's slug rule, so `rvSlug` must stay identical to
  `_fSlug`.
- **The dashboard** reads `vacUnit` from the drop as a fallback. `vrRaw` / `vrr` now hold the reading that was actually
  scored, so units show unit vacancy.

July 2026 was backfilled from the 10 Oct CSVs, matching all 36 markets. Match LGA rows by state as well as name: Central
Coast exists in both NSW and TAS.

## Compare tooltip names the benchmark (2026-10-13)

The score is relative. Each market is graded against `Nb = grade(45 × 0.9 × 3 × Fb)`, where `Fb` is the median listings
per 1,000 people across the set. When that median moves, every market's score moves, even if its own inputs did not.

`explain()` now takes `ctx.bench = { prevFb, curFb, prevNb, curNb }`, built from the two maps being compared. It adds a
"Market-wide benchmark" driver: the same row scored against the new benchmark minus against the old one. It also adds an
`own` total: all of the market's own inputs changed at once, against last month's benchmark. That has to be done in one
step, because swapping one input at a time can miss a grade step that the combination crosses.

When the benchmark is the largest driver, the verdict says so. The wording also names the series the market was actually
scored on (Cotality or SQM) instead of always saying "SQM".

Example: Brisbane houses, Oct v Sep 2026, moved +9 overall. The benchmark gave about +11; its own inputs gave about −0.8.

## Changelog

- 2026-10-13: units scored on unit vacancy. The Forge upload keeps `vacUnit` and extends the monthly series; July
  backfilled. The compare tooltip gains the benchmark driver and the own-inputs total, and its SQM/Cotality wording is
  fixed. Raised by Saskia's review of the October preview.
