-- =============================================================================
-- 012_cadence_assignees.sql — Per-card assignee + dropdown list
--
-- PMs pick who the card is assigned to when filing it. The chosen person
-- receives the "card created" email (replacing the fixed CADENCE_ALIAS_EMAIL
-- fallback). Completion emails still go to the original filer.
--
-- Three additions:
--   1. cadence_assignees — small reference table populating the dropdown.
--      Seeded with vandolf@ only; admins can add more via SQL or future UI.
--   2. cadence_cards.assigned_to_email — denormalised email of the assignee
--      (text, not a FK) so the value survives if the assignee row is later
--      archived or renamed.
--   3. cadence_card_history.assigned_to_email + trigger update — captures
--      reassignments in the audit log (without this, reassignment without
--      other edits would slip past the change-detection check).
--
-- Run order: after 011_cadence_notify.sql. Idempotent.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Assignees lookup. Email is the primary key — natural identifier, matches
-- the denormalised text columns elsewhere.
-- ---------------------------------------------------------------------------
create table if not exists public.cadence_assignees (
  email          text          primary key,
  name           text,
  display_order  int           not null default 0,
  archived       boolean       not null default false,
  created_at     timestamptz   not null default now()
);

create index if not exists cadence_assignees_order_idx
  on public.cadence_assignees (display_order, name)
  where archived = false;


-- ---------------------------------------------------------------------------
-- Card column — text (not FK) so an old card retains its assigned email
-- even if that row is later archived / removed from cadence_assignees.
-- ---------------------------------------------------------------------------
alter table public.cadence_cards
  add column if not exists assigned_to_email text;

create index if not exists cadence_cards_assignee_idx
  on public.cadence_cards (assigned_to_email);


-- ---------------------------------------------------------------------------
-- Audit log column + trigger update. Without extending change-detection to
-- include assigned_to_email, a reassignment with no other edit would be
-- silently dropped by the IS NOT DISTINCT FROM guard.
-- ---------------------------------------------------------------------------
alter table public.cadence_card_history
  add column if not exists assigned_to_email text;

create or replace function public.log_cadence_card_change() returns trigger as $$
declare
  v_email text;
begin
  if (tg_op = 'UPDATE') then
    if (NEW.data              is not distinct from OLD.data
        and NEW.completed_at      is not distinct from OLD.completed_at
        and NEW.assigned_to_email is not distinct from OLD.assigned_to_email) then
      return NEW;
    end if;
  end if;

  select email into v_email from public.profiles where id = auth.uid();

  if (tg_op = 'DELETE') then
    insert into public.cadence_card_history
      (card_id, board_slug, action, data, completed_at, assigned_to_email, changed_by, changed_by_email)
    values
      (OLD.id, OLD.board_slug, 'deleted', OLD.data, OLD.completed_at, OLD.assigned_to_email, auth.uid(), v_email);
    return OLD;
  end if;

  insert into public.cadence_card_history
    (card_id, board_slug, action, data, completed_at, assigned_to_email, changed_by, changed_by_email)
  values
    (NEW.id,
     NEW.board_slug,
     case when tg_op = 'INSERT' then 'created' else 'updated' end,
     NEW.data,
     NEW.completed_at,
     NEW.assigned_to_email,
     auth.uid(),
     v_email);
  return NEW;
end;
$$ language plpgsql security definer;


-- ---------------------------------------------------------------------------
-- RLS — staff read the list, writers (dev/admin) manage it.
-- ---------------------------------------------------------------------------
alter table public.cadence_assignees enable row level security;

drop policy if exists "staff read assignees"     on public.cadence_assignees;
drop policy if exists "writers manage assignees" on public.cadence_assignees;

create policy "staff read assignees" on public.cadence_assignees
  for select to authenticated using (public.is_staff());

create policy "writers manage assignees" on public.cadence_assignees
  for all to authenticated
  using      (public.is_writer())
  with check (public.is_writer());


-- ---------------------------------------------------------------------------
-- Seed: one entry to start. Add more rows in SQL Editor as the PH Team grows.
-- ---------------------------------------------------------------------------
insert into public.cadence_assignees (email, name, display_order)
values ('vandolf@performanceproperty.com.au', 'Vandolf', 10)
on conflict (email) do nothing;
