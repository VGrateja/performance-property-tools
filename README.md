# Performance Property — Analytics Hub

This is the split-out, multi-file version of the original single-page
`Performance_Property_Hub.html`. It's structured for Netlify deployment and
easy local editing.

## What's inside

```
performance-property/
├── index.html                  Login screen + hub landing page
├── _redirects                  Netlify SPA fallback
├── assets/
│   └── logo.png                Brand logo (used site-wide)
├── shared/
│   ├── common.css              Brand tokens, login, hub, back button styles
│   ├── auth.js                 All auth/OTP/tier-switcher helpers (loaded on every page)
│   └── auth-gate.js            Redirects tool pages to /index.html if not signed in
├── tools/
│   ├── property-clock.html     Property Clock tool
│   ├── runway-demand.html      Runway v Demand tool
│   └── demand-score.html       Demand Score Dashboard (live data)
└── README.md                   You are here
```

## How users navigate the app

1. Land on `index.html` → sees login screen.
2. Log in → login screen is hidden, hub landing appears with three tool cards.
3. Click a tool card → browser navigates to `tools/<tool>.html`.
4. Click "Back to Hub" on any tool → returns to `index.html`.
5. Auth state lives in `sessionStorage` — it persists across pages within the
   same browser tab, and clears when the tab closes.
6. If someone opens a tool URL directly without signing in, `auth-gate.js`
   notices the missing session and redirects them to `index.html`.

## Access tiers

The same four tiers from the original single-file app:

| Tier | Who                         | How they sign in                |
|------|-----------------------------|---------------------------------|
| 0    | Dev (super-admin)           | Username + password (Van)       |
| 1    | Performance Property staff  | @performanceproperty.com.au + OTP |
| 2    | Company-wide (named admins) | Listed in `ADMIN_EMAILS` + OTP  |
| 3    | External viewers            | Self-registration, limited UI   |

All auth constants live at the top of `shared/auth.js` — search for
`TIER0_USERNAME`, `ADMIN_EMAILS`, `ALLOWED_DOMAIN`, `PASS`, and the EmailJS
keys. They're hard-coded intentionally so there's no build step; if you ever
want to rotate credentials, just edit that file.

## Testing locally

You can't just double-click `index.html` — modern browsers block
`sessionStorage`, external script loading, and EmailJS when pages are served
over the `file://` protocol. You need a local web server. Two easy options:

### Option A — VS Code Live Server

1. Install the extension **Live Server** by Ritwick Dey from the
   VS Code marketplace.
2. Open the `performance-property/` folder in VS Code.
3. Right-click `index.html` → **Open with Live Server**.
4. Your browser opens to something like `http://127.0.0.1:5500/index.html`.
5. Log in, click tools, test the flows.

Any edit to any file will auto-reload the page — great for iterating.

### Option B — Python's built-in server

Open a terminal in the `performance-property/` folder and run:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/` in your browser. Ctrl+C in the terminal
stops the server.

## Deploying to Netlify

### Simplest: drag-and-drop

1. Go to <https://app.netlify.com/drop>.
2. Drag the **entire** `performance-property/` folder onto the page.
3. Netlify gives you a URL like `https://swift-panda-12345.netlify.app`.
4. Sign in and check it works.

To deploy an update, drag the folder again — Netlify creates a new version
and hands out the same URL.

### Nicer: Git-connected continuous deploy

1. Put the `performance-property/` folder in a GitHub (or GitLab/Bitbucket)
   repo.
2. On Netlify: **Add new site** → **Import an existing project** → pick
   the repo.
3. Leave the build command **empty** — this is a static site.
4. Set the **publish directory** to `.` (or wherever `index.html` lives
   inside your repo).
5. Deploy. From now on every git push redeploys automatically.

The `_redirects` file already in the folder tells Netlify to serve
`index.html` for unknown paths, so typos and stale bookmarks land on the
login screen instead of a 404.

## Adding a 4th tool

The scaffolding is designed so that new tools plug in with two steps.

### Step 1 — Create `tools/<your-tool>.html`

Copy `tools/demand-score.html` as a starting template (it's the simplest).
At the very top of `<body>`, keep this block verbatim — it's what gates
access to the page:

```html
<script src="../shared/auth.js"></script>
<script src="../shared/auth-gate.js"></script>
```

Then add your own markup, styles, and scripts below. Use the CSS class
`--ds-*` token pattern (or whatever prefix you like) to avoid collisions
with hub styles. Your tool CSS/JS can be entirely inline or split into
external files under a `tools/<your-tool>/` subfolder — both work.

Don't forget a back button. Copy the `#pp-back-to-hub` block from
`tools/demand-score.html` or, for a light-themed tool, use the
`.back-btn-wrap` + `.back-btn` pattern from `tools/property-clock.html`.
Both point at `../index.html`.

### Step 2 — Add a card to the hub

Open `index.html` and find the `.hub-tools` section. It has three
`<button class="hub-tool-card nav-pill">` cards. Add a fourth, modelled
on one of the existing ones:

```html
<button class="hub-tool-card nav-pill"
        onclick="location.href='tools/your-tool.html'">
  <div class="hub-tool-icon">🎯</div>         <!-- pick any emoji -->
  <div class="hub-tool-badge">New · Beta</div>
  <h2 class="hub-tool-title nav-pill-title">Your Tool Name</h2>
  <p class="hub-tool-desc">One-sentence description of what the tool does.</p>
  <div class="hub-tool-cta">Launch Tool <span>›</span></div>
</button>
```

The hub is CSS-grid based so the fourth card will flow naturally onto a
second row on narrower screens.

### (Optional) Step 3 — Restrict the tool by tier

If the new tool should only be visible to certain tiers, add one of these
classes to the hub card:

- `tier1-only` — hidden for tiers 2 and 3 (admin-and-above)
- Or do it in JavaScript at the top of the tool page:

  ```js
  if (isGuest()) {
    document.body.innerHTML = '<p>Not available for external viewers.</p>';
  }
  ```

`applyAccessRestrictions()` in `shared/auth.js` already hides every
element with the `tier1-only` class automatically on every page load.

## Things worth knowing

- **EmailJS** is only loaded on `index.html` (where the OTP flow runs).
  Tool pages don't need it. If you move the login form somewhere else,
  remember to move the EmailJS `<script>` tag too.
- **D3, html2canvas, and jsPDF** are loaded only on the runway and clock
  tool pages (they need them for charts/PDF export). Don't add them to
  other pages unless you need them.
- **Leaflet and Lucide** are loaded only on the demand-score page.
- The logo was previously embedded 5× as a base64 data-URI in the single-
  file version — about 280 KB of duplicate bytes. It's now a single
  42 KB PNG at `assets/logo.png`. Hub and tool pages reference it via
  `assets/logo.png` and `../assets/logo.png` respectively.
