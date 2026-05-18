-- =============================================================================
-- 026_supabase_linter_fixes.sql — Bulk fix for Performance + Security Advisor
--
-- Tackles four classes of warnings reported by Supabase's Database Advisors:
--
--   1. function_search_path_mutable (14)
--      Adds an explicit SET search_path to every flagged function so the
--      callable surface can't be hijacked via a malicious search_path on
--      the caller's session.
--
--   2. auth_rls_initplan (16+)
--      Rewrites RLS policies to wrap auth.uid() / auth.jwt() in a sub-
--      select. Lets Postgres cache the value once per query instead of
--      re-evaluating it for every row.
--
--   3. multiple_permissive_policies (3)
--      Merges overlapping permissive policies on profiles + cadence_-
--      assignees so only one policy per (role, action) pair has to be
--      evaluated.
--
--   4. anon_security_definer_function_executable (24)
--      Revokes EXECUTE from the anon role on every public SECURITY
--      DEFINER function. Authenticated keeps it for the user-facing RPCs;
--      for trigger-only functions, authenticated also loses it (triggers
--      run as the table owner, not the caller).
--
-- The remaining ~18 authenticated_security_definer_function_executable
-- warnings are by design (signed-in users genuinely need to call the
-- game RPCs + RLS helper functions) — the linter just wants
-- acknowledgement.
--
-- Run order: after 025_*.sql.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- A. Function search_path
-- ─────────────────────────────────────────────────────────────────────────────
-- Pure-SQL helpers with no schema dependencies (only built-ins) → empty path.
alter function public._scrabble_letter_value(text)        set search_path = '';
alter function public._scrabble_square_premium(int, int)  set search_path = '';
alter function public._scrabble_shuffle_text(text)        set search_path = '';
-- plpgsql helper that uses only built-ins (substr, position) → also safe.
alter function public._scrabble_remove_char(text, text)   set search_path = '';

-- Older functions that touch public tables — keep public in the search path
-- so unqualified references inside their bodies (we don't have all the
-- sources here) still resolve. pg_temp added per Postgres-recommended
-- least-privilege ordering.
alter function public.handle_new_user()                   set search_path = public, pg_temp;
alter function public.current_tier()                      set search_path = public, pg_temp;
alter function public.is_writer()                         set search_path = public, pg_temp;
alter function public.is_staff()                          set search_path = public, pg_temp;
alter function public.is_team_lead()                      set search_path = public, pg_temp;
alter function public.touch_updated_at()                  set search_path = public, pg_temp;
alter function public.touch_profile_updated_at()          set search_path = public, pg_temp;
alter function public.touch_cadence_boards()              set search_path = public, pg_temp;
alter function public.touch_cadence_cards()               set search_path = public, pg_temp;
alter function public.log_cadence_card_change()           set search_path = public, pg_temp;


-- ─────────────────────────────────────────────────────────────────────────────
-- B. Revoke anon EXECUTE on every public SECURITY DEFINER function.
-- Authenticated keeps EXECUTE for the user-facing RPCs.
-- ─────────────────────────────────────────────────────────────────────────────

-- Chess
revoke execute on function public.accept_chess_challenge(bigint) from anon;

-- Scrabble RPCs
revoke execute on function public.accept_join_request(uuid, uuid)                                       from anon;
revoke execute on function public.accept_lobby_invite(uuid)                                              from anon;
revoke execute on function public.cancel_scrabble_lobby(uuid)                                            from anon;
revoke execute on function public.create_scrabble_lobby(int, boolean, int)                              from anon;
revoke execute on function public.decline_lobby_invite(uuid)                                             from anon;
revoke execute on function public.expire_scrabble_turn(uuid)                                             from anon;
revoke execute on function public.expire_stale_scrabble_lobbies()                                        from anon;
revoke execute on function public.invite_to_scrabble_lobby(uuid, uuid)                                   from anon;
revoke execute on function public.kick_lobby_player(uuid, uuid)                                          from anon;
revoke execute on function public.leave_scrabble_lobby(uuid)                                             from anon;
revoke execute on function public.request_join_scrabble_lobby(uuid)                                      from anon;
revoke execute on function public.settle_scrabble_game(uuid, text)                                       from anon;
revoke execute on function public.start_scrabble_lobby(uuid)                                             from anon;
revoke execute on function public.submit_scrabble_move(uuid, text, jsonb, text, integer)                 from anon;

-- RLS helpers (called from inside policies — authenticated still needs EXECUTE)
revoke execute on function public.current_tier()                                                          from anon;
revoke execute on function public.is_writer()                                                             from anon;
revoke execute on function public.is_staff()                                                              from anon;
revoke execute on function public.is_team_lead()                                                          from anon;

-- Trigger-only functions: nobody needs EXECUTE; triggers run as table owner.
revoke execute on function public.handle_new_user()              from public, anon, authenticated;
revoke execute on function public.log_cadence_card_change()      from public, anon, authenticated;
revoke execute on function public.touch_updated_at()             from public, anon, authenticated;
revoke execute on function public.touch_profile_updated_at()     from public, anon, authenticated;
revoke execute on function public.touch_cadence_boards()         from public, anon, authenticated;
revoke execute on function public.touch_cadence_cards()          from public, anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- C. RLS policies — wrap auth.uid() / auth.jwt() in a subselect so Postgres
-- caches the per-query value instead of re-evaluating per row.
-- Where the table also tripped the multiple_permissive_policies warning,
-- the old policies are merged into a single OR'd policy.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── profiles (merge multiple permissive + wrap auth.uid) ──
drop policy if exists "users read own profile"     on public.profiles;
drop policy if exists "writers read all profiles"  on public.profiles;
drop policy if exists "users update own profile"   on public.profiles;
drop policy if exists "writers update any profile" on public.profiles;

create policy "read profiles" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.is_writer());

create policy "update profiles" on public.profiles
  for update to authenticated
  using      (id = (select auth.uid()) or public.is_writer())
  with check (id = (select auth.uid()) or public.is_writer());


-- ── arena_typing_scores ──
-- This table uses `user_id` (the typing-score schema predates the chess /
-- scrabble convention of `created_by_user_id`).
drop policy if exists "users insert own arena scores" on public.arena_typing_scores;
create policy "users insert own arena scores"
  on public.arena_typing_scores for insert to authenticated
  with check (user_id = (select auth.uid()));


-- ── arena_chess_matches ──
drop policy if exists "users insert own arena chess matches" on public.arena_chess_matches;
create policy "users insert own arena chess matches"
  on public.arena_chess_matches for insert to authenticated
  with check (created_by_user_id = (select auth.uid()));


-- ── arena_chess_challenges ──
drop policy if exists "participants read arena chess challenges"  on public.arena_chess_challenges;
drop policy if exists "challenger insert arena chess challenges"  on public.arena_chess_challenges;
drop policy if exists "participants update arena chess challenges" on public.arena_chess_challenges;

create policy "participants read arena chess challenges"
  on public.arena_chess_challenges for select to authenticated
  using ((select auth.uid()) in (challenger_user_id, challengee_user_id));

create policy "challenger insert arena chess challenges"
  on public.arena_chess_challenges for insert to authenticated
  with check ((select auth.uid()) = challenger_user_id);

create policy "participants update arena chess challenges"
  on public.arena_chess_challenges for update to authenticated
  using      ((select auth.uid()) in (challenger_user_id, challengee_user_id))
  with check ((select auth.uid()) in (challenger_user_id, challengee_user_id));


-- ── arena_chess_games ──
drop policy if exists "participants insert arena chess games" on public.arena_chess_games;
drop policy if exists "participants update arena chess games" on public.arena_chess_games;

create policy "participants insert arena chess games"
  on public.arena_chess_games for insert to authenticated
  with check ((select auth.uid()) in (white_user_id, black_user_id));

create policy "participants update arena chess games"
  on public.arena_chess_games for update to authenticated
  using      ((select auth.uid()) in (white_user_id, black_user_id))
  with check ((select auth.uid()) in (white_user_id, black_user_id));


-- ── arena_chess_moves ──
drop policy if exists "participants insert arena chess moves" on public.arena_chess_moves;
create policy "participants insert arena chess moves"
  on public.arena_chess_moves for insert to authenticated
  with check (
    exists (
      select 1 from public.arena_chess_games g
      where g.id = arena_chess_moves.game_id
        and (select auth.uid()) in (g.white_user_id, g.black_user_id)
    )
  );


-- ── arena_scrabble_games (the join-table-based policy from migration 021) ──
drop policy if exists "participants update arena scrabble games" on public.arena_scrabble_games;
create policy "participants update arena scrabble games"
  on public.arena_scrabble_games for update to authenticated
  using (
    exists (
      select 1 from public.arena_scrabble_game_players gp
      where gp.game_id = arena_scrabble_games.id and gp.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.arena_scrabble_game_players gp
      where gp.game_id = arena_scrabble_games.id and gp.user_id = (select auth.uid())
    )
  );


-- ── arena_scrabble_matches ──
drop policy if exists "users insert own arena scrabble matches" on public.arena_scrabble_matches;
create policy "users insert own arena scrabble matches"
  on public.arena_scrabble_matches for insert to authenticated
  with check (created_by_user_id = (select auth.uid()));


-- ── arena_scrabble_racks ──
drop policy if exists "owner read arena scrabble racks" on public.arena_scrabble_racks;
create policy "owner read arena scrabble racks"
  on public.arena_scrabble_racks for select to authenticated
  using ((select auth.uid()) = player_user_id);


-- ── cadence_assignees (split the FOR ALL writers policy so SELECT no longer
--    overlaps with the staff read policy) ──
drop policy if exists "staff read assignees"     on public.cadence_assignees;
drop policy if exists "writers manage assignees" on public.cadence_assignees;

create policy "read assignees" on public.cadence_assignees
  for select to authenticated using (public.is_staff());

create policy "writers insert assignees" on public.cadence_assignees
  for insert to authenticated with check (public.is_writer());

create policy "writers update assignees" on public.cadence_assignees
  for update to authenticated
  using      (public.is_writer())
  with check (public.is_writer());

create policy "writers delete assignees" on public.cadence_assignees
  for delete to authenticated using (public.is_writer());


-- ── cadence_cards (wrap auth.jwt() in subselect) ──
drop policy if exists "scoped read cards" on public.cadence_cards;
create policy "scoped read cards" on public.cadence_cards
  for select to authenticated using (
    public.is_writer()
    or public.is_team_lead()
    or lower(created_by_email)  = lower((select auth.jwt()) ->> 'email')
    or lower(assigned_to_email) = lower((select auth.jwt()) ->> 'email')
  );

drop policy if exists "scoped update cards" on public.cadence_cards;
create policy "scoped update cards" on public.cadence_cards
  for update to authenticated using (
    public.is_writer()
    or public.is_team_lead()
    or lower(created_by_email)  = lower((select auth.jwt()) ->> 'email')
    or lower(assigned_to_email) = lower((select auth.jwt()) ->> 'email')
  );


-- ── cadence_card_history ──
drop policy if exists "scoped read history" on public.cadence_card_history;
create policy "scoped read history" on public.cadence_card_history
  for select to authenticated using (
    public.is_writer()
    or public.is_team_lead()
    or exists (
      select 1 from public.cadence_cards c
      where c.id = cadence_card_history.card_id
        and (
          lower(c.created_by_email)  = lower((select auth.jwt()) ->> 'email')
          or lower(c.assigned_to_email) = lower((select auth.jwt()) ->> 'email')
        )
    )
  );


-- =============================================================================
-- What's NOT in this migration (deliberately):
--
-- • public_bucket_allows_listing — the online-reports bucket has a broad
--   storage.objects SELECT policy. Public buckets serve files via direct
--   URL without that policy; removing it tightens things but might break
--   any code that calls supabase.storage.from('online-reports').list().
--   Leaving alone until you confirm whether anything lists the bucket.
--
-- • auth_leaked_password_protection — toggled in the Supabase dashboard
--   (Authentication → Sign In / Sign Up → "Prevent use of leaked
--   passwords"). Not a SQL setting.
--
-- • authenticated_security_definer_function_executable (~18 remaining) —
--   intentional. The user-facing RPCs (submit_scrabble_move, etc.) MUST
--   be callable by signed-in users; the RLS helpers (is_writer / is_staff /
--   is_team_lead / current_tier) are called from inside policies and need
--   EXECUTE for authenticated. The linter flags them as informational.
-- =============================================================================
