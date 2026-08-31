-- 119_clock_state_history.sql
--
-- Version history for the National Property Clock, so the tool's audit log
-- entries can become CLICKABLE ("show me the clock as it was at that save,
-- and which regions moved").
--
-- WHY A DB TRIGGER
--   public.clock_state is a single row (id=1, payload jsonb) holding only the
--   LATEST state — every save overwrote the previous one, so the audit log
--   (payload.auditLog, capped 100) recorded who/when but kept no content.
--   Capture happens server-side so a save is recorded no matter which browser
--   or which deployed version of property-clock.html wrote it, and so no
--   client bug can skip it.
--
-- THE JOIN KEY (used by the tool's audit modal)
--   saveState() appends its audit entry INTO the payload and then updates the
--   row, so every archived payload carries, as the LAST element of its
--   auditLog, the entry describing that very save:
--       payload->'auditLog'->-1->>'ts'  ==  the audit entry's ts
--   Audit entries older than this migration have no matching row; the modal
--   shows them as "no snapshot". Offline Saves never touch clock_state, so
--   they never get a row either (by design).
--
-- HOW TO APPLY (never `supabase db push` against this project)
--   supabase db query --linked -f supabase/migrations/119_clock_state_history.sql
--   Idempotent — safe to re-run.


-- ---------------------------------------------------------------------------
-- History table — one row per saved payload version (the NEW payload, i.e.
-- the state as it looked after that save; the tool diffs a row against the
-- row before it to get "what moved").
-- ---------------------------------------------------------------------------
create table if not exists public.clock_state_history (
  id        bigserial    primary key,
  saved_at  timestamptz  not null default now(),
  payload   jsonb        not null
);

create index if not exists clock_state_history_saved_at_idx
  on public.clock_state_history (saved_at desc);


-- ---------------------------------------------------------------------------
-- Capture trigger. AFTER UPDATE, only when the payload actually changed
-- (the WHEN clause below), archive the NEW payload and prune.
--
-- No time throttle here (unlike reports_state, mig 030): the clock has no
-- debounced auto-save — every row is one deliberate click of Save — so each
-- write is worth keeping.
--
-- PRUNE: keep the newest SNAP_KEEP rows. The payload is ~68 KB today (region
-- lists + partitions + any image overlays as data URLs), so 200 rows is
-- ~14 MB — bounded, and deeper than the 100-entry audit log the UI lists.
--
-- SECURITY DEFINER (+ pinned search_path) so the insert/prune run regardless
-- of the caller's RLS — the table has no write policies at all, this function
-- is its only writer.
-- ---------------------------------------------------------------------------
create or replace function public.snapshot_clock_state() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  SNAP_KEEP constant int := 200;
begin
  insert into public.clock_state_history (payload) values (NEW.payload);

  delete from public.clock_state_history
   where id not in (
     select id
       from public.clock_state_history
      order by id desc
      limit SNAP_KEEP
   );

  return null;   -- AFTER trigger: return value is ignored
end;
$$;

-- Postgres grants EXECUTE to PUBLIC on creation and anon inherits it, so the
-- security advisor re-flags any new SECURITY DEFINER function (see mig 115).
-- Nothing calls this by name — it only ever runs as a trigger — so revoke it
-- from callers entirely. Postgres checks EXECUTE when the trigger is CREATED,
-- not when it fires (verified against a throwaway definer-trigger table with
-- EXECUTE revoked: `set role authenticated` + insert still wrote the log row),
-- so saves from the browser are unaffected. Don't "fix" this by re-granting.
revoke execute on function public.snapshot_clock_state() from public;
revoke execute on function public.snapshot_clock_state() from anon;
revoke execute on function public.snapshot_clock_state() from authenticated;
grant  execute on function public.snapshot_clock_state() to service_role;

drop trigger if exists trg_clock_state_history on public.clock_state;
create trigger trg_clock_state_history
  after update on public.clock_state
  for each row
  when (OLD.payload is distinct from NEW.payload)
  execute function public.snapshot_clock_state();


-- ---------------------------------------------------------------------------
-- RLS. This is edit history for the dev/admin-only audit modal, so SELECT is
-- writers-only. There are NO insert/update/delete policies on purpose: the
-- SECURITY DEFINER trigger above is the only writer, and nothing should ever
-- be able to rewrite history through a policy path.
-- ---------------------------------------------------------------------------
alter table public.clock_state_history enable row level security;

drop policy if exists "writers read clock history" on public.clock_state_history;
create policy "writers read clock history"
  on public.clock_state_history
  for select to authenticated
  using (public.is_writer());


-- ---------------------------------------------------------------------------
-- Seed the current payload as version 1 so the first real save already has a
-- base to diff against. Only when the table is empty, so re-running this file
-- never duplicates it.
-- ---------------------------------------------------------------------------
insert into public.clock_state_history (payload, saved_at)
select cs.payload, cs.updated_at
  from public.clock_state cs
 where cs.id = 1
   and not exists (select 1 from public.clock_state_history);


-- Verify with:
--   select id, saved_at, payload->'auditLog'->-1->>'user' as saved_by,
--          payload->'auditLog'->-1->>'ts'   as audit_ts,
--          pg_column_size(payload)          as bytes
--     from public.clock_state_history order by id desc limit 10;
