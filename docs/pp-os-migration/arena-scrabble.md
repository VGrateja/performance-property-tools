# Arena Scrabble — moved to pp-os

The hub's Scrabble (`tools/arena-scrabble.html`) is closed. pp-os Scrabble (`/arena/scrabble`, PRs #633–#637)
is the live game; its cutover runbook is pp-os `docs/arena/scrabble-cutover-runbook.md`.

- **History carried:** every ranked match since the 2026-08-14 ladder reset, copied by the Worker's
  `backfill --only=arena-scrabble-matches`; the pp-os ladder is recomputed from those results.
- **Closed here (migration 133):** creating, joining, inviting to and starting lobbies, moves, and match
  deletes are revoked from signed-in staff. Reads and the clean-up paths stay.
- **The page** shows "Scrabble has moved to Performance OS" with a link.

## Changelog

- 2026-10-30 — moved to pp-os: hub matches copied, hub play closed (migration 133), moved banner (Van)
