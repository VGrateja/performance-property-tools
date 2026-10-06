-- =============================================================================
-- 126_sold_check.sql — Sold Check: the register of properties bought for
-- clients, and a queue of sold checks a person verifies
--
-- The ask. Saskia (2026-09-29): "a tool where Ben, Rachel or Shaene can upload
-- all our properties we have bought for clients, and the tool will check them
-- all and return any that have been sold recently … select what sold period we
-- want to search for — 1 month, 3 month, 6 month, 1 year, or return the most
-- recent date of sale." Van (2026-10-06): "a tool that can record this data and
-- they can also add their additional data/property. Then I will set a schedule
-- where you will run the new properties added to see if they're sold."
--
-- The mechanism.
--   sold_check_properties  the register — one row per property, keyed by a
--                          normalised address (address_key, unique). Filled by
--                          the tool's import (the city "Total Purchases"
--                          workbooks), by hand, or by QA (source='qa').
--   sold_check_results     what a checker found (verdict sold / listed /
--                          not_sold / unknown, with the source URL and a
--                          confidence) and what a person decided (review
--                          confirmed / rejected). The scheduled checker
--                          (scripts/sold-check/record.mjs) only INSERTS here; it
--                          never changes a property's status. A candidate becomes
--                          "sold" only through sold_check_confirm(), which a
--                          writer runs from the tool's Verify queue.
--   There is no runs table: a run is the set of results sharing a run_id.
--
-- address_key is computed HERE by a trigger (sold_check_key(address)) so every
-- writer — the page, the scripts, a hand-written SQL insert — lands on the same
-- key; the page computes the identical key in JS only to preview an import.
-- Normalisation: lower-case; commas -> a space; periods dropped; spaces around
-- "/" removed (unit/street numbers kept: "2 / 15" = "2/15"); runs of spaces
-- collapsed; trimmed. No street-type expansion (St stays st).
--
-- Access (the scorecard_can_write() pattern, mig 071/089):
--   read   any signed-in user (to authenticated using (true));
--   write  sold_check_can_write() = is_writer() OR has_tool_role('sold-check',
--          'editor') — so Van can make Ben and Rachel editors inside this tool
--          from the Roles panel without making them admins.
--   anon   nothing.
-- =============================================================================

-- ── the key ──────────────────────────────────────────────────────────────────
create or replace function public.sold_check_key(p_address text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select btrim(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 replace(replace(lower(coalesce(p_address, '')), ',', ' '), '.', ''),
               '\s+', ' ', 'g'),
             '\s*/\s*', '/', 'g'),
           '\s+', ' ', 'g'));
$$;

-- ── the scoped write predicate ──────────────────────────────────────────────
create or replace function public.sold_check_can_write() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.is_writer() or public.has_tool_role('sold-check', 'editor'), false);
$$;

revoke execute on function public.sold_check_can_write() from public, anon;
grant  execute on function public.sold_check_can_write() to authenticated;

-- ── the register ─────────────────────────────────────────────────────────────
create table if not exists public.sold_check_properties (
  id               uuid primary key default gen_random_uuid(),
  market           text not null,
  address          text not null check (btrim(address) <> ''),
  address_key      text not null unique,
  purchase_price   numeric,
  purchase_date    date,
  status           text not null default 'held' check (status in ('held','sold','unknown')),
  sold_price       numeric,
  sold_date        date,
  client_name      text,
  hubspot_url      text,
  advisor          text,
  lead_originator  text,
  comments         text,
  sales_agent      text,
  agency           text,
  listing_url      text,
  property_type    text,
  land_m2          numeric,
  sales_advisory   boolean,
  source           text not null default 'manual' check (source in ('import','manual','qa')),
  import_file      text,
  created_at       timestamptz default now(),
  created_by       text,
  updated_at       timestamptz default now(),
  updated_by       text
);

create index if not exists sold_check_properties_market_status_idx
  on public.sold_check_properties (market, status);

-- address_key from the address on every insert/update; updated_at on update.
-- (Not touch_updated_at(): that one writes auth.uid() into updated_by, and
-- updated_by here is the editor's email, set by the page / scripts.)
create or replace function public.sold_check_properties_touch() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.address_key := public.sold_check_key(new.address);
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end;
$$;

drop trigger if exists trg_sold_check_properties_touch on public.sold_check_properties;
create trigger trg_sold_check_properties_touch
  before insert or update on public.sold_check_properties
  for each row execute function public.sold_check_properties_touch();

-- ── the checks ───────────────────────────────────────────────────────────────
create table if not exists public.sold_check_results (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.sold_check_properties (id) on delete cascade,
  checked_at   timestamptz not null default now(),
  checked_by   text not null,                  -- 'schedule', 'manual', or an email
  run_id       text,
  verdict      text not null check (verdict in ('sold','listed','not_sold','unknown')),
  sale_date    date,
  sale_price   numeric,
  source_url   text,
  confidence   text check (confidence in ('high','medium','low')),
  notes        text,
  reviewed_at  timestamptz,
  reviewed_by  text,
  review       text check (review in ('confirmed','rejected'))
);

create index if not exists sold_check_results_property_checked_idx
  on public.sold_check_results (property_id, checked_at desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.sold_check_properties enable row level security;
alter table public.sold_check_results    enable row level security;

drop policy if exists "sold check props read"   on public.sold_check_properties;
drop policy if exists "sold check props insert" on public.sold_check_properties;
drop policy if exists "sold check props update" on public.sold_check_properties;
drop policy if exists "sold check props delete" on public.sold_check_properties;
create policy "sold check props read"   on public.sold_check_properties for select to authenticated using (true);
create policy "sold check props insert" on public.sold_check_properties for insert to authenticated with check (public.sold_check_can_write());
create policy "sold check props update" on public.sold_check_properties for update to authenticated using (public.sold_check_can_write()) with check (public.sold_check_can_write());
create policy "sold check props delete" on public.sold_check_properties for delete to authenticated using (public.sold_check_can_write());

drop policy if exists "sold check results read"   on public.sold_check_results;
drop policy if exists "sold check results insert" on public.sold_check_results;
drop policy if exists "sold check results update" on public.sold_check_results;
drop policy if exists "sold check results delete" on public.sold_check_results;
create policy "sold check results read"   on public.sold_check_results for select to authenticated using (true);
create policy "sold check results insert" on public.sold_check_results for insert to authenticated with check (public.sold_check_can_write());
create policy "sold check results update" on public.sold_check_results for update to authenticated using (public.sold_check_can_write()) with check (public.sold_check_can_write());
create policy "sold check results delete" on public.sold_check_results for delete to authenticated using (public.sold_check_can_write());

-- ── grants (RLS does the gating) ─────────────────────────────────────────────
revoke all on public.sold_check_properties from anon;
revoke all on public.sold_check_results    from anon;
grant select on public.sold_check_properties, public.sold_check_results to authenticated;
grant insert, update, delete on public.sold_check_properties, public.sold_check_results to authenticated;
grant all on public.sold_check_properties, public.sold_check_results to service_role;

-- ── Confirm: one transaction for the person's decision ───────────────────────
-- SECURITY INVOKER on purpose: both updates run under the caller's RLS, so a
-- viewer's call fails on the policies exactly like a direct write would. The
-- explicit check gives a readable error instead of "0 rows".
--   verdict 'sold'   -> the result is confirmed and the property becomes sold
--                       with the date/price the person saved (edited or as found);
--   verdict 'listed' -> the result is confirmed (the property is on the market)
--                       and its listing_url is filled if empty; status stays.
-- Rejecting needs no function: a plain update of review/reviewed_* on the result.
create or replace function public.sold_check_confirm(p_result uuid, p_sale_date date, p_sale_price numeric)
returns void
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_prop    uuid;
  v_verdict text;
  v_url     text;
  v_who     text := coalesce(auth.jwt() ->> 'email', 'unknown');
begin
  if not public.sold_check_can_write() then raise exception 'sold check: editors only'; end if;
  select property_id, verdict, source_url into v_prop, v_verdict, v_url
    from public.sold_check_results where id = p_result and review is null;
  if v_prop is null then raise exception 'sold check: result not found or already reviewed'; end if;
  if v_verdict not in ('sold', 'listed') then raise exception 'sold check: only sold or listed results are confirmed'; end if;
  if v_verdict = 'sold' then
    update public.sold_check_results
       set review = 'confirmed', reviewed_at = now(), reviewed_by = v_who,
           sale_date = coalesce(p_sale_date, sale_date), sale_price = coalesce(p_sale_price, sale_price)
     where id = p_result;
    update public.sold_check_properties
       set status = 'sold',
           sold_date  = coalesce(p_sale_date, sold_date),
           sold_price = coalesce(p_sale_price, sold_price),
           updated_by = v_who
     where id = v_prop;
  else
    update public.sold_check_results
       set review = 'confirmed', reviewed_at = now(), reviewed_by = v_who
     where id = p_result;
    update public.sold_check_properties
       set listing_url = coalesce(nullif(listing_url, ''), v_url),
           updated_by  = v_who
     where id = v_prop;
  end if;
end;
$$;

revoke execute on function public.sold_check_confirm(uuid, date, numeric) from public, anon;
grant  execute on function public.sold_check_confirm(uuid, date, numeric) to authenticated;
