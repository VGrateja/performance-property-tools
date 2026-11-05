# IRR Calculator — feature note for the pp-os port

A Vault tool: what our clients' purchases actually returned. Median IRR, CAGR, return and hold period across the properties
they have sold, a register you can filter and sort, a growth comparison against the Cotality medians, a per-deal
calculation, and the RP Data sold check that drives the bookmarklets. Ported 2026-10-28 from the standalone build at
`pp-research.github.io/tools/irr-breakdown.html`, which Shaene had been running against her own Supabase project, and
refreshed from that build on 2026-10-30.

It is NOT connected to Sold Check. Both tools hold a register of client purchases and both drive an RP Data bookmarklet, but
they keep separate data and answer different questions — Sold Check asks "has this sold?", the IRR Calculator asks "what did
it return?". Merging the two registers was considered and deliberately deferred: see **Not done** below.

| What | Path |
|---|---|
| The tool | `tools/irr-calculator.html` |
| Its engine (XIRR, the realised-deal model) | `tools/irr-breakdown-engine.js` |
| Suburb → council lookup, for the register's spell-check and the vs-Council view | `tools/suburb-lga.js` |
| Cotality council medians, 38 Greater Adelaide/Brisbane councils, monthly from 1980-03 | `tools/lga-median.js` |
| The Apps Script source the sold-check modal links to | `tools/sheet-endpoint.gs.txt` |
| Tables + RLS | `supabase/migrations/131_irr_calculator.sql` |
| Registry / hub | `shared/tool-registry.js` key `irr-calculator` (sec `vault`); `index.html` Vault APPS card + search entry |

The engine and the three data files sit beside the page rather than in `shared/`, like `client/adelaide-returns-math.js` —
nothing else uses them, and it keeps them out of the shared-asset stamping cycle.

---

## 1. Data model (migration 131)

Three tables, like `126_sold_check.sql`: the thing, what people did to it, and the one setting that belongs to the team
rather than to a browser.

**`public.irr_book`** — `id text primary key` (one row per capital-city book: `adelaide`, `brisbane`, …) · `body jsonb not
null` · `updated_at timestamptz` · `updated_by text`.

`body` is the whole register as the tool already stores it: `properties[]`, the assumptions block, a rev stamp. Archived and
outside-of-advice entries are **in** that array, carrying `outside` and `outsideReason` — `shareBody()` writes them, so the
row is complete and a CSV export (which only ever holds the visible, filtered rows) is not. The document shape is unchanged
from the standalone build, so the move is a copy rather than a migration of content.

`shareBody()` rebuilds each property from the explicit `SHARE_FIELDS` list, so that list **is** the schema: a field missing
from it is a field deleted from the book the next time anyone saves. It carries `name`, `category`, `ptype`,
`purchasePrice`, `purchaseDate`, `soldPrice`, `soldDate`, `soldVerified`, `soldLink`, `soldCheck`, `note` and the
`outside` / `outsideReason` pair. Only the per-entry `savedAt` is deliberately browser-local.

> **This is the one thing to understand before editing `shareBody()`.** Until 2026-10-29 the list omitted `ptype`,
> `soldVerified`, `soldLink` and `soldCheck`, and every save pushed a shared copy without them; the next `applyShared()`
> replaced the local copy wholesale. That silently erased the property type from all 372 typed properties, and `soldLink`
> is still empty across the whole book as a result. Adding a field to the entry shape without adding it to `SHARE_FIELDS`
> does not make it browser-local — it makes it disappear.

**`public.irr_log`** — `id bigint identity` · `at timestamptz default now()` · `who text` · `action text` · `property text`
· `detail text`, indexed on `at desc`. The tool appends `{ who, action, property, detail }` and reads the latest 300. It is
a separate table because the book is overwritten on every save, so a log kept inside it would be erased by the next edit.
`detail` stays `text` rather than `jsonb`: the tool writes a JSON string for some actions and a plain sentence for others,
and the History tab parses the former to find a property's city.

**`public.irr_config`** — `key text primary key` · `value text` · `updated_at timestamptz` · `updated_by text`. One row,
key `rpdata_exec`: the `/exec` address of the Apps Script behind the sold-check sheet, so whoever sets it up sets it up
once for everyone instead of each person pasting it into their own browser.

Reads are writers-only here too, and for a sharper reason than the book's: that address **is** the capability. Anyone
holding it can append rows to the sheet without signing in to anything. The tool only ever reads the row when
`canWrite === true`, so the policy and the code agree exactly.

The tool treats this table as optional — both call sites catch the error and fall back to this browser's own copy, and the
sold-check panel says so — so a project without it degrades to per-browser configuration rather than failing.

- Trigger `trg_irr_book_touch`: `updated_at := now()`, `updated_by := jwt email`. Matches
  `sold_check_properties_touch()` rather than `touch_updated_at()`, which writes `auth.uid()`.
- Writes: `irr_calculator_can_write() = is_writer() OR has_tool_role('irr-calculator', 'editor')` — the scorecards / sold-check
  tool-scoped pattern, so a Viewer can be given edit rights inside this one tool.
- **Reads are writers only.** The body carries real client addresses and purchase prices. `sold_check_properties` holds the
  same addresses under read-for-any-authenticated; these tables start narrower so that widening them is a decision someone
  makes rather than one inherited by copying a pattern. To open the book and the log to all signed-in staff, the
  `"irr book read"` and `"irr log read"` policies become `using (true)` and nothing else changes. `irr_config` should
  **not** be widened with them — see above.
- No DELETE policy: a book is renamed or emptied from the UI, never dropped.
- Added to the `supabase_realtime` publication (guarded), because the tool subscribes to `postgres_changes` so one person's
  edit reaches another's open tab without a reload.

## 2. What the port changed

Everything below is the difference between the standalone build and this one. The tool's own behaviour — the engine, the
register, the overview, the sold check — is untouched.

- **Head and chrome.** `os-chrome.js` + `os-theme.css`, `PP_OS.initChrome({ name: 'IRR Calculator', section: 'vault' })`, and
  the usual Vault script set (supabase-client, tool-registry, desktop-pins, auth, auth-gate, pp-telemetry, fit-screen).
- **The theme block is gone.** os-chrome owns the shade, and its legacy bridge is the convention this stylesheet already
  used — dark = no `data-theme` attribute, light = `data-theme="light"` — so both token sets work unchanged. The page's own
  pre-paint theme script, the moon/sun button and the logo-variant swap all went with it.
- **Sign-in is gone.** It had its own email+password dialog against its own project. `auth-gate.js` now bounces anyone not
  signed in, and the appbar signs them out.
- **The Supabase client is the hub's.** It used to call `createClient()` with its own URL and key from a
  `supabase-config.js` beside the page; it now uses `window.sb`.
- **The write gate changed meaning.** It was "any session can write" — true of a project whose only users were the three
  people who had the password. It is now dev/admin or the `irr-calculator` editor grant, asked on the client only so the UI
  can disable what RLS would refuse.
- **`connectShare()` removed** — the Claude artifact-runtime path the tool was first built in (`window.claude`), dead here
  and setting `canWrite` from a different authority.

## 3. Not done

- **The registers are still separate.** `sold_check_properties` (one row per property, typed columns) and `irr_book` (one
  jsonb document per city) hold overlapping addresses. Unifying them means deciding where the IRR Calculator's
  `outside` / `outsideReason` flags and its ten assumptions live, neither of which the Sold Check schema has a home for.
  Sold Check's Import already reads this tool's JSON export, so the manual path still works in the meantime.
- **The Google Sheet is still the sold check's store.** Results go to an Apps Script `/exec` endpoint rather than into
  Supabase. Sold Check's `sold_check_results` + Verify queue is the obvious destination if these ever converge.

### Check tracking sheets

The **Sold check** tab has a second button on it. Everything else there asks a website what it knows; this asks the
people. Two spreadsheets, kept by hand by the advisory team:

| Spreadsheet | Tab | City |
|---|---|---|
| Adelaide Total Purchases & Sales - TrackingSheet | **ADL - Sold** | Adelaide |
| Brisbane - Total Purchases | **BRI - Sold** | Brisbane |

A sale is written there before RP Data has it, so these are the only sources that can be *ahead* of the register rather
than behind it. Adding a third city is one row in `TRACKING` in `sheet-endpoint.gs` and nothing else: the columns are
found **by name**, never by position, which BRI - Sold needs &mdash; it has no IRR column, so `Link` sits one column to
the left of where ADL - Sold keeps it. Reading by position would not have failed, it would have returned the CAGR as
the record link.

The browser cannot read those spreadsheets: they are private and on another origin. The read goes through the `/exec`
the sold check already holds, which runs as somebody who can see them &mdash; `?tracking=1` in `sheet-endpoint.gs`
(`?adl=1` is the old name and still answers, so a tool published before this keeps working). **The spreadsheet ids are
pinned in that file**, deliberately. Taking one from the request would turn a capability that can append rows to one
sheet into one that can read every sheet the script's owner can see, which is a much larger thing to leave sitting on a
bookmarks bar. The ids are also **scrubbed out of the published copy** of that file, which is a template on a public
page; `scrub-gs.pl` does it, and the placeholders fail loudly rather than quietly.

**Two buttons, and only two**, side by side &mdash; in the empty state before anything is loaded, and in the card head
afterwards, never both at once:

- **Load sold check records (RP&nbsp;Data)** &mdash; the results of a bookmarklet run, out of the sold-check sheet.
- **Check tracking sheets (ADL &amp; BRI &ndash; Sold)** &mdash; every sheet in `TRACKING`, in one press.

One button for both sheets, because it is one question &mdash; *what do the sheets know that we do not* &mdash; and
the answer names each sheet with its own count anyway. Adding a city is still one row in `TRACKING` and nothing else:
there is no per-sheet button to keep in step.

A sheet that cannot be read **stops the check**, by name, rather than quietly shrinking the answer &mdash; because a
sheet that will not open and a sheet with nothing new in it look identical from the far end, and "nothing new" is the
one wrong answer that reads as good news.

Each row is matched against the register the way a sold import is &mdash; tight key first (unit and street type must
agree), then loose (number, street, suburb) &mdash; and an address that matches two properties matches neither. What
happens next depends on what was found, and most of the answers are *nothing*:

| The register says | What happens |
|---|---|
| held, and the sheet has a whole sale | the sale is **parked** for review, never written |
| not there at all | **added**, waiting for review, carrying its own sale |
| already sold, same figures | nothing |
| already sold, different figures | counted and reported, **never overwritten** |
| already waiting in For review | nothing &mdash; it would double-queue |
| outside of advice | nothing &mdash; archiving is a decision, re-queueing undoes it |
| price or date missing | nothing &mdash; half a sale approves into a property that still reads as held |

Nothing is written until the counts have been shown and accepted, because this can be hundreds of properties at once
and the count is the thing worth seeing before it happens.

### The daily check

**A web page cannot run while it is closed.** There is no background job here and there cannot be one: nothing in this
tool exists until somebody opens it. So "daily" means the first time it is opened on a given day &mdash; or the first
time the Sold check tab is opened &mdash; it asks the tracking sheets what they know and says so. Twenty hours between
asks, so it lands once a working day rather than once a visit.

It only ever **looks**. It queues nothing, writes nothing, and opens no dialog: it leaves a line on the Sold check tab
and a count on the tab itself, and the button is still the thing that acts. A check that quietly changed the book while
you were reading the Overview would be a worse tool, not a more automatic one.

The matching is `trackBuckets`, which the button uses too &mdash; lifted out of the button's own handler so the two
cannot drift into disagreeing about what "new" means. The result is kept in `localStorage` under
`pp-irr-trackseen-v1` (per browser: it is a notification, not a record, and the queue is where the shared truth
lives), so reopening shows what was found without asking again.

A failed read is stored as a failure and says which sheet would not open, never as a zero. The startup run is deferred
a moment so it is not competing with the first paint.

**Acting on the queue throws the stored answer away.** The count means "what the sheets have that the register does
not", and working through the queue changes that &mdash; so the stored number is wrong from the moment somebody
finishes a review session, which is exactly when they look at it. Recording, archiving or rejecting anything, and the
tracking check's own apply, all call `trackInvalidate()`: the stored answer goes, the badge goes blank rather than
stale, and the next open looks again. It does not re-fetch on the spot, because a review session is twenty clicks and
twenty fetches to keep a badge honest is a worse trade than one on the next open.

#### Red, and opening the tab does the asking

A count you have to go and press a button about is a count you stop noticing. So:

- The badge is **red** (`.badge-alert`) while it holds a number nobody has been shown, and plain again at zero. On the
  selected tab it inverts to white-on-red, because the teal fill would otherwise swallow it.
- **Opening the Sold check tab** loads the sold check records and opens the tracking confirm, with no second press.

It fires from the **tab**, never from the page load. A modal that appears while somebody is reading the Overview is an
interruption; one that appears when they open the tab it belongs to is the answer to what they just asked &mdash;
which is why `maybeAutoOpen()` begins with `if (currentTab() !== 'check') return;`.

It fires **once per scan result**. The record carries `shown`, set in `chkAdlSold` *after* `trackNote` has written the
fresh record &mdash; `trackNote` writes `shown:false` every time, so setting the flag where the asking was decided
instead of where the answer was shown left it permanently false and the dialog reopened on every visit. The order of
those two lines is the whole of it. An `autoOpening` guard covers the gap while the fetch is in flight, and is
released on both the success and the failure path.

A new scan writes a new record, so a new day re-arms it. Cancelling counts as having been shown: the button is still
there.

**The automatic load queues nothing.** `chkLoadSheet(quiet, onDone)` fills the table and reports its count without
calling `queueFound()`; the automatic path passes `quiet`, the button does not, because pressing the button is asking
for exactly that. The two are then **chained** rather than timed, so the tracking check counts the same book the badge
counted.

This was shipped the other way round for about half an hour and it was instructive. The auto-open loaded the records
first &mdash; which queued twenty properties &mdash; and *then* asked the tracking sheets what was new. Three of those
twenty were properties the tracking sheets also knew about, so they came back as "already waiting" and were skipped.
The tab said **12**, the dialog offered **9**, and twenty properties appeared in For review that nobody had agreed to.
Every number was correct on its own, which is the worst kind of wrong: there was nothing to see in any one of them.

The test for it asserts the badge and the dialog carry the same number, and that loading the records queues nothing
&mdash; with a fixture where the sheet and the tracking sheets overlap, because without the overlap the bug does not
appear. It also asserts that pressing the button still queues, since `addEventListener('click', chkLoadSheet)` would
hand the click Event in as `quiet` and silently stop it.

A `chkTrackBusy` guard stops two tracking checks running at once &mdash; the tab can start one and a press a moment
later can start another. It is released where the answer arrives rather than at each exit, because three of the
branches below it return early.

#### The count is the whole tab's, and it counts properties

The badge read **12** while **32** rows across three sheets were waiting, because it only counted two of them. A
number on a tab has to mean "this is what is waiting on this tab", so the scan now reads the sold check sheet
alongside the two tracking sheets &mdash; one `Promise.all`, both in the same pass.

It counts **properties, not rows**. RP Data and a tracking sheet both knowing about one sale is the normal case, and
that is one thing to deal with, not two. `scanCount()` takes the distinct matched property ids plus the distinct
unknown addresses. The parts can therefore add to more than the whole, and the line says so rather than letting it
look like an error:

> **29** properties the register does not have &mdash; **20** in Sold check sheet, **12** in ADL - Sold, **3** in
> BRI - Sold *(some in more than one)*. Open this tab to work through them &mdash; nothing has been queued.

**The badge and the tracking dialog are allowed to differ now**, and that is not the earlier bug coming back. The
badge is the tab's; the dialog speaks for the tracking sheets; the remainder is **on screen in the loaded table**
rather than hidden, and the line has already said where everything is. What must never happen again is the dialog
offering fewer because something was quietly queued ahead of it &mdash; which is what the test asserts, with a fixture
where the sheets overlap.

`trackNote` has one owner, `trackScan`. The tracking button sets `shown` and leaves the count alone: it speaks for two
of the three sheets, so letting it rewrite the tab's number is how the two disagreed in the first place.

#### Saying that it is reading

Three sheets go over the network and nothing on screen said so. A ring spins beside the Sold check badge whenever the
daily scan, the records load or the tracking check is in flight, the tab carries `aria-busy`, and the four buttons
that would start another read are disabled while it runs.

`chkBusy()` counts rather than flags, because those three can overlap and the last one to finish is what "done"
means; it clamps at zero so one unpaired call cannot leave the tab spinning for ever. Three starts, six stops &mdash;
the two fetching paths each have several exit branches and only one runs per call.

The ring is drawn in `currentColor`, so it reads on the selected tab's teal fill and on the plain ones without a rule
for each. `.pp-spin[hidden]{display:none}` is not redundant: a `display` rule beats the `hidden` attribute, which is
how a hidden spinner ends up spinning for ever in the corner of the screen. Under `prefers-reduced-motion` it slows
to 2.4s rather than stopping, because a still ring reads as "nothing is happening".

The test holds every reply open until it has looked, which is the only way "while it is reading" is observable at
all; it also checks the ring has a real size, since a 12&times;12 element that renders 0&times;0 passes every
assertion about being visible.

The ring lives **in the tab button**, so it shows from wherever you happen to be &mdash; the first open of the day
reads the sheets while you are on the Register, and the tab says so without you going to look.

It goes on when the read is **decided**, not when the fetch starts. The startup scan is deferred 1200ms so it is not
competing with the first paint, and for that second and a bit the tab used to look idle while a read was already
certain. `trackDue()` answers "is a scan coming?" at startup as well as inside `trackScan`, one decision in one place
so the two cannot drift; the counter makes the overlap safe, because the startup hold is released the moment
`trackScan` has taken its own. Measured from the first frame, the ring is up at ~330ms instead of ~1840ms, and the
test fails if it waits longer than the pause.

#### The findings are a list, not a dialog

The tracking check used to end in a confirm: *"Send 12 to For review"*. A count you have to agree to without seeing
what it is made of is not really a question, so it is now a block on the Sold check page &mdash; `#chkFound`, a
sibling of `#chkBody` so that redrawing the match table underneath does not take it away.

It lists each property with its city, whether it is a found sale or one the register has never seen, the figures, the
record link and the sheet it came from, then **Send N to For review** and **Not now** beneath. Acting on it clears it.

The link says where it goes. `recordLink` reads the hostname and prints **View in RP Data**, **View in REA** or
**View in Pricefinder** with an arrow, falling back to *View record* for a host it does not recognise &mdash; the old
label was a bare *record*, which told you there was one but not whose. The same function draws the link in For review,
so the two places cannot drift apart, and it is held on one line (`.rec-link{white-space:nowrap}`) so the label never
wraps away from the date beside it.

Two things that follow from it being on the page rather than over it:

- **The buttons move up.** `syncSheetBtn` now hides the empty-state pair and shows the card-head pair as soon as there
  is anything to read on the tab &mdash; a loaded table *or* a list of findings. Before that the empty state carries
  them, because it is the only thing on screen.
- **The daily summary steps aside while the list is up.** It is a summary of the same question, and a summary that
  disagrees with the list under it is worse than no summary. `clearFound()` brings it back.

`#chkFound` needs its **own** click listener. The existing delegation is bound to `#chkBody`, and the list is a
sibling, not a child &mdash; so the Send and Not now buttons reached nothing and did so silently. That is the second
time today a listener bound to the wrong node failed without an error.

#### One list, kept

The tab used to carry three accounts of the same question: a row of tallies, a match table of RP Data results with its
own way of queueing, and the findings list. They are now one list, fed by every sheet.

- **Kept in the browser** under `pp-irr-found-v1` &mdash; the **rows only, never the verdict**. The buckets are worked
  out again on every draw against the register as it stands, so a property dealt with somewhere else drops out of the
  list by itself rather than sitting there waiting to be queued twice. The test proves that by recording one
  elsewhere and watching it leave.
- **Drawn the moment the tab opens**, from what is kept. The daily scan has already read every sheet, so opening the
  tab costs **no network call at all** &mdash; the test asserts zero.
- **One row per property.** RP Data and a tracking sheet both knowing about one sale is the normal case; listing it
  twice would make the table disagree with the count on the tab and ask for the same property to be dealt with twice.
  The other sheet's name is shown beside the first.
- **`mergeFound` replaces one source and leaves the others**, so pressing one button does not throw away what the
  other found.

**Loading the records no longer queues.** That button used to queue everything it found the moment it finished; now it
feeds the list like everything else, and **Send** is the only thing that writes. The parked sale still records the
*site* that answered (`r.src` &mdash; RP Data or Pricefinder) while `reviewSrc` records the *sheet*; collapsing those
two into one would lose which site found a price, and the test for it caught exactly that.

Gone with it: the tallies line, the "left alone" summary, the match table on this tab, and the once-per-scan
machinery that existed only to stop a dialog reopening. `chkRun` and `markSold` stay &mdash; the paste-import sold
flow still uses them and has its own display.

### A read that did not happen is not the day's read

On 5 Nov the daily check said *Failed to fetch* at 06:45 and then said nothing
for the rest of the day. "Failed to fetch" is the browser never getting a reply
at all &mdash; no network, rather than an error from the script &mdash; and the likeliest
moment for it is exactly that one: a laptop comes out of sleep, the browser
restores its tabs, and the scan fires 1.2 seconds later while the wifi is still
coming up.

The bug was what happened next. `trackNote` writes `{at: Date.now(), ...}`
whether the read worked or not, and `trackDue` only looked at `at` against the
20-hour window &mdash; so a read that never happened stood in for the day. No badge,
no retry, nothing until tomorrow, on the one failure most likely to be a
two-minute network blip.

A failed record now stands for two minutes rather than twenty hours
(`TRK_RETRY`). Long enough that clicking between tabs cannot hammer an
endpoint that is genuinely down &mdash; `trackScan` runs on every open of the Sold
check tab as well as on load &mdash; and short enough that coming back to the tab
tries again. The note says so, rather than reading as final.

`render/retry.html` holds the whole day: the failure, a reopen inside the floor
that must not read, a reopen five minutes later that must, and a reopen after a
good read that must not.

### What the city filter applies to

The filter in the header means "show me this city". It applies to the three tabs that are about **a set of
properties**, and not to the three that are about **the work**:

| Scoped to the city | Every city, always |
|---|---|
| Register | Sold check |
| Growth comparison | For review |
| Calculation | History |

The work is not filed by city. One bookmarklet run covers the whole register, so a Sold check that reported on one city
disagreed with the thing it was reporting on. A queue that hid half of itself behind a filter in the header is a queue
you cannot trust to be empty, which is the only thing a queue is for. And a change you made this morning should not
vanish from the History this afternoon because you switched city.

This replaced an earlier attempt to have it both ways: For review *was* scoped, and the tracking check printed "2 in
Brisbane &mdash; switch the city filter to see them" afterwards. Telling somebody where you hid something is worse than
not hiding it.

### For review is scoped to the city, with a condition

It was taken out of the city filter on 2 Nov and put back on 5 Nov. Both
decisions were right, which is worth writing down rather than flip-flopping
over again.

The objection to scoping it is real: a queue that hides half of itself behind
a filter is a queue you cannot trust to be empty, and being trustworthy when
empty is the only thing a queue is for. The first version was scoped with a
badge that counted every city, so the tab said 24 and the table showed 18 and
nothing explained the gap.

So the scope now comes with the two things that were missing, and it is only
sound with both:

- `syncReviewBadge` counts `pendingProps()`, which is scoped &mdash; the badge and
  the table always agree.
- `elsewhereLine()` sits above the table and names what is waiting in the
  other cities, by city and count. Nothing can be waiting unseen.

`setCity` redraws the queue as well as the register, since the queue is now
this city's. The Sold check and the History stay whole: those are about the
work, and the work is not filed by city. `render/scopes.html` holds all of it
and checks the badge, the line and the switch; scoping it without them should
fail that test.

### Sold before &mdash; the one decision this queue makes most

Of the 444 properties set outside of advice, **443 were archived for having
sold before the sell rating**, written four ways: *Sold prior to sell rating*
(201), *Sold prior to selling window (before 2025)* (149), *Sold prior to IC
sell rating* (77), *Sold before IC sell rating* (15), *sold too early for IC*
(1). Every one of them has a sale date, running 2017 to 2025 and peaking in
2023-25. Not one archived property has a 2026 sale, and the queue is the
mirror image: on 5 Nov, 19 of its 24 findings were 2026 sales and 5 were
older.

So in practice it is a date rule, and **Sold before** in the For review card
head is that rule: a date box that narrows the queue to findings whose sale
predates it, so they can be ticked and archived in one action. It reads
`queueSaleDate()` &mdash; the *parked* date where there is one, the record's own
`soldDate` for a property that arrived already sold &mdash; because the point of the
queue is that the sale is not written yet. Kept in `pp-irr-revbefore-v1`,
per browser: it is how somebody is working today, not a fact about the book.

Two things it deliberately does not do. It does not touch the badge, which
goes on counting the city's work, because a tab badge answers *is there
anything waiting* and a filter is a way of looking at it. And it cannot hide
anything quietly: `beforeLine()` prints "Showing 3 of 5 &mdash; only sales before
1 Jan 2026" whenever it is set, on the empty state as well, so an empty queue
is never ambiguous between no work and a filter. That is the same condition
the city scope carries, for the same reason.

**What it cannot answer.** *Prior to IC sell rating* &mdash; 293 of the 443 &mdash; is
per-property, and the register holds no rating date. No filter can derive it;
it needs a field somebody populates. The date box is the part that is exact.

Worth doing at some point: four wordings for one decision means the History
cannot be counted or searched. A short preset list on the Archive dialog would
fix it going forward.

### Reading the queue

**Finding** says which of two things a property is, and they are not the same decision:

- **Sale found** &mdash; the property is already on the register and a sale has turned up against it. The price and
  date are *parked*, not written; the property still reads as held until it is recorded.
- **Added** &mdash; the property is new to the register. Recording it accepts the whole record, and until then it is
  counted in nothing at all.

The note above the table says this, because a column heading cannot.

The heading was **Waiting on** until 4 Nov. It was wrong in the plainest way: the cell under it says *Sale found*, and
nothing is waiting on a sale that has already been found. What the column actually gives is the kind of finding, which
is what it is now called &mdash; the same heading over the same two values on the Sold check list, where the second one
reads *Not on the register*.

**Purchase** is the price with its date under it, in one cell, centred like the register's
own purchase columns — the two lines read as one figure when they share a centre line and as
two ragged ones when both are pushed left. For a row
matched to a property it is the register's own purchase, because that is the
purchase we hold; for one the register has never seen it is the sheet's, which
is then the only purchase there is. A property with neither reads as a dash
over *no date* rather than as a blank.

It means **What was found** is only ever about the sale now. An added record
used to read "Bought $455,000 on 9 Sep 2019, sold $810,000 on 20 May 2026" in
one cell, with the purchase doing the work the new column does; it says "Sold
$810,000 on 20 May 2026", or *No sale recorded* for a property added by hand
that has not sold. The same column is on the Sold check list, in the same
place, for the same reason.

**What was found** carries the figures with the source on a line beneath them. The source used to be a column of its
own; it is the provenance *of* those figures rather than a separate fact about the property, and the column pushed the
table 17px past the edge of its panel &mdash; which is how the Delete button ended up half off the screen.

**Record** keeps its word, because it is the one that changes the figures and should be read before it is pressed.
**Archive** and **Reject** are icons, with the name on `title` and `aria-label`. That is what gets the row down to
129px of buttons in a 170px cell, on one line.

### Record, Archive, Reject &mdash; and what each one sticks to

The three are not three strengths of the same action. They answer different questions, and the difference is which
thing is being refused:

| | What it does | Offered again? |
|---|---|---|
| **Record** | Accepts it. The one place a parked sale becomes a sale. | No &mdash; the register and the sheet now agree. |
| **Archive** | Keeps the property, sets it outside of advice with your reason. | No &mdash; the check skips archived properties. |
| **Reject** | Refuses **what was found**, not the property. | Your choice &mdash; *forever* or *for now*. A re-added property always does. |

**Reject used to be Delete, and Delete removed the whole property.** A found sale is a claim *about* a property you
already hold; refusing the claim deleted the record, purchase history and all, which is an enormous thing to do to say
"that sale is wrong". Worse, the review delete logged only the typed reason, while the Register's delete logs the
record as JSON &mdash; and the JSON is what puts **Restore** on a History row. So a property deleted from the queue
could never be got back.

Now:

- **A found sale** &mdash; the sale is discarded and the property is left exactly as it was, still held, with its
  purchase record intact. The refused figures are remembered on the property as `rejected: {price, date}`, and both
  the tracking check and the sold-check load skip a sale that matches them. Only *that* sale is silenced: a different
  price or a different date is new information and still comes through.
- **A property that arrived with the finding** &mdash; it is on the register only because a check added it, so
  refusing the finding and removing the property are the same act. Its whole record goes to the History as JSON, so
  **Restore** works. The tracking sheets still list it, so a later check can offer it again; the prompt says so before
  you press.

`rejected` is in `SHARE_FIELDS`. A rejection one person makes has to be a rejection everybody has, or the next person
to open the tool is asked the same question again.

#### "Not now" is a different answer from "no"

The Reject prompt has **two ways of saying yes**:

- **Reject forever** &mdash; the figures are remembered and that sale is never raised again.
- **Reject for now** &mdash; the queue entry is cleared and nothing is remembered, so the next check finds the sale
  exactly as it did this time.

This started as a tick box and became two buttons, because a tick box has to be read to be understood and a button
says what it does. Guessing which one somebody meant is how a queue ends up lying about what is outstanding, so it
asks — but it asks with the answer written on the thing you press.

The second button only appears when at least one selected row is a **Sale found**. For a property the check *added*
there is nothing left on the register to hang a decision on, so it always comes back, the single button says plain
**Reject**, and the note explains why.

It is `prAlt` in the prompt dialog, shown by an optional `opt` argument to `askPrompt` of the shape
`{label, okLabel}` — the primary button takes `okLabel` so the two read as a pair rather than as "Reject" beside
something longer. Both buttons call the same handler with the same typed reason and a boolean for which was pressed.
The dialog widens from 440px to 540px while the second button is there, because three buttons do not fit and a Cancel
that has wrapped onto its own line reads as a mistake rather than a choice.

Two layout notes worth keeping, both of which only showed up in a screenshot and neither of which any assertion had
caught:

- `.note` is `display:flex` so an icon can sit beside its text. **Every inline child of a flex container becomes its
  own column**, so a two-sentence explanation with `<strong>` in it rendered as a wall of narrow columns. The notes
  that carry no icon are now ordinary blocks.
- `table.mini` sets `white-space:nowrap` on every cell, which suits figures and forced this table wider than its
  panel. The two columns that hold sentences wrap; the figures, the city and the buttons do not.

### Where a queued property came from

Every door into the queue stamps `reviewSrc` on the property, and it is printed under the figures: `Sold check sheet`,
`ADL - Sold`, `BRI - Sold`, `Pasted in`, `Added by hand`, or the name of the file that was imported. There are seven
such doors &mdash; paste/file import, the Add property dialog, both halves of the sold-paste commit, both halves of the
tracking check, and Mark sold &mdash; and a door that does not stamp is a row that cannot say where it came from.

`reviewSrc` is a different question from `pending.src`, which records the **site that answered for a price** (RP Data
or Pricefinder) and rides onto the record as `soldVerified` when the sale is written. One says who said it, the other
says where it was found. A row queued before `reviewSrc` existed falls back to the site rather than printing a dash
over information we have.

`reviewSrc` is in `SHARE_FIELDS`. It has to be &mdash; see **Data model**.

### Record, Archive, Delete &mdash; per row

Each row carries its own three buttons, and the tick boxes with the buttons under the table still act on a set. They
are the same code: `revAct` takes an optional single id, and everything after that point &mdash; the reason prompt, the
History row, the redraw &mdash; is identical. One property or twenty, there is one path through it and therefore one
way for it to behave.

**Record** is what used to be called Approve, and the History verb moved with it to `recorded`; rows written before
this still say `approved`. When it is one property the prompt names it, because "Record 1 property." is a worse
question than the address.

One trap worth knowing, since it cost a test: `addEventListener('click', reviewApprove)` hands the handler a click
**Event**, which arrives as that optional id and matches nothing &mdash; the buttons under the table would silently do
nothing at all. The listeners wrap their calls, and `revAct` checks the argument is a string. Both halves, because
either one alone is a trap for the next person.

### The day the second sheet lost

Worth writing down, because it was invisible and it will happen again to anybody who opens a second spreadsheet here.

`Utilities.formatDate` needs a time zone, and the obvious one &mdash; `Session.getScriptTimeZone()` &mdash; is the
*script's*. This script is bound to the sold-check sheet and runs in **Asia/Singapore**; the tracking sheet is
**Australia/Adelaide**. A date-only cell holds midnight in its own spreadsheet's zone, and midnight in Adelaide is
half past nine the previous evening in Singapore &mdash; so every one of the 323 sales came back **one day early**,
consistently, with no error anywhere.

It was caught because 84 sales matched the register on price and *none* matched on date. One systematic difference is
a bug; eighty-four coincidences are not a thing. Reading the tab in `ss.getSpreadsheetTimeZone()` instead &mdash; the
zone belonging to the file the cells came from &mdash; made all 84 agree exactly and left none disagreeing.

The worklist round trip was checked for the same fault and is clean: 1,213 of 1,213 purchase dates match the book,
because that tab lives in the spreadsheet the script is bound to, so the two zones are the same one. `fmt_` is only
safe for that reason, and the reply to `?adl=1` now carries both zones so the next person can see it rather than
deduce it.

### For review

Nothing counts until somebody has said so. A property arrives in the **For review** tab two ways — it was added to the
register, or the sold check found a sale against it — and leaves it three ways, each with a typed reason and each as a
row in the History: **approved**, **archived**, **deleted**.

The part worth knowing is that a found sale is **parked, not written**. `markSold` and `doCommitSold` set
`review:'sale'` and hang the figures off `pending:{price,date,src,link}`; the property stays exactly the held property
it was. `reviewApprove` is the only place in the file that writes `soldPrice`/`soldDate`/`soldCheck` onto a property,
which is what makes the queue a gate rather than a notification.

Three add paths all queue, because missing one would let half the additions skip review: `addEntries` (paste/import),
`mergeByName` (the Add property dialog), and the new-property branch of `doCommitSold`. Adding also reaches the History
now; it never used to.

What is excluded from the figures, and what is not:

- `review:'new'` — a property nobody has reviewed. **Kept out** of the Overview and the Growth comparison by
  `reviewedProps()`, so the headline numbers only ever come from reviewed data. It still shows on the Register: a queue
  whose contents you cannot see is no use.
- `review:'sale'` — a held property with a parked sale. **Not excluded.** The property is unchanged, and dropping it
  would make the Overview flinch every time the sold check ran.

`review` and `pending` are in `SHARE_FIELDS`, which is not optional — see **Data model**. A queue only one browser can
see is not a queue, and a field left out of that list is deleted from the book on the next save.

### The register was hanging out of its panel

The register does not scroll sideways on purpose: it runs down the page with
its headers stuck to the top of the window, because a table you have to scroll
to read the IRR of is a table you misread. The cost of that decision is that
when the columns do not fit, nothing catches them &mdash; they simply hang over the
edge of the card, and the right-hand ones end up where no scrollbar can reach.

That is what had happened. The table wanted 1373px inside a 1183px card at a
1280px window, and 1341 inside 1343 at 1440 &mdash; just over, which is why it looked
fine most days and broke on a smaller screen. Eight separate things were a few
pixels too wide; the two that mattered were not figures at all:

- **The column headings were setting the width of the figure columns.**
  "Purchase price" on one line wants 125px; the money under it wants 95px. The
  headers wrap to two lines now, which is what the monthly breakdown and the
  swap columns already did.
- **"Sold check: SOLD SINCE PURCHASE" could not break.** `.cat` is nowrap, and
  that chip is 31 characters of prose sitting under the address &mdash; it was
  holding the Property column 63px wider than any address in it needed. The
  note chip and the suburb warning already wrapped for exactly this reason; the
  sold-check and outside-of-advice chips now do too.

The rest: 8px gutters down to 6px, the three swap columns from 116/150 to
104/140, Type from 92 to 76 (its longest value is "Dev site"), the market
view's `PPA / Mkt` line wrapping like the council view's always has, the source
pill down to one word, and the sold link down to **View**, since the pill above
it already names the site.

That lands the floor at 1152px, so it fits from 1280 up. Below that it cannot
fit at any sensible reading size, so `overflow:visible` now starts at 1280
rather than 1024 and the table gets its own scroll window back in between &mdash;
the same one a phone gets. A window you can scroll beats columns you cannot.

### Somebody else's change, in a tab that has been open all day

A record made in Adelaide at 09:14 on 5 Nov was still sitting in For review in
a browser here hours later. The write was fine &mdash; `irr_book.updated_at` and the
one `recorded` row in `irr_log` agree to the second. Nothing was wrong at the
sending end at all.

The receiving end had one way in: a Supabase realtime channel subscribed once,
at load. A websocket does not survive a laptop sleeping, the channel reported
its state to nobody, and nothing re-read afterwards &mdash; so the tab went quiet and
stayed quiet. The same morning's `Failed to fetch` says the network did drop.

Three things now:

- The channel is held as `share.chan` and `.subscribe()` takes a status
  callback, so `share.live` says whether it is actually joined.
- `pullShared()` re-reads the shared row when the tab becomes visible, on
  `focus`, and on `online`, throttled to once every 15 seconds; if the channel
  is not joined it is torn down and re-subscribed.
- A pull replaces the book wholesale, which is right on a reload and wrong on
  top of unsent work, so it only runs when this browser has nothing
  outstanding. A failed push sets `share.sent` to null, and a null is exactly
  the state the guard refuses to overwrite.

**`rev` is a timestamp.** `shareBody()` ends `rev: Date.now()`, so two copies
of the same book never stringify alike and every `json !== share.sent` in this
file was a comparison that could only ever be true. It cost nothing while the
answer was "apply it anyway", and it silently disabled the first version of
the pull guard, which could never pass. `bodyKey()` compares properties and
assumptions and leaves `rev` out; everything that asks "is this the copy I
already have?" goes through it. Worth knowing that `pushShared`'s own
"nothing actually changed" check has the same hole, so every push is a real
write.

`render/sharepull.html` drives all of it against a stubbed Supabase client
(`render/irr-sb.html`, built by `mksb.py` &mdash; it replaces the CDN script and the
config file with a stub the test page answers for): a live change with the
socket up, a change that lands while the socket is dead and arrives when the
tab is re-opened, and a pull that must not run over unsent work.

### For review was the one tab that let a signed-out viewer act

Everything else drops its write controls when the sign-in has gone: the
register's row buttons check `share.canWrite === false`, the sold check's do,
and `WRITE_CONTROLS` covers the rest. For review did not. Record, Archive and
Reject stayed pressable, and pressing one took the row out of the queue here,
wrote nothing to the shared copy, logged nothing and said nothing. The next
reload pulled the shared copy and the row came back.

`pushShared` made it silent. Its first line returned on
`share.canWrite === false` without a word &mdash; the *"you are signed out"* warning
below it only fires on a 42501 from the server, which is the case where the
sign-in lapses mid-session. When the tool already knows it cannot write, it
now says the same thing rather than nothing.

So: the queue's buttons are gone while signed out and the note above the table
says why, `applyShareMode` redraws the queue as well as the register, and a
change that cannot be shared says so.

`render/rogate.html` holds it, against the stubbed client. It fails on the
build published before this (three assertions) and passes after.

### Archiving keeps the sale

"Outside of advice" is a decision about whether a property counts towards the
advice. It is not a claim that the sale never happened &mdash; and Archive used to
drop the parked figures on the floor, which left a sold property reading as
held for ever. Worse, `queueFound` skips anything archived, so the sold check
never offered it again: the sale was not set aside, it was lost.

`takeSale(e)` is now the single place a parked sale becomes a sale, and Record
and Archive both go through it. The dialog says *"Record the sale and set
outside of advice"* and the note on the tab says Archive records it too.
`render/archsale.html` covers both buttons.

### Editing an untyped property used to type it

`ptypeOf()` answers *which Cotality series is this measured against*, and says
House for a blank. `openEdit` filled the type field with it, so opening any
untyped property and saving anything at all &mdash; a price, a note &mdash; wrote House
onto the record as though somebody had checked. 22 sold properties have no
type; every one of them was one edit away from claiming one.

The field now has **Not recorded** as its first option and opens on it when
nothing is stored; the save line already turned a non-HUD value into
`undefined`, so it needed nothing. `render/notyped.html` checks the three
cases: a blank stays blank through a save, a recorded type round-trips, and a
type can still be set on a property that had none.

This bit, in the register's own words, is why it matters: an empty field is
measured AS a house, but saying "House" claims someone checked.

### What soldVerified actually holds

Counted over the 600 sold properties in the shared book on 5 Nov:

| stored value | rows |
|---|---|
| nothing | 573 |
| Manual import | 23 |
| RPData import | 2 |
| ADL - Sold | 2 |

Two things follow. **"Manual" mostly means "nothing recorded"** &mdash; `verifiedOf`
returns *Manual import* for a blank, which is a deliberate decision (a sale
with nothing against it was keyed in by hand) but it means 573 pills are a
default, not a fact. And **the field holds two different kinds of answer**: the
site that answered for a price (RP Data, Pricefinder, REA, Manual) and, for a
sale that came off a tracking sheet, the sheet itself.

That second kind broke the edit form. `eVerified` is built from `VERIFIED`,
which lists the four sites; setting `.value` to *"ADL - Sold"* matched no
option, so the select fell to no selection and the save line wrote `undefined`
over it. Editing the note on such a row threw away where the figure came from,
without a word &mdash; the same shape as the property-type trap above. Anything
stored that the list does not have is now appended to it, so it round-trips.
`render/notyped.html` covers both traps, since they are one mistake twice.

Only 4 of the 600 carry a sale link, which is the `soldLink` gap in
**Known gaps**, now with a number against it.

### A full browser is not an empty register

`putProps` used to treat a refused `localStorage` write as "there is no list", and the error it wrote was cleared a
moment later by `calc()`, which ends in `showEmpty`/`showHeld`/`showNoted` — each of which sets `#messages` to `''`. The
two faults together meant a browser that was out of room presented as an empty book with no explanation. It happened:
this origin is shared with every tool on the domain, localStorage is ~5 MB between them, and the register is ~224 KB.

Now the shared copy is treated as the record it is. A refused write keeps the list in `memProps` for the life of the
tab, `loadProps` prefers it, and `sayStorage()` is called *after* the renders rather than before. An edit that neither
`localStorage` nor the database can hold is still refused outright, because showing a change a reload would discard is
worse than refusing it.

### The worklist, and why the bookmarklets do not read the database

A bookmarklet runs on `rpdata.corelogic.com.au`. The sign-in that gates the register lives on this origin, and one origin
cannot read another's, so a bookmarklet can never borrow it — it can only present a credential it carries in itself.

Until 2026-10-30 it carried none and did not need to: it fetched `supabase-config.js` from pp-research and read `irr_book`
anonymously with the publishable key. `__CFG_SRC__` was supposed to repoint that at the hub but was never substituted by
`buildBm`, so a bookmarklet dragged from this build drove the **standalone** book. Substituting it would not have fixed
anything either — migration 131 revokes `anon` on `irr_book`, so the hub answers that fetch with `401 permission denied`.
The two routes left were to open the register to anyone holding the publishable key, or to put a credential on a bookmarks
bar. Neither is worth the register.

So the party that **is** signed in writes the list down where both can reach it. Opening the **Sold check** tab POSTs the
register to the Apps Script as `{kind:'register', rows}`; it replaces a `Register` tab wholesale and stamps the header with
the time; `?register=1` hands it back. The bookmarklets read that, through the `/exec` address they already hold. One
capability between them instead of two, and `irr_book` stays shut to anyone not signed in.

Consequences worth knowing:

- **The worklist is a snapshot.** It refreshes when the tab is opened (at most once a minute). A sweep can run against a
  list a few hours old; the tab says how old, and the bookmarklet warns past a week.
- **`tools/sheet-endpoint.gs.txt` is now load-bearing, not reference.** A deployment without the `register` branch cannot
  answer, and both bookmarklets refuse to run rather than reporting an empty worklist as a finished job. The liveness reply
  advertises `kinds: ['type','register']` so they can tell.
- **The whole register goes, archived and sold included.** Which properties are due is the bookmarklet's decision and
  differs per pass — the sweep wants the untyped ones, the sold check the held ones — so the list carries facts, not a
  verdict.
- `__CFG_SRC__` is gone from the source. There is no longer a placeholder to forget to substitute.

## 4. Known gaps

- A new key needs a Groups tick (Van) before admins assigned to a group, or staff, see the Vault card.
- The standalone build at `pp-research.github.io/tools/irr-breakdown.html` still exists and still works. Until it is retired
  there are two copies, and only one of them is the real register — decide which before anyone else is pointed at this.
- The data has to be copied across: the book one row per city, and the change log as a table. Neither goes through a
  CSV export of the register — that only ever holds the visible, filtered rows.

## Changelog

- 2026-11-05 &mdash; **The For review note can be hidden.** It is a setup you read
  once; **Hide** in its corner puts it away and a **?** beside the heading
  brings it back (the words are in its title and aria-label), the way the Sold check's guide already waits
  behind a button. Remembered per browser in `pp-irr-revnote-v1`. The hide
  button is written into the note, which `drawQueue` rebuilds on every draw,
  so its listener is delegated rather than bound &mdash; `render/revnote.html`
  checks it still works after a redraw, which is what a bound one would fail.
- 2026-11-05 &mdash; **The queue runs down the page.** A review row is two lines tall,
  so the 520px box held seven of twenty-four and you worked the queue by
  dragging a scrollbar inside a card. Above 1280 it has no inner window at
  all and the headers stick to the screen, like the register; below 1280,
  where the table cannot fit side to side, the window is 75vh rather than
  520px. The media query has to come after the plain rule or it loses the
  cascade &mdash; same specificity.
- 2026-11-05 &mdash; **The For review badge is red.** Same as the Sold check badge, and
  for the same reason: both mean there is work nobody has dealt with, and a
  count in the quiet colour reads as a total rather than as something to do.
- 2026-11-05 &mdash; **Sold before, on For review.** A date box that narrows the queue
  to findings whose sale predates it &mdash; the archive says 443 of 444
  properties outside of advice were archived for exactly that, so it is the
  queue's most common decision, done in one action.
- 2026-11-05 &mdash; **For review follows the city filter again.** With the badge
  counting the same city the table shows, and a line above it naming what is
  waiting elsewhere &mdash; which is what was missing the first time.
- 2026-11-05 &mdash; **"Added" is "Not on the register".** One finding, one name, on both
  the Sold check list and For review.
- 2026-11-05 &mdash; **Editing a row no longer throws away a sale source the dropdown
  does not list.** A sale off a tracking sheet carries the sheet name, which was
  not one of the four options, so an unrelated edit wrote `undefined` over it.
- 2026-11-05 &mdash; **Editing an untyped property leaves it untyped.** The type field
  opens on *Not recorded* rather than House, so saving an unrelated change no
  longer claims somebody checked.
- 2026-11-05 &mdash; **Archive records the sale.** It used to throw the parked figures
  away, and the sold check skips archived properties, so the sale was lost
  rather than set aside.
- 2026-11-05 &mdash; **For review needs a sign-in to act on.** Record, Archive and
  Reject were pressable while signed out: the row left the queue here, nothing
  reached the shared copy, and nothing said so. The buttons are gone while
  signed out, and a push that cannot happen now warns instead of returning
  silently.
- 2026-11-05 &mdash; **Another person's change reaches a tab that has been open all
  day.** The live channel was the only way in and does not survive a sleep; the
  tab now re-reads the shared copy when it comes back, unless it is holding
  unsent work. `bodyKey()` fixes the comparisons that `rev: Date.now()` had
  made meaningless.
- 2026-11-05 &mdash; **A failed daily check retries.** One *Failed to fetch* at 06:45
  used to stand in for the whole day; a failed read now stands for two minutes,
  not twenty hours.
- 2026-11-04 &mdash; **Purchase is a column of its own, on both tables.** The price with
  its date under it on the Sold check list and in For review; the cell beside it
  is now only about the sale.
- 2026-11-04 &mdash; **The register fits its panel again.** It wanted 1373px in a
  1183px card at 1280 and hung over the edge, where nothing could scroll to the
  right-hand columns. Headings wrap instead of setting the width, the sold-check
  chip wraps like the note chip already did, and eight columns gave back a few
  pixels each. Below 1280 the table gets its own scroll window rather than
  spilling.
- 2026-11-04 &mdash; **The source pill says RP Data, Pricefinder, Manual, REA.**
  "import" was in all four and said nothing; eighteen characters of pill was
  setting the width of the Sold price column. The stored value is untouched &mdash;
  the edit dialog, the CSV and the share all still carry "RPData import" &mdash; and
  the pill's tooltip gives it in full.
- 2026-11-04 &mdash; **Waiting on &rarr; Finding.** The column names the kind of finding (*Sale found*, *Added*,
  *Not on the register*); nothing in it was ever something the property was waiting on.
- 2026-11-04 &mdash; **The link beside the date names the site.** *View in RP Data ↗*, *View in REA ↗* or
  *View in Pricefinder ↗* in place of a bare *record*, read off the hostname by `recordLink` and used in both the
  findings list and For review.
- 2026-11-04 &mdash; **The count says sales, not properties.** "27 properties the register does not have" was
  wrong for 26 of them: it has the property, it does not have the sale. Only the handful marked *Not on the
  register* are properties it has never seen, which the list says row by row.
- 2026-11-04 &mdash; **One list on the Sold check tab, kept across a refresh.** The match table, the tallies and
  the left-alone line are gone; every sheet feeds one list, one row per property, drawn the moment the tab opens
  with no network call. Loading the records no longer queues — Send is the only thing that writes.
- 2026-11-04 &mdash; **The ring shows from whichever tab you are on, as soon as a read is decided.** The first
  open of the day reads the sheets while you are still on the Register, and the Sold check tab says so straight
  away rather than after the 1200ms startup pause.
- 2026-11-04 &mdash; **The findings are a list on the page, not a dialog.** The tracking check now writes what it
  found into the Sold check tab &mdash; each property, its city, the figures and the sheet it came from &mdash;
  with Send and Not now underneath. The two buttons move up beside How this works as soon as anything is listed.
- 2026-11-04 &mdash; **The Sold check tab says when it is reading.** A ring spins beside the badge while the
  daily scan, the records load or the tracking check is in flight, the tab carries `aria-busy`, and the buttons
  that would start another read are disabled until it finishes.
- 2026-11-04 &mdash; **The Sold check count covers all three sheets.** It read the two tracking sheets only, so
  it said 12 while 32 rows were waiting. It now reads the sold check sheet in the same pass, counts distinct
  properties rather than rows (a sale in two sheets is one thing to deal with), and the line names the split.
- 2026-11-04 &mdash; **The automatic load queues nothing, and the two numbers agree.** Opening the tab used to load the
  sold check records *and queue them*, then ask the tracking sheets what was left &mdash; so the tab said 12, the
  dialog offered 9, and 20 properties arrived in For review unasked. The automatic path now loads quietly and the two
  steps are chained, so the badge and the dialog count the same book.
- 2026-11-04 &mdash; **The count is red, and opening the tab does the asking.** A number nobody has been shown wears
  `.badge-alert`; opening the Sold check tab loads the records and opens the tracking confirm without a second press,
  once per scan result, and never from the page load.
- 2026-11-04 &mdash; **The daily count is thrown away when the queue is acted on.** Recording, archiving or rejecting
  anything invalidates the stored answer, so the badge goes blank rather than stale and the next open checks again. It
  was showing the last scan's number for up to twenty hours after the queue had been emptied.
- 2026-11-04 &mdash; **Reject asks with buttons, not a tick box**: *Reject forever* and *Reject for now* sit side by
  side in the prompt. Also: the History prints the word that is on the toggle rather than the value behind it &mdash;
  the rent basis is stored as `Flat` and its button says **Midpoint**, so the log said a word that appears nowhere in
  the tool. Rows written before this are shown under the button's name too; the stored rows are untouched.
- 2026-11-04 &mdash; **Reject can say "not now".** A tick box on the prompt decides whether a refused sale is
  remembered (so it is never raised again) or simply cleared (so the next check finds it exactly as before). It is
  offered only where it means something.
- 2026-11-04 &mdash; **Reject replaces Delete in the queue.** It refuses what was found rather than the property: a
  rejected sale leaves the property untouched and is remembered so the same one is not raised again, while a property
  that a check added is removed *and* kept in the History where Restore can reach it. The old button deleted the whole
  record and logged no way back.
- 2026-11-04 &mdash; **Two buttons, and a daily check.** *Load sold check records (RP&nbsp;Data)* and *Check tracking
  sheets (ADL &amp; BRI &ndash; Sold)* sit side by side; the per-sheet buttons are gone and one press covers every
  sheet in `TRACKING`. On the first open of the day the tool asks the tracking sheets itself and leaves a count on the
  Sold check tab &mdash; it looks, it never acts.
- 2026-11-04 &mdash; **The queue's table, after looking at it.** The Source column is gone and the source sits under
  the figures it belongs to; Archive and Delete are icons so the row fits its panel; the note explains what *Sale
  found* and *Added* actually mean. Fixes two layout faults a screenshot found and no assertion had: a flex `.note`
  rendering its own text as columns, and `table.mini`'s `nowrap` forcing the table past the panel edge.
- 2026-11-04 &mdash; **The city filter now stops at the Register, the Growth comparison and the Calculation.** The Sold
  check, For review and the History show every city, whichever one is selected. Also: one button per tracking sheet,
  beside *From Google Sheet* and in the same shape, each reading only its own tab.
- 2026-11-04 &mdash; **BRI - Sold**, a **Source** column, and per-row **Record / Archive / Delete**. `TRACKING` is a
  table now, so a third city is one row; both sheets are read in their own time zones and a sheet that cannot be read
  stops the check by name instead of shrinking it. Every door into the queue stamps where it came from, the result line
  says when something was queued for a city the view is filtered away from, and Approve became Record.
- 2026-11-04 &mdash; **Check ADL &ndash; Sold**: a second source on the Sold check tab, reading the Adelaide tracking
  sheet through the same `/exec` by a pinned id. Found sales are parked and unknown properties are added, both waiting
  in For review; everything already sold, already queued, archived or half-filled is reported and left alone. Also
  fixes a one-day shift that came from formatting that sheet's dates in the script's time zone rather than its own, and
  a name collision in which the review queue's `drawReview` silently replaced the paste importer's, leaving the
  Updates stage of an import with nowhere to render.
- 2026-10-30 — **For review**: a queue between the sold check and the register. Found sales are parked rather than
  written, added properties wait for approval and are kept out of the Overview and Growth comparison until they get it,
  and approved/archived/deleted all reach the History with a reason. Adds `review` and `pending` to `SHARE_FIELDS`.
  Also: `putProps` no longer loses the register when `localStorage` is full, and `tools/online-reports.html` now evicts
  a stale data cache instead of keeping it for ever — between them the cause and the symptom of an empty register on a
  full browser.
- 2026-10-30 — The bookmarklets stopped reading the database. The signed-in tool now publishes the worklist to the Google
  Sheet and they read it from there, which ends the cross-wiring to the standalone project and removes the last reason to
  consider opening `irr_book` to `anon`. Needs `tools/sheet-endpoint.gs.txt` deployed before the tool is used.
- 2026-10-30 — Refreshed from the standalone build, which had moved on 60 kB since the port. Adds the **Growth comparison**
  tab (Performance Property against the Cotality capital-city and council medians, three methods, houses/units/all), the
  register's **vs Market** and **vs Council** views, a copy-address button, and the `shareBody()` fix described under
  **Data model**. Adds `tools/lga-median.js` (the council medians the comparison reads — referenced by the page and
  previously missing from the port, so the council views would have shipped dead), `tools/sheet-endpoint.gs.txt` (linked
  from the sold-check modal; static checks caught the dangling link), and `public.irr_config` to migration 131 (the tool
  reads and writes it; the migration did not create it).
- 2026-10-28 — Ported: the tool, its engine and suburb file, migration 131, the registry key, the Vault card and the hub
  search entry.
- 2026-11-05 — "Update returns data" saves a draft (`draftPp` on the city's `client_pages` row) instead of writing the live `pp`; it is published from that city's Returns page in the Vault (Ian, PR #16). See adelaide-returns.md.
- 2026-11-05 (later) — "Update returns data" also works when the city has no `client_pages` row yet: it creates a draft-only row, and the Vault Returns page fills the rest from SEED on Publish (Ian, `46d1297`). See adelaide-returns.md.
