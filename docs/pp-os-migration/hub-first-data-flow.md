# Hub first, then the OS: the monthly data order

Hub change, 2026-11-23. The hub's Data Forge is the master for research data again. The new app (pp-os, "OS") gets
the data only by copying it from the hub, after the hub has gathered, checked, published and built Runway v Demand.

## Why

Owner, 2026-11-23: "we gather data in hub, we check the data in hub, we publish the data in hub and once runway v
demand has been approved, we push it to the tool. After that, all tools in the hub are up to date with the latest data.
That's the time we will backfill those latest data to OS. So for now, no gathering in OS, no checking in OS and no
publishing in OS."

Hub and OS data must be identical. The OS's own gathers had drifted from the hub's.

## What changed in the hub

1. **Runway v Demand records when it was built.** `scripts/build-cotality-rvd-history.mjs --write`, run for
   `--id=rvd_v3_methods` (the live row), upserts `forge_data_status` row `pipeline_rvd` once the timeline is stored.
   Other `--id` builds are trials and record nothing.
2. **The Data Forge shows the whole chain.** The home page's pipeline line now reads
   `Gather <date> → Publish <date> → Runway v Demand <date> → Sent to OS <date>`, using Sydney days. It is amber,
   "Waiting to be sent to OS", while the OS copy is older than the newest Publish or Runway v Demand build, or has
   never run. Either new row in error shows in the red "Pipeline failed" banner with its message
   (labels `RUNWAY V DEMAND`, `SENT TO OS`).
3. **Bug fix: the newest demand snapshot.** B/S Slides (Demand vs Runway slide) and Market Compare took the newest `forge_demand_snapshots` row with `version not like 'rvd-%'`. The Runway v Demand
   push on the Cotality basis writes `rvdcot-YYYY-MM` rows, whose `houses` is an array, and `rvdcot-` does not match
   `rvd-%`. So they read `rvdcot-2026-11`: the slide plotted points named "0", "1", … and Market Compare found no
   demand for any market. The filter is now `rvd%`, which leaves `cot-2026-11`. The Academy's "five dials" has the
   same one-line bug and is left alone (Academy is parked).
4. **Docs.** `docs/DATA_FORGE_PIPELINE.md` §2a sets out the order.

## The two status rows

Both live in `forge_data_status`, beside `pipeline_gather`, `pipeline_publish` and `pipeline_watchdog`.

| `data_key` | Written by | `label` | `source` | `message` |
|---|---|---|---|---|
| `pipeline_rvd` | hub, `build-cotality-rvd-history.mjs --id=rvd_v3_methods --write` | Runway v Demand built | `build-cotality-rvd-history` | `<n> months, newest <YYYY-MM>`, or the write error |
| `pipeline_os_copy` | pp-os `sync-from-hub`, production only, when the copy succeeds | Sent to OS | `pp-os sync-from-hub` | e.g. "hub publish 2026-11-20 · RvD built 2026-11-12 · 24 tables identical" |

The hub build sets `status 'ok'` and `last_run_at`, `last_ok_at`, `updated_at` to now. If its write fails it sets
`status 'error'` with the error and leaves `last_ok_at` alone, so the last good date survives (as GATHER and PUBLISH
do). The Data Forge dates each step by `last_ok_at`, so `pipeline_os_copy` should keep the same habit.

- The PUBLISH readiness gate skips every `pipeline_*` row, so neither can block a publish.
- The watchdog fails on any error row except its own, so a failed build or copy turns it red. It does not check that a
  copy happened.

## For the port

The OS does no gathering, checking or publishing while this rule stands. Its copy command is the only way data reaches
it, and it should write `pipeline_os_copy` back to the hub as above. If the OS later takes the pipeline over, the same
chain (gather, check, publish, Runway v Demand built, copied) is the thing to show on its Data Forge.

## Changelog

- 2026-11-23: built. Runway v Demand build records `pipeline_rvd`; the Data Forge shows the chain and "Waiting to be
  sent to OS"; B/S Slides and Market Compare read `cot-2026-11` again instead of `rvdcot-2026-11`. OS side: pp-os
  #1133 (spec 061, `sync-from-hub`; OS gather and publish refuse) merged to OS staging, ab07fe727.
