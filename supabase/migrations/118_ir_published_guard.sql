-- =============================================================================
-- 118_ir_published_guard.sql — close two loopholes in the published-IR
-- delete protection that a production audit proved exploitable (2026-08-23).
--
-- CONTEXT. Mig 117 made "only the dev tier may DELETE a published IR" and the
-- IR Builder cascades the IR Library row + report PDF on delete. An adversarial
-- probe as a non-dev writer (company tier + ir-builder grant) broke both:
--
--   LOOPHOLE 1 — bypass the dev-only delete. ir_files_update is gated only on
--     ir_can_write(), so a non-dev writer could UPDATE a published file to
--     strip compliance.published, which flips the DELETE policy's
--     `compliance->'published' IS NULL` branch to TRUE, then delete it. The
--     direct delete was blocked; the two-step route was not.
--
--   LOOPHOLE 2 — the cascade lived only in ir-builder.html JS, so ANY delete
--     off the button (the bypass above, or a raw dev API delete) orphaned the
--     investment_reports row (a ghost in IR Library + Documents) and the PDF.
--
-- FIX. Move both guarantees into the database, where no path can dodge them.
--   • A BEFORE UPDATE guard: only the dev tier may clear an existing publish
--     stamp. Re-publish keeps a non-null stamp, and flip-back-to-active only
--     touches `status` — both are unaffected. This closes loophole 1's first
--     step, so the bypass can't start.
--   • A BEFORE DELETE cascade: when the row being deleted was published, its
--     IR Library row (which IS the Documents "Example Investment Reports"
--     entry — that folder reads investment_reports live) goes in the SAME
--     transaction, atomically, for EVERY delete path. This closes loophole 2
--     for the visible surfaces and makes the client-side library-row cascade
--     redundant (removed in ir-builder.html).
--
-- WHY THE PDF ISN'T DELETED HERE. Supabase forbids direct SQL deletes on
-- storage.objects ("Use the Storage API instead", errcode 42501) to prevent
-- orphaned files — a trigger that tried it aborted the whole delete. So the
-- report PDFs under published/<id>/ are removed by the Builder via the Storage
-- API right after the row delete. That path is safe because loophole 1 is now
-- closed: ONLY the dev tier can delete a published IR, and it does so through
-- the UI. (A dev deleting via raw API would leave the PDF bytes behind, but
-- with no library row referencing them and an unguessable uuid path they are
-- effectively unreachable — and no visible surface shows them.)
--
-- The cascade is SECURITY DEFINER so it runs as its owner (postgres, which has
-- BYPASSRLS) and can always remove the library row regardless of who deletes;
-- the guard needs no elevation. Neither is reachable as an RPC (they return
-- `trigger`), but per the mig-115 rule new definer functions carry their own
-- anon/public revokes anyway.
--
-- Run order: after 117_ir_files_delete_policy.sql.
-- =============================================================================

-- ── Loophole 1: only dev may un-publish (null out the stamp) ─────────────────
create or replace function public.ir_guard_unpublish()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (old.compliance -> 'published') is not null
     and (new.compliance -> 'published') is null
     and public.current_tier() <> 'dev' then
    raise exception 'Only a developer can un-publish an IR (delete published IRs from the Builder instead).'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
-- trigger functions fire via the trigger mechanism, which needs no EXECUTE
-- grant on the invoking user — so revoke it from everyone to keep them off the
-- RPC surface (the mig-115 rule; the advisor flags any lingering grant).
revoke execute on function public.ir_guard_unpublish() from public, anon, authenticated;

drop trigger if exists trg_ir_guard_unpublish on public.ir_files;
create trigger trg_ir_guard_unpublish
  before update on public.ir_files
  for each row execute function public.ir_guard_unpublish();

-- ── Loophole 2: cascade the downstream artifacts on delete, every path ───────
create or replace function public.ir_cascade_published_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lib uuid := nullif(old.compliance -> 'published' ->> 'libraryId', '')::uuid;
begin
  if (old.compliance -> 'published') is not null then
    -- the IR Library row IS the Documents "Example Investment Reports" entry
    -- (that folder reads investment_reports live). Prefer the exact stamped id;
    -- fall back to the source+address match doPublish itself uses, but only
    -- when no id was stamped (address alone can match siblings).
    if v_lib is not null then
      delete from public.investment_reports where id = v_lib;
    else
      delete from public.investment_reports
        where source = 'ir-builder' and address ilike old.address || '%';
    end if;
    -- the report PDFs under published/<old.id>/ are removed by the client via
    -- the Storage API (Supabase blocks direct SQL deletes on storage.objects);
    -- see the header note.
  end if;
  return old;
end;
$$;
revoke execute on function public.ir_cascade_published_delete() from public, anon, authenticated;

drop trigger if exists trg_ir_cascade_published_delete on public.ir_files;
create trigger trg_ir_cascade_published_delete
  before delete on public.ir_files
  for each row execute function public.ir_cascade_published_delete();
