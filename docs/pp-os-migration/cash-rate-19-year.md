# Cash rate forecast — 19-year rolling average over completed months (hub)

Feature note for the pp-os migration. Hub files: `scripts/sync-rolling-cash-to-runway-config.mjs`,
`scripts/ingest-rba-rates.mjs`, `tools/data-forge.html` (Cash Rate / Bank Rate cards), `tools/runway-workbook.html`
(the "auto" tag), `tools/ir-builder.html` (IC rate footnote), `tools/runway-demand.html` + `tools/demand-score.html`
(fallback display rate), `.github/workflows/forge-publish.yml` (comments).

## Why

Investment Committee decision (relayed 2026-10-22): the long-run cash rate forecast moves from the 18-year to the
**19-year average**, and every tool and whitepaper aligns to it. The IC's working is the "Other Data Auto Gathering"
sheet (tab "RBA Cash Rate"): 19-year average = **2.87%** over **Oct 2007 – Sep 2026** (228 months), so with the 1.75%
bank margin and 0.50% APRA buffer the **PP Variable Rate is 5.12%**.

## The rule

- `rdp_runway_config.rates.forecast.cash` = mean of the **228 most recent COMPLETED months** of the RBA cash rate target
  (`rdp_raw_series` rba/cash_rate/M), rounded to 2 dp of a percent. "Completed" = before the current calendar month in
  Australia/Sydney — the sheet leaves the running month out, and so do we (before this change the hub counted it, which
  is why it showed 2.63% where the sheet said 2.64% for 18 years).
- `forecast.rate` = cash + margin + APRA (unchanged arithmetic). Set at every Data Forge PUBLISH (sync-rolling-cash);
  a hand-typed value in the Runway Workbook holds only until the next publish (unchanged).
- Our stored series reproduces the sheet exactly on the same window: 10y 2.15%, 15y 2.33%, 18y 2.64%, 19y 2.87%,
  20y 3.04% (all ending Sep 2026).
- The Data Forge Bank Rate card's reference average moves to 19 annual points (nothing consumes it).
- Past months' recorded rates (the per-month maps in Runway v Demand / Demand Score) are history and are not changed.
- Expected drift: when October 2026 completes, the window becomes Nov 2007 – Oct 2026 → about 2.86% / 5.11%; the
  publish emails the change to Pre DD + Jonathan as before.

## Whitepapers

Checked all 27 PDFs on docs.performanceproperty.com.au (whitepapers, strategies, brochures). Only **"Interest Rates"**
still states the 18-year basis (p2 "most recent 18-year economic cycle"; p8 "18-year credit cycle … cash rate average
of 2.69% (… ~4.94%)") — the research team updates the PDF. "New v Established" already uses the 19-year rolling rate
(Bank Rate 5.12%).

## pp-os

pp-os carries the same rule in its own code (`worker/src/publish/rules/rolling-cash.ts`,
`steps/sync-rolling-cash.ts`, `api/src/forge/series/rules.ts` + `blocks.ts`, `web/src/lib/screens/forge-series.ts`,
`runway-workbook-view.tsx`, contracts `data-forge.ts` / `ir-builder.ts` / `ir-samples.ts`, and their tests): 216 → 228,
completed months only, labels "19-year". Owed as a planned PR. Until it lands, a pp-os PUBLISH would set its own
config back to the 18-year rate.

## Changelog

- 2026-10-22 — 18 → 19 years, completed months only; config 2.63% / 4.88% → 2.87% / 5.12%; IR Builder footnote now says
  "plus the 1.75% bank margin and 0.50% APRA buffer" (it said "plus 2.29 percentage points", which the tools never
  used).
