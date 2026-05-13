-- =============================================================================
-- 016_cadence_team_lead.sql — Team-lead visibility override
--
-- Lindsay heads the PM team. She's on Tier 2 (company) so the migration-014
-- scoped policy would normally only show her cards she filed or was assigned.
-- This migration adds a small helper function — public.is_team_lead() — that
-- whitelists a fixed set of emails as "can see every Cadence card across the
-- whole team". The read + update policies on cadence_cards and the read policy
-- on cadence_card_history check this helper alongside the existing scoping.
--
-- Why a function (not inline `or auth.jwt() ->> 'email' = '…'`):
--   - Easier to read in policy SQL
--   - One place to extend when a second/third team lead joins — no fresh
--     migration needed for code paths, just update the array and re-run
--   - Can be reused by future Cadence panels (e.g. team-load dashboards)
--
-- To add more team leads later, run a one-line UPDATE of this function:
--   create or replace function public.is_team_lead() …
-- with the extended array. No data migration needed.
--
-- Run order: after 014_cadence_card_scoping.sql. Idempotent — re-running
-- replaces the function + the three policies cleanly.
-- =============================================================================

create or replace function public.is_team_lead() returns boolean as $$
  /* lower-case both sides to avoid case-sensitivity surprises with JWT
     email claims (which can carry the user's input casing verbatim). */
  select lower(coalesce(auth.jwt() ->> 'email', '')) = any(array[
    'lindsay@performanceproperty.com.au'
  ]);
$$ language sql stable security definer;


-- ---------------------------------------------------------------------------
-- cadence_cards read — extended to include team leads.
-- ---------------------------------------------------------------------------
drop policy if exists "scoped read cards" on public.cadence_cards;
create policy "scoped read cards" on public.cadence_cards
  for select to authenticated using (
    public.is_writer()
    or public.is_team_lead()
    or lower(created_by_email)  = lower(auth.jwt() ->> 'email')
    or lower(assigned_to_email) = lower(auth.jwt() ->> 'email')
  );


-- ---------------------------------------------------------------------------
-- cadence_cards update — same scoping. Lets Lindsay reassign cards or
-- nudge stages on behalf of her team.
-- ---------------------------------------------------------------------------
drop policy if exists "scoped update cards" on public.cadence_cards;
create policy "scoped update cards" on public.cadence_cards
  for update to authenticated using (
    public.is_writer()
    or public.is_team_lead()
    or lower(created_by_email)  = lower(auth.jwt() ->> 'email')
    or lower(assigned_to_email) = lower(auth.jwt() ->> 'email')
  );


-- ---------------------------------------------------------------------------
-- cadence_card_history read — same.
-- ---------------------------------------------------------------------------
drop policy if exists "scoped read history" on public.cadence_card_history;
create policy "scoped read history" on public.cadence_card_history
  for select to authenticated using (
    public.is_writer()
    or public.is_team_lead()
    or exists (
      select 1 from public.cadence_cards c
      where c.id = cadence_card_history.card_id
        and (
          lower(c.created_by_email)  = lower(auth.jwt() ->> 'email')
          or lower(c.assigned_to_email) = lower(auth.jwt() ->> 'email')
        )
    )
  );
