# Report-edit consolidation (#5) — cutover plan & parity audit

> **STATUS: PROMOTED + PUSHED.** `tools/online-reports.html` now loads
> `shared/report-edit.{js,css}` and the inline engine is deleted (~15.7k →
> ~9.7k lines). Rollback options: the previous commit, or the local untracked
> copy `tools/online-reports.pre-cutover.html` (kept out of git on purpose).
> The `_cutover*.mjs` transform scripts were removed (job done; re-running
> would corrupt the promoted file).

Goal: stop `tools/online-reports.html` carrying its own ~5,000-line inline
copy of the report-edit engine and have it load `shared/report-edit.{js,css}`
instead — the single source of truth the National + Commercial research
reports already use.

Status: **pre-swap.** Shared-side parity gaps are being closed first; the
swap itself is NOT done. The live regional tool is untouched.

---

## Why the swap is atomic (and therefore risky)

Both files define the **same global function names** (`ctMakeEl`, `shRedraw`,
`buildSideToc`, `syncApply`, …). You can't cut over one function at a time:
whichever `<script>` loads last wins for *every* call. So the swap is
all-or-nothing for the whole generic-engine set. The only safe way in is:

1. Prove, function-by-function, that shared matches-or-supersets regional.
2. Close every gap **in shared** (or as regional boot wiring) first.
3. Do the atomic swap in one edit to `online-reports.html`.
4. Verify in a browser (no automated behavioral tests exist).

Every shared change must stay safe for the **live** National/Commercial
reports — region-guard anything regional-specific.

---

## Cutover model (decided)

- **Regional KEEPS inline** (its genuinely-regional layer):
  the chart-patch IIFE, live-data layer (`liveData*`, `mapLiveToRegion`, …),
  charts (`renderMedianPrice`/`StockDom`/`Industry`/sparklines), `REGIONS` /
  `REGION_MANIFEST`, `setupSkeletonPages`, `applyRegionCoverBackground`,
  `populateRegionSelect`, `setupRegionDoubleTap`, `switchRegionInCluster`,
  the **bands** subsystem, prebuilt-cache (`ppPrebuilt*`), the multi-region /
  lite **export** (`setupExport`, `buildEditionFilename`, `loadRegionInIframe`,
  `addPdfLinkAnnotations`), `setupArrowKeyNav`, `setupKeyboardNudge`,
  clipboard (`_ctClipboard*`, `setupCopyPaste`), `setupTokenGuide`, and its
  **Slice-1 RS layer** (`ACTIVE_REGION`, `rsScheduleSave`, `rsApplyToCache`,
  `rsSetStatus`, `rsLoadFromServer`, `rsBoot`, `rsAppendAudit`).
- **Regional DROPS** (replaced by shared): text/shape/image overlay engines,
  page-bg editor, side-TOC, page CRUD/persistence, undo-redo, page numbering,
  mode/grid/scroll-spy/auto-zoom, backup/sync/audit/pdf-pages modals.
- **Seam already built:** shared reads regional's globals defensively
  (`_rs_active`→`ACTIVE_REGION`, `_rs_scheduleSave`→`rsScheduleSave`,
  `_rs_appendAudit`→`rsAppendAudit`), and `initReportEdit` honours
  `window.PPA_REPORT_EDIT_OPTS` to disable the sub-inits regional owns
  (`regionSelect`, `bands`, `refresh`, `prebuiltIndicator`, `backup`, `sync`,
  `audit`, `downloadModal`). Token rendering is pluggable via
  `window.PPA_CT_TOKENS`.

---

## Parity audit (4 clusters, ~150 paired functions)

Verdicts: IDENTICAL / EQUIVALENT / SHARED-SUPERSET (all fine) vs
REGIONAL-RICHER (gap). Below are only the gaps.

### CLOSED in shared (this pass)

| ID | Function | Gap | Fix landed |
|----|----------|-----|-----------|
| CT-1 | `ctLoad` | shared lacked the legacy `…-v1` → Sydney-v2 migration | added `CT_LEGACY_KEY` + migration block (writes Sydney bucket; no-op for research) |
| CT-3 | `_ctSaveSel` | missing the 3 defensive `_ctSavedSel=null` fail-paths + `isCollapsed` check → stale selection could corrupt another box's per-word styling | added all guards |
| CT-4 | `_ctRestoreSel` | missing use-after-blur guards (`document.body.contains` + `.editing` class + range-contains) | added |
| CT-6 | `ctAddNew` | dark-page detection diverged (regional p1/p2 vs research cover/p25/p33) — would mis-colour new overlays & wrongly darken regional Perth p33 | region-scoped: regional→p1/p2, research→p1/cover/p25-p33 |
| SH-2 | `_imgCopyToAll` | shallow `Object.assign` clone vs regional deep copy | switched to `JSON.parse(JSON.stringify())` |
| SH-3 | image context menu | missing "Copy to pages…" option | added option + `_imgCopyToPages` prompt standin (mirrors `_shCopyPagesOpen`) |
| SYNC-1 | `_syncFilterForTarget` | no band-year clipping (only had pageDrops) | ported `_ppBandToYear` + `_syncBandStartYearForTarget`; bands now clip to target chart-start year before pageDrops |
| LAYOUT | `ctInit` deselect / `setupPagerToolsToggle` | shared used only `.pp-pager`/`#pp-pager`; regional uses `.pager`/`#pager-tools` → silent toolbar breakage post-swap | dual-selector (`.pp-pager, .pager`; `#pp-pager` \|\| `#pager-tools`); also added `#sh-picker`/`#bg-popover` deselect guards |
| BACKUP-1 | `backupParseFile` / `backupRenderPreview` / `_backupApplyLegacy` | shared only read the v3 multi-region format; regional also reads legacy v1/v2 single-region localStorage dumps | parse now accepts `json.data`; preview branches v3/legacy; added `_backupApplyLegacy` (faithful port: clear active keys → remap suffix → import-pending → reload) |
| BACKUP-2 | `backupApplyImport` (v3) | known-targets filtered to `RESEARCH_REGIONS` only → a regional v3 backup would be fully skipped post-cutover | broadened to `RESEARCH_REGIONS[s] \|\| REGIONAL_REGIONS[s]` (consistent with shared's cross-tool sync) |

(Also note: shared was already SUPERSET on several — `buildSideToc` HTML-escapes
labels, `setupModeToggle` deselects shapes+images, `applyAutoZoom` checks both
`PP_EXPORT_MODE` and `.export-mode`, `_shWireColorRole` null-guards. Keep these.)

### REMAINING — must validate before the swap

| ID | Where | Gap | Plan |
|----|-------|-----|------|
| **SCROLLSPY** | `setupScrollSpy` | shared rewrote regional's rAF + `ctVisiblePageId` (largest-visible-area) as an IntersectionObserver (`rootMargin -40%/-55%`). National/Commercial run the IO version fine, but regional's 35-page layout must be eyeballed. | Browser-validate active-TOC highlight on regional after swap; if it drifts, port regional's rAF logic behind an OPTS flag. (Non-destructive — only affects which TOC row is highlighted.) |

### REMAINING — regional boot wiring (not a shared code change)

| ID | Gap | Plan |
|----|-----|------|
| **CT-2** | shared's `ctRender` only expands `{REGION}`/`{region}`/`{year}` via fallback; regional expands `{STATE}`/`{state}`/`{PEER}`/`{peer}`/`{KIND}`/`{kind}` from `REGION_MANIFEST`. | At cutover, regional must set `window.PPA_CT_TOKENS = fn` (reproducing its inline token logic) **before** `initReportEdit()` runs. |

### Accepted as-is (no action)

- **CT-5** `_ctApplyToSelection` span re-selection differs slightly — both valid HTML; shared's simpler version kept.
- **SH-1** shape/image "copy to pages" uses a `prompt()` standin vs regional's checkbox modal — functional; the Slice-4 modal will replace both prompts.
- **Sync modal modes**: regional offers cluster/state targeting; shared offers research/regional/all/pick. Both enumerate all 36 regional regions (`REGIONAL_REGIONS`), so coverage is complete; UX differs. Port cluster/state pickers only if the user wants exact UX parity.
- **Audit delegation**: shared `_rs_appendAudit` → regional `rsAppendAudit`; no double-logging. Fine.

---

## Known duplications to reconcile at swap

- `REGIONAL_PAGEDROPS` (shared) mirrors `REGION_MANIFEST.pageDrops`
  (online-reports). Marked CANONICAL-PENDING in both — at cutover, make
  online-reports read drops from shared so the copy disappears.

---

## Swap mechanics — exact runbook

### Load model (from national-report.html, the working reference)
National sets **no** `PPA_REPORT_EDIT_OPTS` / `PPA_CT_TOKENS` — it delegates
everything to shared. Its boot is just:
```js
document.addEventListener('DOMContentLoaded', () => {
  initReportEdit(); liveBoot(); applyAccessRestrictions(); rsBoot();
});
</script>
<script src="../shared/report-edit.js"></script>   <!-- AFTER the inline script -->
```
Regional is different: it KEEPS richer regional versions of several
subsystems, so it must set OPTS to turn shared's off, set `PPA_CT_TOKENS`,
and keep calling its own.

### ⚠️ Function-shadowing rule (the load-order trap)
Two `<script>`s sharing the global scope: a top-level **`const`/`let`**
declared in both throws `SyntaxError` (kills the whole 2nd script — dead
editor). A top-level **`function`** declared in both is legal — the
**last-loaded wins**. Shared loads last, so for EVERY function name in both,
regional silently runs **shared's** version. Consequence: regional cannot
"keep its own" copy of any function shared also defines — it must be
parity-equal (the audit confirmed the generic engine is) OR be renamed.

### Collisions to remove from the inline script (catastrophic if missed)
Top-level `const`/`let` present in BOTH (line refs in online-reports.html):
`CT_LEGACY_KEY` 7661, `CT_HISTORY_MAX` 7744, `SH_STORAGE_KEY` 9303,
`IMG_STORAGE_KEY` 10334, `PAGE_ORDER_KEY` 10830, `CUSTOM_PAGES_KEY` 10831,
`PAGE_LABELS_KEY` 10837, `PAGE_BG_KEY` 10857, `BACKUP_KEY_PREFIX` 14215,
and the state lets `_ctEntries` 7712, `_ctHistory` 7741, `_ctHistoryIdx`
7742, `_ctRestoring` 7743, `_ctSavedSel` 8535, `_shEntries` 9325,
`_imgEntries` 10356, `_tocDragSrc` 11164, `_autoZoomRaf` 11459,
`_bgEditorTarget` 15110, `_bgEditorOriginal` 15111, `_bgApplySnapshot` 15414.
(NOT collisions — regional-only: `REGIONS`, `REGION_MANIFEST`,
`RS_BUCKET_KEYS`, `BANDS_STORAGE_PREFIX`, `_ctClipboard`, `_copyPagesContext`,
`PP_EXPORT_MODE`, `PREBUILT_BUCKET`, `MASTER_PAGE_CATALOG`, etc.)

### Group-A blocks to delete (contiguous, verified no B-islands inside)
- **A-I: lines 7661 → ~11256** — `CT_LEGACY_KEY` through `setupAddPageButton`.
  The whole overlay engine + page CRUD/TOC/persist. One ~3,600-line block.
- KEEP 11257–11344: `VICWATAS_STATE_ORDER`, `compareClusterRegions`, `populateRegionSelect`.
- **A-II: `setupScrollSpy`** (~11345 → before 11373). ⚠️ SCROLLSPY divergence — validate.
- KEEP 11373–11457: `setupRegionDoubleTap`, `switchRegionInCluster`.
- **A-III: ~11458 → before 11638** — `AUTOZOOM_REQUIRED`, `_autoZoomRaf`, `applyAutoZoom`, `setupAutoZoom`, `setupTocToggle`, `setupPagerToolsToggle`.
- KEEP 11638–12978: prebuilt cache + the entire **export** subsystem (`setupExport`, `buildEditionFilename`, `loadRegionInIframe`, `addPdfLinkAnnotations`).
- **A-IV: `setupGridToggle`** only (~13271 → before 13286). NOTE: the pdf-pages modal (`MASTER_PAGE_CATALOG` 12979, `setupPdfPagesModal`/`openPdfPagesModal`/… 13019–13270) is parity-IDENTICAL to shared's — delete it too so shared's wins, BUT verify regional's **export** still drives shared's modal (see open coupling below).
- KEEP 13286–13674: `setupArrowKeyNav`, `setupKeyboardNudge`, clipboard (`_ctClipboard*`, `setupCopyPaste`).
- KEEP 13674–14214: **bands** subsystem + `copyPages*` modal + `setupBandsModal`.
- **A-V: ~14215 → ~15033** — `BACKUP_KEY_PREFIX`/`BACKUP_VERSION` + backup + sync + audit. (Regional's backup/sync are RICHER — but they collide as functions and shared wins. Decide per open-coupling below.)
- KEEP 15034–15109: `setupTokenGuide`.
- **A-VI: ~15110 → ~15562** — page-bg editor + apply modal (`_bgEditorTarget` … `setupPageBgApplyModal`).

### Regional boot, post-swap (replace the 39-call DOMContentLoaded)
```js
window.PPA_REPORT_EDIT_OPTS = {
  regionSelect:false, bands:false, refresh:false, prebuiltIndicator:false,
  backup:false, sync:false, audit:false, downloadModal:false,
};
window.PPA_CT_TOKENS = function (t) { /* paste regional ctRender body (7936-7956) */ };
document.addEventListener('DOMContentLoaded', () => {
  setupSkeletonPages(); applyRegionCoverBackground();
  initReportEdit();                 // shared: pages/TOC/overlays/undo/mode/grid/scrollspy/autozoom/pagebg
  populateRegionSelect(); setupRegionDoubleTap();
  setupExport(); ppRefreshPrebuiltIndicator();
  setupKeyboardNudge(); setupArrowKeyNav();
  setupBandsModal(); setupTokenGuide(); setupCopyPaste();
  renderAtAGlanceSparklines(); renderMedianPrice(); renderStockDom(); renderIndustry();
  if (window.PpaCharts && window.PPA_REGION_DATA) { /* PpaCharts.renderAll */ }
  rsBoot(); liveBoot();
  /* regional refresh-button wiring */
});
```
Then `<script src="../shared/report-edit.js"></script>` after the inline script.

### ⚠️ OPEN COUPLINGS — must be resolved in-browser (why this can't be blind)
1. **Backup/Sync are RICHER in regional** but their functions collide → shared
   wins. With `backup:false`/`sync:false`, shared won't *wire* its modals, but
   regional's `setupBackupModal`/`setupSyncModal` are inside delete-block A-V.
   Either (a) keep A-V's backup/sync functions (rename to avoid shadow) and
   call them, or (b) accept shared's backup/sync (now feature-complete after
   SYNC-1 + BACKUP-1/2). **(b) is simplest — flip `backup`/`sync` to true and
   delete A-V entirely. Decide after a browser test of shared's modals on a
   regional region.**
3. **Modal-DOM divergence**: regional uses `#audit-modal`, `.pager`,
   `#pager-tools`; shared expects `#audit-modal-bg`, `.pp-pager`, `#pp-pager`
   (pager now dual-selectored; audit/History still differ). Shared's modal
   setups no-op on missing IDs, so nothing breaks — but regional's audit/
   history won't gain shared's versions until the DOM ids are reconciled.
4. **Export ↔ pdf-pages modal**: regional `setupExport` (kept) may call
   `openPdfPagesModal`; after A-IV deletes regional's, it calls shared's
   (parity-identical). Verify the "select pages" flow still launches the export.

### No automated browser test exists on our side
`check-static.mjs` does NOT lint inline `<script>` in HTML. The only loadability
guard is: concatenate the candidate's inline JS + `shared/report-edit.js` and
`node --check` the result (catches const collisions + syntax). Logic bugs
(double-wiring, modal IDs, OPTS) surface ONLY in the browser. → cut over on a
**candidate file**, A/B against the live tool, iterate.

## Candidate v1 — BUILT (tools/online-reports.cutover.html)

Built by `scripts/_cutover.mjs` (a reviewable, re-runnable transform) and gated
by `scripts/_cutover_check.mjs` (concatenates the candidate's inline JS +
shared, `node --check` as a classic script → catches any missed const/let
collision or syntax break — **passes**). Both scripts are temporary and get
deleted once the cutover lands. The live `online-reports.html` is **untouched**.

**Phase 1 + Phase 2 — DONE.** The transform now physically DELETES the 6
contiguous inline-engine blocks (A-I…A-VI), not just shadows them. Verified:
- candidate **15,748 → 10,273 lines** (~5,475 lines of dead engine removed)
- loadability `node --check` passes (no const collisions / syntax errors)
- every kept regional function present; every engine function gone from inline
  (now sourced only from shared); `MASTER_PAGE_CATALOG` retained
- no orphan references to the 5 deleted regional-only helpers (their callers
  were in the same blocks; `backupApplyImport` is provided by shared)
This is a true single-source consumer of `shared/report-edit.js`.

**Config applied:** `PPA_REPORT_EDIT_OPTS = { regionSelect, bands, refresh,
prebuiltIndicator, downloadModal: all false }` (regional keeps those); backup /
sync / audit left to shared (feature-complete this session). `PPA_CT_TOKENS`
set to regional's token logic. Shared `<script>` loads after the inline script.

### How to test (in your offline copy, real HTTP server — not file://)
Open the candidate and A/B it against the live tool, same region:
- `…/tools/online-reports.cutover.html?region=sydney`  vs `…/online-reports.html?region=sydney`
- repeat for a 26-page regional (e.g. `?region=newcastle`) and `?region=perth`.

Checklist: View/Edit toggle; add/move/edit text overlay (+ `{REGION}`/`{STATE}`/
`{PEER}` tokens render); add shape + image; right-click image → "Copy to pages…";
page-bg editor + bulk apply; side-TOC reorder/rename; add/duplicate/delete page;
undo/redo; grid toggle; scroll-spy TOC highlight; region nav + double-tap;
reference bands modal; PDF export (pick-pages → render); backup download +
import (try a v1/v2 file AND a v3 file); sync to another region (band-clip +
pageDrops); Save → reload persists; charts + live-data refresh.

### Modal DOM — RECONCILED (in the transform)
Verified every id shared's `setupBackupModal`/`setupSyncModal`/`setupAuditModal`
query (28 ids) is now present in the candidate. Shared shows modals by toggling
`.open` on `#{backup,sync,audit}-modal-bg`.
- **Backup**: already compatible — `class="bands-modal-bg"` (regional CSS shows
  `.bands-modal-bg.open`, the class shared toggles) + all ids matched. No change.
- **Sync**: same `.bands-modal-bg.open` show; transform swapped the radio target
  section cluster/state → **research/regional/all/pick** (shared's scheme) and
  added `#sync-other-research-name`/`#sync-regional-count`. Regional CSS classes
  kept. ⚠ UX change: regional loses the cluster/state presets; "Pick specific
  regions…" still covers any manual selection.
- **Audit**: transform renamed `#audit-modal`→`#audit-modal-bg`, added
  `id="audit-close"`, and aliased the CSS show-class (`.audit-modal.show,
  .audit-modal.open`). "This region" reads the same `…audit-log-v1-<slug>` key
  regional writes → populates correctly. ⚠ The "All regions" scope fetches
  *research* regions only (shared behaviour) — mislabeled for regional; minor.

### Other things to watch for
- **Styling**: `report-edit.css` is NOT loaded (regional's inline CSS covers the
  engine + modals, same class names). If any shared-created UI looks unstyled,
  add the `<link>`.
- **History**: absent in regional (no `#history-modal-bg` scaffold) — expected.

To regenerate the candidate after a fix: re-run `node scripts/_cutover.mjs`
(re-copies + transforms), then `node scripts/_cutover_check.mjs`.

## The swap itself (when all REMAINING gaps are closed)

1. In `online-reports.html`: add `<link rel="stylesheet" href="../shared/report-edit.css">`
   and `<script src="../shared/report-edit.js"></script>` (after supabase-client.js, before boot).
2. Set `window.PPA_REPORT_EDIT_OPTS` (disable regional-owned sub-inits) and
   `window.PPA_CT_TOKENS` (CT-2) **before** boot.
3. **Delete** the inline Group-A engine functions (text/shape/image/page-bg/
   TOC/persist/CRUD/modals/undo) from the inline `<script>`. Keep the Group-B
   regional layer.
4. Replace the regional boot's engine calls with a single `initReportEdit()`;
   keep the regional-only boot calls (`setupSkeletonPages`, charts, `rsBoot`,
   `liveBoot`, `populateRegionSelect`, bands, export, etc.).
5. `npm run check`, then browser-verify on several regions (capital + a 26-page
   regional + Perth): overlays render/move/save, undo/redo, TOC reorder/rename,
   page add/dup/delete, page-bg, sync (incl. band clip + pageDrops),
   backup download + **import (v1/v2 and v3)**, audit log, history/restore,
   scroll-spy highlight, and the monthly PDF (`?exportMode=1`) chrome-strip.
6. Confirm `scripts/render-reports.mjs` chrome-strip still covers regional's
   modals (it already lists the shared modal ids).

Do NOT push until the user has browser-verified in their offline copy.
