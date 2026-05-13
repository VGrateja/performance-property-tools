-- =============================================================================
-- 011_cadence_notify.sql — Per-board email notification toggle
--
-- Adds a single boolean column to cadence_boards. The Edge Function
-- (notify-cadence) reads this flag and skips sending if false. Defaults
-- to true so existing boards keep emailing once Phase 3 ships.
--
-- Why a column and not a key inside the schema jsonb:
--   - schema describes fields; this is board-level meta
--   - queryable (e.g. "select count(*) where notify = false")
--   - one less special-case in the admin UI
--
-- Run order: after 010_cadence_history.sql. Idempotent.
-- =============================================================================

alter table public.cadence_boards
  add column if not exists notify boolean not null default true;
