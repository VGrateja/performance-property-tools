-- =============================================================================
-- 098 — Google Slides change watch
--
-- Lets an editor ATTACH a Google Slides link to a specific hub slide (or to a
-- whole deck / library card). A scheduled monitor (scripts/gslides-watch.mjs,
-- .github/workflows/gslides-watch.yml) then polls each linked Google file and
-- records WHAT CHANGED, so the hub can put a red mark on the hub slide the
-- link is attached to.
--
-- Why a human attaches the link instead of us deriving it: hub decks and their
-- Google counterparts are NOT page-for-page copies (the Google Buying decks run
-- 19-22 slides against 34-39 hub pages), so no automatic page correspondence
-- exists. The attach point IS the mapping.
--
-- Three tables, three different write authorities:
--   gslides_links  — the attachments.       authenticated read / is_writer() write
--   gslides_files  — monitor state.         authenticated read / service-role write only
--   gslides_seen   — per-user acknowledge.  own rows only (the desktop_pins idiom)
-- =============================================================================

-- ── the attachment: one hub slide -> one Google Slides target ────────────────
create table if not exists public.gslides_links (
  id          uuid primary key default gen_random_uuid(),
  scope       text        not null,            -- 'deck' (presentation_decks) | 'bss' | 'library'
  deck_key    text        not null,            -- deck id / 'bss-<slug>-<mode>' / library card url
  slide_key   text        not null default '', -- hub slide id; '' = the deck as a whole
  file_id     text        not null,            -- Google Drive file id
  page_id     text,                            -- Google page objectId when the link targets ONE page
                                               -- (parsed from #slide=id.<objectId>); null = whole deck
  source_url  text        not null,            -- exactly what the editor pasted
  label       text,                            -- optional note ("June deck, page 7")
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id),
  constraint gslides_links_scope_chk check (scope in ('deck','bss','library')),
  constraint gslides_links_one_per_slide unique (scope, deck_key, slide_key)
);
create index if not exists gslides_links_file_idx on public.gslides_links (file_id);
create index if not exists gslides_links_deck_idx on public.gslides_links (scope, deck_key);

alter table public.gslides_links enable row level security;

drop policy if exists "gslides_links read" on public.gslides_links;
create policy "gslides_links read" on public.gslides_links
  for select to authenticated using (true);

drop policy if exists "gslides_links write" on public.gslides_links;
create policy "gslides_links write" on public.gslides_links
  for insert to authenticated with check (public.is_writer());

drop policy if exists "gslides_links update" on public.gslides_links;
create policy "gslides_links update" on public.gslides_links
  for update to authenticated using (public.is_writer()) with check (public.is_writer());

drop policy if exists "gslides_links delete" on public.gslides_links;
create policy "gslides_links delete" on public.gslides_links
  for delete to authenticated using (public.is_writer());


-- ── monitor state: ONE row per watched Google file (many links may share it) ─
create table if not exists public.gslides_files (
  file_id         text primary key,
  google_title    text,
  slide_count     int,
  revision_id     text,                         -- the cheap change GATE (Slides API revisionId)
  content_stamp   text,                         -- hash over all page hashes in order = deck fingerprint
  page_hashes     jsonb not null default '{}'::jsonb,   -- { <objectId>: <sha1> }
  page_order      jsonb not null default '[]'::jsonb,   -- [ <objectId>, ... ] in deck order
  page_titles     jsonb not null default '{}'::jsonb,   -- { <objectId>: "Vacancy Rate v Rent" }
  changed_pages   jsonb not null default '[]'::jsonb,   -- [{objectId,index,title,kind}] from the LAST change
  last_checked_at timestamptz,
  last_changed_at timestamptz,
  error_text      text,                         -- last transient failure (never clears a fingerprint)
  error_at        timestamptz
);

alter table public.gslides_files enable row level security;

-- read for everyone signed in; NO write policy at all -> only the service-role
-- monitor can write (the migration-094 telemetry idiom).
drop policy if exists "gslides_files read" on public.gslides_files;
create policy "gslides_files read" on public.gslides_files
  for select to authenticated using (true);


-- ── per-user acknowledge, keyed on the CONTENT stamp ─────────────────────────
-- Storing the stamp (not a counter/boolean) means an edit-then-revert in Google
-- clears itself: the stamp returns to the value the user already acknowledged.
create table if not exists public.gslides_seen (
  user_id    uuid not null references auth.users(id) on delete cascade,
  link_id    uuid not null references public.gslides_links(id) on delete cascade,
  seen_stamp text not null,
  seen_at    timestamptz not null default now(),
  primary key (user_id, link_id)
);

alter table public.gslides_seen enable row level security;

drop policy if exists "gslides_seen own select" on public.gslides_seen;
create policy "gslides_seen own select" on public.gslides_seen
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "gslides_seen own insert" on public.gslides_seen;
create policy "gslides_seen own insert" on public.gslides_seen
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "gslides_seen own update" on public.gslides_seen;
create policy "gslides_seen own update" on public.gslides_seen
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "gslides_seen own delete" on public.gslides_seen;
create policy "gslides_seen own delete" on public.gslides_seen
  for delete to authenticated using (user_id = auth.uid());
