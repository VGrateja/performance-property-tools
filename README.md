# Performance Property — Analytics Hub

Internal, staff-only web app for Performance Property (Australian property
research). A static, **no-build** multi-tool site: hand-authored HTML/CSS/JS,
one self-contained page per tool, shared code in `shared/`.

- **Live:** https://tools.performanceproperty.com.au (GitHub Pages)
- **Backend:** Supabase — auth, Postgres + Row-Level Security, storage, realtime
- **No bundler, transpiler or framework.** Edit a file, commit, Pages redeploys.

## Layout

```
index.html            the hub (login + Performance OS desktop)
tools/                one HTML file per tool
shared/               auth, supabase client, report editor, theme, telemetry, css
supabase/migrations/  numbered SQL, applied to the shared Supabase project
supabase/functions/   Deno edge functions (notifications)
scripts/              Node maintenance: Forge ingests, monthly PDF renderer, seeds
.github/workflows/    scheduled data gathers, PDF render, reminders
docs/                 pipeline + renderer reference
```

`package.json` dependencies exist for `scripts/` only — the site itself loads
its third-party libraries per page from CDNs.

## Working on it

Read **`CLAUDE.md`** first. It is the current, maintained description of the
architecture, the access model, the data pipelines and the conventions this
repo expects — cache-busting shared assets, migration numbering, deploy steps.
This README is the short version; `CLAUDE.md` is the source of truth.

Serve the folder over HTTP to develop; `file://` breaks sessionStorage, the CDN
loads and Supabase auth.

## Access model

Two independent axes, both on `public.profiles`:

- **Groups** (`hub_groups.tools` + `profiles.team`) decide which tools a person
  can see.
- **Roles** (`profiles.tier` + `public.tool_roles`) decide whether they can edit
  or only view.

Access is enforced by **Row-Level Security in Postgres**, never by client-side
checks. The Supabase anon key in the page is public by design; it grants
nothing on its own.
