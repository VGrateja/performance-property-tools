# IR chain — distance band, cashflow disclaimer, cashflow slide (pp-os port note)

This note records three additions the hub's Investment Report (IR) chain received on 2026-09-29. pp-os has already ported the
IR chain and should mirror them. They came from the 2026-09-29 research meeting (Saskia, relayed by Van):

1. **Distance from CBD under the address.** IR page 1 prints the file's "Distance From CBD" grade as a distance band, so the
   team no longer pastes in a map.
2. **A disclaimer below the cashflow.** The text is verbatim and sits wherever the IR cashflow page renders.
3. **The cashflow as a second slide.** Adding a property from the Presentation Builder's IR Library now inserts two slides:
   the existing case-study slide, then a cashflow slide.

Scope: the change covers every IR already in the hub. The band and the disclaimer are derived at render time, so nothing was
backfilled and no migration was needed. New master-file imports come later.

Source of truth in the hub repo:

| What | Path |
|---|---|
| IR Samples mini-deck (page 1 band, page 2 disclaimer, PDF) | `tools/ir-samples.html` (`CBD_BANDS`, `cbdBand()`, `CF_DISCLAIMER`, `FOOTER_DISCLAIMER()`) |
| IR Builder client report (cover band, cashflow-page disclaimer; also the Vault's published PDF) | `tools/ir-builder.html` (`CBD_BANDS`, `cbdBand()`, `CF_DISCLAIMER`, `buildReportPages()`) |
| Presentation Builder IR Library (case-study band, the new cashflow slide) | `tools/presentation.html` (`IR_CBD_BANDS`, `_irCbdBand()`, `IR_CF_DISCLAIMER`, `_irCfCalc()`, `_irCashflowSlideOverlays()`, `_irInsert()`) |
| Grade rubric (read-only here) | `public.ir_grading_rubric`, created in `supabase/migrations/104_ir_builder.sql` |

**LOCKSTEP.** The band table and the disclaimer text are copied into all three hub files. The presentation's cashflow model
is a copy of `calcCashflow()` in `ir-samples.html`. Change one, change all three, and change pp-os too.

---

## 1. Distance from CBD

### 1.1 Data source

- **The grade.** It is `ir_files.grading.items["Distance From CBD"]`, the value the inspector picks on the IR Builder's
  grading step (the master file's "5d - IR Grading" tab, block "Location Attributes"). The key is matched
  case-insensitively and whitespace-tolerantly (`/^\s*distance\s+from\s+cbd\s*$/i`). The value is trimmed and lower-cased
  before the lookup.
- **The thresholds.** They come from `public.ir_grading_rubric`, the rows with `item = 'Distance From CBD'` (sort 112–116).
  Staff cannot read the rubric table: its RLS is `ir_can_write()`, and only `ir_files` reads were widened by mig 109. So the
  derived table is a constant in page code, not a runtime read.
- **The derivation rule** (Saskia): "average is more than 5 km but below average is more than 25 km, so it must be between
  5-25". Each grade's own rubric note gives one bound and the neighbouring grade's note the other:
  - For the "More than" grades, the next lower grade gives the upper bound.
  - For the "Within" grades, the next higher grade gives the lower bound.
  - The two extremes stay open.
- **Nothing is stored.** The band is derived on every render. A file with no grade, or a grade outside the table, prints
  **nothing**: no placeholder, and the original layout is kept.

### 1.2 The band table

| Grade | Rubric note (`ir_grading_rubric.comment`) | Printed band |
|---|---|---|
| Excellent | Within 2.5km of the CBD | `Within 2.5 KM of the CBD` |
| Above Average | Within 5km of the CBD | `Between 2.5 - 5 KM from the CBD` |
| Average | More than 5km from the CBD | `Between 5 - 25 KM from the CBD` |
| Below Average | More than 25km from the CBD | `Between 25 - 50 KM from the CBD` |
| Poor | More than 50km to the CBD | `More than 50 KM from the CBD` |

The format follows Saskia's example verbatim: "Between 5 - 25 KM from the CBD" (spaced hyphen, upper-case KM).

### 1.3 The numeric cross-check (report only)

`ir_files.suburb_stats.cl.distCbd` is Cotality's `forge_cl_suburbs.metrics.dist`. It is a **suburb-level** distance and it
is measured to the **state capital's** CBD. A Townsville suburb therefore reads ≈1,110 km, the distance to Brisbane, so
it cannot be compared with a grade given against the market's own CBD. It is a cross-check only; **the graded band always
wins**. Do not render the numeric distance on client pages.

### 1.4 Where it renders

**IR Samples page 1** (`slideOverview`), on the dark address panel at the bottom left of the photo:
- With a band, the panel and the address block grow upward by one 22px line, so the block's last line ends where the
  locality line always did (y≈678). Nothing moves lower.

| | No band (unchanged) | With band |
|---|---|---|
| Dark panel `.band` | top 600, height 120 | top 578, height 142 |
| Address | (28, 622), 404 wide, 24px bold white, nowrap | (28, 600) |
| Locality line | (28, 658), 14px `#D9D9D6` | (28, 636) |
| Band line | — | (28, 658), 404 wide, 14px `#D9D9D6`, nowrap — the locality line's style |

**Presentation IR Library: the case-study slide** (`_irCaseStudyOverlays`). This applies to new inserts only; existing decks
are untouched. The geometry matches IR Samples:
- Dark panel: a `rectSharp` shape at (0, 578, 460, 142) with `#171B24`.
- Address: text (28, 600, 404, h32), 24px bold white.
- Locality: text (28, 636, 404, h20), 14px `#D9D9D6`.
- Band line: text (28, 658, 404, h20), 14px `#D9D9D6`.
- With no grade, the old 600 / 622 / 658 geometry is kept.

**IR Builder client report cover** (A4):
- A centred line (`.pg .cbd`: 12px, weight 600, `#555`, margin −6px 0 6px) sits directly under the teal address band and
  above the bed/bath/car line.
- It is in the live preview, the print, and the PDF that "Publish as example IR" uploads to the Vault.

---

## 2. The cashflow disclaimer

### 2.1 Text (verbatim, two paragraphs)

> The above cashflow is an indicative example considering many variables and assumptions.
>
> It does not include any tax impacts that may be applicable, including benefits such as depreciation and negative gearing. Where negative gearing is not available, the annual loss may still be carried forward and applied to the final capital gains outcome. Tax outcomes are individual and must be discussed with an accountant or financial planner, and are therefore not factored into the cashflow.

### 2.2 Where it renders

**IR Samples page 2** (`slideCashflow` → `FOOTER_DISCLAIMER()`), on screen and in the PDF:
- **Placement.** The disclaimer takes page 2's footer zone. The running footer line was "Prepared from the Performance
  Property Investment Report · <month> · before tax and depreciation". The disclaimer now states its "before tax and
  depreciation" tail in full, so on page 2 the footer line is replaced. Pages 1, 3 and 4 keep their footer line.
- **Geometry.** The same hairline at y572 as every page (72→1208). Then the block `.irs-disc` at (72, 580), 940 wide: the
  running footer's measure, so it stays left of the logo column. Two `<p>` with a 3px gap.
- **Type.** 11px Montserrat 400, line-height 1.45, `#63666A` (the running footer's muted ink).
- **Clearance.** 1 + 3 lines end at y≈647. The logo box is x1024–1244 × y661–696.
- **Cashflow unchanged.** The three columns still fill y150–562 on the approved grid; no row lost height.
- **No cashflow, no disclaimer.** A file with no cashflow (no purchase price or budget) keeps the plain footer.

**IR Builder client report, cashflow page** (`buildReportPages()`, page "Cashflow"):
- **Placement.** `<div class="cfdisc">` directly under the cashflow table: two `<p>` at 9.5px, line-height 1.5, `#666`,
  margin-top 10px.
- **Existing note kept.** The page's `normalised_note` (config text above the table that explains the normalised rate) is
  not a disclaimer, so it stays.
- **A4 fit.** The disclaimer needs ~71px. A standard file (41 table rows) leaves ~104px of A4 free, and each extra fee line
  costs ~19px. So the table tightens a step by its own row count: `cfN = cfRows.match(/<tr/g).length`. From 43 rows it
  becomes `.cfb.dense` (td padding 1.5px 6px); from 48 rows, `.cfb.denser` (padding 1px 6px, 10px type).
- **Why it matters.** The publish path squeezes every `.pg` into one A4 image, so a page taller than 1122px would distort.
  Measured on all 94 files: 0 pages over A4 (82 normal, 12 dense), with the content bottom ≤ 1061 of 1078.

**Presentation IR Library: the cashflow slide.** See §3.

**Vault example IRs** (`tools/investment-reports.html`):
- The Vault page renders no IR pages itself. Its "IR report (PDF)" button opens the PDF that the Builder's "Publish as
  example IR" rendered from `buildReportPages()` at publish time.
- New and re-published files carry the band and the disclaimer. PDFs stored before 2026-09-29 do not until they are
  re-published (see Changelog / open items).

---

## 3. The cashflow slide (Presentation Builder IR Library)

### 3.1 Behaviour

- `+ Add` on an IR Library row appends **two** slides, the case study then its cashflow, both on a `#ffffff` slide
  background.
- Every await (photo copy, rates, fonts) runs **before** the first append. So a property's two slides always land together,
  even when "Add all" fires several inserts at once.
- One `pushHistory()` covers both slides, so a single undo removes the pair.
- `renderSlide(first)` selects the case-study slide. Thumbnails rebuild, and the deck saves through the normal path
  (`saveOverlays` / `saveSlideBgs` / `saveActiveDeckIfCustom`).
- The toast reads "<address> — added as slides N–N+1".
- **No purchase figure → no cashflow slide.** A file with no purchase figure (no `compliance.published.price_paid` and no
  `cashflow.budget`) gets only the case study, and the toast says why.
- **Figures** follow the IR Samples PDF basis:
  - interest only, at the normalised rate (`rdp_runway_config` key `rates` → `forecast.rate`, cached for 10 minutes, fallback
    0.0494);
  - **100% LVR** (Van 2026-09-30; until then the file's own LVR, `0 < lvr ≤ 1.5`, else 0.9), applied to the **total property + acquisition cost**;
  - a 30-year loan;
  - price = what was paid, else the file's modelled budget.

  The numbers are fixed at insert time, and the basis line on the slide names the rate used.
- **Model.** `_irCfCalc()` is `calcCashflow()` from `ir-samples.html` verbatim, with the rates passed in. The slide must
  never disagree with IR Samples page 2.
- **Pool line.** The IR list query adds `ir_pool:inspection->>pool` (the inspection's "Pool or outdoor spa" answer) for
  IR Samples' `poolOf()` rule. It fetches that one field instead of the whole inspection jsonb.
- **Existing decks are never touched.**

### 3.2 Layout (1280×720, 47 overlays)

"Ink" means where the glyphs start. Text overlays pad 10px / 6px inside their box, so each box is ink − (10, 6), sized to
hold its lines exactly. Table overlays render 6px inside their box, so each box is ink − (6, 6).

| Element | Type | Ink / box | Font / style |
|---|---|---|---|
| Eyebrow: property line (address · suburb state postcode · market), upper-case | text | ink (73, 30), 1134 wide | 12px bold `#00A0B4`, letter-spacing 0.2em; steps down in 0.5px (min 9px) to fit one line |
| Title "Cashflow" | text | ink (73, 50) | 30px bold `#171B24`, lh 1.1 |
| Accent rule | shape `line` | (73, 92, 48×4) | `#00A0B4`, stroke 2 |
| Basis line: "Interest only · normalised rate R% · L% LVR incl. acquisition costs · 30-year loan" | text | right-aligned, ink ends x1207, y62, 640 wide | 12.5px `#63666A` (fits to 640) |
| Column grid | — | ink x 73 / 459 / 845, each 362 wide; band y118–548 | — |
| Column titles "Summary" · "Cost of property" · "Annual cash flow" | text | y118 | 12.5px bold `#00A0B4`, letter-spacing 1.8px |
| **Summary**: 4 tiles (annual cash flow · weekly cash flow · gross yield · net yield) | shape `rect` radius 10 + 3 texts | 362×94 at y140 / 244 / 348 / 452 | fill `#F2F8F9`, stroke `#D5EBEE` 1px; label at (+16, +12), 11px bold `#4A4F57`, caps, ls .09em; value at (+16, +30), 30px bold (`#E72347` if negative), lh 1.15; note at (+16, +70), 12px 500 `#63666A` |
| Pair tiles (purchase price + total acquisition cost / income + running costs) | shape + 2 texts | 146 + 208 wide × 56, at y140 | label 9.5px, value 20px at (+16, +24); sizes step down to fit |
| Sub-headings "Allowances" · "Acquisition costs" · "Running costs (annual)" · "Income (annual)" | text | under the tiles; the gap between a column's two sections absorbs its leftover height, so every column ends on y548 | 11px bold `#63666A`, letter-spacing 1.4px |
| **The four line-item lists** | `table` ×4, 2 columns (label · figure) | column width 362; figure column = widest figure + 6px | see below |
| Hairline above the disclaimer | shape `line` | (73, 558, 1134×2) | `#E4E7EA`, stroke 1 |
| Disclaimer paragraph 1 | text | ink (73, 568), 1134 wide | 11px `#63666A`, lh 1.45 |
| Disclaimer paragraph 2 | text | ink (73, 587), 1134 wide, 2 lines, ends ≈ y619 | 11px `#63666A`, lh 1.45 |
| Logo | image | (1030, 666, 200×31), `../assets/logos/pp-logo-standard.png`, contain, 100% 50% | the same corner as the case-study slide; nothing on the slide goes below y625 |

**Tables** (real `table` overlays, editable cell by cell):
- **Sizing.** `cellPadding [0,0,0,0]` and `borderWidth 0`.
- **Rows.** Row height `rowH` uses the IR Samples fit rule: 14–20px, shared by the whole slide. Total rows are `rowH + 4`.
- **Rules.**
  - Normal rows: a `borders.b = [1, '#F1F3F5']` hairline.
  - Total rows: a `borders.t = [1.5, '#171B24']` rule.
  - All other sides are `[0, '#ffffff']`.
- **Cells.** Montserrat, `lineHeight 1.2`, `vAlign middle`.
- **Type size.** It follows `rowH` (≥19 → 12.5px, ≥17 → 11.5px, else 10.5px), then steps down 0.5px at a time until every
  label fits beside its figure (measured in the DOM).
  - A label still too long at 9.5px is cut with an ellipsis.
  - On the current 94 files: 79 at 12.5px, the rest at 11.5 / 10.5px. None is clipped.
- **Labels.** `#3F4650` weight 400; totals `#171B24` weight 700.
- **Figures.** Weight 600, tabular-nums; totals weight 800. A negative total is `#E72347`.
- **Tile figures have no tabular-nums.** html2canvas (the deck's PDF export) spaces a tabular "%" off its digits, so the
  single-figure tiles leave it out.

### 3.3 Rows (identical to IR Samples page 2)

- **Allowances.** Maintenance allowance, Cosmetic works allowance, Minimum rental standards (only when set), **Property +
  allowances**.
- **Acquisition costs.**
  - Lines: Stamp duty, Engagement fee, Acquisition fee, Mortgage & title transfer fee, Conveyancing / legal, Building & pest
    inspection, Depreciation schedule, Professional clean.
  - Totals: **Acquisition costs**, **Total property + acquisition cost**.
- **Running costs (annual).**
  - Finance · interest · L% LVR at R%.
  - Finance · principal · interest only.
  - Letting fee & marketing (· N weeks rent).
  - Property management fee (· P%).
  - Every `cashflow.feeLines` entry (label · pct).
  - Repairs & maintenance (· P% of rent).
  - Pool maintenance · <inspection answer> (only when `poolOf()` says so; "not costed" when there is no cost).
  - Strata fees, Council & water rates, Land tax, Insurance estimate.
  - Total: **Running costs incl. finance**.
- **Income (annual).** Rent per week, Income · N weeks let, **Income minus running costs · out of pocket / surplus**.

### 3.4 Left out on the slide (by design)

- **The toggles.** IR Samples page 2's LVR / interest-rate / loan-type toggles are left out. A slide is a static client
  surface, so it is fixed (IR Samples' PDF basis, except the LVR, which is 100% since 2026-09-30) and the basis line says which.
- **The running footer line.** "Prepared from the Performance Property Investment Report · <month>" is left out; the
  disclaimer takes the footer zone, as on IR Samples page 2.
- **IR Samples page 3.** Pricing & comparable sales was not requested as a slide. (IR Samples' fourth page, Scenarios, was removed on 2026-09-30 — the tool is three pages now.)

### 3.5 Verified (hub, 2026-09-29)

- **Dry run, all 94 files.** 0 text overflow, 0 table rows growing past plan; columns end ≤ y546, the disclaimer ≤ y619.
- **Scratch private deck.** Edit → + New Presentation → IR Library → + Add: two slides, the case study selected, 2 rail
  thumbnails.
- **Undo / redo.** Ctrl+Z removes the pair in one step; Ctrl+Y restores it identical.
- **Present mode and PDF.** Present mode steps from the case study to the cashflow. The PDF export gives 2 pages at
  1280×720.
- **Add all.** Three properties at once landed as three intact pairs.
- **Cleanup.** The deck was deleted through the tool, with nothing left behind.

---

## 4. Notes for the port

- **Derive, don't store.** Compute the band from the stored grade at render time; add no column and run no backfill.
- **Rubric changes.** If the rubric notes ever change, re-derive the table from `ir_grading_rubric` and update every copy.
- **Keep the numeric distance off client output.** `distCbd` is capital-city based for regional markets.
- **Keep the verbatim disclaimer** and the two-paragraph split.
- **Keep the model.** The presentation's cashflow slide must use the IR Samples model: the LVR (100% on the slide) on the total property +
  acquisition cost. The IR Builder client report still computes its own cashflow with the LVR on the budget. That is a
  known, pre-existing difference, open for Van, and not introduced here.
- **Photo copy for advisors.** Company-tier advisors cannot upload to `presentation-images` (the INSERT policy is
  `is_writer()`, mig 029). So the case-study slide's photo copy falls back to the dark panel for them. This is pre-existing
  and unchanged here; the cashflow slide has no images.

## Changelog

- 2026-09-29 — Distance-from-CBD band under the address (IR Samples p1, IR Builder cover, Presentation case study); verbatim cashflow disclaimer (IR Samples p2 footer zone, IR Builder cashflow page with row-density fit, Presentation cashflow slide); the Presentation IR Library now inserts the case study + a cashflow slide (IR Samples page 2 as real overlays, 4 table overlays, 47 elements).
- 2026-09-30 — IR Samples: the Scenarios page (page 4, the model across LVR × rate) removed — the tool is three pages (Overview · Cashflow · Pricing & comparable sales), the PDF stack too; `slideScenarios` and the `.irs-sc` grid CSS deleted. Presentation IR Library: the cashflow slide is computed at 100% LVR on the total property + acquisition cost (was the file's own LVR, else 90%), so its basis line reads "100% LVR incl. acquisition costs". IR Samples' own page 2 and PDF are unchanged (file LVR, toggles). Both on Van's word.
