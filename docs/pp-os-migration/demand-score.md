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

## Compare tooltip names the benchmark (2026-10-13; retired 2026-11-23, see "Fixed benchmark" below)

The score is relative. Each market is graded against `Nb = grade(45 × 0.9 × 3 × Fb)`, where `Fb` is the median listings
per 1,000 people across the set. When that median moves, every market's score moves, even if its own inputs did not.

`explain()` now takes `ctx.bench = { prevFb, curFb, prevNb, curNb }`, built from the two maps being compared. It adds a
"Market-wide benchmark" driver: the same row scored against the new benchmark minus against the old one. It also adds an
`own` total: all of the market's own inputs changed at once, against last month's benchmark. That has to be done in one
step, because swapping one input at a time can miss a grade step that the combination crosses.

When the benchmark is the largest driver, the verdict says so. The wording also names the series the market was actually
scored on (Cotality or SQM) instead of always saying "SQM".

Example: Brisbane houses, Oct v Sep 2026, moved +9 overall. The benchmark gave about +11; its own inputs gave about −0.8.

## Fixed benchmark: Option A (2026-11-23)

The Investment Committee approved Option A on 2026-11-23, and Van asked for it in the Demand Score tool as well as in
Runway v Demand. Every score on the dashboard is now graded against a **fixed benchmark** instead of that month's median.

**Definition.** It is the same as `dsA` in `docs/pp-os-migration/runway-demand-methods.md`. The benchmark row keeps VR 3,
DOM 45 and rent growth 0.1. Its listings per 1,000 (`Fb`) is one constant per property type: the average of the monthly
medians, Jan 2025 – Nov 2026. Houses are 3.5693 (`Nb` 65.5) and units 4.4740 (`Nb` 60). Then
`score = clamp((grade(M) − Nb) / Nb × 100, −20, 80)`, as before.

**Where the constants come from.** There is one source. The page reads `data->benchFixed` from `forge_cotality` id
`rvd_v3_methods`, where `build-cotality-rvd-history.mjs` (section 4a) stored it once. That read is in `loadForgeAll`, and
the page stops with an error if it is missing. It never falls back to the median. Nothing in the page holds a copy of the
numbers.

**Engine.** `compute(rows, fb)` and `benchmark(rows, fb)` take an optional `fb`. The dashboard always passes it. Without
it the engine still uses the median, so the scripts that load this block are unchanged: the RvD builders' Current `ds`,
the `dsA` anchoring, and `make-cot-capture*.mjs`.

**What the page shows.**

- **The live month** is computed directly against the fixed benchmark.
- **A stored capture** is re-graded for display. The record itself is never rewritten (`_dsFix`).
  - A capture that kept its inputs (Aug 2026 onwards) is re-scored from them.
  - An older capture (Jan 2025 – Jul 2026, copied from the RvD timeline without inputs) takes the timeline's own method
    difference: `ds + (dsA − ds)`.
  - A market with neither gets no score.
- **The capture button and Push to Runway v Demand still store `ds` on the median method** (`demandScoreCurrent`). Every
  other reader of `forge_demand_snapshots` therefore keeps getting the same kind of number until Van decides about them
  (see the map below).

**Explanation.** The "Market-wide benchmark" driver, its "own inputs, all together" line and the "Mostly a market-wide
shift" verdict are removed. Both months are graded against the same `Nb`, so a move is the market's own inputs. The
compare view now says: "Every month is measured against a fixed benchmark: the average market listings level, Jan 2025 –
Nov 2026."

**Effect, Nov 2026 capture.**

- Houses fall 17–29 points, 24.4 on average. The number of markets at 25 or more goes from 30 to 6.
- Units fall 13–37 points, 30.8 on average. The number at 25 or more goes from 30 to 17.

Nov's median listings level was well above the 23-month average: 5.51 per 1,000 against 3.57 for houses, and 6.60
against 4.47 for units. That makes the fixed benchmark harder to beat. The
tier/quadrant line at 25 was not changed.

**Parity with RvD `dsA`, Nov 2026.** Every market is within 1 point.

- Houses: 34 of 36 are exact.
  - Bundaberg is 1 point off. The capture's Current `ds` already differed from the timeline's by 1.
  - Ballarat is 1 point off because of the builder's anchoring: rounding, and re-scoring on today's VR projection.
- Units: 30 of 36 are exact.

The fixed benchmark closes most of the old units gap. 32 of 36 units markets had a Current `ds` 1–4 points off the
timeline, because the dashboard's median included National and the builder's did not (units `Nb` 47.5 against 47). That
gap is now gone.

### Other places that compute or show a demand score (map only; none changed)

| Where | Source of its number | Differs from this tool now? | To switch |
|---|---|---|---|
| `tools/runway-demand.html` | `rvd_v3_methods` timeline (`ds`, `dsA`) | Being switched to Option A by a separate change | — |
| `tools/market-compare.html` | Newest non-rvd capture's stored `ds` (cot-2026-11) | Yes: median method, plus its own tier/quadrant copy | Re-grade like `_dsFix`, or store `dsA` in captures |
| `tools/buying-selling-slides.html` (demand v runway scatter) | Newest non-rvd capture's stored `ds` | Yes | Same as Market Compare |
| `shared/traffic-lights-engine.js` → `tools/traffic-lights.html`, B/S RAG slides, Data Forge compare | SQM captures only (`YYYY-MM`, newest 2026-08); `ds` series, thresholds 5/30 | Yes: old method, and stale since Aug 2026 | Read cot- captures re-graded; re-tune 5/30 thresholds |
| `tools/academy.html` + `shared/academy-math.js` | Own verbatim engine copy (median) + captures | Yes | Parked by Van; do not change |
| `scripts/build-cotality-rvd-history.mjs`, `build-sqm-rvd-history.mjs` | Load this engine; `ds` = median, `dsA` = fixed | `ds` differs by design; `dsA` matches | None needed for `dsA` |
| `scripts/make-cot-capture*.mjs`, `backfill-cot-captures.mjs` | One-off capture writers: engine median / copy of V3 `ds` | Store the median `ds` like the button does | Only if captures should store fixed |
| `forge_demand_snapshots` (button captures, `rvdcot-` pushes) | Median `ds` (kept on purpose) | Stored on the old method; shown here re-graded | Store fixed or add `dsA`; switches every reader above at once |
| `scripts/build-demand-score.mjs`, `build-runway.mjs`, `tools/online-reports.html`, `ir-builder.html`, `vr-projection.html`, `median-prices.html` | No demand score computed or shown (IR Builder's "demand" is Suburb Scoring's) | No | — |

## Changelog

- 2026-10-13: units scored on unit vacancy. The Forge upload keeps `vacUnit` and extends the monthly series; July
  backfilled. The compare tooltip gains the benchmark driver and the own-inputs total, and its SQM/Cotality wording is
  fixed. Raised by Saskia's review of the October preview.
- 2026-11-23: every score is graded against the fixed benchmark (Option A, approved by the Investment Committee); the
  constants are read from `rvd_v3_methods.benchFixed`. The benchmark driver, the own-inputs line and the "market-wide
  shift" verdict are removed. Captures and the push still store the median `ds`. Consumer map added. Not committed;
  Van gates it.
