-- 094_usage_telemetry.sql
--
-- Usage telemetry for the dev-only "Usage Analytics" tool.
--
-- Design: ONE row per (session, tool, AEST-day), incremented in place by a
-- SECURITY DEFINER RPC — never by direct table writes. A staff member using
-- 6 tools in a day = 6 rows, so the table stays tiny (~100–300 rows/day for
-- the whole company) while still carrying hour-of-day resolution via the
-- `hours` jsonb ({"09": 540} = 9 minutes engaged during the 9am hour).
--
-- "Engaged seconds" are counted client-side (shared/pp-telemetry.js) only
-- while the tab is VISIBLE and the user gave input in the last 60s (5 min
-- while presenting fullscreen) — the GA4-style engagement model — and are
-- clamped server-side so a buggy/hostile client can't inflate hours.
--
-- Reading is DEV-ONLY, three layers deep:
--   1. RLS: select policy requires current_tier() = 'dev'
--   2. the dashboard/live RPCs re-check current_tier() and raise otherwise
--   3. the tool page itself bounces non-dev (and the hub hides the card;
--      auth-gate bounces company/assigned-admin deep-links because the
--      'usage-analytics' registry key belongs to NO group)
-- Writes are open to every signed-in user (that's the point), but only
-- through pp_track_usage with clamps + a user-match guard on update.

create table public.pp_usage (
  session_id   text        not null,   -- crypto.randomUUID per tab (sessionStorage)
  tool_key     text        not null,   -- page filename sans .html; 'hub' for index
  day          date        not null,   -- AEST day (server-derived)
  user_id      uuid        not null references auth.users(id) on delete cascade,
  page_path    text,
  ctx          text,                   -- whitelisted query params, e.g. "region=perth&mode=sell"
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  engaged_secs integer     not null default 0,
  views        integer     not null default 0,   -- page opens for this tool/session/day
  hours        jsonb       not null default '{}'::jsonb,  -- {"HH24": secs} AEST
  meta         jsonb,                  -- {br, os, vw, vh, sw, sh} first beat only
  primary key (session_id, tool_key, day)
);

create index pp_usage_day_idx  on public.pp_usage (day);
create index pp_usage_user_idx on public.pp_usage (user_id, day);
create index pp_usage_tool_idx on public.pp_usage (tool_key, day);
create index pp_usage_seen_idx on public.pp_usage (last_seen_at);

alter table public.pp_usage enable row level security;

-- Dev-only read. NO insert/update/delete policies: the only write path is
-- the definer RPC below, so RLS denies direct client writes outright.
create policy "pp_usage_dev_read" on public.pp_usage
  for select to authenticated using (public.current_tier() = 'dev');

-- ── the write path ─────────────────────────────────────────────────────────
create or replace function public.pp_track_usage(
  p_session text,
  p_tool    text,
  p_page    text    default null,
  p_secs    integer default 0,
  p_views   integer default 0,
  p_ctx     text    default null,
  p_meta    jsonb   default null
) returns void
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_now   timestamptz := now();
  v_day   date := (now() at time zone 'Australia/Sydney')::date;
  v_hour  text := to_char(now() at time zone 'Australia/Sydney', 'HH24');
  -- flush interval is 60s; 180 allows the final pagehide beat + slack
  v_secs  integer := greatest(0, least(coalesce(p_secs, 0), 180));
  v_views integer := greatest(0, least(coalesce(p_views, 0), 20));
begin
  if v_uid is null then return; end if;
  if p_session is null or length(p_session) not between 8 and 64 then return; end if;
  if p_tool is null or p_tool = '' then return; end if;

  insert into public.pp_usage as u
    (session_id, tool_key, day, user_id, page_path, ctx,
     started_at, last_seen_at, engaged_secs, views, hours, meta)
  values
    (p_session, left(p_tool, 64), v_day, v_uid, left(p_page, 128), left(p_ctx, 160),
     v_now, v_now, v_secs, v_views,
     case when v_secs > 0 then jsonb_build_object(v_hour, v_secs) else '{}'::jsonb end,
     p_meta)
  on conflict (session_id, tool_key, day) do update set
    engaged_secs = u.engaged_secs + excluded.engaged_secs,
    views        = u.views + excluded.views,
    last_seen_at = v_now,
    ctx          = coalesce(excluded.ctx, u.ctx),
    meta         = coalesce(u.meta, excluded.meta),
    hours        = case when excluded.engaged_secs > 0
                        then jsonb_set(u.hours, array[v_hour],
                             to_jsonb(coalesce((u.hours ->> v_hour)::int, 0) + excluded.engaged_secs))
                        else u.hours end
  -- a random session id colliding across users is ~impossible, but never
  -- let one user's beat mutate another user's row
  where u.user_id = excluded.user_id;
end;
$$;

revoke all on function public.pp_track_usage(text,text,text,integer,integer,text,jsonb) from public, anon;
grant execute on function public.pp_track_usage(text,text,text,integer,integer,text,jsonb) to authenticated;

-- ── the read path: one blob, one round trip ────────────────────────────────
-- Returns everything the dashboard needs pre-joined, keyed by the email
-- local-part (human-readable, avoids shipping full addresses). Client-side
-- JS does the aggregation + the include/exclude-internal toggle — the whole
-- company's data for 90 days is a few hundred KB at most.
create or replace function public.pp_usage_dashboard(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_out jsonb;
begin
  if public.current_tier() <> 'dev' then
    raise exception 'not authorized';
  end if;

  with rng as (
    select * from public.pp_usage where day between p_from and p_to
  ),
  users as (
    select distinct r.user_id,
           split_part(p.email, '@', 1) as k,
           p.tier, coalesce(p.team, '') as team
    from rng r join public.profiles p on p.id = r.user_id
  ),
  rows_agg as (
    select u.k, r.day as d, r.tool_key as t,
           sum(r.engaged_secs)::int as s, sum(r.views)::int as v
    from rng r join users u on u.user_id = r.user_id
    group by u.k, r.day, r.tool_key
  ),
  hours_agg as (
    select u.k,
           (extract(isodow from r.day)::int - 1) as w,   -- 0=Mon … 6=Sun
           (h.key)::int as h, sum((h.value)::int)::int as s
    from rng r
    join users u on u.user_id = r.user_id
    cross join lateral jsonb_each_text(r.hours) h
    group by u.k, w, h.key
  ),
  devices as (
    select distinct on (r.session_id) u.k,
           r.meta->>'br' as br, r.meta->>'os' as os,
           (r.meta->>'vw')::int as vw, (r.meta->>'sw')::int as sw
    from rng r join users u on u.user_id = r.user_id
    where r.meta is not null
    order by r.session_id, r.last_seen_at desc
  ),
  ctxs as (
    select u.k, r.tool_key as t, r.ctx, sum(r.engaged_secs)::int as s
    from rng r join users u on u.user_id = r.user_id
    where r.ctx is not null and r.ctx <> ''
    group by u.k, r.tool_key, r.ctx
  )
  select jsonb_build_object(
    'from',  p_from, 'to', p_to,
    'since', (select min(day) from public.pp_usage),
    'users', coalesce((select jsonb_agg(jsonb_build_object('k',k,'tier',tier,'team',team)) from users), '[]'::jsonb),
    'rows',  coalesce((select jsonb_agg(jsonb_build_object('k',k,'d',d,'t',t,'s',s,'v',v)) from rows_agg), '[]'::jsonb),
    'hours', coalesce((select jsonb_agg(jsonb_build_object('k',k,'w',w,'h',h,'s',s)) from hours_agg), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('k',k,'br',br,'os',os,'vw',vw,'sw',sw)) from devices), '[]'::jsonb),
    'ctxs',  coalesce((select jsonb_agg(jsonb_build_object('k',k,'t',t,'c',ctx,'s',s)) from ctxs), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

revoke all on function public.pp_usage_dashboard(date,date) from public, anon;
grant execute on function public.pp_usage_dashboard(date,date) to authenticated;

-- ── who's on right now (5-minute window; polled by the dashboard) ──────────
create or replace function public.pp_usage_live()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if public.current_tier() <> 'dev' then
    raise exception 'not authorized';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'k', split_part(p.email,'@',1),
             'tier', p.tier,
             't', x.tool_key,
             'c', x.ctx,
             'ago', extract(epoch from (now() - x.last_seen_at))::int))
    from (
      select distinct on (u.user_id) u.*
      from public.pp_usage u
      where u.last_seen_at > now() - interval '5 minutes'
      order by u.user_id, u.last_seen_at desc
    ) x
    join public.profiles p on p.id = x.user_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.pp_usage_live() from public, anon;
grant execute on function public.pp_usage_live() to authenticated;
