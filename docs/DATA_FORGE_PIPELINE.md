# Data Forge Pipeline

*Current-state reference — Performance Property Analytics Hub. Assembled from a grounded repo audit on 2026-07-10.*

Anything the audit could not fully confirm from the repo is marked **(verify)**.

---

## 1. Purpose & principle

**Data Forge is the intended single source of truth for research data.** Every number that feeds the Online Reports, National report, Commercial report, Runway Workbook, VR Projection, and Demand Score Dashboard is meant to originate in Data Forge's isolated stores and marts, then be published outward to the tools — never edited directly in the consuming tools.

Three principles hold the design together:

- **Two-stage monthly cadence.** Data is *gathered* into isolated stores automatically on the 10th (plus manual collection in the UI), the owner *confirms* everything is current, then a separate manual *publish* reshapes and propagates it to the tools.
- **Isolation by design.** The `rdp_*` / `forge_*` schema was deliberately kept isolated from the live tools (migration 050 header: "nothing in the live site reads it yet… ZERO risk"). Cutover is deliberate and staged — see §7 for what has actually flipped.
- **Preserve history / upsert-only.** No ingest ever deletes rows the source no longer covers. Widest-window upserts everywhere.

---

## 2. The monthly cadence at a glance

```
   10th of month (~1am AEST)                Owner, in Data Forge UI            Manual, from Actions tab
  ┌───────────────────────────┐          ┌───────────────────────┐        ┌──────────────────────────┐
  │  STAGE 1 — GATHER          │          │  CONFIRM                │        │  STAGE 2 — PUBLISH         │
  │  forge-ingests.yml (cron)  │  ──────► │  Freshness banner:      │ ─────► │  forge-publish.yml         │
  │  21 API ingests +          │          │  every point green or   │        │  (workflow_dispatch only)  │
  │  1 local JSA run           │          │  "✓ No new data" checked│        │  11 steps, strict order    │
  └───────────────────────────┘          └───────────────────────┘        └──────────────────────────┘
            │                                                                          │
            ▼                                                                          ▼
   forge_* stores + rdp_raw_series                                    rdp_* marts + report_data_cache
   (isolated; tools do NOT see this yet)                              (this is what the tools read)
```

**Key point: "auto-updated on the 10th" does NOT mean the tools changed.** GATHER only lands data in the isolated stores. Nothing reaches a tool until the owner manually runs PUBLISH.

---

## 3. Stage 1 — GATHER

**Workflow:** `.github/workflows/forge-ingests.yml` — *"Data Forge — 1/ GATHER (API ingests)"*.

| Property | Value |
|---|---|
| Trigger | cron `0 15 9 * *` = 15:00 UTC on the 9th = **~1:00 AM AEST on the 10th** (drifts to ~2:00 AM during AEDT, Oct–Apr). Also `workflow_dispatch`. |
| Runner | `ubuntu-latest`, Node 22, `npm install`, Puppeteer download skipped, 45-min timeout, `concurrency: forge-ingests`, `cancel-in-progress: false`. |
| Secrets | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` only (server-side write). No FRED/IMF/ABS keys — all keyless public endpoints. |
| Resilience | each ingest runs under `set +e`; one failure doesn't stop the rest. Failures record `status='error'` into `forge_data_status` (red flag in UI). The job exits 1 at the end if any ingest errored. |

Scope: this workflow **only gathers** into the isolated research DB. It does **not** rebuild the report mart — that is the separate, manual "2/ PUBLISH" workflow.

### 3a. The 21 auto-run API ingests (exact YAML order)

All write **`rdp_raw_series`** (long format, upsert `onConflict: source,region_slug,metric,freq,period`) unless a `forge_*` JSONB store is named. Each also appends an `rdp_runs` log row and upserts `forge_data_status`.

| # | Script | Source | Metric(s) | Freq | Store |
|---|---|---|---|---|---|
| 1 | ingest-abs-population | ABS ERP (national+8 states, capital SUAs, LGAs) | `population` | A | rdp_raw_series (completeness guard) |
| 2 | ingest-abs-income | ABS AWE (Average Weekly Earnings) | `median_income` | A | rdp_raw_series (completeness guard) |
| 3 | ingest-abs-popcomponents | ABS 3101.0 ERP_COMP_Q | `natural_increase`,`nim`,`nom` | A | rdp_raw_series |
| 4 | ingest-abs-lending | ABS HOUSING_PURPOSE | lending | M | rdp_raw_series |
| 5 | ingest-abs-fhb | ABS LEND_HOUSING | `fhb` | A | rdp_raw_series |
| 6 | ingest-abs-jobvacancies | ABS 6354.0 JV (australia, '000s) | `job_vacancies_total/_private/_public` | Q | rdp_raw_series |
| 7 | ingest-abs-inflation | ABS CPI (all groups, year-ended %) | `inflation` | A | rdp_raw_series |
| 8 | ingest-rba-rates | RBA FIRMMCRT (cash) + F6 FLRHOFVA (+0.5pp, bank/lending) | `cash_rate`,`bank_rate` | M & A | rdp_raw_series |
| 9 | ingest-abs-business-investment | ABS CAPEX | `bus_investment` | A | rdp_raw_series |
| 10 | ingest-abs-retail | ABS **MHSI Table 19 .xlsx** (RT SDMX flow frozen) | `retail_turnover` | A | rdp_raw_series |
| 11 | ingest-abs-approvals | ABS BA_GCCSA + BA_LGA + BUILDING_ACTIVITY | `approvals_h/u`,`commenced_h/u` | A | rdp_raw_series |
| 12 | ingest-abs-unemployment | ABS LF + LF_UNDER + capitals + MRM1 SA4 | `unemployment`,`underemployment` | A | rdp_raw_series |
| 13 | ingest-abs-mineral-exploration | ABS MIN_EXP (Original, $m) | `mineral_exploration` | Q | rdp_raw_series |
| 14 | ingest-fred-iron-ore | FRED `PIORECRUSDM` (= IMF Iron Ore) | `iron_ore_price` (source=`imf`, region=global, USD/t) | M | rdp_raw_series |
| 15 | ingest-abs-pop-pyramid | ABS ERP + C21_G04_LGA Census | — | — | **forge_population_pyramid** (merge; keeps manual regionals) |
| 16 | ingest-abs-commercial | ABS RT (retail_trade $m) + building_approvals_total | retail_trade, etc. | M & A | rdp_raw_series (region australia) |
| 17 | ingest-rba-commercial | RBA F3 corporate + F2 govt (2013+) + F4 term deposit | `corporate_bond_yield`,`govt_bond_yield`,`term_deposit_1y` | M & A | rdp_raw_series (pre-2013 stays on forge_commercial seed) |
| 18 | ingest-national-only | ABS CWD + IMF DataMapper + RBA + cash_rate read-back + seeds | — | — | **forge_national_only** |
| 19 | ingest-abs-act-industry | ABS 5220.0 Table 9 (ACT GVA by industry) | — | — | **forge_industry** (Canberra only; keeps REMPLAN regions) |
| 20 | ingest-sqm-rents | SQM Research (HTML scrape) | house/unit rents | — | **forge_demand_inputs** (keeps manual REA listings) |
| 21 | ingest-sqm-vacancy | SQM Research (HTML scrape) | `vr` | — | **forge_demand_inputs** |

### 3b. The one local-run source

- **`ingest-jsa-jobcreation.mjs`** — JSA Internet Vacancy Index (`.xlsx`). Metrics `job_creation_index` (36 cities) + `internet_vacancies`, source=`jsa`, freq M → `rdp_raw_series` (upsert-only + `rdp_runs` + `forge_data_status`).
- **Not in CI:** jobsandskills.gov.au hard-blocks GitHub runner IPs at the network layer (a gov WAF — connection refused, not a UA filter; a browser UA + retry both failed).
- **How it runs:** manually each month from a non-blocked machine (the laptop): `node scripts/ingest-jsa-jobcreation.mjs --write`.
- **The scheduled task exists.** The launcher `scripts/run-jsa-jobcreation.cmd` is committed, and the Windows task *"Performance Forge - JSA Job Creation (monthly)"* is registered and Ready on the laptop (10th, noon). If the registration is ever lost, `scripts/register-jsa-task.ps1` re-creates it.

### 3c. Upsert / history rules

- Every `rdp_raw_series` write is upsert-only on the 5-column key — never deletes rows the API dropped.
- JSONB stores read-then-merge: pop-pyramid keeps manual regionals; act-industry only touches `canberra`; demand_inputs keeps manual REA listings; national_only / commercial pin/merge against seeds.
- SQM ingests refuse to write when nothing parsed ("Nothing parsed — refusing to write") to avoid wiping good data with an empty scrape.

### 3d. Explicitly out of GATHER scope (manual)

Cotality, Mortgage Arrears (S&P SPIN), Industry REMPLAN uploads, and the REA listings in the Demand card. (`ingest-data-dump.mjs` / `ingest-deferred.mjs` exist but are one-off historical seeders — not referenced by the workflow and not scheduled.)

---

## 4. Manual collection (in the Data Forge UI, `tools/data-forge.html`)

Editing is gated by `_forgeCanEdit` (dev/admin tier; **defaults to DENY** until tier resolves). This is UI feedback only — real writes are RLS-gated server-side by `is_writer()`.

| Data point | Store | How the owner updates it |
|---|---|---|
| **Cotality** (the main monthly drop) | `forge_cotality` (`latest` + `rentvacancy`) | COTALITY view: drop the Market Trends `.xlsx` + two Vacancy/Rent `.csv`. Parsed in-browser, filtered to capitals + 28 LGAs (matched/missing QC pill), upserts. The `.xlsx` also appends `forge_monthly_price` and recomputes CIV. Each drop replaces `latest`/`rentvacancy`. |
| **Mortgage Arrears** | `forge_arrears` | ARR view: drop the S&P SPIN `.xlsx`; parser maps National + state columns, normalises to %, upserts (replaces the series). |
| **Industry (Value Added)** | `forge_industry` | IND view: pick region → open its REMPLAN link → grab "Value added by industry" → drop file. Each drop **merges** regions into the store. Canberra is auto (ABS); never uploaded. |
| **Commercial** | `forge_commercial` (23 tabs) | COMMERCIAL view **in-place editor**: pick tab → ✏️ Edit → add/delete rows, edit cells → Save writes the whole jsonb straight to the store. No spreadsheet, no re-seed. Editing a ⚡ wired tab is allowed but a banner warns it's overwritten on the 10th by PUBLISH. |
| **Demand listings (REA)** | `forge_demand_inputs` | DEMANDINPUTS → Listings tab: type House/Unit counts or use the one-click **"REA → Forge" bookmarklet**. Save merges only changed fields (re-fetches the store first to avoid stale-tab clobber). Rent house/unit + VR tabs are **read-only** — refreshed only by the SQM scripts. |
| **National Only (3 seeded series)** | `forge_national_only` | NATONLY view is read-only. The 3 manual series (federalBudget, govtDebtGdp, householdComposition) are updated by editing the lists in `scripts/ingest-national-only.mjs` then running `node … --write`. No in-tool write path. |

### Freshness indicators

`freshInfo()` classifies each card: **current ≤40d (green) / aging ≤75d (amber) / stale >75d (red)**.
- Manual points (cotality, arrears, industry, commercial, demand_inputs) take their date from the **store row's `updated_at`**.
- civ / monthly_price / computed_metrics show a neutral "live" chip. commodity_prices shows "static" unless checked.
- Everything else uses `forge_data_status.last_ok_at` / `updated_at`.

### The "✓ No new data" check (migration 076)

Each non-derived, non-errored card has a check button → `markNoNewData` upserts `forge_data_status {checked_at:now, checked_by:email}`. `freshInfo` uses the **more recent of data-refresh vs check** as effective age, so a checked card shows "checked · Nd" and turns green **without any data changing**. A check now **expires after 40 days** — it cannot keep a card green indefinitely; once expired the card ages from its real data date again until re-checked or refreshed.

---

## 5. The confirmation step

At the top of Data Forge home, a **freshness banner** names any Stale/Aging points ("**Stale:** … **Aging:** … — refresh these before relying on the reports.") or shows green "✓ All data points current — every source refreshed within ~40 days." The banner also **names any stale-fallback regions** (regions a store lacks, so `enrich-marts` served them from old `rdp_raw_series` copies), and **pipeline health is visible in the tool** — last GATHER, last PUBLISH, and the monthly watchdog's verdict (from `forge_data_status` rows `pipeline_gather` / `pipeline_publish`).

Cards are grouped by gathering method (Manual / Local / Hybrid / Auto / Derived / Static), each with an ingest chip (⚡ Auto / 📄 Seeded / ✋ Manual / 🖥️ Local / 🔀 Hybrid / 🔗 Derived) and a freshness chip. Manual/local/hybrid groups are the ones needing human action.

The owner's job before publishing: get every point either **freshly refreshed** or **"✓ No new data" checked** so the banner reads all-current. **There is no PUBLISH button in the tool** — publish is an external GitHub workflow; the tool's role is only to signal readiness.

---

## 6. Stage 2 — PUBLISH

**Workflow:** `.github/workflows/forge-publish.yml` — **`workflow_dispatch` only** (manual from the Actions tab). No cron. Single `set -e` bash step (any non-zero exit aborts the rest), 30-min timeout, `concurrency: forge-publish` / `cancel-in-progress: false`, no Chromium. It fetches no external data — only reshapes what's already in Forge, so it's safe to re-run.

The run's outcome is recorded to `forge_data_status` as **`pipeline_publish`** (GATHER records **`pipeline_gather`**), and a monthly watchdog — `.github/workflows/forge-watchdog.yml`, on the 14th — red-flags a missed GATHER or PUBLISH month.

### The ordered DAG (read → write)

| # | Script | Reads | Writes |
|---|---|---|---|
| 1 | **publish-readiness-gate** | `forge_data_status`, the `forge_*` stores | nothing — **INPUT gate**; fails the run before any mart write if the inputs aren't ready |
| 2 | **sync-cotality-medians-to-rdp** | `forge_cotality` (`latest` + `rentvacancy`), `rdp_regions` | `rdp_raw_series` — the FULL drop's current-year annual rows: mp_h/mp_u, sales_h/u, adom_h/u (corelogic) + som_h/u, vacancy_rate (÷100), rent_h/u (sqm). Prior years untouched |
| 3 | **sync-arrears** | `forge_arrears`, `rdp_raw_series` (existing series, for the parity diff) | `rdp_raw_series` metric `arrears` (values ÷100 to fractions, hardcoded st-*→capital slug map) — closes the National-vs-regional arrears divergence |
| 4 | **build-report-feed** | `rdp_raw_series` (A), `rdp_regions` | `rdp_report_feed` city rows — `payload:{years}` (**extras-PRESERVING**; year ceiling is dynamic, no hardcoded 2026) |
| 5 | **build-national-report** | `rdp_raw_series` (A), `rdp_regions` | `rdp_report_feed` `australia` row — `payload:{national:true,years}` (extras-preserving, same) |
| 6 | **enrich-marts** | `rdp_report_feed`, `rdp_raw_series`, `forge_cotality`/`forge_monthly_price`/`forge_industry`/`forge_population_pyramid` | `rdp_report_feed` — `{...payload, extras}` (pyramid, industry, arrears, jci, CIV yields, lending, national + Perth extras); writes `extras._sources` provenance and **names any stale-fallback regions** |
| 7 | **rebuild-vr-forecast-from-forge** | `rdp_vr_forecast`, `rdp_raw_series` (population, approvals_h/u), `forge_demand_inputs` | `rdp_vr_forecast` |
| 8 | **build-runway** | `rdp_runway_config`, `rdp_report_feed` | `rdp_runway` |
| 9 | **build-commercial-from-rdp** | `forge_commercial`, `rdp_raw_series` | `forge_commercial` (API tabs only; manual tabs passed through; **fails the run on >25% divergence** instead of just warning) |
| 10 | **refresh-snapshots-from-forge** | `rdp_report_feed`, `rdp_raw_series`, `forge_national_only`/`forge_arrears`/`forge_population_pyramid`/`forge_cotality`/`forge_commercial` | `report_data_cache` (one row per cluster: capital/qld/nsw/vicwatas/national/commercial); logs `rdp_runs` |
| 11 | **post-publish-verify** | `rdp_report_feed`/`rdp_vr_forecast`/`rdp_runway`, `forge_cotality` + `forge_arrears`, `report_data_cache` | nothing — **OUTPUT gate**; fails the run if the marts didn't absorb the stores, arrears/median parity breaks (month-aligned), or snapshots are stale |

### Ordering gotchas (all confirmed correct in the YAML)

- **sync-cotality (2) before build-report-feed (4):** writes current-year medians into `rdp_raw_series` so the feed's annual read picks them up. If `forge_cotality` `latest` is empty/missing `.data.cap`, this step hard-exits → with `set -e` it **aborts the whole publish** (a month with no Cotality drop blocks the entire mart rebuild).
- **build-report-feed (4) / build-national (5) before enrich-marts (6):** steps 4–5 are now **extras-preserving** — they merge `{years}` into the existing payload instead of replacing it, so a crash before enrich (6) no longer strips `payload.extras` from the mart. enrich (6) still re-writes `{...payload, extras}` fresh from the stores, so it must follow both.
- **rebuild-vr (7) before build-runway (8)**; **build-commercial (9) before refresh-snapshots (10)** (which reads `forge_commercial`).

---

## 7. Consumers

| Tool | Forge table(s) read | Default / opt-in / live | Fallback chain | Cutover status |
|---|---|---|---|---|
| **Online Reports** | `rdp_report_feed` | **Forge default** (`?src=live`/`legacy` forces old feed) | Forge → localStorage 15-min cache → `report_data_cache` snapshot → Apps Script | DONE (default) |
| **Commercial report** | `forge_commercial` | **Forge default** | Forge → snapshot → Apps Script | DONE (default) |
| **National report** | `forge_national_only` + `rdp_raw_series` + `rdp_report_feed` + `forge_arrears`/`forge_population_pyramid`/`forge_cotality` | **Forge default** (Forge used only if it returns a non-empty `data.year`) | Forge assemble → snapshot → Apps Script | DONE (default) |
| **Runway Workbook** | `rdp_runway`, `rdp_runway_config`, `rdp_regions`, `rdp_raw_series` | Forge-native only (no toggle) | none | Native from start |
| **VR Projection** | `rdp_vr_forecast` (+ `rdp_regions`, `forge_demand_inputs` for freshness) | Forge-native only (no toggle) | none | Native from start |
| **Demand Score Dashboard** | `forge_demand_inputs` + `rdp_vr_forecast` + `rdp_runway` + `forge_monthly_price` + `rdp_raw_series` + `forge_cotality` + `rdp_runway_config`; score computed **client-side** (no `rdp_demand_score` read) | Forge-native only (no toggle) | none; versioned `forge_demand_snapshots` for compare | Native, but off the central mart path (manual seed lineage) |
| **Runway v Demand** (`runway-demand.html`) | `forge_demand_snapshots` (`rvd-*` push mirrors) merged over the hardcoded `RAW` baseline; localStorage = same-month manual override | Forge-native merge (no toggle) | localStorage → baseline `RAW` | **Ported 2026-07-10** — the Demand Score "Push" now mirrors to Forge, so every machine/deck sees pushed months; Manage→Delete removes the Forge copy too |

Notes:
- The Forge path on Online Reports **bypasses the snapshot/cache** — every page load hits `rdp_report_feed` live; the cache/snapshot only engage on a Forge failure (via `liveDataFetch`).
- Header comments in commercial/national claiming the adapter was "used only with `?src=forge`" were stale — **fixed 2026-07-10**; comments now match the Forge-default behaviour.
- **Demand Score lineage:** the live score is computed **client-side** by `PP_DEMAND_ENGINE` in `tools/demand-score.html` from the tables above (forge_demand_inputs + rdp_vr_forecast + rdp_runway + forge_cotality + forge_monthly_price + rdp population). The `rdp_demand_score` mart is **retired** (decision 2026-07-10) — it was a write-only dead end with zero readers; `scripts/build-demand-score.mjs` is kept for reference only.

---

## 8. Storage & security model

Two families, both in `public`, both deliberately isolated from the live site until cutover.

### Tier A — `forge_*` single-row JSONB stores (manual/UI + JSONB ingest land here)

Shape: `id text PK default 'latest'`, `data jsonb`, `uploaded_at`, `uploaded_by`, `updated_at`.
`forge_cotality` (054 — filtered columns only; the raw licensed CoreLogic workbook is NOT stored), `forge_industry` (055), `forge_population_pyramid` (056, hybrid API+upload), `forge_arrears` (057), `forge_national_only` (058), `forge_monthly_price` (059), `forge_commercial` (060), `forge_demand_inputs` (064), `forge_demand_snapshots` (065 — the one versioned store, PK `version`; also carries the `rvd-*` Runway-v-Demand push mirrors), `forge_data_status` (053 + `checked_at`/`checked_by` in 076 + the full data-key seed in 077).

### Tier B — `rdp_*` research marts (PUBLISH computes into here)

- **L0** `rdp_sources` (registry, `last_ingested_at`). **L1** `rdp_regions` (PK `slug`, +`aliases` jsonb; 051 adds 8 state rows), `rdp_metrics` (controlled vocab; 051 adds vacancy_rate_h/u, commenced_h/u, underemployment).
- **L1 raw** `rdp_raw_series` — long format, **PK (source, region_slug, metric, freq, period)**, `value numeric`. Source is in the PK so overlapping feeds coexist and marts pick the authoritative one. Secondary indexes (metric,period) and (region_slug,metric). **No FK** to regions/metrics — a typo'd slug/metric ingests silently; marts must validate.
- **L2 marts** (uniform `region_slug` PK, `payload jsonb`, `source_month`, `computed_at`, `computed_by`): `rdp_report_feed` (+`cluster`, indexed), `rdp_vr_forecast`, `rdp_runway`, `rdp_demand_score`, `rdp_civ`. Plus cluster-compat views (`rdp_report_feed_capital/_qld/_nsw/_vicwatas`, `security_invoker=on`) and `rdp_runway_config` (052).
- **Lineage:** `rdp_runs` — append-only run log (id, dataset, source_month, row_count, status, run_by, run_at). Distinct from the per-point `forge_data_status` current-state health row.

### RLS

Uniform across both tiers: **authenticated read (`using(true)`), writer-only write (`is_writer()` = dev/admin)**. `rdp_*` uses four per-command policies each; `forge_*` uses one `FOR ALL` policy — functionally equivalent. The browser holds only the anon key; the service-role key lives only in GitHub secrets. `is_writer()` itself (defined in 001_init) was not re-verified this pass. **(verify)**

**Applied-vs-pending state is not discoverable from the SQL** — there is no tracking table or marker in-repo; migrations are applied by hand via the dashboard SQL editor on the owner's schedule. Memory marks the Forge data points SHIPPED, which implies 050–065/076 are live, but that is inference, not a direct signal. **(verify)**

---

## 9. Known gaps & fragilities

**Store → mart stranding**
- ~~`forge_arrears` stranded for the 35 regional/capital reports~~ **Fixed:** `sync-arrears` (PUBLISH step 3) copies `forge_arrears` into `rdp_raw_series` metric `arrears` before `enrich-marts` runs, so a fresh S&P SPIN drop now reaches National and the regional/capital reports alike.
- Industry, population_pyramid, monthly_price, and the commercial API tabs are wired correctly (preferred-store pattern). `enrich-marts` still falls back to **stale** `rdp_raw_series ind_/pyr_` copies when a store lacks a region (e.g. Perth Mining 30.86% old vs 65.8% current REMPLAN) — but the fallback is now **surfaced**: `enrich-marts` writes `extras._sources` provenance and names the stale-fallback regions, and the Data Forge freshness banner names them too.

**Process / handoff**
- **PUBLISH is still 100% manual**, but a forgotten month is no longer silent: the monthly watchdog (`forge-watchdog.yml`, 14th) red-flags a missed GATHER or PUBLISH month, and pipeline health (GATHER / PUBLISH / watchdog) is visible in the Data Forge tool.
- ~~No pre-PUBLISH parity/readiness gate~~ **Fixed:** `publish-readiness-gate` (step 1, INPUT gate) fails the run before any mart write, and `post-publish-verify` (step 11, OUTPUT gate) fails it after — checking the marts absorbed the stores, arrears/median parity, and snapshot freshness. `build-commercial-from-rdp` now fails the run on >25% divergence instead of only warning.
- ~~"✓ No new data" can mask genuinely stale data indefinitely~~ **Fixed:** a check now expires after 40 days, so repeated real checks are required to keep a card green.
- **JSA remains laptop-bound**, but it is now driven by the registered Windows scheduled task (§3b) rather than a remembered manual command; `scripts/register-jsa-task.ps1` restores the registration if it's ever lost.

**Infra fragility**
- GitHub cron is best-effort (dropped runs already bit scorecards) and UTC cron drifts ~1h across AEST/AEDT; GATHER still has **no catch-up window**, but the watchdog (14th) now red-flags a missed month instead of it passing silently.
- Fragile non-API sources: `ingest-abs-retail` downloads the MHSI Table 19 `.xlsx` (RT SDMX flow frozen); SQM rents/vacancy are HTML scrapes with a spoofed UA — markup or UA changes break them (they do flag `status='error'` and refuse empty writes).
- ~~Two writers to `report_data_cache`~~ **Fixed:** all three "Save data" buttons are Forge-sourced, `PPReportCache.updateAllSnapshots` is neutralized dead code, and `refresh-report-cache.yml` is deprecated behind a typed confirm — a "Save data" click can no longer clobber the Forge snapshot.
- **PDF renderer `&fresh=1` is a documented no-op** on the Forge-default path (the render-reports comment was rewritten 2026-07-10 to state this is intended). Residual risk only: PDFs are exactly as fresh as the last PUBLISH — the watchdog's publish-pending check covers the lag.
- **Local-machine-only dependency.** `ingest-deferred` (arrears/JCI/pyramid/industry/mining/iron/lending) and `build-national-report`'s verify read `~/Downloads/*.xlsx`; JSA is local-only (scheduled task, §3b); `build-demand-score` is retired (see below). A real slice of the "source of truth" still depends on one person's machine, unreproducible in CI.

**Data-model risks**
- `forge_*` stores are single `latest` rows with **no history** (except `forge_demand_snapshots`) — a bad merge/upload overwrites the prior payload with no DB-level rollback; the only audit trail is `uploaded_by`/`uploaded_at` on the surviving row.
- ~~Hardcoded provenance stamps and the 2026 year ceiling~~ **Fixed:** `build-report-feed`'s year ceiling is dynamic (no 2027 cliff) and provenance stamps reflect the run month; `enrich-marts` writes `extras._sources` provenance.
- **Demand Score lineage settled (2026-07-10):** the live score computes **client-side** (`PP_DEMAND_ENGINE` in `tools/demand-score.html`) from `forge_demand_inputs` + `rdp_vr_forecast` + `rdp_runway` + `forge_cotality` + `forge_monthly_price` + rdp population. `rdp_demand_score` is **retired** — it was a write-only dead end (builder in no workflow, wrote `score:null`/`listings:null`, zero readers); `build-demand-score.mjs` carries a RETIRED header and is kept for reference only.
- **`runway-demand.html` — Forge port done 2026-07-10.** Pushed months now mirror to `forge_demand_snapshots` (`rvd-YYYY-MM`) and merge on every machine; the historical Jan-2025→May-2026 baseline stays a frozen in-file literal (it is history, not live data); localStorage remains the same-month manual override.
- **Status seeding — closed by migration 077 (pending apply, like 076).** 077 seeds a row for every data_key (ingest-written + pipeline_* heartbeats + manual points, `updated_at` pinned to epoch so never-run points read stale, not "current"), and deletes the orphan `internet_vacancies` error key. Until 077 is applied, points that have never run simply lack a row (their first real run creates it).
