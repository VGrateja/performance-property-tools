# Performance Academy — feature note for the pp-os port

A Vault tool (`tools/academy.html`, registry key `academy`): the staff learning tool. A shelf of "videotape" volumes,
each a set of chapters made of scenes: text, infographics, playable charts that pause on beats, and quizzes. It teaches
how the team reads runway, demand and the clocks from the live data. This note records what a port must copy. It is not
a full description of the tool.

Shipped 2026-11-09 visible to Van only (he unticks it for every group); the product is not released to staff.

## Data (all behind auth; nothing in the repo)

| Table (mig 121) | What |
|---|---|
| `academy_volumes` | the shelf: slug, title, cover hints, `generated` for region volumes |
| `academy_chapters` | `scenes` jsonb per chapter (shapes listed in mig 121's header) |
| `academy_glossary` | terms linked from scenes as `[[term]]` |
| `academy_decisions` | the decisions ledger |
| `academy_progress` | per-user progress and quiz scores, private to that user |

Read: any signed-in user. Write: `is_writer()`; progress: the user's own rows only. The course narrative is proprietary:
it is seeded by a scratch script from local JSON and never committed (this repo is public).

## Maths

`shared/academy-math.js` is a verbatim copy of the Demand Score engine plus the clock and quadrant tables. A port must
keep it equal to the Demand Score tool's own maths (the hub proves parity per market with a scratch check), or the
lessons will show numbers the advisers' tools do not.

## For the port

- Copy the five tables and their content from the hub database; keep the content out of the repo.
- Charts in chart-play scenes read the same research series as the reports.

## Changelog

- 2026-11-09 — Committed to the hub (tool, `shared/academy-math.js`, mig 121 already applied), registered in the Vault
  with a search entry and a window card; access limited to Van through the Groups panel.
