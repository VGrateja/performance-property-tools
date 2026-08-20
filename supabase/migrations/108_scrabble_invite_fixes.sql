-- =============================================================================
-- 108_scrabble_invite_fixes.sql — Scrabble invite reliability
--
-- Players reported invites they couldn't accept (2026-08-18: an invite sat
-- unaccepted for 11 minutes until the lobby auto-expired around it). A live
-- audit found the RPCs healthy but with three sharp edges; this migration
-- files them off. Signatures are unchanged — create-or-replace keeps the
-- existing grants (authenticated only; anon revoked in 026).
--
--   1. status='open' is now the ONLY liveness gate on accept/invite paths.
--      The old expires_at hard-fail raced the sweeper: a lobby could render
--      as acceptable, drift past expires_at while the invitee reached for
--      the button, and refuse the click even though nothing had cancelled
--      it yet. expire_stale_scrabble_lobbies() remains the one thing that
--      kills idle lobbies; every successful action still resets the clock.
--
--   2. Capacity is enforced where it was missing:
--        - invite_to_scrabble_lobby refuses to invite into a full lobby
--          (before, the invite sent fine and the ACCEPT blew up later with
--          "Lobby is full" — the worst place to learn about it).
--        - request_join_scrabble_lobby's invited→joined shortcut now runs
--          the same seat check accept_lobby_invite has always had.
--
--   3. One lobby at a time is now a real invariant. Every path that makes a
--      player 'joined' somewhere (accepting an invite, a host accepting
--      their request, the request-join invited→joined shortcut) — plus
--      creating a lobby — first releases their other open commitments:
--      any open lobby they host is cancelled and their joined/requested/
--      invited rows in other open lobbies flip to 'left'. Without this,
--      holding two memberships was reachable — and the client can only
--      surface one, which is how invites went invisible.
--
-- Run order: after 107_*.sql.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- scrabble_release_other_lobbies — internal helper for the one-lobby
-- invariant. NOT client-callable (no grant to authenticated); only the
-- security-definer RPCs below invoke it.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.scrabble_release_other_lobbies(p_user_id uuid, p_keep_lobby_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  update public.arena_scrabble_lobbies
     set status = 'cancelled', cancelled_at = now()
   where host_user_id = p_user_id
     and status = 'open'
     and (p_keep_lobby_id is null or id <> p_keep_lobby_id);

  update public.arena_scrabble_lobby_players p
     set status = 'left'
    from public.arena_scrabble_lobbies l
   where l.id = p.lobby_id
     and p.user_id = p_user_id
     and l.status = 'open'
     and (p_keep_lobby_id is null or p.lobby_id <> p_keep_lobby_id)
     and p.status in ('joined', 'requested', 'invited');
end;
$$;
revoke all on function public.scrabble_release_other_lobbies(uuid, uuid) from public;
revoke all on function public.scrabble_release_other_lobbies(uuid, uuid) from anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- invite_to_scrabble_lobby — host invites a specific user.
-- Changed: seat check added; expires_at hard-fail dropped (status gates).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.invite_to_scrabble_lobby(p_lobby_id uuid, p_invitee_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_lobby  record;
  v_email  text;
  v_name   text;
  v_count  int;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;

  select * into v_lobby from public.arena_scrabble_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_user_id <> v_uid then raise exception 'Only the host can invite'; end if;
  if v_lobby.status <> 'open' then raise exception 'Lobby is no longer open'; end if;

  select count(*) into v_count from public.arena_scrabble_lobby_players
    where lobby_id = p_lobby_id and status = 'joined';
  if v_count >= v_lobby.max_players then
    raise exception 'Lobby is full — no seats left to invite into';
  end if;

  select email into v_email from auth.users where id = p_invitee_id;
  if v_email is null then raise exception 'Invitee not found'; end if;
  v_name := split_part(v_email, '@', 1);

  insert into public.arena_scrabble_lobby_players (lobby_id, user_id, email, name, status)
    values (p_lobby_id, p_invitee_id, v_email, v_name, 'invited')
  on conflict (lobby_id, user_id) do update
    set status = 'invited'
    where arena_scrabble_lobby_players.status in ('left', 'kicked', 'requested');

  /* Host took action — refresh the expiry. */
  update public.arena_scrabble_lobbies
     set expires_at = now() + interval '10 minutes'
   where id = p_lobby_id;
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- accept_lobby_invite — invitee accepts; status invited → joined.
-- Changed: expires_at hard-fail dropped; the accepter's other open-lobby
-- commitments are released in the same transaction.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.accept_lobby_invite(p_lobby_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_lobby  record;
  v_row    record;
  v_count  int;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;

  select * into v_lobby from public.arena_scrabble_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.status <> 'open' then raise exception 'Lobby is no longer open'; end if;

  select * into v_row from public.arena_scrabble_lobby_players
    where lobby_id = p_lobby_id and user_id = v_uid for update;
  if not found then raise exception 'No invite found for you on this lobby'; end if;
  if v_row.status <> 'invited' then raise exception 'You are not currently invited (status=%)', v_row.status; end if;

  select count(*) into v_count from public.arena_scrabble_lobby_players
    where lobby_id = p_lobby_id and status = 'joined';
  if v_count >= v_lobby.max_players then raise exception 'Lobby is full'; end if;

  /* One lobby at a time: cancel any open lobby I host and walk out of any
     other open lobby I'm attached to, so the client's single "My lobby"
     slot can never hide a membership. */
  perform public.scrabble_release_other_lobbies(v_uid, p_lobby_id);

  update public.arena_scrabble_lobby_players
     set status = 'joined', joined_at = now()
   where lobby_id = p_lobby_id and user_id = v_uid;

  /* Successful join — refresh expiry. */
  update public.arena_scrabble_lobbies
     set expires_at = now() + interval '10 minutes'
   where id = p_lobby_id;
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- accept_join_request — host lets a requester in.
-- Changed: expires_at hard-fail dropped (status gates; success resets it).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.accept_join_request(p_lobby_id uuid, p_requester_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_lobby  record;
  v_count  int;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_lobby from public.arena_scrabble_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_user_id <> v_uid then raise exception 'Only the host can accept requests'; end if;
  if v_lobby.status <> 'open' then raise exception 'Lobby is no longer open'; end if;

  select count(*) into v_count from public.arena_scrabble_lobby_players
    where lobby_id = p_lobby_id and status = 'joined';
  if v_count >= v_lobby.max_players then raise exception 'Lobby is full'; end if;

  /* The requester becomes 'joined' here, so the one-lobby invariant
     applies to THEM: release their other open commitments first. */
  perform public.scrabble_release_other_lobbies(p_requester_id, p_lobby_id);

  update public.arena_scrabble_lobby_players
     set status = 'joined', joined_at = now()
   where lobby_id = p_lobby_id and user_id = p_requester_id and status = 'requested';

  /* Host accepted — refresh expiry. */
  update public.arena_scrabble_lobbies
     set expires_at = now() + interval '10 minutes'
   where id = p_lobby_id;
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- request_join_scrabble_lobby — any signed-in user asks to join.
-- Changed: the invited→joined shortcut (requesting a lobby you were already
-- invited to counts as accepting) now enforces the seat cap and resets the
-- expiry like every other successful join. Plain requests still deliberately
-- do NOT extend the lobby's life (024's anti-spam rule).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.request_join_scrabble_lobby(p_lobby_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text;
  v_name   text;
  v_lobby  record;
  v_row    record;
  v_count  int;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;

  select * into v_lobby from public.arena_scrabble_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.status <> 'open' then raise exception 'Lobby is no longer open'; end if;
  if v_lobby.host_user_id = v_uid then return; end if;   -- host's already joined

  select * into v_row from public.arena_scrabble_lobby_players
    where lobby_id = p_lobby_id and user_id = v_uid for update;

  if found and v_row.status = 'invited' then
    /* Requesting a lobby you're invited to = accepting the invite. */
    select count(*) into v_count from public.arena_scrabble_lobby_players
      where lobby_id = p_lobby_id and status = 'joined';
    if v_count >= v_lobby.max_players then raise exception 'Lobby is full'; end if;
    perform public.scrabble_release_other_lobbies(v_uid, p_lobby_id);
    update public.arena_scrabble_lobby_players
       set status = 'joined', joined_at = now()
     where lobby_id = p_lobby_id and user_id = v_uid;
    update public.arena_scrabble_lobbies
       set expires_at = now() + interval '10 minutes'
     where id = p_lobby_id;
    return;
  end if;

  if found and v_row.status in ('left', 'kicked') then
    update public.arena_scrabble_lobby_players
       set status = 'requested'
     where lobby_id = p_lobby_id and user_id = v_uid;
    return;
  end if;

  if found then return; end if;   -- already requested / joined — no-op

  select email into v_email from auth.users where id = v_uid;
  v_name := split_part(v_email, '@', 1);
  insert into public.arena_scrabble_lobby_players (lobby_id, user_id, email, name, status)
    values (p_lobby_id, v_uid, v_email, v_name, 'requested');
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- create_scrabble_lobby — host opens a lobby (022's signature/body).
-- Changed: creating a lobby also enforces the one-lobby invariant. The
-- client already refuses with an alert while you're in a lobby, but a stale
-- view could slip past it and strand a ghost lobby only the sweeper would
-- ever clean up — now the old commitments release instead.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.create_scrabble_lobby(
  p_max_players       int     default 4,
  p_ranked            boolean default true,
  p_turn_time_seconds int     default null
)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text;
  v_name   text;
  v_id     uuid;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  if p_max_players not between 2 and 4 then
    raise exception 'max_players must be 2, 3 or 4';
  end if;
  if p_turn_time_seconds is not null and p_turn_time_seconds not between 30 and 3600 then
    raise exception 'turn_time_seconds must be between 30 and 3600 (or null for untimed)';
  end if;

  select email into v_email from auth.users where id = v_uid;
  if v_email is null then raise exception 'Could not resolve caller email'; end if;
  v_name := split_part(v_email, '@', 1);

  perform public.scrabble_release_other_lobbies(v_uid, null);

  insert into public.arena_scrabble_lobbies (
    host_user_id, host_email, host_name, max_players, ranked, turn_time_seconds
  ) values (
    v_uid, v_email, v_name, p_max_players, p_ranked, p_turn_time_seconds
  ) returning id into v_id;

  insert into public.arena_scrabble_lobby_players (lobby_id, user_id, email, name, status, joined_at)
    values (v_id, v_uid, v_email, v_name, 'joined', now());

  return v_id;
end;
$$;
