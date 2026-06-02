-- ============================================================================
-- Performance Property — reports_state version history (safety net)
-- Migration target: Supabase Postgres (project cannojsxduvlewimwoxa)
--
-- WHY
--   reports_state is one JSONB blob per region, written by debounced
--   auto-save AND by Sync — which can overwrite the chosen buckets across
--   ALL 37 reports in a single click. Saves are last-write-wins and the
--   in-tool undo is session-only, so a bad sync or an accidental clobber
--   was previously unrecoverable. The audit log records who/when but keeps
--   no content.
--
--   This adds an automatic, server-side history of prior payloads so any
--   region can be rolled back to an earlier version. Capture is via a
--   BEFORE UPDATE trigger (can't be bypassed by the client) and is
--   throttled + pruned so it stays bounded.
--
-- HOW TO APPLY
--   Idempotent — safe to re-run. Paste into the Supabase SQL Editor and
--   Run, or apply through tooling. Matches the file-numbered convention
--   used by 001–029.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- History table — one row per archived payload version.
--   saved_at  = when the version was archived (i.e. when it was overwritten)
--   saved_by  = who authored the version being archived (OLD.updated_by)
-- ---------------------------------------------------------------------------
create table if not exists public.reports_state_history (
  id          bigint       generated always as identity primary key,
  region      text         not null,
  payload     jsonb        not null,
  saved_at    timestamptz  not null default now(),
  saved_by    uuid         references public.profiles(id)
);

create index if not exists reports_state_history_region_saved_idx
  on public.reports_state_history (region, saved_at desc);


-- ---------------------------------------------------------------------------
-- Snapshot trigger. On every reports_state UPDATE where the payload actually
-- changed, archive the OLD payload — but:
--
--   • THROTTLE: skip if this region was snapshotted within the last
--     SNAP_THROTTLE window. The debounced auto-save fires often during an
--     editing burst; without the throttle we'd store dozens of near-identical
--     versions per session. The first change in a burst captures the
--     pre-edit ("pre-burst") state, which is exactly what you want to roll
--     back to. A multi-region Sync still archives each region's pre-sync
--     state because each region's first write in the window snapshots.
--
--   • PRUNE: keep only the newest SNAP_KEEP versions per region so the table
--     stays bounded. NOTE: payloads currently embed image overlays as data
--     URLs, so versions can be large — SNAP_KEEP is deliberately modest.
--     Once image overlays move to Storage (planned), this can be raised.
--
-- SECURITY DEFINER so the insert/prune run regardless of the caller's RLS
-- (matches touch_updated_at and the other state triggers from 001).
-- ---------------------------------------------------------------------------
create or replace function public.snapshot_reports_state() returns trigger as $$
declare
  last_snap     timestamptz;
  SNAP_KEEP     constant int      := 20;                 -- versions kept per region
  SNAP_THROTTLE constant interval := interval '10 minutes';
begin
  -- No-op updates (e.g. a re-save with identical content) don't archive.
  if OLD.payload is not distinct from NEW.payload then
    return NEW;
  end if;

  select max(saved_at) into last_snap
    from public.reports_state_history
   where region = OLD.region;

  if last_snap is null or (now() - last_snap) >= SNAP_THROTTLE then
    insert into public.reports_state_history (region, payload, saved_by)
    values (OLD.region, OLD.payload, OLD.updated_by);

    delete from public.reports_state_history
     where region = OLD.region
       and id not in (
         select id
           from public.reports_state_history
          where region = OLD.region
          order by saved_at desc
          limit SNAP_KEEP
       );
  end if;

  return NEW;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_reports_state_history on public.reports_state;
create trigger trg_reports_state_history
  before update on public.reports_state
  for each row execute function public.snapshot_reports_state();


-- ---------------------------------------------------------------------------
-- Restore RPC. Copies a chosen archived version back into reports_state.
-- SECURITY DEFINER + an explicit is_writer() gate (RPCs bypass RLS, so the
-- check must be inside). Crucially it force-archives the CURRENT payload
-- first — bypassing the trigger's time throttle — so a restore is ALWAYS
-- itself undoable, even if the live state was saved seconds ago and the
-- trigger would otherwise have skipped snapshotting it.
--
-- Client usage (browser, via window.sb):
--   await window.sb.rpc('restore_reports_state',
--     { p_region: 'national', p_version_id: 1234 });
-- then re-fetch reports_state, repaint, reload.
-- ---------------------------------------------------------------------------
create or replace function public.restore_reports_state(p_region text, p_version_id bigint)
returns void as $$
declare
  v_payload jsonb;
begin
  if not public.is_writer() then
    raise exception 'not authorized';
  end if;

  select payload into v_payload
    from public.reports_state_history
   where id = p_version_id and region = p_region;

  if v_payload is null then
    raise exception 'version % not found for region %', p_version_id, p_region;
  end if;

  -- Archive current state unconditionally (no throttle) before overwrite.
  insert into public.reports_state_history (region, payload, saved_by)
  select region, payload, updated_by
    from public.reports_state
   where region = p_region;

  -- Apply the restore. The BEFORE UPDATE trigger sees a fresh history row
  -- (just inserted) so its throttle skips a duplicate snapshot.
  update public.reports_state
     set payload = v_payload
   where region = p_region;
end;
$$ language plpgsql security definer;

revoke all on function public.restore_reports_state(text, bigint) from public;
grant execute on function public.restore_reports_state(text, bigint) to authenticated;


-- ---------------------------------------------------------------------------
-- RLS. History is edit-history — only writers (dev/admin) need to read it,
-- and only for the in-tool "Version history / restore" UI. There are no
-- insert/update/delete policies on purpose: archiving + pruning happen
-- inside the SECURITY DEFINER trigger, and a restore is just a normal
-- reports_state UPDATE (already gated to writers by 001). So nothing
-- writes this table through a policy path.
-- ---------------------------------------------------------------------------
alter table public.reports_state_history enable row level security;

drop policy if exists "writers read reports history" on public.reports_state_history;
create policy "writers read reports history"
  on public.reports_state_history
  for select to authenticated
  using (public.is_writer());


-- Verify with:
--   select region, count(*) , max(saved_at)
--     from public.reports_state_history group by region order by region;
