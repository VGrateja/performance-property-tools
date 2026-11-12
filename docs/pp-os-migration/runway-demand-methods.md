# Runway v Demand: Demand Method switch (Current / A / B)

Hub only. Van, 2026-11-12: "this is for Hub only dont do it in OS". Not to be ported unless Van asks.

## What it is

Saskia's concern: the Demand Score's benchmark moves every month with the median listings per 1,000 across all markets,
so a market-wide (seasonal) listings rise lifts nearly every score even when the market's own inputs got worse
(Brisbane houses Oct → Nov 2026: own grade 88 → 87, score 54 → 61).

A **Demand Method** dropdown on Runway v Demand re-plots every month on one of three scores:

| Option | Field | Benchmark listings per 1,000 |
|---|---|---|
| Current (default) | `ds` | that month's median across all markets |
| Option A: fixed benchmark | `dsA` | one constant: the average monthly median, Jan 2025 – Nov 2026 (houses 3.569, units 4.474), stored once |
| Option B: season-adjusted | `dsB` | the same constant, after each market's listings are rescaled by (constant ÷ that month's median) |

Embeds (decks) always show Current and hide the dropdown. The choice is not remembered between visits.

## Where

| What | Path |
|---|---|
| Builder: A/B, the fixed constant (`benchFixed`), `--id=<row>` | `scripts/build-cotality-rvd-history.mjs` (section 4a) |
| Timeline the page reads | `forge_cotality` id `rvd_v3_methods` (`rvd_v3` left as it was) |
| Page | `tools/runway-demand.html` (`rvdDsField`, `rvdDsOf`, `#dsMethodSelect`) |

A and B are anchored on the stored Current score: `dsA = ds + (A − Current re-scored today)`, so switching shows only the
method's effect, never the VR-projection drift between builds.

Monthly build from now on: `node scripts/build-cotality-rvd-history.mjs --listings=rea --id=rvd_v3_methods --write`.
The builder now reads vacancy and rent from `cot_rentvacancy_history` wherever the Downloads exports do not carry a
month (the reason Nov 2026 would not build: no rent 36 months back once the historic export left Downloads).

## Changelog

- 2026-11-12: built. Nov 2026 added; A and B computed for Jan 2025 – Nov 2026 (1,656 market-months). Current matches
  `rvd_v3` exactly (0 of 1,584 differ).
