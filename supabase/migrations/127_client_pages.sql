-- =============================================================================
-- 127_client_pages.sql — published client pages (first page: "Adelaide returns")
--
-- The ask. Research meeting 2026-10-14 (the research head, relayed by Van): a
-- client-facing page showing what Performance Property's Adelaide purchases did
-- for a client's deposit against shares, bonds, A-REITs, cash and the property
-- market — and "the numbers behind the scenes might change … we might change
-- the assumptions", so every figure, label and sentence is edited in the hub
-- without a code change.
--
-- The mechanism.
--   client_pages   one row per published client page, keyed by a stable text
--                  key (first row: 'adelaide-returns-2026'). payload = the whole
--                  page as one jsonb document (figures, benchmark tables, text,
--                  legal notices) — the schema is described in
--                  docs/pp-os-migration/adelaide-returns.md.
--   Written by the Vault editor tools/adelaide-returns.html; read by the public
--   page client/adelaide-returns.html, which has NO sign-in.
--
-- Access.
--   read    anon AND authenticated (using (true)). THESE ROWS ARE PUBLISHED
--           CLIENT CONTENT: anyone on the internet with the anon key can read
--           every row. Nothing private may ever go in this table — no client
--           names, addresses, individual prices, internal notes or drafts that
--           are not ready to be seen. Market-level and aggregate figures only.
--   write   insert / update for authenticated writers only (is_writer() =
--           dev/admin). anon can never write.
--   delete  no policy — nobody deletes through the API (service role only).
-- =============================================================================

create table if not exists public.client_pages (
  key         text primary key check (key ~ '^[a-z0-9][a-z0-9-]*$'),
  payload     jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

comment on table public.client_pages is
  'Published client pages (one jsonb payload per page key). PUBLIC: readable by anon — never store anything private here.';

-- updated_at on every write; updated_by = the signed-in editor's email when
-- there is one (the page sends it too, but the JWT is the trustworthy source).
-- Not touch_updated_at(): that one writes auth.uid() into updated_by.
create or replace function public.client_pages_touch() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.jwt() ->> 'email', new.updated_by);
  return new;
end;
$$;

revoke execute on function public.client_pages_touch() from public, anon, authenticated;

drop trigger if exists trg_client_pages_touch on public.client_pages;
create trigger trg_client_pages_touch
  before insert or update on public.client_pages
  for each row execute function public.client_pages_touch();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.client_pages enable row level security;

drop policy if exists "client pages read"   on public.client_pages;
drop policy if exists "client pages insert" on public.client_pages;
drop policy if exists "client pages update" on public.client_pages;
-- Public read on purpose: published client content (see the header).
create policy "client pages read"   on public.client_pages for select to anon, authenticated using (true);
create policy "client pages insert" on public.client_pages for insert to authenticated with check (public.is_writer());
create policy "client pages update" on public.client_pages for update to authenticated using (public.is_writer()) with check (public.is_writer());
-- No delete policy: rows are not deleted through the API.

-- ── grants (RLS does the gating) ─────────────────────────────────────────────
revoke all on public.client_pages from anon, authenticated;
grant select on public.client_pages to anon;
grant select, insert, update on public.client_pages to authenticated;
grant all on public.client_pages to service_role;
