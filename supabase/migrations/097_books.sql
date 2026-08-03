-- 097_books.sql
--
-- Bookshelf (tools/bookshelf.html): one row per book.
--
-- WHY A TABLE AND NOT REPO FILES: the strategy content is marked
-- Confidential and the Pages repo is PUBLIC — book content must never be
-- committed. The reader fetches the payload at runtime behind auth, same
-- confidentiality model as reports_state / documents_state. Adding a book
-- later = one INSERT (scratch seed script or a future admin UI); the shelf
-- lists whatever rows exist.
--
-- payload shape (built by scratch/book-src/_build-playbook2.mjs):
--   { slug, title, subtitle, publisher, edition, confidential,
--     chapters:[{n,slug,title,tag}], toc:[{n,title,page,sections:[…]}],
--     tocPage, flowPage, flow:{q:[…],ends:{…}},  -- decision-tree definition
--     assets:{clock:dataURI}, pages:[{kind:cover|title|flow|toc|chapter|content|end, …}] }

create table public.books (
  slug       text primary key,
  title      text not null,
  subtitle   text,
  sort       integer not null default 100,
  cover      jsonb,             -- shelf-card hints {accent, icon} (cover itself renders from payload)
  payload    jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.books enable row level security;

-- every signed-in staff member can read; the hub's group gating decides who
-- sees the tool at all (registry key 'bookshelf')
create policy "books_read" on public.books
  for select to authenticated using (true);

-- writes: dev/admin only (seeding happens via service role, which bypasses RLS)
create policy "books_write" on public.books
  for all to authenticated
  using (public.is_writer()) with check (public.is_writer());
