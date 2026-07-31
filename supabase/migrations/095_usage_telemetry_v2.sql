-- 095_usage_telemetry_v2.sql
--
-- Usage Analytics v2 (no schema change — RPC replace only):
--   · staff_total  — active internal headcount, so the dashboard can say
--                    "14 of 45 staff" instead of a bare number
--   · firsts       — per (person, day): the tool whose row has the earliest
--                    started_at, i.e. what people open FIRST; the dashboard
--                    filters the hub out client-side ("beyond the hub")
--   · devices.lm   — page-load milliseconds (collector v2 puts it in meta),
--                    for p50/p95 load per tool/device
--
-- Pseudo tool keys arrive with collector v2 as well ('present:<tool>' on
-- fullscreenchange, 'export:<tool>' from the download paths). They ride the
-- SAME pp_usage rows/RPC — the dashboard splits them out of the leaderboard
-- and engaged-time KPIs client-side, so no server change is needed for them.
--
-- Errors need nothing here: client_errors (mig 031) already lets writers
-- SELECT, and the dashboard is dev-gated; it queries the table directly.

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
           (extract(isodow from r.day)::int - 1) as w,
           (h.key)::int as h, sum((h.value)::int)::int as s
    from rng r
    join users u on u.user_id = r.user_id
    cross join lateral jsonb_each_text(r.hours) h
    group by u.k, w, h.key
  ),
  devices as (
    select distinct on (r.session_id) u.k,
           r.meta->>'br' as br, r.meta->>'os' as os,
           (r.meta->>'vw')::int as vw, (r.meta->>'sw')::int as sw,
           (r.meta->>'lm')::int as lm
    from rng r join users u on u.user_id = r.user_id
    where r.meta is not null
    order by r.session_id, r.last_seen_at desc
  ),
  ctxs as (
    select u.k, r.tool_key as t, r.ctx, sum(r.engaged_secs)::int as s
    from rng r join users u on u.user_id = r.user_id
    where r.ctx is not null and r.ctx <> ''
    group by u.k, r.tool_key, r.ctx
  ),
  firsts as (
    /* the earliest-started row per person per day = what they opened first;
       pseudo keys can never win (present:/export: rows are born from an
       already-open page, so a real key always precedes them) — but guard
       anyway so a pathological order can't surface one */
    select distinct on (u.k, r.day) u.k, r.day as d, r.tool_key as t
    from rng r join users u on u.user_id = r.user_id
    where position(':' in r.tool_key) = 0
    order by u.k, r.day, r.started_at
  )
  select jsonb_build_object(
    'from',  p_from, 'to', p_to,
    'since', (select min(day) from public.pp_usage),
    'staff_total', (select count(*) from public.profiles
                    where status = 'active' and tier in ('dev','admin','company')),
    'users', coalesce((select jsonb_agg(jsonb_build_object('k',k,'tier',tier,'team',team)) from users), '[]'::jsonb),
    'rows',  coalesce((select jsonb_agg(jsonb_build_object('k',k,'d',d,'t',t,'s',s,'v',v)) from rows_agg), '[]'::jsonb),
    'hours', coalesce((select jsonb_agg(jsonb_build_object('k',k,'w',w,'h',h,'s',s)) from hours_agg), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('k',k,'br',br,'os',os,'vw',vw,'sw',sw,'lm',lm)) from devices), '[]'::jsonb),
    'ctxs',  coalesce((select jsonb_agg(jsonb_build_object('k',k,'t',t,'c',ctx,'s',s)) from ctxs), '[]'::jsonb),
    'firsts', coalesce((select jsonb_agg(jsonb_build_object('k',k,'d',d,'t',t)) from firsts), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;
