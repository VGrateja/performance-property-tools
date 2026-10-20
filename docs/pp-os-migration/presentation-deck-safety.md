# Presentation deck safety — save check and nightly backups (hub)

Feature note for the pp-os migration. Hub files: `tools/presentation.html`,
`supabase/migrations/128_presentation_deck_backups.sql`, `.github/workflows/backup-decks.yml`,
`scripts/restore-deck-backup.mjs`, `scripts/gc-presentation-images.mjs`.

## Why

A deck row (`presentation_decks.payload`) is written as one block: the slide list, every slide's
overlays and every slide's background. Until 2026-10-20 a save was "last write wins", so a browser
holding an older copy (a second tab, the offline copy, a stale local mirror kept at hydrate because the
deck was edited before the cloud load finished) overwrote newer work just by saving. On 2026-10-20 the
"Stage 4: Performance Property Strategy Consultation" deck lost three slides, got a July picture back on
slide 21 and had 20 backgrounds land on the wrong slides this way (repaired by hand from a 13 Oct copy).
The July 2026 wipe of the same deck had the same root.

## 1. Save check (`tools/presentation.html`)

- `_persistDeckRow` updates with `.eq('id', rowId).eq('updated_at', deck._updatedAt)`: the write lands only
  if the row is still the version this tab loaded. Zero rows back = the deck moved on elsewhere: nothing is
  written, the deck is flagged `_saveConflict` (every later save of it is refused without a request), the
  save status turns to error and a toast tells the user to reload. Not retried — a reload brings in the
  current version and clears the flag.
- A deck with no loaded `updated_at` is refused the same way (cannot prove it is current).
- `_setDeckLocked` and `assignDeckToUser` now take the row's new `updated_at` from their own update, so a
  lock or an assignment in this tab does not make this tab's next edit look stale.
- The existing anti-wipe guard (refuse a save with empty overlays over a populated row) stays.
- Verified with a harness that drives the real page against a fake Supabase client
  (`scratch/deck-save-check/test.mjs`, 5/5).

## 2. Nightly backups, 7 days rolling (mig 128)

- `public.presentation_deck_backups` — `(slot 1..7 = ISO weekday in Sydney time, deck_id)` primary key,
  a full copy of each deck row (title, owner, created_by, visibility, locked, payload, the row's
  updated_at) and `backed_up_at`. No FK to `presentation_decks`, so a deleted deck's backups survive.
- `public.backup_presentation_decks()` (security definer, execute granted to `service_role` only): deletes
  today's slot and copies every deck into it, in one transaction; refuses (raises) when the deck table is
  empty so a bad night never empties a slot. Returns `{slot, decks}`.
- RLS on; SELECT for the dev tier only; no write policies.
- `.github/workflows/backup-decks.yml` calls it daily at 12:00 UTC (11:00pm AEDT / 10:00pm AEST) and on
  manual dispatch. Size: all 17 decks ≈ 4.8 MB a night, ≈ 34 MB for the week.
- Restore: `node scripts/restore-deck-backup.mjs` (list) / `--deck "<title or id>" --day mon` (dry run) /
  `--write` (saves the current row to `scratch/deck-restores/` first; guarded on `updated_at`; re-creates a
  deleted deck with its original id and owner). Tested end-to-end on a throwaway deck.
- `scripts/gc-presentation-images.mjs` counts images referenced by backups as in use, so restoring a
  backup never brings back a blank picture.

## pp-os

pp-os Presentations has its own deck tables and save path. The mirror owed: (1) confirm its deck save is
not last-write-wins — an `updated_at` (or version) precondition on the update with a "reload" refusal, as
here; (2) a 7-night deck backup in the Worker (pg-boss schedule, `tz: 'Australia/Sydney'`) with a restore
command, if the owner wants the same protection there.

## Changelog

- 2026-10-20 — Save check, nightly 7-day deck backups (mig 128 applied; first backup taken: Tuesday slot,
  17 decks), restore script, image GC counts backups. (Van: "build the save check and also can we build a
  backup for the decks … auto backup every end of day"; 7 days chosen over 1.)
