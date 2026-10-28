# Adelaide Returns — feature note for the pp-os port

A public client page that shows what Performance Property's Adelaide purchases did for a client's deposit, set against Australian
shares, US shares (NASDAQ-100 in AUD), Australian bonds, A-REITs, cash and the residential market over the same years; plus a
"selection, not just the market" comparison and a risk v return scatter. A Vault editor in the hub lets research staff change every
figure, table cell, label, sentence and the legal text without a code change. Built 2026-10-14.

The ask. Research meeting 2026-10-14 (the research head, relayed by Van): a client page "like" the portfolio-audit page on
docs.performanceproperty.com.au, for Adelaide only — the median IRR over the median hold, the median CAGR, the median purchase price,
the number of properties; the cash a client actually put in (median price × 18.5%); what that cash would have become in the
alternatives; our CAGR v the Adelaide and national market; a risk v return chart like the Commercial deck's. "The numbers behind the
scenes might change … we might change the assumptions." Van chose: a Vault editor + a public page with no sign-in that reads the
saved numbers.

| What | Path |
|---|---|
| Public page (no auth, no telemetry) | `client/adelaide-returns.html` |
| The maths (pure functions, `window.ADLMath`) | `client/adelaide-returns-math.js` |
| Unit tests (hand calculations) | `scripts/adelaide-returns-math.test.mjs` — `node --test scripts/adelaide-returns-math.test.mjs` |
| Vault editor (auth-gated) | `tools/adelaide-returns.html` |
| Table + RLS | `supabase/migrations/127_client_pages.sql` |
| Registry / hub | `shared/tool-registry.js` key `adelaide-returns` (sec `vault`); `index.html` Vault APPS card + search entry |
| QA harness (gitignored) | `scratch/adl-returns/_qa.mjs` (Puppeteer, write-blocked), `_read-riskreward.mjs` (read-only seed read) |

---

## 1. Data model (migration 127)

`public.client_pages` — `key text primary key` (lower-case slug check) · `payload jsonb not null` · `updated_at timestamptz not null
default now()` · `updated_by text`. One row per published client page; the first key is `adelaide-returns-2026`.

- Trigger `trg_client_pages_touch` (before insert or update): `updated_at := now()`, `updated_by := coalesce(jwt email, new.updated_by)`.
- RLS: SELECT for `anon` and `authenticated` (`using (true)`) — **the rows are published client content; nothing private may ever be
  stored here**. INSERT `with check (is_writer())`, UPDATE `using/with check (is_writer())`, authenticated only. No DELETE policy.
- Grants: `anon` select; `authenticated` select/insert/update; `service_role` all.

## 2. Payload schema (one jsonb document)

```
version            1
years              ['2015', …, '2025', '2026YTD']   column order; 'YYYY' = calendar year, 'YYYYYTD' = 1 Jan → window.ytdEnd
window             { endDate: 'YYYY-MM-DD', ytdEnd: 'YYYY-MM-DD' }   start = endDate − pp.medianHoldYears
pp                 { label, properties, medianIrr, medianCagr, medianHoldYears, medianPurchasePrice, depositPct,
                     purchasePeriodLabel, asAtLabel, source }      decimals (0.14 = 14%); any may be null → "—"
benchmarks[]       { key, label, kind: 'total' | 'growth+yield', include, annual { year → decimal },
                     yield { year → decimal } (growth+yield only), source }
selection          { ppLabel, compare: [{ key (a benchmark key), label }] }
risk               { ppRisk, ppLabel, xLabel, yLabel, source, rows: [{ label, risk, reward (decimal) }] }
text               { eyebrow, title, subtitle, meta, tiles { irr, cagr, hold, properties },
                     headings { deposit, yearByYear, selection, risk, legal, disclaimer, riskWarning },
                     depositLine, windowLine, table { asset, pa, total, end },
                     takeaways { deposit, yearByYear, selection, risk }, notes { yearByYear, risk },
                     footnotes { leverage, method }, sourcesLabel, footer }
legal              { disclaimer, riskWarning }
```

Text tokens (filled on render, "—" when the figure is blank): `{deposit} {price} {depositPct} {loanPct} {ppIrr} {ppCagr} {ppEnd}
{ppTotal} {hold} {properties} {startLabel} {endLabel} {ytdEndLabel} {purchasePeriod} {asAt}`, and per benchmark `{pa:key}
{total:key} {end:key} {growth:key}`. p.a. tokens carry the " p.a." suffix. Text is plain (never HTML); a blank line = new paragraph.

## 3. The maths (`client/adelaide-returns-math.js`)

- Time = decimal years on a month grid: `year + (month − 1)/12 + day/daysInMonth/12` (2026-09-30 → 2026.75; a year = 1.0).
- Window = `[end − hold, end]`; 7.8 years to 2026-09-30 = 2018.95 → 2026.75.
- A benchmark compounds its period returns inside the window; a period contributes `(1 + r)^(share of that period inside the window)`;
  the YTD period's share is relative to its own span (1 Jan → ytdEnd). Factor = the product; total = factor − 1;
  % p.a. = factor^(1 / years covered) − 1; end value = deposit × factor. A blank cell is skipped and the row is flagged `short`
  (the page marks it * with "data covers X of Y years") — never padded.
- `growth+yield` rows: r = growth + gross yield × period length (a full year adds the year-end yield; the 9-month YTD adds 0.75 of it).
- Selection uses the growth alone (`annualise(b, p, null, true)`).
- PP: deposit = medianPurchasePrice × depositPct; end = deposit × (1 + medianIrr)^hold.
- `compute(payload)` → `{ window, deposit, pp, rows[], selection[] }` — what the page draws.

Hand check (seed, 7.8 years to 30 Sep 2026, deposit $117,706.25): NASDAQ-100 AUD 23.6% p.a. → $612,635 · ASX 200 9.8% → $244,532 ·
Australian residential (growth + yield) 9.0% → $229,817 · A-REITs 5.5% → $178,079 · cash 2.4% → $141,634 · AusBond 1.3% → $130,402 ·
Adelaide residential (hidden by default) 12.9% → $303,631. Growth only: Adelaide 9.0% p.a., national 5.3% p.a.

## 4. Public page (`client/adelaide-returns.html`)

- Loads ECharts 5.5.0, supabase-js 2.112.3 + `shared/supabase-client.js` (anon), `adelaide-returns-math.js`. Reads
  `client_pages` key `adelaide-returns-2026`; renders it. Row unreadable / missing / invalid → "This page is being updated" (no
  embedded fallback numbers, ever).
- `?preview=1`: waits for `postMessage({ type: 'adl-preview', payload, status, saved })` from `location.origin` only; posts
  `{ type: 'adl-ready' }` to its parent on load. A "Draft preview" / "Saved · …" pill shows only in preview mode (hidden in print).
- Sections: header + 4 tiles (IRR, CAGR, hold, properties) · Your deposit (line, period line, horizontal bar of end values with a
  dashed deposit marker, PP first in teal, others sorted by end value, table asset · % p.a. · total · end value, takeaway, sources)
  · Year by year (cumulative lines; PP a smooth line at the IRR, others joined at each period end) · Selection (PP median CAGR v the
  compare rows' growth) · Risk v return (x = risk score, y = 20-yr average return; PP point at (ppRisk, medianIrr), teal, larger;
  labels of right-hand points sit on their left; PP label left on desktop, top on phones) · leverage + method footnotes · Legal
  notices (disclaimer + risk warning) · footer with the logo bottom-right (`assets/Reports/logo-color-black.png`; in print a fixed
  logo bottom-right on every sheet).
- PP figures blank → tiles "—", PP table row greyed "—", no PP bar / line / point (never zeros).
- The leverage footnote cannot disappear: blanked in the payload, the page uses a built-in sentence (text only, figures from tokens).
- Colours: PP Teal #00A0B4; alternatives in benchmark order Dark Teal, Celestial Blue, Dark Gray, Eucalyptus, Yellow, Cobalt, Green,
  Purple, Red. Montserrat. Light, printable; responsive to 390px (2-column tiles, narrower chart labels).

## 5. Editor (`tools/adelaide-returns.html`)

- Head as every Vault tool (os-chrome, os-theme, supabase-js, supabase-client, tool-registry, desktop-pins, auth, auth-gate,
  pp-telemetry, fit-screen) + `shared/copy-link.js` + the maths module. `PP_OS.initChrome({ name: 'Adelaide Returns', section: 'vault' })`.
- Writer = `getAccessLevel()` dev/admin (honours view-as). Others: form disabled, no Save, "View only" note. RLS is the gate.
- Boot: read the row; missing → SEED (in the file); table missing (migration not applied) → SEED + a note that saving needs 127.
- Groups: PP figures (IRR/CAGR/deposit entered in %), Period (end date, YTD end; shows the derived start and any benchmark without
  enough years), Benchmarks table (year columns renamable YYYY / YYYYYTD, + Year, Remove last year; per asset label, Show toggle,
  kind, source, growth row + yield row for residential, + Asset, Remove asset), Selection (PP bar label, compare rows), Risk table
  (PP score/label, axis labels, source, rows label/risk/return%, add/remove), Text (every block, token list), Legal.
- Every edit updates the draft and posts it to the preview iframe (150 ms debounce). Save validates (numbers parse, period valid,
  client cash in (0, 100%], price and YTD date set) then upserts `{ key, payload, updated_by }` on `key`; the preview pill then reads
  "Saved · <time>". Unsaved changes warn on leaving. "Copy client link" = PP_COPY_LINK (named hyperlink + plain URL); "Open client
  page" opens `client/adelaide-returns.html`. Preview has Full width / Phone (390px) toggles.

## 6. Seed sources

Benchmarks: `seed-benchmarks.json` researched 2026-10-14 (the `sources` strings are copied into each row's source). Risk table:
`forge_commercial` id `latest` → `tabs['riskreward-data']` (investmentOption, totalRiskScore, 20YrAverageReturnsAsRewardPa), read
2026-10-14; default PP risk = "Leverage Residential Property" = 12. Legal text: written fresh (the reference page's wording was not
read during the build) — research to replace with the approved wording.

## 7. Known gaps

- The PP figures (IRR, CAGR, properties, period labels) are null until Van supplies them from the IRR calculator.
- No version history of saved payloads (one row, overwritten on save).
- A new key needs a Groups tick (Van) before admins assigned to a group or staff see the Vault card.

## Changelog


- 2026-10-15: seed carries the IRR calculator's Adelaide medians (87 sold of 331; IRR 18.67%, CAGR 8.46%, hold 7.8 yrs, price $637,500); new `pp.lvr` (loan share, default 90%) feeds `{loanPct}` — the calculator lends 90% of the price, so the loan is not 1 − client cash.
- 2026-10-14 — Built: migration 127 (`client_pages`, public read, writer write), public page `client/adelaide-returns.html` + maths
  module + tests, Vault editor `tools/adelaide-returns.html`, registry key + Vault card + search entry; `scripts/stamp-shared-assets.mjs`
  now also stamps `client/*.html`.
- 2026-10-27 — Retired the Vault editor, the hub client page, the maths module and its tests, plus the two index.html entries (owner: "we don't need the editor anymore"). The static page in the owner's `adelaide-combined` folder (index.html + data.json, no editor) replaces them. The `client_pages` table (migration 127, 0 rows) and the registry key are left in place. Do not port this tool to pp-os.
- 2026-10-27 (later) — Restored at the owner's request ("add it back in the hub. I just want the editor in the left side of the page to be removed"): the Vault page now shows only the client page, full width (no form, no Save). Figures and wording are the SEED in `tools/adelaide-returns.html`; a saved `client_pages` row still wins if one ever exists. Both pages gained a highlighted "All figures on this page are before tax" notice under the tiles (`text.beforeTax`).
- 2026-10-28 — "Standard periods" table on the client page, after "Year by year" (owner asked for this part of the draft dashboard, using our numbers): annual return over the last 1, 3, 5 and 10 full calendar years to 31 December of the last full year, before tax, for every benchmark in the payload (Adelaide residential included; residential = growth + gross yield). A period with any blank year shows "—". The Performance Property row reads `ppYears.returns` (calendar-year returns on client cash) and shows "Figures to come" until research supplies them — the IRR medians cannot give yearly returns. Text: `text.headings.periods`, `text.periodsLead` ({periodEndLabel}), `text.ppRowToCome`.
- 2026-10-28 (later) — Seed updated from Shaene's data response (IRR calculator book as at 27 Oct 2026, aggregates only; owner chose the 27 Oct book): 86 sold of 330, median IRR 18.75%, CAGR 8.48%, hold 7.81 yrs, price $601,625; new `ppYears` (the "seasoned" series: pooled return on client cash of properties owned for the whole calendar year) fills the Performance Property row of Standard periods (1 yr 23.0%, 3 yrs 25.0%, 5 yrs 41.4% p.a.; 10 yrs blank), with a note (`text.notes.periods`, rendered as `nPeriods`) that it is geared and leaves out the 8.5% purchase costs. Method note now says the figures are after purchase costs and our fee.
