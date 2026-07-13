-- ============================================================================
-- 078_report_pdf_links.sql
--
-- Single-row store for report PDF *shareable* links, captured at download time.
--
-- Why: the online-reports tool names each downloaded PDF with a RANDOM suffix
-- (buildEditionFilename → "…-vwpgv11"), and those files are uploaded to Google
-- Cloud Storage under docs.performanceproperty.com.au. The GCS URL therefore
-- can't be derived ahead of time — the ONLY moment the exact filename exists is
-- when the tool generates it for a download. So the tool records the full GCS
-- URL right then, into this table. The Documents tool ("PDF Reports" folder)
-- reads it and overlays these permanent GCS links (with a Copy Link button)
-- over the expiring Supabase fallback links.
--
-- payload shape (keyed by report slug; lite entries keyed "lite:<slug>"):
--   { "adelaide": { slug, lite, edition, year, url, date, at }, … }
--
-- RLS mirrors the other single-row state tables (001_init): any authenticated
-- user reads; only writers (dev/admin) write. Guests/company can't download, so
-- can't write anyway.
--
-- How to apply: Supabase dashboard → SQL Editor → paste → Run. Idempotent.
-- ============================================================================

create table if not exists public.report_pdf_links (
  id          int          primary key default 1 check (id = 1),
  payload     jsonb        not null default '{}'::jsonb,
  updated_at  timestamptz  not null default now(),
  updated_by  uuid         references public.profiles(id)
);

-- Reuse the shared updated_at/updated_by touch trigger from 001_init.
drop trigger if exists trg_report_pdf_links_updated_at on public.report_pdf_links;
create trigger trg_report_pdf_links_updated_at
  before update on public.report_pdf_links
  for each row execute function public.touch_updated_at();

alter table public.report_pdf_links enable row level security;

drop policy if exists "authenticated read report_pdf_links" on public.report_pdf_links;
drop policy if exists "writers update report_pdf_links"     on public.report_pdf_links;
drop policy if exists "writers insert report_pdf_links"     on public.report_pdf_links;

create policy "authenticated read report_pdf_links" on public.report_pdf_links
  for select to authenticated using (true);
create policy "writers update report_pdf_links"     on public.report_pdf_links
  for update to authenticated using (public.is_writer());
create policy "writers insert report_pdf_links"     on public.report_pdf_links
  for insert to authenticated with check (public.is_writer());

-- Seed the singleton row so the first upsert has something to update.
insert into public.report_pdf_links (id) values (1) on conflict (id) do nothing;

-- Verify:
--   select id, payload from public.report_pdf_links;   -- {} until first download
