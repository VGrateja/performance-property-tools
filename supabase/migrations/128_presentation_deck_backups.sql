-- ===========================================================================
-- 128 — Nightly presentation deck backups, kept for 7 days (Van 2026-10-20)
-- ===========================================================================
-- Every night a copy of every presentation_decks row goes into the slot for
-- that day of the week (1 = Monday … 7 = Sunday, Sydney time). Each slot is
-- overwritten a week later, so the table always holds the last 7 days and
-- never grows (all 17 decks are ~5 MB, so 7 copies are ~35 MB).
--
-- Why: a deck is saved as one block, and a browser holding an older copy can
-- overwrite newer work (the Stage 4 deck lost slides and had its backgrounds
-- scrambled this way on 2026-10-20). Supabase's own daily backup restores the
-- WHOLE database; this lets one deck be put back on its own.
--
-- No foreign key to presentation_decks on purpose: a deck deleted by mistake
-- must keep its backups (it stays in the other slots for up to a week).
--
-- Written only by backup_presentation_decks() (service role, nightly GitHub
-- Action backup-decks.yml); read only by the developer tier. Restore with
-- scripts/restore-deck-backup.mjs.
-- ===========================================================================

create table if not exists public.presentation_deck_backups (
  slot             smallint     not null check (slot between 1 and 7),  -- ISO weekday, Sydney time
  deck_id          uuid         not null,                               -- presentation_decks.id
  title            text,
  owner_id         uuid,
  created_by       uuid,
  visibility       text,
  locked           boolean,
  payload          jsonb        not null,
  deck_updated_at  timestamptz,                                         -- the row's updated_at when copied
  backed_up_at     timestamptz  not null default now(),
  primary key (slot, deck_id)
);

alter table public.presentation_deck_backups enable row level security;

drop policy if exists "dev reads deck backups" on public.presentation_deck_backups;
create policy "dev reads deck backups" on public.presentation_deck_backups
  for select to authenticated
  using (public.current_tier() = 'dev');
-- no insert / update / delete policies: only the service role writes.

-- Copy every deck into today's slot, replacing what that slot held a week ago.
-- One statement pair in one transaction, so a slot is never half-written.
create or replace function public.backup_presentation_decks()
returns table (slot smallint, decks integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  s smallint := extract(isodow from (now() at time zone 'Australia/Sydney'))::smallint;
  n integer;
begin
  -- an empty deck table is a read problem or an accident, not a night to copy:
  -- refuse, so the slot keeps last week's copy instead of being emptied
  if not exists (select 1 from public.presentation_decks) then
    raise exception 'presentation_decks is empty — backup refused, slot % left as it was', s;
  end if;
  delete from public.presentation_deck_backups b where b.slot = s;
  insert into public.presentation_deck_backups
    (slot, deck_id, title, owner_id, created_by, visibility, locked, payload, deck_updated_at)
  select s, d.id, d.title, d.owner_id, d.created_by, d.visibility, d.locked, d.payload, d.updated_at
  from public.presentation_decks d;
  get diagnostics n = row_count;
  return query select s, n;
end;
$$;

revoke all on function public.backup_presentation_decks() from public, anon, authenticated;
grant execute on function public.backup_presentation_decks() to service_role;
