-- =============================================================================
-- 024_arena_scrabble_lobby_expiry.sql — Lobby auto-expiry
--
-- Adds a 10-minute expiry to arena_scrabble_lobbies so ghost lobbies (host
-- closed the browser) don't pile up in the Open lobbies browser.
--
-- expires_at is reset to now() + 10 minutes whenever a host-driven activity
-- happens (host invites, host accepts a join request, an invitee accepts),
-- so a lobby that's actively gathering players stays alive. Idle lobbies
-- (nobody joins, host walks away) auto-cancel.
--
-- expire_stale_scrabble_lobbies() is a security-definer cleanup RPC that
-- any signed-in client can call on each loadLobbies() — best-effort
-- garbage collection without needing pg_cron.
--
-- Run order: after 023_*.sql.
-- =============================================================================

alter table public.arena_scrabble_lobbies
  add column if not exists expires_at timestamptz not null
    default (now() + interval '10 minutes');

-- Index speeds the cleanup query.
create index if not exists arena_scrabble_lobbies_expires_at_idx
  on public.arena_scrabble_lobbies (status, expires_at);


-- ─────────────────────────────────────────────────────────────────────────────
-- expire_stale_scrabble_lobbies — flips every open-but-overdue lobby to
-- status='cancelled'. Returns the number of rows updated.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.expire_stale_scrabble_lobbies()
  returns int
  language plpgsql
  security definer
  set search_path = public
as $$
declare v_count int;
begin
  update public.arena_scrabble_lobbies
     set status = 'cancelled', cancelled_at = now()
   where status = 'open' and expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.expire_stale_scrabble_lobbies() from public;
grant execute on function public.expire_stale_scrabble_lobbies() to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- Extend expiry on host-driven activity. Same +10-minute reset rule applied
-- on invite / accept-request / accept-invite. A pure join request (no host
-- action) does NOT extend, because an unattended host could leave a lobby
-- alive forever by getting periodic spam requests.
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
begin
  if v_uid is null then raise exception 'Not signed in'; end if;

  select * into v_lobby from public.arena_scrabble_lobbies where id = p_lobby_id for update;
  if not found then raise exception 'Lobby not found'; end if;
  if v_lobby.host_user_id <> v_uid then raise exception 'Only the host can invite'; end if;
  if v_lobby.status <> 'open' then raise exception 'Lobby is no longer open'; end if;
  if v_lobby.expires_at < now() then raise exception 'Lobby has expired'; end if;

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
  if v_lobby.expires_at < now() then raise exception 'Lobby has expired'; end if;

  select * into v_row from public.arena_scrabble_lobby_players
    where lobby_id = p_lobby_id and user_id = v_uid for update;
  if not found then raise exception 'No invite found for you on this lobby'; end if;
  if v_row.status <> 'invited' then raise exception 'You are not currently invited (status=%)', v_row.status; end if;

  select count(*) into v_count from public.arena_scrabble_lobby_players
    where lobby_id = p_lobby_id and status = 'joined';
  if v_count >= v_lobby.max_players then raise exception 'Lobby is full'; end if;

  update public.arena_scrabble_lobby_players
     set status = 'joined', joined_at = now()
   where lobby_id = p_lobby_id and user_id = v_uid;

  /* Successful join — refresh expiry. */
  update public.arena_scrabble_lobbies
     set expires_at = now() + interval '10 minutes'
   where id = p_lobby_id;
end;
$$;


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
  if v_lobby.expires_at < now() then raise exception 'Lobby has expired'; end if;

  select count(*) into v_count from public.arena_scrabble_lobby_players
    where lobby_id = p_lobby_id and status = 'joined';
  if v_count >= v_lobby.max_players then raise exception 'Lobby is full'; end if;

  update public.arena_scrabble_lobby_players
     set status = 'joined', joined_at = now()
   where lobby_id = p_lobby_id and user_id = p_requester_id and status = 'requested';

  /* Host accepted — refresh expiry. */
  update public.arena_scrabble_lobbies
     set expires_at = now() + interval '10 minutes'
   where id = p_lobby_id;
end;
$$;
