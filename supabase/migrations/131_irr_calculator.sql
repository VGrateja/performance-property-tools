-- 131: the IRR Calculator — the shared book and its change log.
--
-- Two tables, like 126_sold_check.sql: the thing, and what people did to it.
--
--   irr_book  one row per capital-city book ('adelaide', 'brisbane', …).
--             `body` is the whole register exactly as the tool already
--             stores it — properties[] (archived and outside-of-advice
--             entries included, carrying outside/outsideReason), plus the
--             assumptions block and a rev stamp. Nothing about the
--             document's shape is new here, so the move is a copy.
--
--   irr_log   one row per change. Separate from the book on purpose: the
--             book is overwritten on every save, so a log kept inside it
--             would be rewritten by the next edit.
--
-- READS ARE WRITERS ONLY on both, deliberately. The book carries real client
-- addresses and purchase prices, and the log carries property names in
-- `property` and `detail`. sold_check_properties holds the same addresses
-- under a read-for-any-authenticated policy; these start narrower so that
-- widening is a decision somebody makes rather than one inherited by copying
-- a pattern. Widening later is the two read policies, marked below.

-- ── the book ──────────────────────────────────────────────────────────────

create table if not exists public.irr_book (
  id          text primary key check (btrim(id) <> '' and id = lower(btrim(id))),
  body        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- updated_by is the editor's email, set here rather than by touch_updated_at()
-- (which writes auth.uid()), matching sold_check_properties_touch().
create or replace function public.irr_book_touch() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.jwt() ->> 'email', new.updated_by);
  return new;
end $$;

drop trigger if exists trg_irr_book_touch on public.irr_book;
create trigger trg_irr_book_touch
  before insert or update on public.irr_book
  for each row execute function public.irr_book_touch();

-- ── the change log ────────────────────────────────────────────────────────
-- The tool inserts { who, action, property, detail } and lets id and at
-- default; it reads the latest 300 ordered by at. `detail` is sometimes a
-- JSON string (the History tab parses it to find the property's category),
-- so it stays text rather than jsonb — the tool writes both shapes.

create table if not exists public.irr_log (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  who       text,
  action    text not null,
  property  text,
  detail    text
);

create index if not exists irr_log_at_idx on public.irr_log (at desc);

-- ── who may write ─────────────────────────────────────────────────────────
-- dev/admin, or an 'irr-calculator' editor grant: the scorecards /
-- sold-check tool-scoped pattern.
create or replace function public.irr_calculator_can_write() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.is_writer() or public.has_tool_role('irr-calculator', 'editor'), false);
$$;

alter table public.irr_book enable row level security;
alter table public.irr_log  enable row level security;

drop policy if exists "irr book read"   on public.irr_book;
drop policy if exists "irr book insert" on public.irr_book;
drop policy if exists "irr book update" on public.irr_book;
drop policy if exists "irr log read"    on public.irr_log;
drop policy if exists "irr log insert"  on public.irr_log;

-- To open reading to all signed-in staff later, these two policies become
--   using (true)
-- and nothing else changes.
create policy "irr book read"   on public.irr_book for select to authenticated
  using (public.irr_calculator_can_write());
create policy "irr book insert" on public.irr_book for insert to authenticated
  with check (public.irr_calculator_can_write());
create policy "irr book update" on public.irr_book for update to authenticated
  using (public.irr_calculator_can_write()) with check (public.irr_calculator_can_write());
-- No DELETE on the book: a city is renamed or emptied from the UI, never
-- dropped.

create policy "irr log read"    on public.irr_log for select to authenticated
  using (public.irr_calculator_can_write());
create policy "irr log insert"  on public.irr_log for insert to authenticated
  with check (public.irr_calculator_can_write());
-- No UPDATE or DELETE on the log, by design: it is the record of what was
-- done, and the tool only ever appends to it.

revoke all on public.irr_book from anon;
revoke all on public.irr_log  from anon;
grant select, insert, update on public.irr_book to authenticated;
grant select, insert         on public.irr_log  to authenticated;
grant usage, select on sequence public.irr_log_id_seq to authenticated;

-- The tool subscribes to postgres_changes on the book so one person's edit
-- reaches another's open tab without a reload. Adding a table twice raises,
-- so this is guarded.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'irr_book'
  ) then
    alter publication supabase_realtime add table public.irr_book;
  end if;
end $$;
