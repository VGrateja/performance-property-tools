-- =============================================================================
-- 007_arena_chess_points_security_invoker.sql
--
-- Clears Supabase Advisor's CRITICAL "Security Definer View" warning on
-- public.arena_chess_points. By default, Postgres views run with the
-- privileges of the view's owner (the postgres superuser in Supabase),
-- which lets the view bypass row level security on the underlying table.
-- For arena_chess_points this isn't a real data leak — arena_chess_matches
-- already has an "authenticated read all" RLS policy — but the advisor is
-- right that views should run with the caller's privileges so RLS keeps
-- working as written.
--
-- Postgres 15+ supports `security_invoker = on` on views, which flips the
-- behaviour to "run as the querying user". That's what we want.
--
-- Run order: after 006_*.sql.
-- =============================================================================

alter view public.arena_chess_points set (security_invoker = on);
