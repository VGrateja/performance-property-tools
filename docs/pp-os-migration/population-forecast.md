# Population Forecast — feature note for the pp-os port

A Vault tool (built by Shaene, hub PRs #23 and #24): how many people each market is expected to add each year to FY2028-29,
on the same inputs as the Vacancy Rate Projection so the two agree. This note records what the pp-os port must copy. It is
not a full description of the tool.

Source of truth in the hub repo: `tools/population-forecast.html`. Registry key `population-forecast` (sec `vault`); it has
a search entry and a Vault window card in `index.html`.

## The method

- **Base:** ERP June 2025 — capitals on GCCSA, regions on LGA.
- **Natural increase and internal migration:** 2-year averages, held flat. Melbourne keeps the VR tool's internal
  migration override.
- **Overseas migration:** the Budget national path, apportioned on each market's FY2024-25 share.
- **Infrastructure workforce (WF):** each year's OWN figure. This is the one deliberate difference from the VR tool, whose
  V1 method repeats year 1 in year 2. Without WF, and in year 1 with the hub table's WF, the figures equal the VR tool's
  stored `people1` / `people2` exactly; the page checks this on load against the hub table.
- **Long-term average yearly change** is drawn the way the Buying/Selling slides compute it: `population_gccsa` from 1980
  for capitals, `population` from 2001 for regions.

## Data it reads (all live, no figures in the file)

| Table | What |
|---|---|
| `rdp_regions` | slug, name, state, cluster |
| `rdp_vr_forecast` | `payload.demand.v1` — the VR tool's inputs and stored people1/people2 |
| `vr_workforce` | WF by year: `y1` FY2025-26, `y2` FY2026-27, `y3` FY2027-28 (mig 135). FY2028-29 has no column |
| `rdp_raw_series` | actual 2024-25 and the long-term history |
| `rdp_runway_config` | key `population_forecast_wf_sheet`: `{ url, saved_at }` — the saved major projects sheet link |

## WF from the major projects Google Sheet (#24)

A field on the page takes the link of the major projects workbook and reads its "Region Calculation" tab ("All regions:
new residents by year") through Google's CSV export
(`/spreadsheets/d/<id>/gviz/tq?tqx=out:csv&sheet=Region%20Calculation`): no key, no server. The sheet must be shared
"Anyone with the link can view"; Google answers the hub origin with CORS, so the pp-os origin must be checked the same way
before relying on it.

- Year mapping: sheet calendar column 2026 → FY2025-26 … 2029 → FY2028-29. The 2025 catch-up column is not used.
- Markets matched by name ("Greater Perth" = Perth); unknown rows are skipped and named; markets not in the sheet have no
  WF while the sheet is in use.
- The link is saved for everyone in `rdp_runway_config` when the user is a writer (`is_writer()`), otherwise in
  `localStorage` `ppPopForecastWfSheet` with "saved in this browser only".
- **"Use hub table" saves `{ url: null }` rather than deleting the row.** `rdp_runway_config` has no DELETE policy, so a
  delete matched 0 rows with no error and the sheet came back on reload. The port should keep the upsert (or add a writer
  DELETE policy — not done here, as it would let writers delete the rates and AI-ceiling rows too).

## What the port needs

- `vr_workforce.y3` on the pp-os database, with the hub's values copied (they live only in the hub table; never in a repo).
- The `population_forecast_wf_sheet` config key, if the port keeps the sheet field.
- The hub-to-pp-os cutover puts ported Vault tools under Advisory.

## Changelog

- 2026-11-09 — Tool added (hub #23), WF from the major projects Google Sheet (#24). Registered under Vault with a search
  entry and a window card; `vr_workforce.y3` added (mig 135) and filled for the eight WF markets from the VR workbook's WF
  Modifier tab (2028 row); "Use hub table" fixed to stick (saves an empty link instead of a delete that RLS ignored).
