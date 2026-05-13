-- =============================================================================
-- 014_cadence_card_scoping.sql — Per-user card visibility
--
-- Before: every staff-tier user (dev/admin/company) read every card. PMs
-- saw each other's queues, completed history filled with other people's
-- work. Messy as the system scales.
--
-- After: a Tier 2 (company) user sees a card only when they are
--   - the filer (created_by_email matches), OR
--   - the assignee (assigned_to_email matches).
-- Tier 0 (dev) and Tier 1 (admin) keep full visibility for support /
-- debugging — bypassed via is_writer().
--
-- Same rule applies to cadence_card_history so the audit log doesn't
-- leak around the card scoping. Boards + assignees stay readable to
-- all staff (they're configuration, not data).
--
-- Inserts: any staff can file (PMs need to create cards on every board).
-- Updates: same scoping as reads — only the filer + assignee + writers
-- can edit a card. Delete remains writer-only.
--
-- Email comparison is case-insensitive (RFC says the local-part is
-- case-sensitive but every mail provider treats it otherwise). NULL
-- compared to anything = NULL = false in USING/WITH CHECK, so legacy
-- cards with null created_by_email naturally fail the match.
--
-- Run order: after 013_cadence_more_boards.sql. Idempotent.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Speed up the email-equality predicate in RLS. Without this, large card
-- tables would seq-scan on every read.
-- ---------------------------------------------------------------------------
create index if not exists cadence_cards_creator_idx
  on public.cadence_cards (lower(created_by_email));

create index if not exists cadence_cards_assignee_lower_idx
  on public.cadence_cards (lower(assigned_to_email));


-- ---------------------------------------------------------------------------
-- Cards — drop the old broad policies, install scoped replacements.
-- ---------------------------------------------------------------------------
drop policy if exists "staff read cards"   on public.cadence_cards;
drop policy if exists "staff update cards" on public.cadence_cards;
drop policy if exists "staff insert cards" on public.cadence_cards;

create policy "scoped read cards" on public.cadence_cards
  for select to authenticated using (
    public.is_writer()
    or lower(created_by_email)  = lower(auth.jwt() ->> 'email')
    or lower(assigned_to_email) = lower(auth.jwt() ->> 'email')
  );

create policy "scoped update cards" on public.cadence_cards
  for update to authenticated using (
    public.is_writer()
    or lower(created_by_email)  = lower(auth.jwt() ->> 'email')
    or lower(assigned_to_email) = lower(auth.jwt() ->> 'email')
  );

-- Filing stays open to all staff — PMs need to create cards on every board.
create policy "staff insert cards" on public.cadence_cards
  for insert to authenticated with check (public.is_staff());


-- ---------------------------------------------------------------------------
-- History — visible only when the user can see the underlying card. EXISTS
-- subquery joins on card_id; cadence_history_card_idx (from 010) already
-- covers that lookup. For DELETED cards the join misses, so PMs lose
-- audit visibility once a card is hard-deleted — acceptable trade-off,
-- writers can still query the raw table for forensics.
-- ---------------------------------------------------------------------------
drop policy if exists "staff read history" on public.cadence_card_history;

create policy "scoped read history" on public.cadence_card_history
  for select to authenticated using (
    public.is_writer()
    or exists (
      select 1 from public.cadence_cards c
      where c.id = cadence_card_history.card_id
        and (
          lower(c.created_by_email)  = lower(auth.jwt() ->> 'email')
          or lower(c.assigned_to_email) = lower(auth.jwt() ->> 'email')
        )
    )
  );
