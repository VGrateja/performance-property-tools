# Online Reports — monthly PDF renderer

The `tools/online-reports.html` tool now ships pre-built PDFs to Supabase Storage so users get instant downloads instead of waiting 30+ seconds for the in-browser html2canvas exporter.

Rendering happens server-side once a month via a GitHub Actions workflow that drives headless Chrome (Puppeteer) and Chrome's native `page.pdf()` — vector text, smaller files, sharper output than the rasterized in-browser path.

## How the pieces fit

```
┌─────────────────────────┐    ┌────────────────────────┐
│  GitHub Actions (12th   │    │  Supabase Storage      │
│  of month, 03:00 UTC)   │───▶│  bucket: online-reports│
│  scripts/render-        │    │  {YYYY-MM}/{slug}.pdf  │
│  reports.mjs            │    │  + .../lite/{slug}.pdf │
└─────────────────────────┘    └─────────┬──────────────┘
                                         │ public read
                       ┌─────────────────┴─────────────────┐
                       │                                   │
                ┌──────▼──────────┐               ┌────────▼─────────┐
                │  Supabase tool  │               │  Netlify tool    │
                │  (staff)        │               │  (public)        │
                │  fetch via      │               │  fetch via       │
                │  window.sb      │               │  HEAD + GET      │
                └─────────────────┘               └──────────────────┘
```

When a user clicks **Download PDF** for the current region with "All pages" ticked, the page checks the bucket first; if there's a current-month file it downloads in <2 seconds, otherwise it falls back to the live in-browser exporter so nobody ever sees an error.

A small toolbar pill — **Cached <date>** or **Live render** — tells the user which mode is active before they click.

## One-time setup

You need to do these three steps once. After that, the workflow runs itself monthly.

### 1. Apply the storage bucket migration

```bash
supabase db push
```

or paste `supabase/migrations/017_online_reports_storage.sql` into the SQL Editor. This creates the public bucket and the RLS policies.

### 2. Create the renderer service account

The renderer signs in to Supabase as a dedicated user so we don't store anyone's personal credentials in GitHub Secrets.

1. **Supabase dashboard → Authentication → Users → Add user**
   - Email: `pdf-renderer@performanceproperty.com.au`
   - Password: generate a long random one (save it for step 3)
   - Skip the confirmation email.
2. **SQL Editor → run:**
   ```sql
   update public.profiles
   set tier   = 'company',
       status = 'active'
   where email = 'pdf-renderer@performanceproperty.com.au';
   ```
   `'company'` is the staff tier (see migration 001's check constraint:
   `tier in ('dev','admin','company','client','guest')`). It's enough — the
   renderer just needs to read region data. Don't promote it to admin; the
   service-role key handles all bucket writes.

### 3. Add the GitHub Secrets

Repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | `https://cannojsxduvlewimwoxa.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → `service_role` key |
| `SUPABASE_ANON_KEY` | Project Settings → API → `anon` / publishable key |
| `PDF_RENDERER_EMAIL` | `pdf-renderer@performanceproperty.com.au` |
| `PDF_RENDERER_PASSWORD` | The password you set in step 2 |
| `APP_URL` | The deploy host serving `tools/online-reports.html` (no trailing slash) |

The `APP_URL` is whichever environment you want Chrome to render from. Most likely the production deploy of *this* repo — wherever `tools/online-reports.html` lives that has the freshest CoreLogic data.

## Running it

**Wait for the cron** — fires on the 12th of every month at 03:00 UTC. Two days after the 10th-of-month CoreLogic data refresh.

**Or trigger manually:** Repository → Actions → **Render Online Reports PDFs** → **Run workflow**. Use this after a mid-month data correction.

A run takes ~10–15 minutes for all 72 PDFs (36 regions × full + lite). When it finishes you'll see green ticks in the Actions tab, and reloading `online-reports.html` on any region should show **Cached <today>** in cyan next to the PDF/JPG button.

## Storage retention

The renderer keeps two months: the one it just wrote plus the previous one. Anything older is pruned at the end of every successful run.

If you ever need to force a clean slate, you can delete the whole `online-reports` bucket from the Supabase dashboard and the next workflow run will recreate it.

## Local testing

If you want to dry-run the renderer locally before trusting CI:

```bash
cp .env.example .env
# fill in the values from your password manager + Supabase dashboard
npm install
npm run render-reports
```

Output ends up in the same bucket. Safe to run repeatedly — `upsert: true` overwrites each path.

## Troubleshooting

**"Sign-in failed: Invalid login credentials"**
The service account email/password in Secrets doesn't match Supabase. Reset the password from Authentication → Users, update the GitHub Secret, re-run.

**"Timed out waiting for PPA_LIVE_BOOT_DONE"**
The page didn't signal it's ready within 90 s. Usually means the Apps Script feed is slow (cold start) or the deploy at `APP_URL` is broken. Manual re-run usually clears it.

**Most regions OK, a few failed**
The renderer doesn't abort on a single-region failure — it reports them at the end. Manual re-run will retry those (the successful uploads from the first run stay, the failed ones get fresh attempts).

**Toolbar pill stays on "Live render" even after a successful workflow**
Hard-refresh the page (Cmd/Ctrl + Shift + R). The pill reads from `storage.list()` which is cached briefly per page load.

## Maintenance

If you add or rename a region in `REGION_MANIFEST` (inside `tools/online-reports.html`), update the matching list at the top of `scripts/render-reports.mjs` too. They're not auto-synced because the renderer can't run JS from the HTML file without booting Chrome — and at boot time the manifest comes from the data feed, which is what we're trying to render.
