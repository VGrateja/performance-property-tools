# Forge Hardening Prompt

*Paste this into Fable 5 (Ultracode) to harden and stabilize the Data Forge pipeline. It is a standalone brief — you do not need any other document to act on it.*

---

## MISSION

Make **Data Forge the single, reliable source of truth** for the Performance Property Analytics Hub, and guarantee the monthly flow works end-to-end:

> **GATHER (10th) → owner confirms everything is current → manual PUBLISH → correct data propagates to every consumer tool.**

"Hardened and stabilized" means: no stale paths, no **stranded data** (a manual data point that updates one report but silently not another), no consumer reading last month's mart without an alarm, and a single confirm-then-publish flow with a real readiness gate. You are improving reliability and closing gaps — **not** redesigning the architecture.

---

## CURRENT ARCHITECTURE (recap — VERIFY against the live repo; do not trust this blindly)

Two GitHub Actions stages, both writing Supabase, both keyed on `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (GitHub secrets only):

- **GATHER** — `.github/workflows/forge-ingests.yml`, cron `0 15 9 * *` (= 15:00 UTC on the 9th = ~1am AEST on the 10th; drifts ~1h under AEDT) + manual. 21 API ingests write `forge_*` JSONB stores and `rdp_raw_series` (long format, upsert-only, `onConflict: source,region_slug,metric,freq,period`). One source, **JSA job-creation**, must run locally (`node scripts/ingest-jsa-jobcreation.mjs --write`) because jobsandskills.gov.au blocks CI runner IPs at the network layer. Cotality, Arrears, Industry-REMPLAN, and REA listings are collected manually in the Data Forge UI (`tools/data-forge.html`). GATHER does **not** touch the marts.
- **PUBLISH** — `.github/workflows/forge-publish.yml`, **manual (`workflow_dispatch`) only**, single `set -e` bash step, strict order:
  `sync-cotality-medians → build-report-feed → build-national-report → enrich-marts → rebuild-vr-forecast → build-runway → build-commercial-from-rdp → refresh-snapshots`.
  Order is load-bearing: `sync-cotality` must precede `build-report-feed`; `build-report-feed`/`build-national` upsert `payload:{years}` which **replaces the payload and wipes `extras`**, so `enrich-marts` must run after both to restore `payload.extras`. PUBLISH fetches no external data — it only reshapes Forge, so it is safe to re-run.
- **Marts the tools read:** `rdp_report_feed` (+ cluster views), `rdp_vr_forecast`, `rdp_runway`, `forge_commercial`, and `report_data_cache` (presentation snapshot). Online/National/Commercial reports **default to Forge** unless `?src=live`/`legacy`; Runway Workbook, VR Projection, and Demand Score are **Forge-native** (no toggle). `runway-demand.html` is **not** wired to Forge (hardcoded `RAW` + localStorage).
- **Freshness** in the Data Forge UI: `forge_data_status` health rows; thresholds current ≤40d / aging ≤75d / stale >75d; plus a migration-076 "✓ No new data" check that stamps `checked_at` (turns a card green without changing data).
- **Security:** RLS everywhere — authenticated read (`using(true)`), `is_writer()` (dev/admin) write. Browser holds only the anon key.

**Known problem areas the audit already flagged** (confirm each still holds before acting): `forge_arrears` reaches only the National report, not the 35 regional/capital reports; no pre-PUBLISH parity gate; PUBLISH is manual with no alarm if skipped; two writers to `report_data_cache`; Demand Score runs off a manual seed lineage; hardcoded `source_month` stamps and a **2026 year ceiling** in `build-report-feed`; enrich silently falls back to stale `rdp_raw_series ind_/pyr_` copies; only `population`/`cotality` seed a `forge_data_status` row.

---

## PHASE 0 — VERIFY FIRST (before changing anything)

Read these files and confirm the recap above still matches reality. The recap may be stale.

- `.github/workflows/forge-ingests.yml`, `.github/workflows/forge-publish.yml` — trigger, order, `set -e`.
- `scripts/enrich-marts.mjs` — where it reads `arrears` (expected: `rdp_raw_series` metric `arrears`, ~line 189) and its industry/pyramid preferred-store-else-stale fallback.
- `scripts/ingest-deferred.mjs` — confirm it is the only writer of the `arrears` metric (source `apra`, from local Data Dump xlsx, ~line 66).
- `scripts/sync-cotality-medians-to-rdp.mjs` — the template pattern for a store→mart sync you will mirror for arrears.
- `scripts/build-report-feed.mjs` — the `payload:{years}` upsert that wipes extras (~line 71), the hardcoded `source_month`, and the **2026 year ceiling** (~line 41).
- `tools/data-forge.html` — `freshInfo` thresholds (~683–693) and `markNoNewData` (~840–852).
- `tools/national-report.html` (`forge_arrears` read ~2234), `tools/online-reports.html` (`PP_FORGE_SRC` ~5219), `shared/report-cache.js` (the second `report_data_cache` writer).

For each objective below, first re-confirm the gap exists, then act.

---

## CONSTRAINTS (do not violate)

- **Static, no-build app.** Edit file → commit → GitHub Pages serves it. No bundler, no framework build step. Keep everything vanilla / inline-loadable.
- **RLS is the security model.** Never make client-side gating the real guard (UI feedback is fine; writes must stay RLS-protected by `is_writer()`). **Never** put a service-role key in the browser or any committed file.
- **Upsert-only / preserve history on ingest.** Never delete rows the source no longer covers; widest-window upserts. Match the existing `onConflict: source,region_slug,metric,freq,period` pattern.
- **Do not break the live tools.** Reports / Runway / VR / Demand Score must keep rendering. Verify graph-by-graph after any change.
- **Keep changes reviewable** — small, incremental commits, one concern each.
- **Cache-bust shared assets** after editing anything under `shared/`: run `node scripts/stamp-shared-assets.mjs` before committing. The owner checks the **offline** copy, which must match online.
- **The DB was deliberately isolated; cutover is deliberate.** Do not wire a new consumer to Forge or flip a default without the owner's go-ahead or a documented, opt-in flag.
- **The owner applies migrations on their own schedule.** Ship migrations as new numbered SQL files; do not assume they're applied, and never prompt "apply to Supabase now?".
- **Never `git push` (or open a PR) without an explicit go-ahead** ("push it" / "ship it" / "go live"). Commit locally so the owner can preview offline first.

---

## HARDENING OBJECTIVES (verify each still applies, then propose an order in your plan)

1. **Close every `forge_* store → rdp_* mart` gap so each manual/JSONB data point reaches *every* tool that charts it, with the same lineage for national and regional/capital.**
   - **Arrears is the priority case.** The manual S&P SPIN drop lands in `forge_arrears` and reaches only the National report; the regional/capital reports read arrears from `rdp_raw_series` metric `arrears` (Data Dump/APRA, via `ingest-deferred`). Add a sync step that **mirrors `sync-cotality-medians-to-rdp.mjs`**: read `forge_arrears` → upsert into the same `rdp_raw_series` `arrears` metric that `enrich-marts` consumes (upsert-only, preserve history). **Position it before `enrich-marts` (step 4)** in PUBLISH — the natural slot is right after `sync-cotality-medians`. Then confirm National and every regional/capital report show identical arrears.
   - Audit `forge_industry`, `forge_population_pyramid`, `forge_monthly_price`, and any other manual store for the same stranding, and eliminate the silent stale-copy fallback (or at least surface a visible flag when enrich falls back to `rdp_raw_series ind_/pyr_`).

2. **Audit + finish the cutover.** Confirm every consumer reads Forge by default, or document why not. Resolve `runway-demand.html` (still hardcoded `RAW` + localStorage): either migrate it to the Forge-native Demand Score numbers or explicitly mark it legacy so decks don't diverge. Fix the stale header comments in commercial/national that claim the adapter is `?src=forge`-only.

3. **Add a pre-PUBLISH validation / parity / readiness gate that fails (not warns).** PUBLISH must refuse to ship stale, empty, or wildly-diverging data. Bring the parity checks into the CI path — they currently skip when a local `~/Downloads` xlsx is absent (`build-national-report`), aren't wired in at all (`verify-report-feed`), or only print warnings (`build-commercial-from-rdp`). The gate must detect a **store→mart mismatch** (something the staleness-only freshness clock structurally cannot), and a failed gate must **abort the publish**.

4. **Make freshness/coverage visible and make the owner's confirmation meaningful.** The freshness clock measures *when a source refreshed*, not *whether the mart reflects the store*, and "✓ No new data" can turn a red flag green with nothing changed. Add coverage/parity signals; flag or block publish if any point is stale or was merely "checked" past a threshold. Ensure **all ~10 data points seed a `forge_data_status` row** (only `population`/`cotality` are seeded today).

5. **Improve monthly-run reliability.** GitHub cron is best-effort with no catch-up and drifts across AEST/AEDT; GATHER can silently miss a month. Add catch-up / late-run detection and a **visible alarm** when GATHER or PUBLISH hasn't run for the current month. Keep the fragile non-API sources (MHSI `.xlsx` download, SQM scrapes) refusing empty writes, and surface their errors clearly.

6. **Guarantee `rdp_runs` logs every step with a real run-month provenance stamp.** Replace the hardcoded `source_month:'Data Dump 2026-06'` (and `'Runway recompute 2026-06'`) with the actual run month. Fix the `build-report-feed` **2026 year ceiling** so 2027+ annual rows build without a code edit.

7. **Handle manual / subscription-only sources gracefully.** JSA (local-only), the manual Commercial tabs (CBRE/Colliers/Savills/Statista/ports), and `building-price-indices` (holds transformed $, not a raw index — a re-seed must re-apply the transform) age with no signal and can silently corrupt a report. Give them freshness/coverage tracking and guardrails.

8. **Resolve the Demand Score old-vs-new source question.** The live tool reads manually-seeded `forge_demand_*`; `build-demand-score.mjs` (local xlsx, `score:null, listings:null`) is in neither workflow. Either bring Demand Score onto the central pipeline, or document the manual lineage as intentional and make its freshness visible.

9. **Single-writer discipline for `report_data_cache`.** Two writers with different sources (Forge-sourced `refresh-snapshots-from-forge` vs the Apps-Script "Save data" buttons / `PPReportCache.updateAllSnapshots`) can clobber each other. Make Forge the authoritative writer, or prevent the legacy path from overwriting Forge snapshots. Note this also un-breaks the PDF renderer (`render-reports.mjs` `&fresh=1` is a no-op under the Forge default — PDFs render the last-PUBLISHed mart).

---

## HOW TO WORK (you are in Ultracode — use it)

- **Verify before you touch anything.** Fan out to audit the pipeline, and **adversarially verify** each finding against the actual repo (read the file; trace the script's read/write) before treating it as true.
- **Work incrementally** — one consumer or one data point per commit. No sweeping rewrites.
- **Dry-run + parity-check every data change.** Before any `--write`, run in dry mode, diff against current mart values, and confirm numbers match the source. Preserve history — upsert, never delete.
- **Verify graph-by-graph** that every affected tool still renders (Online/National/Commercial reports, Runway, VR, Demand Score) after each change. The owner compares side-by-side.
- **Respect ordering.** If you touch PUBLISH, preserve the load-bearing order (sync-cotality → build-report-feed → build-national → enrich-marts → rebuild-vr → build-runway → build-commercial → refresh-snapshots) and re-confirm no step wipes another's output.
- **Propose a plan and get confirmation before any large change** or any default/cutover change. Ship migrations as new numbered SQL files; cache-bust shared assets; commit locally and wait for an explicit go-ahead before pushing.

---

## ACCEPTANCE CRITERIA (definition of "hardened + stabilized")

1. **Every data point has a verified path to every tool that uses it — no store→mart stranding.** Specifically, a manual arrears drop updates the National *and* all regional/capital reports identically; the same holds for every other manual/JSONB store, with no silent fallback to a stale copy.
2. **One confirm → publish flow with a readiness gate.** PUBLISH cannot ship stale, empty, or wildly-diverging data; the gate detects store↔mart mismatches and **fails** (not warns). The owner's confirmation is meaningful and enforced.
3. **Runs are reproducible, logged, and idempotent.** Every ingest and every PUBLISH step writes an `rdp_runs` row with an accurate run-month stamp; re-running PUBLISH is safe; no step silently depends on one person's `~/Downloads` folder without a documented fallback.
4. **No consumer reads stale or old-source data.** Every consumer either reads Forge by default or is explicitly documented as legacy; `report_data_cache` has a single authoritative (Forge) writer; PDFs and snapshots reflect the last successful PUBLISH; and a **visible alarm** fires if GATHER or PUBLISH was missed for the month.
5. **Freshness/coverage is visible and honest** — every data point seeds a status row; "checked" cannot indefinitely mask genuinely stale data; latent cliffs (2026 year ceiling, hardcoded labels) are removed.
6. **Security and constraints intact** — RLS `is_writer()` still gates all writes, no service key in the browser, static-app compatibility preserved, shared assets cache-busted, and nothing pushed without the owner's explicit go-ahead.
