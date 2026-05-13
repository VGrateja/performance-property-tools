-- =============================================================================
-- 010_cadence_history.sql — Audit log for cadence_cards
--
-- One row per change to a card (create / update / delete). Captures the full
-- data jsonb at the time of the change plus completed_at, who made the change,
-- and when. This is an append-only audit trail for compliance / dispute
-- resolution — never edited or deleted by application code.
--
-- card_id is NOT a foreign key on purpose: when a writer hard-deletes a card,
-- we want the history to survive (DELETE row included). The deletion event
-- itself proves the card existed.
--
-- Why a trigger and not just app-level logging:
--   - Captures every change including direct SQL edits an admin might run
--   - Cannot be bypassed by buggy/stale UI code
--   - SECURITY DEFINER means RLS doesn't block the insert
--
-- Run order: after 009_cadence.sql. Idempotent — safe to re-run.
-- =============================================================================

create table if not exists public.cadence_card_history (
  id                uuid          primary key default gen_random_uuid(),
  card_id           uuid          not null,                     -- no FK; history outlives the card
  board_slug        text          not null,
  action            text          not null check (action in ('created','updated','deleted')),
  data              jsonb         not null,                     -- snapshot of cadence_cards.data at the time
  completed_at      timestamptz,                                -- snapshot of cadence_cards.completed_at
  changed_at        timestamptz   not null default now(),
  changed_by        uuid          references public.profiles(id),
  changed_by_email  text
);

create index if not exists cadence_history_card_idx    on public.cadence_card_history (card_id, changed_at desc);
create index if not exists cadence_history_board_idx   on public.cadence_card_history (board_slug, changed_at desc);
create index if not exists cadence_history_changed_idx on public.cadence_card_history (changed_at desc);


-- ---------------------------------------------------------------------------
-- Trigger function — logs every change. UPDATE events are skipped when the
-- only thing that changed was the touch-trigger's updated_at/updated_by
-- (i.e. data + completed_at are both unchanged), to keep the log meaningful.
-- ---------------------------------------------------------------------------
create or replace function public.log_cadence_card_change() returns trigger as $$
declare
  v_email text;
begin
  /* For UPDATEs: only log when something material actually changed. The
     touch trigger fires on every save, so the audit log would otherwise
     fill with no-op edits. */
  if (tg_op = 'UPDATE') then
    if (NEW.data is not distinct from OLD.data
        and NEW.completed_at is not distinct from OLD.completed_at) then
      return NEW;
    end if;
  end if;

  /* Resolve the actor's email once. profiles.email is the canonical lookup. */
  select email into v_email from public.profiles where id = auth.uid();

  if (tg_op = 'DELETE') then
    insert into public.cadence_card_history
      (card_id, board_slug, action, data, completed_at, changed_by, changed_by_email)
    values
      (OLD.id, OLD.board_slug, 'deleted', OLD.data, OLD.completed_at, auth.uid(), v_email);
    return OLD;
  end if;

  insert into public.cadence_card_history
    (card_id, board_slug, action, data, completed_at, changed_by, changed_by_email)
  values
    (NEW.id,
     NEW.board_slug,
     case when tg_op = 'INSERT' then 'created' else 'updated' end,
     NEW.data,
     NEW.completed_at,
     auth.uid(),
     v_email);
  return NEW;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_cadence_cards_history on public.cadence_cards;
create trigger trg_cadence_cards_history
  after insert or update or delete on public.cadence_cards
  for each row execute function public.log_cadence_card_change();


-- ---------------------------------------------------------------------------
-- RLS — staff read only. Nothing inserts directly; the trigger uses
-- SECURITY DEFINER to bypass the table's RLS on its inserts.
-- ---------------------------------------------------------------------------
alter table public.cadence_card_history enable row level security;

drop policy if exists "staff read history" on public.cadence_card_history;
create policy "staff read history" on public.cadence_card_history
  for select to authenticated using (public.is_staff());

-- No INSERT/UPDATE/DELETE policies — only the trigger writes here.
