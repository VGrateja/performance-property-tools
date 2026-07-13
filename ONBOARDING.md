# Onboarding — Performance Property Analytics Hub

Welcome! This gets you from zero to your first pull request. For the full
architecture, read **`CLAUDE.md`** in the repo root — this doc is the *setup +
workflow* companion to it. If you use Claude Code, both files orient it for you.

The live site is **tools.performanceproperty.com.au** (GitHub Pages, from the
`main` branch). It's a **static, no-build** app — hand-written HTML/CSS/JS, one
big self-contained HTML file per tool, shared code in `shared/`. There is **no
bundler or framework**: edit a file, commit, deploy. Dynamic state lives in
**Supabase**.

---

## 1. Prerequisites (Van sets these up for you)

- **GitHub:** you're added as a collaborator on `VGrateja/performance-property-tools`.
  Accept the email invite. `main` is **branch-protected** — you cannot push to it
  directly; all your work lands via pull request + Van's approval.
- **Node.js** 18+ and **git** installed.
- **App login:** sign in once at the live site with your `@performanceproperty.com.au`
  Google account so a profile row exists; ask Van to bump your tier to `admin`
  (or `dev`) so you can see every section while developing.
- **Supabase:** Van adds you to the project (`cannojsxduvlewimwoxa`) if you'll
  apply migrations or inspect tables.
- **Service-role key (only if you'll run data ingests):** Van sends it via a
  password manager — **never** by email/Slack/file copy, and **never commit it.**

---

## 2. First-time setup

```bash
# 1. Clone YOUR authenticated copy (not a folder copy from Van's machine —
#    you want your own git identity + a clean tree)
git clone https://github.com/VGrateja/performance-property-tools.git
cd performance-property-tools

# 2. Install the Node deps (only used by scripts/ — the site itself has none)
npm install

# 3. Run a local static server (any will do). Examples:
npx serve . -l 5500
#   or VS Code "Live Server" on index.html
```

Open **http://localhost:5500/index.html** and sign in. The app talks to Supabase
through the **public anon key already in `shared/supabase-client.js`** — security
is Row-Level Security, so you need no secrets just to run and develop the tools.

**`.env` — only if you'll run `scripts/` ingests.** Create it in the repo root:

```
SUPABASE_URL=https://cannojsxduvlewimwoxa.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<from Van, via password manager>
```

It's gitignored. Never commit it. The service-role key bypasses RLS entirely —
treat it like a production password.

---

## 3. Daily workflow (this is important)

```bash
git checkout main && git pull        # start fresh
git checkout -b tl/fix-value-signal  # a short, scoped branch
# ... make your change ...
node scripts/stamp-shared-assets.mjs # ONLY if you edited anything in shared/
git add -A && git commit -m "..."
git push -u origin tl/fix-value-signal
gh pr create                         # or open the PR on github.com
```

Then **Van reviews and approves** — nothing reaches `main` (and the live site)
without his sign-off. Keep PRs **small and single-purpose**; they review far more
reliably than a giant diff, and they avoid conflicts (see §5).

You never touch deploys or the GitHub Pages build — that's Van's step after merge.

---

## 4. Must-know gotchas

- **Cache-bust after editing `shared/`.** GitHub Pages + browsers cache
  `shared/*.css` / `shared/*.js`. After changing any file in `shared/`, run
  `node scripts/stamp-shared-assets.mjs` before committing — it rewrites the
  `?v=<hash>` query strings so returning users get the new file. Skipping this
  makes the live site silently serve stale shared code.
- **Security is RLS, never client-side.** The in-page anon key is public by
  design. Never add a service-role key to any browser file. DB writes require
  `is_writer()` (dev/admin) — enforced by the database, not the UI.
- **Migrations are applied by hand, by Van.** Put schema changes in
  `supabase/migrations/NNN_name.sql` (next number in sequence) and mention them
  in your PR. Don't assume a migration is live until Van applies it.
- **Tier gating must stay symmetric across tiers** — never write a hub
  visibility/gating function as one-tier-only (it has frozen the hub before).
  Gate the dock/nav + CSS instead. See `CLAUDE.md` → Working rules.
- **Don't copy Van's whole folder to your machine** — it carries his `.env`
  secret, 60 MB of machine-specific `node_modules`, and local clutter. Always
  clone fresh (§2).

---

## 5. Files you'll share with Van — coordinate before editing

Your work touches a few files Van also edits. A quick heads-up before you start,
plus small PRs, avoids painful merge conflicts on these:

- **`index.html`** — the hub/desktop. You edit it to wire a **new tool** into the
  dock (`APPS` config + a dock icon).
- **`tools/data-forge.html`** — you edit the `CLUSTERS` config to register a
  **new Forge data point**.
- **`shared/traffic-lights-engine.js`** — the Traffic Lights scoring logic,
  shared by the tool + the Data Forge preview.

---

## 6. Recipe — add or edit a Forge data point

1. **Ingest script** in `scripts/`. Copy **`scripts/ingest-abs-cpi.mjs`** as your
   template — it's the house pattern:
   - **Dry-run by default; `--write` to persist.** New scripts should do
     download → parse → compute → **print a summary** with no DB access, so you
     can dry-run them **without the service key**. Only `--write` needs the key.
   - **Upsert-only, never delete** (unless you're deliberately replacing a whole
     series — CPI does, and says so). Preserve rows the source no longer covers.
   - Write to `rdp_raw_series` with `(source, region_slug, metric, freq, period)`
     and record status in `forge_data_status`.
2. **Dry-run it:** `node scripts/ingest-xyz.mjs` — eyeball the printed numbers.
3. **Register it** in `tools/data-forge.html` → the `CLUSTERS` array (key, icon,
   `ingest` kind, label, desc, `view`) and add its `renderSeriesView` loader.
4. **Schema change?** Add `supabase/migrations/NNN_*.sql`; Van applies it.
5. **PR the script + Forge changes.** After Van approves, the `--write` to
   production is run with the service key (you, coordinating with Van — or Van).
6. Verify the card in Data Forge once the data lands.

---

## 7. Recipe — add a new tool (the "Performance OS" way)

Every tool wears the same OS chrome. Don't hand-roll a header.

1. Copy an existing reskinned tool as a skeleton (e.g. `tools/traffic-lights.html`
   or `tools/vr-projection.html`).
2. In `<head>`, load the OS chrome + theme (they're cache-busted `shared/` assets):
   `shared/os-chrome.js` + `shared/os-theme.css`, plus the Figtree font link.
   Drop any old `theme.js` include — os-chrome is the single theme writer.
3. At the top of `<body>`, add the wallpaper + the uniform app bar:
   `<div class="wall scrim"></div>` then `PP_OS.initChrome({ name: '...', section:
   '...', backHref: '../index.html' })`. Section is one of analytics / vault / pm /
   arena / docs / present / people (sets the accent + chip).
4. Point the body background to transparent so the wallpaper shows through.
5. Wire it into `index.html` → the `APPS` config for its section (give it a
   per-tool icon), so it appears in that section's window.
6. `node scripts/stamp-shared-assets.mjs`, commit, PR.

Reduced-motion, light/dark, and export-safety are already handled by the OS
layer — match an existing tool and you inherit them.

---

## 8. Getting help

- **`CLAUDE.md`** — architecture, tiers, pipelines, the full gotcha list.
- **Claude Code** — point it at the repo; it reads `CLAUDE.md` + this file and
  can walk you through setup, reviews, and the recipes above.
- **Van** — anything about scope, data correctness, or what to work on next.
