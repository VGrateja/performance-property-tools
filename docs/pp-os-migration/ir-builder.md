# IR Builder — feature inventory for the pp-os port

This file describes everything the hub's IR Builder (`tools/ir-builder.html`) does after the 2026-09-30 redesign, so the pp-os
port can rebuild it feature for feature. The redesign follows the structure the research/acquisitions team agreed on 30 Sep 2026
(Johny's brief: "an easier to use platform to create investment reports and make it clearer for the client"). It changes the
client report and adds the editor inputs the new pages need. **No schema change**: every new field lives inside the existing jsonb
section columns of `public.ir_files`, so the mig-104 audit trigger works unchanged.

Source of truth in the hub repo:

| What | Path |
|---|---|
| The tool (all client code, one file) | `tools/ir-builder.html` |
| Tables, rubric, rulebook, config, audit trigger | `supabase/migrations/104_ir_builder.sql` (+ 105 evidence bucket, 106 library bucket, 107/109 read + write RLS, 117/118 delete rules) |
| The IR chain's shared rules (CBD band, cashflow disclaimer, the cashflow slide) | `docs/pp-os-migration/ir-chain.md` |
| QA scripts (gitignored) | `scratch/ir-redesign/_qa-*.mjs` |

**LOCKSTEP.**
- `calcCashflow()` is a verbatim copy of the one in `tools/ir-samples.html` (and `_irCfCalc()` in `presentation.html`). The
  redesign did **not** touch it; the two-rate client cashflow is a wrapper, `cfTwoRate()` (§4.5).
- `CBD_BANDS` / `cbdBand()` / `CF_DISCLAIMER` are the IR-chain copies (see `ir-chain.md` §1–2).
- `CLOCK_PHASES` copies the phase words of `buying-selling-slides.html` `TL_CLOCK_STEPS` + `TL_PHASE_WORD` (§4.2). If the
  Investment Committee moves a band edge, both move.

---

## 1. Steps (the step rail)

`STEPS`, in order: **Review** · **Setup** · **Preliminary DD** · **Inspection & standards** · **Grading** · **Pricing** ·
**Cashflow** · **Compliance** · **Report** · **Audit**. Home list, Review, Audit, Compliance and Publish behave as before the
redesign. `stepDone()` is unchanged (a green dot when the section has data).

## 2. Access (unchanged)

- Reads: any signed-in staff member who can reach the page (auth-gate + the `ir-builder` group tick).
- Writes: `ir_can_write()` = `is_writer()` OR `has_tool_role('ir-builder')` (RLS). The client mirrors it with `CAN` (not a
  client/guest tier) and `CANW` = `CAN` and `status = 'active'`.
- Publishing flips a file to `final`; final and archived files are read-only until flipped back (the flip is audited).
- Delete: drafts — anyone who can write; published files — dev tier only (mig 117), cascade on publish artefacts (mig 118).
- The grading rubric (`ir_grading_rubric`) is only readable with `ir_can_write()`. A viewer without the role therefore sees the
  report without rubric comments (pre-existing behaviour).

## 3. Data model — every field and its jsonb path

Top-level columns: `address`, `suburb`, `state`, `postcode`, `market_label`, `market_slug` (the region key), `status`
(`active` | `final` | `archived`), `roles` {`consultant`, `dd_support`, `sales_admin`, `assistant`}.

### 3.1 `setup`

| Path | Type | Editor | Notes |
|---|---|---|---|
| `setup.propertyType` | text | Setup | House / Unit / Townhouse / Villa / Unit Block / Industrial / Medical / Office / Retail (datalist, free text) |
| `setup.commercial` | bool | Setup | explicit commercial flag |
| `setup.landSize`, `beds`, `baths`, `cars` | number | Setup | |
| `setup.lga`, `strategy`, `listingUrl`, `crmUrl`, `driveUrl` | text | Setup | `lga` is prefilled from Cotality when empty |
| `setup.photos[]` | `{path, name, at}` | Setup | bucket `ir-evidence`, path `<fileId>/photos/<ts>-<name>`; index 0 = cover |
| `setup.preparedBy`, `preparedAt` | text | (import only) | the cover prints `preparedBy` before `roles.consultant` |
| **`setup.geo`** | `{lat, lng, source, q, at, auto, kind}` | Setup · Map location | NEW — §5 |
| **`setup.execSummary`** | `{priceReturn, positives[], maintenance[], marketNote, auto{…}, at}` | Setup · Executive summary | NEW — §6 |

### 3.2 `dd`

| Path | Type | Notes |
|---|---|---|
| `dd.items[<code>]` | `{rating: Approved|Review|Failed, notes, files[{path,name,size,at}]}` | the region rulebook (`ir_dd_rules`) drives the list; evidence at `<fileId>/<item-slug>/<ts>-<name>` |
| **`dd.strata`** | object | NEW — §8. Fields below; attachments at `<fileId>/strata/<ts>-<name>` |

`dd.strata` fields (DRAFT structure — "to be confirmed against the team's strata DD template"; Saskia will supply the real one):

| Key | Label | Type |
|---|---|---|
| `ocCert` | Owners corporation certificate obtained | `yes` / `no` |
| `ocCertDate` | Certificate date | ISO date |
| `adminLevyQ` | Admin fund levy per quarter | number ($) |
| `sinkingLevyQ` | Sinking / maintenance fund levy per quarter | number ($) |
| `specialLevyQ` | Special levies per quarter | number ($) |
| `sinkingBalance` | Sinking fund balance | number ($) |
| `agmReviewed` | Last AGM minutes reviewed | `yes` / `no` |
| `agmDate` | Last AGM date | ISO date |
| `buildingInsurance` | Building insurance (insurer, sum insured, expiry) | text |
| `publicLiability` | Public liability cover | text |
| `manager` | Building manager / strata manager contact | text |
| `byLaws` | By-laws incl. pets and short-stay | long text |
| `defects` | Known defects, litigation or cladding orders | long text |
| `notes` | Notes | long text |
| `files[]` | attachments `{path, name, size, at}` | |

### 3.3 `inspection`

| Path | Notes |
|---|---|
| `inspection.agentPrice`, `agentRent`, `whySelling`, `occupancy`, `streetAppeal`, `constructionQuality`, `adjoining`, `condition`, `yearBuilt`, `refurbAge`, `kitchenAge`, `bathroomAge`, `ensuiteAge`, `laundryAge`, `wallMaterial`, `roofMaterial`, `storeys`, `pool`, `contingency`, `videoRef` | the Overview card (`INSP_FIELDS`), unchanged; `pool` seeds the cashflow's pool tick; `refurbAge`/`yearBuilt` drive the AMP window |
| `inspection.beds`, `baths`, `living`, `cars` | Accommodation card |
| `inspection.rooms{room: {features[{name,p,r,m,cost,note}]}}` | LEGACY room grid. No longer editable; shown read-only while the checklist is empty; printed as "Inspection notes (legacy format)" |
| `inspection.summaryNotes` | imported legacy summary (printed on the legacy page) |
| **`inspection.checklist`** | NEW — §7: `{items{slug: {state, comment, photos[]}}, defects[], signoff{}}` |

### 3.4 `grading`

`grading.items{attribute: grade}`, `grading.strategy`, `grading.propertyGrade`, `grading.suburbRating` (prefilled from
Suburb Scoring when empty). Commercial files also carry `riskRating`, `overallRating` and a commercial rubric (Lease Terms,
Tenant Quality …) — kept and shown, never dropped (§9).

### 3.5 `pricing`

| Path | Notes |
|---|---|
| `pricing.suburb{suburbMedian, suburbRent, suburbYield, cagr3, cagr5, cagr10, cagr20, ltCagr, dom, avm, p25, p75}` | prefilled from `suburb_stats` where empty; provenance chips |
| `pricing.history[{date, price}]` | this property's sale history |
| `pricing.streetSales[{address, beds, baths, cars, land, price, date}]` | |
| `pricing.compSales[{address, link, beds, baths, cars, land, price, date, land_r, accom_r, loc_r, qual_r, cond_r, overall_r}]` | ratings ∈ Inferior / Slightly Inferior / Comparable / Slightly Superior / Superior. Imported rows may also carry `comments`, `yield`, `area`, `pricePerSqm` — the editor now keeps them on save |
| `pricing.compRents[{address, link, comparability, rent}]` | |
| `pricing.adopted{comparable, rent, marketStrength, topPrice, suburbYield, yieldPrice, negotiationRange, floorToCeiling, directComparisonRange, marketRentRange, …}` | `negotiationRange` = comparable × (1 + level.lowPct … highPct) from `ir_config.market_strength`. Commercial files carry cap-rate / replacement-cost keys (kept, not printed) |

### 3.6 `cashflow`

`budget, rent, lvr, rate, loanTermYears, stampDuty, engagementFee, acquisitionFee, titleTransfer, conveyancing, buildingPest,
depreciationSchedule, professionalClean, maintenanceAllowance, minRentalStdCost, cosmeticWorks, strata, councilWater, landTax,
insurance, pmFeePct, lettingFeeWeeks, weeksLet, repairsPctOfRent, feeLines[{label, pct, amount}], hasPool, poolMaintenance`.
Defaults from `ir_config.defaults`; land-tax and insurance suggestions from `ir_config.land_tax` / `insurance`. `rate` still
drives the editor's P&I card; the client report uses the live rates (§4.5).

### 3.7 `compliance` and `suburb_stats`

- `compliance.items{key: {done, by, at}}` (the manual role checklist), `compliance.review{section: {by, at}}` (Review "checked"
  marks), `compliance.reportAt` (stamped by Print / Save PDF), `compliance.published{at, libraryId, sold_date, price_paid, pdf}`.
- `suburb_stats` = the read-only reference: `asof`, `ptype`, `scores` (Suburb Scoring), `cl` (Cotality `forge_cl_suburbs`
  metrics incl. `distCbd`) and **`market`** (NEW — the cached market refresher, §4.2). Never edited by hand.

---

## 4. The client report — eleven sections, in this order

Rendered by `buildReportPages('client')` after `prepReport()` (async: signs photo URLs, runs the two cashflows, fetches the
market panel, snapshots the map, loads Montserrat so the paginator measures real text). Every page is A4 (794 × 1122 CSS px,
44 px padding top and bottom): content box 1034 px; the paginator's limit is `PG_INNER_MAX = 1030`.

**Engine rules.**
- `flowPages(title, headFn, blocks)` lays blocks onto pages by measuring them in an off-screen `.pg`
  (`#ibMeasure`). A table row is a block, so a row never splits and the table head repeats on each page. `keep` blocks
  (headings) move with the block after them. A section may run to two or more pages; the title gets "(1/2)".
- Page wrapper: `<div class="pg"><div class="pgc">…</div><div class="foot">address · Investment Report · Page N of T</div></div>`.
  `.pgc` is a flow-root so what is measured is what prints.
- The logo appears on the cover only (bottom-right, `../assets/logos/pp-logo-standard.png`, 40 px high).
- Page header `pgHead(title, sub)`: sentence-case title with a 34 × 4 teal accent bar, the address right-aligned.
- Print: `#ibPrint` holds the pages; print CSS hides everything else (`@page A4, margin 0`). The publish PDF (html2canvas →
  jsPDF) captures each `.pg` as one A4 image — so no page may run long.

### 4.1 Cover
- Eyebrow "Investment property report"; "Prepared <date> · by <setup.preparedBy | roles.consultant>".
- Address (30 px), locality line (suburb state postcode · market), **the CBD band** (`cbdBand()`, teal, left-aligned — kept from
  2026-09-29), bed / bath / car / land line.
- **Hero photo**: the first photo whose name is neither a map nor a floor plan (`!/map|floor/i`), full-width band, 440 px.
- Three tiles: Property strategy (`grading.strategy` | `setup.strategy`), Property grade, Suburb rating.
- "IMPORTANT INFORMATION" small print = `boilerplate.cover_important[0]` as the heading and the rest as the body (the old cover
  printed element 0 — the heading — as the body, so the text never showed).
- "Prepared for" is not printed: `ir_files` holds no client name, by design ("No client names, ever").

### 4.2 Executive summary
- Header line: "3 bed · 2 bath · 2 car townhouse on 250 m² · <strategy> · <grade>".
- **Four cards** (`execCards()`):

| Card | Value | Sub-lines |
|---|---|---|
| Purchase price | `pricing.adopted.topPrice`, else `cashflow.budget` | "Negotiation range …" (adopted); "Cashflow modelled on $X" when budget ≠ top price; "Modelled purchase budget" when no top price |
| Rent and gross yield | `cashflow.rent` /wk | "Gross yield" = the cashflow's `grossYield` |
| Weekly cash flow | TWO figures: weekly at the current rate, weekly at the IC rate | "Interest only · L% LVR" |
| Capital required | `max(0, requiredCapital)` | "To complete, incl. acquisition costs" |

  QA asserts every card equals the cashflow page (weekly × 2, capital, rent, gross yield).
- **Three blocks** — "Price and return" (paragraph), "Why this property" (bullets), "What it will need" (bullets): the resolved
  `setup.execSummary` (§6).
- **Market refresher** ("<Region> at a glance", source line "Performance Property Research · <Month YYYY>"), eight tiles:

| Tile | Source | Rule |
|---|---|---|
| Where it sits | `clock_state.payload.houses|units[{name,hour}]` | segment = units when `propertyType` ~ /unit|apart|town|villa|flat|block/i, else houses; name match upper-case; Albury / Wodonga units → the combined "ALBURY-WODONGA" entry; hour label `h:mm`; phase word by `CLOCK_PHASES` (degrees clockwise from twelve, [a1, a2)): 300–30 Selling window · 30–90 Correction · 90–135 Before the buy value · 135–225 Buy value · 225–300 Momentum |
| Vacancy rate | `rdp_raw_series` metric `vacancy_rate` (source tag `sqm` = the Cotality monthly upload), latest annual point | sub: "Our 1-year projection" = `rdp_vr_forecast.payload.forecastVR + (vacancyNow − payload.currentVR)`, floor 0.1% (the B/S deck's `getVRAdjusted`) |
| Median house price | `rdp_raw_series` `mp_h` latest | sub: year-on-year % (latest annual point v the year before; adjacent years only) |
| Median unit price | `mp_u` | same |
| Price rank | latest `mp_h` across a pool | capitals (sydney, melbourne, brisbane, perth, adelaide, canberra, hobart, darwin) rank among the 8 capitals; others among our 36 markets (`rdp_regions` minus `australia` and `state` clusters); 1 = most affordable; ties share a rank; printed "3rd most affordable · of 8 capitals by median house price" |
| Population growth | `population_gccsa` if the region has it, else `population` | year-on-year %; sub = residents (year) |
| Supply | `rdp_vr_forecast.payload.expNewHouseholds` v `expProperties` | "Undersupply N" / "Oversupply N"; sub "H new households v D new dwellings, next 12 months" |
| Runway headroom | `rdp_runway.payload.house|unit.runway_pct` | sub "Median $X v affordability ceiling $Y" (`median`, `ceiling`) |

  The BA's market note prints under the tiles. **Caching**: the panel is written to `suburb_stats.market`
  (`{v, slug, name, seg, isCapital, asof, month, clock, vr, mpH, mpU, rank, pop, supply, runway}`) on Setup save, on Print /
  Save PDF (client mode) and on Publish. An `active` file shows the live panel; a `final` / `archived` file shows the cached one
  (the numbers it was presented with), falling back to live when nothing is cached. No market slug → a note to set the market.
- When hand-written text overflows, the page takes the `tight` class (smaller bullets) instead of a second page.

### 4.3 Map and location grading
- **Left: the map** (330 × 520):
  1. `setup.geo` present → a **canvas snapshot** (`mapSnapshot(lat, lng, 330, 520)`, zoom 15, data-URL PNG): the tiles are
     fetched with CORS, drawn at their pixel offsets, lightened toward a CARTO-light look (55% toward luminance, +22% toward
     white), a teal pin with a white ring at the exact centre. Cached per session. "Map data © OpenStreetMap contributors".
  2. else the file's own map image (first photo named /map/, not /floor/), the box taking the image's shape (max 520 px).
  3. else a neutral "Map unavailable — add the property's location in Setup" card.
- The "N km to the CBD" chip (dark, top-left of the map) prints **only for capital-city markets** with
  `suburb_stats.cl.distCbd`: Cotality measures to the STATE CAPITAL's CBD (`ir-chain.md` §1.3), so a regional suburb would read
  hundreds of km.
- **Right: location attributes** (§4.3.1) in the brief's order, each: name, the rubric comment (small), a grade chip (word AND
  number) and a five-step bar; a legend; "Average of the N location grades: X on the 2.5–5 band" (Excellent counts 4.75).
- **Below: three tiles** — Suburb rating, Distance from the CBD (`cbdBand()`), Asset grade (`propertyGrade` + counts of the
  asset grades).

#### 4.3.1 Location v asset attributes (the rubric's 31 items)

Location (11): Distance From CBD · Security of the Area · Public Transport · Average Area Income · University/Schools in Area ·
Café · Shops · Proximity to Open Space · Proximity to Ocean/Bay/River/Lake · Street Scape/Traffic Flow · Properties Adjoining.

Asset (20): Property Type · Building Quality · Natural Light · Privacy · Noise · Land Content · Scarcity Factor · Price Risk ·
Orientation · Outdoor Space · Parking · Internal Floor Plan Flow · Slope · Outdoor Access and Flow · Stand Alone · Stairs ·
Shape/Frontage · Value Add Opportunity · Building Condition · Views.

Rules (`splitGrading()`):
- The split is these constants, NOT `ir_config.grading_layout` (that layout files Views under location, lists "Title Type"
  and has no Building Quality).
- Alias: the old layout's "Proximity to Ocean/Bay/River" = "Proximity to Ocean/Bay/River/Lake".
- A graded item in neither list (Title Type, the commercial rubric) is an asset attribute unless its name contains
  location / distance / proximity (commercial "Location Quality" → location).
- QA: the two lists cover the 31 rubric items exactly once; on all 94 files every graded item lands once.

#### 4.3.2 The 2.5–5 band

| Grade | Number printed | Chip colour |
|---|---|---|
| Poor | 2.5 | Red `#E72347`, white text |
| Below Average | 3 | Yellow `#FFA91F`, Dark Teal text |
| Average | 3.5 | Neutral `#D9D9D6` |
| Above Average | 4 | Teal tint `#E8F7FA` with a 1 px `#00A0B4` border |
| Excellent | 4.5–5 (4.75 in averages) | Teal `#00A0B4`, white text |

A non-grade value (Property Type "House", Title Type "Strata") prints as a neutral fact chip. Chips use real borders, not inset
box-shadows (html2canvas mis-draws those in the publish PDF).

### 4.4 Asset grading
Tiles: Property grade · Property strategy · Property type. Table: Attribute · Grade chip · "What it means" (rubric comment) for
the asset attributes (+ Title Type and other asset extras). Footnote with the band. Nothing from page 3 is repeated.

### 4.5 Cashflow — one view, two rates
- `cfTwoRate(cf)`: `calcCashflow({...cf, rate: RATES.current}, 'io', RATES.current)` and the same at `RATES.normalised`
  (`rdp_runway_config` key `rates`: `current.rate` ≈ 6.72%, `forecast.rate` ≈ 4.89% — "the IC rate"). Interest only, the
  file's own LVR (`lvr || 0.9`) on the budget, the same loan. **Only `rate`, `interest`, `annual` and `weekly` differ** between the
  runs (QA-asserted).
- The client report uses the LIVE current rate, not the file's stored `cashflow.rate` (that still drives the editor's P&I card).
- Table, five sections: Cost of property (top budget, maintenance, cosmetic, min. rental standards when set, subtotal) ·
  Acquisition costs (stamp duty, engagement, acquisition, mortgage & title transfer, conveyancing, building & pest,
  depreciation schedule, professional clean, subtotal, total property + acquisition cost) · Running costs (**"Finance – interest
  at the current rate (6.72%)"**, **"Finance – interest at the IC rate (4.89%)"**, principal $0, letting fee, PM fee, fee lines,
  repairs, pool (when on), strata, council & water, land tax, insurance, running costs less finance) · Income (rent, income,
  net income before finance) · Investment summary (loan, required capital, gross yield, net yield, expense ratio, **"Annual /
  weekly cash flow at the current rate"**, **"Annual / weekly cash flow at the IC rate"**, each "−$A / −$W", red when negative).
- The old single "Running costs incl. finance" row is gone (it would need two values).
- Under the table: the IC rate definition ("the Investment Committee's normalised rate: the rolling 18-year average cash rate
  plus 2.29 percentage points") replaces `boilerplate.normalised_note`, then Saskia's two-paragraph `CF_DISCLAIMER` verbatim.
- Density by measurement: normal → `dense` → `denser` → `densest` until the page fits (94 files: 82 normal, 12 dense).

### 4.6 Inspection and minimum standards
- When the checklist has any entry: the intro (verbatim) + source line; then the three blocks with group headings, each item a
  row "Pass / Fail / N.A. / —" pill + the verbatim text + the comment (italic) + up to six photo thumbnails (84 × 63, signed
  URLs; the PDF embeds them); the heritage / apartment note under the minimum standards; **the 2027 energy table** (Victorian
  files only — `state = VIC`); the **defects log** table (Item · Room · Issue found · Photo · Who fixes · Action and date); the
  **sign-off** (Property · Inspected by · Date · Settlement date, then the three ticks). Non-VIC files add "Victorian minimum
  standards shown; other states to follow" to the source line.
- Legacy files (rooms / overview / summary notes but no checklist): "Inspection notes (legacy format)" — Summary, Overview,
  Accommodation, Items requiring attention (room features flagged required / maintenance).
- Nothing recorded: the intro + "The pre-settlement inspection has not been recorded yet."

### 4.7 Additional costs and settlement
The file's own figures first — "Acquisition costs" (non-zero lines + total) and "Allowances in the cost of property"
(maintenance allowance, cosmetic works, minimum rental standards) — then `boilerplate.additional_costs` and
`boilerplate.settlement` in two columns. Parser (`bpHtml()`): a short line without end punctuation is a heading (except
"Timeframe:" / "Budget:" lines, which get a bold label); "- " lines become bullets; newlines split paragraphs.

### 4.8 Strata due diligence — units only
Gate `isStrata(file)`: `propertyType` ~ /unit|apart|flat|townhouse|villa/i **or** `grading.items["Title Type"] = Strata`; never a
unit block or a commercial file (a whole block is bought on its own title). 62 of the 94 files qualify. Two-column fact sheet
of `dd.strata` (money formatted, dates en-AU, yes/no) + "Strata fees in the cashflow (per year)" from `cashflow.strata`; the
long-text fields as paragraphs; the attachment list; the footnote "Draft structure — to be confirmed against the team's strata
DD template."

### 4.9 Asset management plan
Content unchanged, restyled: refurbishment plan (last refurbishment = `refurbAge` | `yearBuilt`; window = +11 to +15 years,
"overdue" when past; estimated cost 3% of budget; purpose), renovation plan for foundation assets (7%), items flagged at
inspection, directives (trading v foundation), the inflation note. **Items flagged** come from the defects log when the checklist
is in use (Room — Item: issue (who)), else from the legacy room flags.

### 4.10 Price analysis
Tiles: Adopted comparable value · Adopted top price · Negotiation range · Floor to ceiling · Market strength · Adopted rent.
Comparable sales (max 12): Address · Bd/Ba/Car · Land m² · Sold · Price · five sub-rating chips (short forms Sup / Sl. sup /
Comp / Sl. inf / Inf) · Overall chip (full word), plus a colour legend. Colours: Superior teal, Slightly Superior teal tint,
Comparable neutral grey, Slightly Inferior yellow, Inferior red (matched case-insensitively). Comparable rents (max 8, with a
comparability chip), recent street sales (max 8), sale history (date, price; max 8). **No land $/m²** anywhere.

### 4.11 Disclaimer
`boilerplate.disclaimer` paragraphs, paginated.

## 5. Geocoding (`setup.geo`)
- `geoQuery()` = "street, suburb, state, postcode, Australia"; a unit prefix is stripped ("5/37 Rosewood Cres" →
  "37 Rosewood Cres").
- **One Nominatim request per Setup save, at most**:
  `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=…` (browser fetch, no custom headers).
  It runs only when no coordinates are typed and the query differs from the cached `geo.q` (or the pin is still the automatic
  one and the address changed). A hit stores `{lat, lng, source:'nominatim', q, at, auto:{lat,lng}, kind}`; a miss stores
  `{source:'miss', q}` so an unchanged address never asks again; a cleared pin stores `source:'cleared'`.
- Typed or dragged coordinates → `source:'manual'` (no request). The "Locate from the address" button makes one request per
  click (disabled 1.5 s). Never in a loop; no batch job.
- Setup shows lat/lng with auto / edited chips and a Leaflet 1.9.4 pin picker (drag, click, or type).
- **Tiles**: `MAP_TILES.url = https://tile.openstreetmap.org/{z}/{x}/{y}.png` (CORS, attribution, light use). The decided
  CARTO `light_all` basemap now returns an "API KEY REQUIRED" watermark for every keyless request (checked 2026-09-30); swap
  `MAP_TILES.url` back to CARTO once a key exists (and turn `lighten` off).

## 6. The executive-summary drafts (`setup.execSummary`)
- `execDrafts(file, twoRate, market)` builds four drafts:
  - **priceReturn**: adopted top price (+ negotiation range) or the modelled price; "Rent of $R a week gives a gross yield of Y";
    "Interest only at L% LVR: $W a week out of pocket / surplus at today's R1, and $W2 … at the IC rate of R2"; "Capital required
    to complete: $C".
  - **positives** (max 6): "Suburb rated <rating> in our Suburb Scoring"; the rubric comments of the Excellent then Above
    Average grades (location first, then asset); "Preliminary due diligence approved on all N checks" when the DD result is
    Approved.
  - **maintenance** (max 6): every defects-log row ("Item — issue (who to fix)") when the checklist is used, else the legacy
    flagged features; the refurbishment window when it opens within 12 months or is overdue; the minimum rental standards
    allowance; the year-one maintenance allowance; else "No defects recorded at inspection".
  - **marketNote**: "<Region> houses|units sit at h:mm on the Property Clock (<phase>), and vacancy is V with our one-year
    projection at F."
- **Prefill rule**: Setup shows the stored text when the BA has edited it, else the live draft; chips auto / edited. On save the
  text and the drafts (`auto`) are stored. `execResolved()` prints the live draft whenever the stored text is empty or equals
  its stored `auto` snapshot (so untouched drafts keep refreshing with new numbers); a hand edit always wins. Clearing a box goes
  back to the draft.

## 7. The Victorian minimum-standards checklist (`inspection.checklist`)
- Items (Johny's document, verbatim; `VIC_CHECKLIST`, 50 items, stable slugs — never rename a slug):
  - **Minimum standards** — Entry and security (`es-locks` photo of locks, `es-window-latch`, `es-window-stay`) · Kitchen
    (`ki-area`, `ki-sink`, `ki-stovetop` photo, `ki-oven` photo, `ki-rangehood`) · Bathroom and toilet (`ba-basin`,
    `ba-showerhead` photo, `ba-toilet`, `ba-toilet-room`, `ba-exhaust` photo) · Laundry (`la-taps` photo of taps) · Living areas
    and bedrooms (`lb-heating` photo of the model plate, `lb-coverings`, `lb-anchors`, `lb-lighting`) · Whole property
    (`wp-electrical` photo, `wp-ventilation`, `wp-mould`, `wp-structure`, `wp-bins`), then the heritage / apartment note.
  - **Safety checks and records** — Smoke alarms (`sa-smoke-fitted`, `sa-smoke-hardwired`, `sa-smoke-annual`) · Gas
    (`sa-gas-check`, `sa-gas-smell`, `sa-gas-cooker`, `sa-gas-book` photo of model plate and hot water unit) · Electrical
    (`sa-el-check`, `sa-el-rcd`, `sa-el-points`, `sa-el-book`) · Other (`sa-pool`, `sa-bushfire`, `sa-hotwater`).
  - **Investor handover checks** — Contract and condition (`ho-condition`, `ho-inclusions`, `ho-repairs`, `ho-belongings`,
    `ho-cleared`) · Keys, access and paperwork (`ho-keys`, `ho-remotes`, `ho-manuals`, `ho-oc-cert`) · If a tenant stays on
    (`ho-lease`, `ho-bond`, `ho-rent`, `ho-records`).
  - **Energy efficiency standards from 2027** (information only, report page, VIC files): Cooling · Showerheads · Ceiling
    insulation · Heating · Hot water · Draughtproofing, + the exemptions / VEU line.
  - Intro, source line and notes: `VIC_INTRO`, `VIC_SOURCE`, `VIC_NOTE`, `VIC_ENERGY_NOTE` (verbatim).
- **States**: `pass` | `fail` | `na`; clicking the active state clears it. A Fail opens the comment box.
- **Item record**: `items[slug] = {state, comment, photos[{path, name, size, at}]}`; empty items are dropped on save. Photos go
  to `ir-evidence` at `<fileId>/inspection/<slug>/<ts>-<name>` (signed URLs, 1 h, to view) and save immediately (with the
  in-progress form).
- **Defects log** (`ckDefects()`): one AUTO row per Fail — item = the label before the item's colon (or the group + text),
  room = the group, issue = the comment, photos = the item's photos — derived live, so it always matches the checklist; each
  auto row keeps its own `who` (Vendor / Buyer / Property manager) and `action` ("action and date"), stored as
  `{auto:true, slug, item, room, issue, who, action}`. MANUAL rows `{id, item, room, issue, who, action, photos[]}`, photos at
  `<fileId>/inspection/defect-<id>/…`. An item that stops failing drops its auto row.
- **Sign-off**: `signoff{inspectedBy, date, settlementDate, defectsSent, worksBooked, pmBriefed}` — the three ticks read "All
  defects logged and sent to the conveyancer", "Pre-lease works booked", "Property manager briefed that the property must meet
  all 15 standards before it is advertised".
- A non-VIC file shows "Victorian minimum standards shown; other states to follow".
- The legacy room grid shows read-only while `rooms` exists and the checklist is empty.

## 8. Editors (what each step does now)
- **Setup** — Property card (unchanged), suburb intelligence, **Map location** (lat/lng + chips, Locate, Leaflet pin),
  **Executive summary** (four boxes + chips), photos, roles. Save: at most one address lookup, stores `setup.geo` +
  `setup.execSummary`, refreshes `suburb_stats` (Suburb Scoring + Cotality) **merged with the market panel**, then the prefills.
- **Preliminary DD** — the rulebook list (unchanged) + the **Strata due diligence** card when `isStrata()` (also when the
  market is not set). Uploads keep the unsaved ratings and strata fields.
- **Inspection & standards** — Overview, Accommodation, the checklist (collapsible groups with "n/m checked · f fail"), the
  defects log, sign-off, the legacy notes. Works at phone width.
- **Grading** — Strategy & rollups, then **Location / Asset tabs** over the same `grading.items`; Title Type is a standing asset
  row (Torrens / Strata / Company / Community); every stored item shows (non-rubric ones marked); a live chip per row; the save
  MERGES into the stored items.
- **Pricing** — unchanged tables, the six comparability selects coloured like the report chips (a stored value that differs only
  in case selects its option), rows keep every stored key on save; "Land rating" column label.
- **Cashflow** — a **Client report view** card (the same at both rates: loan, capital, gross yield, running costs; then interest /
  annual / weekly at the current rate and at the IC rate) above the BA's three computed cards.
- **Report** — **Client report / Internal pack** switch; Print / Save PDF exports whichever is showing (stamps `reportAt`;
  client mode also caches the market panel).
- **Review** — unchanged cards + readable blocks for `setup.geo`, `setup.execSummary` (auto / edited), `dd.strata` (inline-
  editable text / money fields) and `inspection.checklist` (counts, the failed / commented items with inline-editable comments,
  the defects log, sign-off).
- **Audit / Compliance / Home / Publish** — unchanged behaviour. Publish renders the **client** report into the library PDF.

## 9. The internal pack (BA + DD teams, not for clients)
`buildReportPages('internal')`: Preliminary due diligence (DD result + the three check groups), Grading matrix (tiles + location
and asset tables with rubric comments), Insurance help sheet (`INSURANCE_QA`). Footer "Internal pack — not for clients". These
pages left the client report because Johny's order has no DD page (the DD notes also name adjoining owners).

## 10. Notes for the port
- Keep the prefill rule (auto only where empty; provenance chips) and the "a hand edit always wins" execSummary logic.
- Keep the one-request geocoding rule; cache misses too.
- Keep the capital-only CBD chip (Cotality distance is to the state capital).
- Keep the two-rate wrapper outside the shared cashflow model.
- The checklist slugs are storage keys; other states' checklists should be new slug sets keyed by state.
- Measured pagination replaced the old per-page row-count density rule; a React port can keep "measure then place" or pre-size.

## Changelog

- 2026-09-30 — redesign to the 30 Sep team structure (Johny's brief): the client report became eleven sections (cover with hero
  photo · executive summary with the market refresher · map with location grading · asset grading · one cashflow at the current
  and IC rates · inspection / Victorian minimum standards · additional costs and settlement · strata DD (units) · AMP · price
  analysis with colour-coded comparability · disclaimer); Preliminary DD, the grading matrix and Insurance Help moved to a new
  Internal pack; measured pagination; new fields `setup.geo`, `setup.execSummary`, `dd.strata`, `inspection.checklist`,
  `suburb_stats.market` (no migration); editors: map location + executive summary (Setup), strata DD (DD), the checklist with
  photos / defects log / sign-off (Inspection & standards), Location / Asset tabs (Grading), coloured comparability (Pricing), the
  client-view card (Cashflow), the report switch; fixes: the cover's IMPORTANT INFORMATION body, grading saves no longer drop
  unlisted items, pricing saves keep unlisted row keys, lower-case ratings no longer blank on save. Tiles: OpenStreetMap
  (CARTO now needs a key).
