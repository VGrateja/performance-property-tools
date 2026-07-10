-- =============================================================================
-- 076_forge_checked_at.sql
-- "No new data" check stamp for Data Forge.
--
-- The user reviews every data point on the 10th of the month. When a source has
-- NO new data and the current copy is already the latest, there's nothing to
-- upload — but the freshness clock (days since last refresh) would keep climbing
-- and eventually show the point as "aging" / "stale" even though it's verified
-- current. These columns record that manual "checked, nothing new" confirmation
-- WITHOUT touching the data or its real update timestamp, so the UI can reset the
-- age clock to the check date.
--
--   checked_at — last time a writer confirmed "no new data" for this point
--   checked_by — who confirmed it (email)
-- =============================================================================

alter table forge_data_status
  add column if not exists checked_at timestamptz,
  add column if not exists checked_by text;
