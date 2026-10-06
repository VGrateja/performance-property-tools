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

## 11. Shell redesign (2026-10-05)

Van asked for a cleaner design that is easier to follow, with aligned content and slightly larger text, in both the file picker and the file view. He also wanted to preview the report. Only the shell changed.

**Unchanged:**
- The report pages: `buildReportPages`, every `.pg` rule and the pagination.
- `calcCashflow`.
- Every save, harvest, publish and delete flow, and the audit.
- The data model, the RLS queries, the permission gates (`CAN` / `CANW`, tool roles, the group bounce), telemetry and the URL parameters.

The report HTML of all 94 files was hashed before and after the change, covering 188 reports (the client report and the internal pack for each file).
- **Byte-identical:** 187 of 188. The one difference was the map snapshot's pixel data. That image is redrawn from OpenStreetMap tiles on every build, and the original page shows the same variance between two of its own runs.
- **With the snapshot masked:** 188 of 188 identical.
- **Page counts:** unchanged (1,002 client pages and 287 internal pages), with 0 pages over A4.

QA scripts: `scratch/ir-shell/`.

**Type scale.** These are tokens on `:root`, used only by the shell. The body is left alone because the report pages inherit from it.

| token | px | use |
|---|---|---|
| `--ib-fs-body` | 15 | body, values, inputs |
| `--ib-fs-label` | 12 | uppercase labels, table heads |
| `--ib-fs-note` | 13 | notes, meta, help line, small buttons |
| `--ib-fs-chip` | 11 | chips, provenance tags |
| `--ib-fs-title` | 17 | card titles |
| `--ib-fs-step` | 14 | stepper, buttons |
| `--ib-fs-addr` | 24 | the address in the file header |
| `--ib-fs-card` | 16 | the picker card address |

Line-height is 1.45 for text and 1.25 for headings, and numbers use tabular numerals. Small "teal" or "green" text has ink tokens: `--ib-accent-ink`, `--ib-good-ink`, `--ib-warn-ink`, `--ib-chip-ink` and `--ib-blue-ink`. In the light theme these switch to Dark Teal, Eucalyptus, `#9A5F00` and Cobalt Blue so the text passes 4.5:1. Every `<select>` is opaque and has an explicit ink colour. The content column is at most 1,240 px wide, and the bottom padding of 84 px is kept clear.

**Picker.**
- **Header:** a compact header (≤ 120 px). The eyebrow and title share one line, the description sits beneath, and "+ New property file" is right-aligned on the title row. The visibility rule for the button is unchanged.
- **Toolbar:**
  - Search covers address, suburb, consultant and market, with a live 120 ms debounce.
  - Market `<select>`: all markets, then each group with its count.
  - Status `<select>`: "Active + final" is the default and equals the old view with archived files hidden. The other options are Active, Final, Archived and All. This select replaces the old "Show archived" button.
  - Sort `<select>`: "Market A–Z" is the default and equals the old order (groups A–Z, newest first inside each). "Recently updated" orders the groups by their newest file. "Address A–Z" sorts inside each group.
  - A count ("94 files · 58 shown").
  - A List / Cards toggle, remembered in `localStorage` under `ib_pick_view_v1`.

  Filters stay in memory, so ← Files returns to the same view.
- **Grouped by market:** groups use `groupOf()`, and commercial files pool under "Commercial", as before. Each group heading spans the full width (market · states · count) and sticks under the appbar. The cards sit in a `repeat(auto-fill,minmax(300px,1fr))` grid, so the columns are fixed and the cards are left-aligned.
  - The old container `.ib-files` collided with the evidence-chip rule of the same name, which forced a flex flow. The picker now uses `.ib-pick` / `.ib-pgrid`.
- **Cards:**
  - The address is 16 px and clamps at two lines.
  - Below it: suburb · state · status chip (final green, active teal, archived grey), plus the existing "checked n/7" chip.
  - Then consultant · updated date.
  - The whole card is a stretched `<button>` that opens the file. Preview and Open appear on hover or focus, and they always show on touch screens.
- **List view:**
  - One row per file: address · suburb · market · status · consultant · updated · Preview · Open.
  - The same groups and sort apply.
  - All groups share one column template so every column lines up.
  - Rows collapse to two lines below 860 px.
- **Keyboard:** the arrow keys move between files. Up and down follow the column position in the grid. Enter opens a file, `p` previews it, and `/` focuses the search.

**Inside a file.**
- **Header row 1:** ← Files (quiet) · the address (24 px) with suburb · state · market beside it · the status `<select>` and its "read-only while …" hint, grouped together · **Preview report** (new) · Publish / Re-publish · Delete. Delete is the only button with danger styling.
  - The ids and gates are unchanged: `#ibBack`, `#ibStatus`, `#ibPublish`, `#ibDelete`.
  - The page header (eyebrow, title, New button) is hidden inside a file (`body.ib-infile`).
- **Header row 2 is the stepper:**
  - Review comes first with its "(n/7)" count and a list glyph. A divider follows, then numbered steps 1–9.
  - A step shows ✓ when `stepDone()` is true. The current step has a filled teal circle and a bold label, plus `aria-current="step"`.
  - The stepper scrolls sideways when it is too narrow and keeps the current step in view.
  - Under it, one help sentence per step (`STEP_HELP`; Review's is the old checking-window sentence), plus the legend "✓ = step has data".
- **Card anatomy:** the title (17 px) sits on the left and actions or notes on the right. Cards are size containers (`container-type:inline-size`).
- **Review label/value grid:**
  - `.ib-kv` is a fixed grid: `repeat(var(--kvp), minmax(140px,180px) minmax(0,1fr))`. That gives 3 pairs per row when the card is at least 1,100 px wide, 2 pairs from 700 px, and 1 below.
  - `.pair` is `display:contents`, so every label in a card has the same width. Labels are 12 px uppercase and right-aligned.
  - Values are 15 px on one line with an ellipsis and the full text in `title`.
  - URLs show without the scheme and get **open ↗** and **copy** links. These sit outside the inline-edit span, so clicking them never starts an edit.
  - The executive summary is a set of full-width blocks (`.ib-xs` / `.ib-xb`) with real lists.
  - Sub-sections share one style (`.ib-subh`): roles and photos, map location, executive summary, strata DD, checklist, defects log, Suburb Scoring / Cotality, Attributes, Suburb data / Adopted / Sale history / Comparable sales and rents, Computed.
  - The `.ib-rv` dashed underline now shows only on hover of the value, row or table row.
  - The provenance chips keep their meaning (auto / edited) and use one style.
  - Grading shows Strategy and Suburb rating above the attributes.
  - Helpers: `kvPair(label, innerHtml, fullText, tail)`, `subh()`, `isUrl()`.
- **Editors:** same card anatomy. Form labels are 12 px, inputs 15 px, with gaps of 12 × 16. The checklist, rooms, tables and map keep their layouts at the new scale.

**Report viewer (new).** One full-screen overlay, `#ibViewer` (`role=dialog`, `aria-modal`).
- **Entry points:**
  - **Preview** on a picker card or list row. `previewFile(id)` loads the row, the rulebook and the rubric the way `openFile` does, but stays on the picker: there is no editor and no URL change. Closing the viewer restores `CUR`. A preview opened this way always starts on the Client report.
  - **Preview report** in the file header.
  - Any page thumbnail on the Report tab, which opens the viewer at that page.
- **Rendering:** it goes through the existing `prepReport()` → `buildReportPages(REPORT_MODE)` → `pageHtml()`, and it also fills `#ibPrint`. There is no second renderer, so the viewer shows exactly what prints.
- **Page display:** each page is drawn at its real 794 × 1122 px inside a host scaled to fit the height. The page stays white in both themes, and the host resets the type to 16 px with a normal line-height, the same as print.
- **Controls:**
  - Top bar: Client report / Internal pack switch, a "3 / 12" counter, zoom (Fit · 75 · 100 · 125 %), Print / Save PDF, and Close.
  - Previous and next arrows sit at the sides.
  - A page strip of small thumbnails runs along the bottom.
- **Keyboard:** ← → and PageUp / PageDown move between pages, Home and End jump to the ends, + and − zoom, 0 returns to Fit, and Esc closes. Tab stays inside the dialog, and focus returns to where it was on close.
- **Print / Save PDF:** this is `printReport(build)`, the Report tab's own print handler moved into a function. The steps are unchanged: rebuild, stamp `compliance.reportAt`, cache the market panel in client mode, wait for images, `window.print()`. The tab and the viewer share it, and it is still gated on `CAN`.
- **Partial access:** for an account that cannot read `ir_config`, the viewer shows the pages it can build plus a one-line note that the boilerplate is missing. If building fails, it shows the error message instead of a blank page.
- **Report tab:** the thumbnails are the page index, 3 per row. A ResizeObserver scales them to the column width, and each one opens the viewer.

**For the port.** Keep the picker defaults equal to the old behaviour. Keep the label column shared within a card, the viewer rendering through the report builder, and print as a single shared path.

## 12. Saskia's 6 Oct review — pages 1, 3, 4, 5

Saskia reviewed the client report with Van on 6 Oct 2026. This round changes the content of pages 1, 3, 4 and 5 only. Pages 2 and 6–11, the page spacing, the §11 shell (picker, header, viewer) and `calcCashflow` are unchanged. Where this section differs from §4.1, §4.3, §4.3.2, §4.4 or §4.5, this section wins. No migration: every new field lives in the existing jsonb columns, so the mig-104 audit trigger records it.

**Verified on all 94 files** (QA scripts: `scratch/ir-saskia/`):
- **Page counts:** unchanged, at 1,002 client pages and 287 internal pages. 0 pages are over A4, and the tallest page measures 1,028 px against the 1,030 px limit.
- **Unchanged pages:** every out-of-scope client page is byte-identical before and after (626 of 626 pages: executive summary, inspection, costs, strata, AMP, price analysis, disclaimer). The internal pack's HTML is identical too (287 of 287); only its chip colours change, through CSS.
- **Cover:** the gap between the cover's last block and the IMPORTANT INFORMATION small print is at least 159 px, so the hero photo keeps its 440 px.

### 12.1 New fields

| Path | Type | Editor | Notes |
|---|---|---|---|
| `compliance.recommendation` | `'buy'` \| `'rejected'` \| null | Compliance → **Recommendation** card (two toggles; clicking the active one clears it); Review → Grading card select | The BA's decision. It is never derived and defaults to null. |
| `compliance.recommendationBy`, `compliance.recommendationAt` | email, ISO time | stamped on every change | The same by/at pattern as `compliance.items`, and the trigger audits the compliance column. |
| `setup.blockStoreys` | number \| null | Setup → Property card, "Block storeys" (optional) | The number of storeys in the block. Used only by the land-rich rule below. |
| `setup.blockUnits` | number \| null | Setup → Property card, "Units in the block" (optional) | The number of units in the block. Used only by the land-rich rule below. |
| `grading.propertyGradeScale` | `'A-D'` \| null | written by the Grading editor whenever a letter from the A–D scale is chosen | The marker that says the grade was chosen from Saskia's scale. A letter grade WITHOUT it predates the scale (the old "A Grade" meant investment quality) and prints as stored — see §12.5. |

The Review window lists both block fields in the Setup grid (inline-editable like the other fields, shown even when empty). The Grading card now always has a kv row with **Recommendation** (a select for editors and plain text for viewers), which saves through the same path as the Compliance card. The Compliance automatic checks ("Setup complete" etc.) are unchanged.

### 12.2 Page 1 — cover
- **Exact CBD distance:** the line under the address now reads "N.N km from the CBD". It uses `cbdKm(c)`, which is the same figure as the map page's chip (the chip now calls it too).
  - The figure is Cotality's suburb distance, `suburb_stats.cl.distCbd`, and it is used **for capital-city markets only**. Cotality measures to the state capital's CBD (`ir-chain.md` §1.3).
  - The figure is not computed from `setup.geo`, because the hub stores no market CBD coordinates.
  - The fallback is the old `cbdBand()` text: a regional market, or no Cotality distance.
  - IR Samples and the Presentation slide still print the band through their own `irCbdBand`-style copies. This round left them untouched.
- **Cover bands (`coverBands`):**
  - The bands are Property strategy · Property grade · Suburb rating. The grade band prints "B grade" with its meaning beneath it ("Townhouse or Land-Rich Unit").
  - The grade and rating bands turn **green** when the property grade is A or B (via `propGrade`, so the stored "A Grade" counts) **and** the suburb rating is AAA or BBB.
  - Green styling: a Green `#71B357` border and top accent, the Green 50 `#F3F9F1` fill, and text in Green 700 `#4D7F39`. Green 500 text on white is only 2.5:1, so the text uses the 700 step.
  - 20 of the 94 files qualify today.
- **Recommendation band (`coverRec`):** a large band at the bottom of the flowed cover content.
  - "RECOMMENDATION Buy" is white on Green `#71B357`.
  - "RECOMMENDATION Rejected" is white on Red `#E72347`.
  - "RECOMMENDATION Pending" is neutral grey, shown when the field is unset (all 94 files today).

### 12.3 Grade colours (pages 3 and 4, and the internal pack and editor chips through the shared classes)

| Grade | `gradeBand().cls` | Report chip `.pg .gc` / bar `.pg .bb` / `.pg .c-*` | Editor chip `.ib-gchip` |
|---|---|---|---|
| Excellent | g5 | Green `#71B357`, ink `#171B24` | `--ib-good` fill, dark ink |
| Above Average | g4 | Green 300 `#A0CC8E`, ink `#171B24` | good-soft fill, good ink |
| Average | g3 | Celestial Blue `#54A6DE`, ink `#171B24` | blue-soft fill, blue ink |
| Below Average | g2 | grey `#9A9B9D`, ink `#171B24` | neutral surface, ink2 |
| Poor | g1 | Yellow `#FFA91F`, ink `#171B24` | warn-soft fill, warn ink |

- **Ink:** every chip uses dark ink. White text would fail contrast on all five fills.
- **Grey:** the brand tokens have no Light Gray ramp, so `#9A9B9D` (between Light Gray and Dark Gray) is used as the brief specified.
- **Comparability:** the comparability chips (`.rc`, price analysis) were split off the shared rule and keep their old teal/grey/yellow/red colours.
- **DD chips:** `.c-Approved` / `.c-Review` / `.c-Failed` (internal-pack DD chips) are unchanged.
- **Band numbers:**
  - `gradeChip(v)` now prints the **word only**.
  - `gradeChip(v, true)` adds the band number ("Above Average · 4"), and only the internal pack's grading matrix uses it.
  - The numbers (2.5–5) are still stored in `GRADE_BAND` for averages.

### 12.4 Page 3 — map and location grading
- The legend "Grades on the 2.5–5 band …" is removed, along with the band numbers on the chips and the "Average of the N location grades: X on the 2.5–5 band" line.
- The **Asset grade** tile is removed, and the asset grade moves to page 4. It is replaced by **Location grade** (`locationGrade(items)`):
  - **Average:** the mean of the graded location attributes' band values (`gradeBand().n`, with Excellent counted as 4.75).
  - **Nearest word:** the mean maps back to the **nearest** band word on the anchors Poor 2.5 · Below Average 3 · Average 3.5 · Above Average 4 · Excellent 4.5. The cut points are therefore 2.75 / 3.25 / 3.75 / 4.25, and an exact cut point rounds up.
  - **Display:** the word prints as a large chip in the rule-12.3 colour, with the sub "Average of N location attributes".
  - **No grades:** with no location grade the tile shows "—" and "Location attributes not graded yet".
- The "Distance from the CBD" tile on this page still prints the band (only the cover changed).
- On the 94 files: 63 Above Average, 16 Excellent, 2 Average, and 13 with no graded location attribute.

### 12.5 Page 4 — asset grading
- The tiles now read **Property type · Property grade · Property strategy**. The grade tile prints the letter and its meaning ("B · Townhouse or Land-Rich Unit"), or a legacy value as stored.
- The chips print the word only, in the new colours, and the band-explanation footnote is removed.
- **Property grade scale (`PROP_GRADES`):** A – House with Land · B – Townhouse or Land-Rich Unit · C – Medium Density Unit · D – High Density Unit.
  - **Stored values:** grades are stored as **"A Grade" … "D Grade"**, the strings existing files already carry. The executive summary's "… · A Grade" line and every other reader therefore keep working.
  - **Reading values:** `propGrade(g)` reads "A", "A Grade", "a grade" and "A – …" alike — **but only when `grading.propertyGradeScale` is `'A-D'`**. Without the marker the grade predates the scale and is treated as legacy (Van, 2026-10-06: a unit graded "A Grade" under the old scale printed "A · House with Land").
  - **Pre-scale and legacy values:** a bare "A Grade" without the marker, "Investment Grade" and "Speculative" print as stored on the cover, page 4 and the executive summary, carry no meaning text and never turn the cover bands green. `propGradeLegacy(g)` names them.
  - **Values on file today:** "Investment Grade" 63 · "A Grade" 20 · empty 11 — so 83 files are pre-scale (43 of them units) until re-graded; the suggestion engine would make them A 19 · B 20 · C 40 · no suggestion 4. The 20 "A Grade" × AAA/BBB covers that printed green before this change print grey until re-graded. **Decision for Saskia:** re-grade by hand file by file (the default), or a one-off backfill that writes the suggestion to the 83 files once the land-rich thresholds are confirmed.
  - **Suburb rating values:** the suburb rating field holds "AAA" 48 · "Investment Grade" 44 · "A Grade" 1 · empty 1.
- **The Grading editor:**
  - `#gGrade` is now a `<select>` with "—", the four grades, and — for a pre-scale or legacy grade — a "keep for now" option (`__keep__`) that leaves the stored value and its absent marker untouched, so a save never drops or silently re-labels it. A pre-scale grade shows a **re-grade** chip and the line under the select names the suggestion. Choosing a scale letter stores "X Grade" **and** `propertyGradeScale: 'A-D'`; clearing the field clears both.
  - When the field is empty, the select is **pre-filled with the suggestion** and shows a "suggested" chip. It is stored only when the BA saves the grading.
  - A line under the select explains the suggestion, or says that it matches.
- **Suggestion (`propGradeSuggest`):**

| Property type | Suggestion |
|---|---|
| House (not townhouse) | A |
| Townhouse / Villa / Duplex / Terrace | B |
| Unit / Apartment / Flat that is land-rich | B |
| Unit in a block of 9+ storeys | D |
| any other unit | C ("block storeys and units are not recorded" when neither is known) |
| Commercial, Unit Block, Industrial / Medical / Office / Retail, or no type | none — graded by hand |

- **Land-rich unit** (constants `LAND_RICH_M2 = 150`, `LAND_RICH_STOREYS = 3`, `HIGH_DENSITY_STOREYS = 9`): `setup.landSize ÷ setup.blockUnits ≥ 150 m²` (only when both are known), **or** `setup.blockStoreys ≤ 3`. These thresholds are open for Saskia to confirm.

### 12.6 Page 5 — cashflow
- **Lending basis (Saskia: "the LVR is based off of the total acquisition costs, not just the property price. Therefore LVR can't go above 100%").** `calcCashflow` now lends the LVR on the **total acquisition cost** — `loan = totalCost × cfLvr(cf)`, where `cfLvr(cf) = min(lvr || 0.9, 1)` — so it agrees with IR Samples' copy and the Presentation cashflow slide (the `ir-chain.md` §4 difference is closed). The engine returns `lvr` so every printer uses the figure it lent at.
  - **The basis line:** under the heading: "Lending basis: **LVR 100% of the total acquisition cost** ($898,951 — the purchase price plus acquisition costs and allowances), not the property price alone, so the LVR cannot exceed 100% and no capital is required to complete." (the last clause only at 100%).
  - **LVR labels:** the Finance rows and the Loan amount row read "LVR N% of total acquisition cost"; the executive summary reads "Interest only at N% LVR of the total acquisition cost"; the summary card "N% LVR of total cost".
  - **Stored LVR above 100%:** 46 of the 94 files store 104–111% (the old workaround for funding the purchase costs on the price basis) and 2 store exactly 100%. They all read as **100% of the total cost**, which is what they meant; the Cashflow editor's field ("LVR % of total acquisition cost") shows 100.00% with the note "was 110% of the price · capped at 100%", and a save writes the capped value. The field also caps anything typed above 100.
  - **Required capital:** `max(0, totalCost − loan)`, which is **$0 at 100%** — 48 files now, 5 before.
  - **What moved (all 94 files, measured):** the loan rises by 6.7% at the median (max 12.3%) because the purchase costs are inside the base now, so weekly cash flow falls by $55 a week at the median (max $525 on one high-budget file) and required capital falls or reaches $0. The 46 files under 100% (90% × 19, 70% × 12, 60% × 8, 80% × 4, 86%, 50%, 0%) keep their percentage, now of the total cost.
- **Section order:** Cost of property · Acquisition costs · **Income · Finance · Running costs** · Investment summary. The "Total property + acquisition cost" row left the acquisition section and now sits in the summary.
- **Income:** Rent (per week) and **Total income**, the green hero line with a plus sign ("+$29,120"). The "Net income (after running costs, before finance)" line is removed.
- **Finance** (its own section), three hero lines:
  - **Principal** ("$0" on this interest-only page).
  - **Interest at the current rate (6.72%)**.
  - **Interest at the IC rate (4.89%)**.
- **Running costs:** the fee, repairs, pool, strata, council, land tax and insurance lines, then the hero line **Running costs (excluding finance)**.
- **Investment summary:**
  - Purchase price, Acquisition costs, and Allowances (when non-zero), then **Total acquisition cost**, **Loan amount** and **Required capital**.
  - Gross yield, Net yield, and Expense ratio (kept).
  - Four hero lines: **Annual cash flow at the current rate**, **Annual cash flow at the IC rate**, **Weekly cash flow at the current rate**, **Weekly cash flow at the IC rate**.
- **Signed money** (the `sm()` / `srow()` helpers):
  - **Which lines:** the Income, Finance and Running-costs sections and the four cash-flow lines are signed.
  - **The rule:** inflow is "+$" in Green 700 `#4D7F39`, outflow is "−$" (U+2212) in Red `#E72347`, and zero is "$0" in black.
  - **Unsigned lines:** capital lines (cost of property, acquisition costs, totals, loan, required capital) stay unsigned and black.
- **Hero rows (`tr.hero`):** 11.5 px, bold, with a top rule and a light fill.
- **Density:** the page still fits by measurement (`dense` → `denser` → `densest`). It is longer now, so the 94 files sit at 4 dense, 87 denser and 3 densest, against 82 normal and 12 dense before. Saskia's spacing pass is next.
- **Executive summary:** the cards and draft sentences (page 2) are unchanged and still match the cashflow (same `cfTwoRate`).

### 12.6a Verification (2026-10-06, later)
- Pre-patch → patched sweep over the 94 production files (read-only, same account state): only **Executive summary 94 · Cashflow 94 · Cover 20 · Asset grading 20** pages changed; the internal pack's 287 pages are byte-identical; 0 pages over A4 (max inner 1023 px); page counts unchanged; the cashflow page sits at 90 denser · 4 densest (the basis line is one line longer).
- Rendered checks from an anonymised in-memory row (`Desktop/ir-report-saskia-qa/lvr-legacy/`): stored 110% → "LVR 100% of the total acquisition cost", loan = total, required capital $0; 80% → loan 80% of total, capital 20%; a pre-scale "A Grade" unit's page-4 tile reads "A Grade", a scale "B Grade" reads "B · Townhouse or Land-Rich Unit"; the Grading editor shows the re-grade chip, the keep option and the suggestion; the Cashflow editor shows 100.00% with the capped note.
- Harness note: the QA account cannot read `CFG.boilerplate`, so client reports render 10 pages (no Disclaimer) under it — a sweep is comparable only with another sweep under the same grant state.

### 12.7 For the port
- Keep the recommendation a stored BA decision (never derived) with by/at.
- Keep grades stored as "X Grade" strings and map them on display.
- Keep the suggestion a pre-fill only, never auto-saved.
- Keep the location-grade rounding (nearest anchor, ties up).
- Keep the comparability chips on their own colours.
- The builder lends on the total acquisition cost, capped at 100% (Saskia, 2026-10-06) — `cfLvr` + `calcCashflow` above. **pp-os's round-5 port of the engine still lends on the price and must be changed to match**, together with the three LVR labels, the editor's cap and the `propertyGradeScale` marker.
- Keep the pre-scale rule: a letter grade without `grading.propertyGradeScale === 'A-D'` prints as stored, carries no meaning, never turns the bands green, and the editor offers "keep for now" plus the suggestion.

## Changelog

- 2026-10-06 (later) — Saskia's P5 basis: the LVR is of the total acquisition cost and capped at 100% (`cfLvr`, `calcCashflow` lends on the total; basis line, three LVR labels, editor field and cap; 46 stored 104–111% read as 100%; required capital $0 on 48 files); pre-scale grades: new marker `grading.propertyGradeScale`, a letter grade without it prints as stored with no meaning and no green band, Grading editor "keep for now" + re-grade prompt (Van: a unit printed "A · House with Land").

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
- 2026-10-05 — shell redesign: picker with search/filter/sort and list view, two-row header with stepper, aligned label/value grid and larger type, full-screen report preview (Van)
- 2026-10-06 — Saskia's 6 Oct review, pages 1/3/4/5 (§12): cover exact CBD km + green A/B × AAA/BBB bands + Recommendation band (new `compliance.recommendation`, set on Compliance); grade colours Excellent green · Above Average light green · Average blue · Below Average grey · Poor yellow, word-only chips, no band legend; Location grade replaces the asset grade on page 3; property grade A–D with meanings, Grading select with a suggested value (new optional `setup.blockStoreys` / `setup.blockUnits`, land-rich ≥ 150 m²/unit or ≤ 3 storeys); page 4 tiles type · grade · strategy; cashflow: lending basis stated (the engine lends on the price — unchanged), Income / Finance / Running costs (excl. finance) / Investment summary with signed hero lines and annual + weekly cash flow at both rates on their own lines (Saskia, Van)
