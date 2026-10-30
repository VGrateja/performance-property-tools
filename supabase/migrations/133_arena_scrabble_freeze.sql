-- 133_arena_scrabble_freeze.sql
-- Scrabble has moved to Performance OS (pp-os docs/arena/scrabble-cutover-runbook.md, step 1.1).
-- Closes the hub's Scrabble: no new lobbies, joins, invites or starts, no moves, and no match
-- deletes, so the ladder history the copy carried cannot change here. The read functions and the
-- clean-up paths (cancel/leave a lobby, the expiry sweeps) stay. Every overload is covered.
-- Rollback: the same loop with `grant execute … to authenticated`.

do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'create_scrabble_lobby', 'request_join_scrabble_lobby', 'invite_to_scrabble_lobby',
         'start_scrabble_lobby', 'submit_scrabble_move', 'delete_scrabble_match')
  loop
    execute format('revoke execute on function %s from authenticated, public', f);
  end loop;
end $$;
