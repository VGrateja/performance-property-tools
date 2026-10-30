-- 132_arena_sudoku_freeze.sql
-- Sudoku has moved to Performance OS (pp-os docs/arena/sudoku-cutover-runbook.md, step 5).
-- Freezes the hub's Sudoku before the one-time history copy: every function that starts,
-- changes or finishes an attempt stops being callable by signed-in staff. The read
-- functions (overview, boards, ranking, stats) stay, so the page still shows the history.
-- Every overload of each name is covered. Rollback: the same loop with `grant execute … to authenticated`.

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
         'sudoku_complete_tutorial', 'sudoku_start', 'sudoku_restart', 'sudoku_save',
         'sudoku_check', 'sudoku_hint', 'sudoku_submit', 'sudoku_pause', 'sudoku_resume',
         'sudoku_heartbeat', 'sudoku_daily_start', 'sudoku_sprint_start')
  loop
    execute format('revoke execute on function %s from authenticated, public', f);
  end loop;
end $$;
