# Presentation builder — editable PowerPoint download (hub)

Feature note for the pp-os migration. Hub file: `tools/presentation.html` (all code). Checks:
`scratch/pptx-edit/` (local only: `scratch/` is gitignored).

## What it is

The Download menu has two PowerPoint rows:

| Row | `data-fmt` | What it makes |
|---|---|---|
| PowerPoint (.pptx) — "One image per page, exact look" | `pptx` | Unchanged. One screenshot per page (`downloadDeck` → `_presBuildPptx`). The only download guaranteed to look identical to the builder. |
| PowerPoint, editable (.pptx) — "Text, shapes and tables stay editable" | `pptx-edit` | New. Built from the deck's DATA (overlays + slide backgrounds), not from screenshots (`downloadDeckEditable`). |

The file is named like the other downloads with ` (editable)` before `.pptx`
(`<deck title> - <Month YYYY> (editable).pptx`). Slides are 16:9, 13.333 x 7.5 in (12192000 x 6858000 EMU);
1280 slide px = 13.333 in, so 1 px = 9525 EMU, and font sizes are px x 0.75 pt. It uses the same busy screen
and progress lines as the other exports, and ends with one toast, e.g. "Downloaded 6 slides as an editable
PowerPoint. 1 chart and 1 live tool were kept as pictures."

## What stays editable

- **Text** → a real text box at the element's x, y, w, h. Inset = the builder's 6px 10px box padding. Font by
  name (Montserrat unless the element says otherwise; nothing embedded), size, bold (weight ≥ 600),
  italic, underline, strike, colour, alignment, vertical alignment, and the box background as the box fill.
  The html becomes runs: bold/italic/underline/strike tags, inline colour, size, letter-spacing (→ `spc`),
  highlight, sup/sub. `<div>`/`<p>`/`<li>` start paragraphs, `<br>` and newlines are soft line breaks inside
  one, `<ul>` → bullets (• ◦ ▪ by depth, `pres-list-dash` → –), `<ol>` → 1. a. i. by depth, `<a href>` →
  hyperlink. Data tokens (`{vac:…}`) are resolved first (`presResolveTokens`), so the file holds the
  figures as shown, frozen at download time. Unset fields use the builder's defaults (24px, line height
  1.4, #0a1520).
- **Shapes** → native presets: rect (rounded, with its radius; 6px default) → `roundRect`, rectSharp →
  `rect`, ellipse, line → `line`, arrow → `line` with a triangle head, star → `star5`, heart, triangle,
  triangleDown → `triangle` flipped, parallelogram (its slant set through the preset's `adj` guide). Solid
  fill and outline with width, dash and transparency. A shape with `link` gets that hyperlink; a transparent
  hotspot gets a 100%-transparent fill so the whole box stays clickable while invisible.
- **Images** → a native picture, fetched the way the builder resolves it (`_getClockImageUrl`,
  `_getSignedImageUrl` for `presentation-images`, or `src` relative to the page). A plain picture is
  embedded as is, placed where object-fit puts it (contain → the visible rectangle). A crop, a radius or a
  cover fit is drawn to a canvas exactly as the builder shows it and that is embedded at the box. Opacity
  → picture transparency.
- **Tables** → a native table at the overlay + 6px (the host padding): column widths, row heights, cell html
  as runs, fill (white default), borders (table-wide, then per-side `cell.borders`), padding
  (`_tableCellPad`, default 6px 10px), alignment, vertical alignment, merged cells (colspan/rowspan).
- **Connectors** → one native line per segment of the elbow path, from the same geometry the builder draws
  (`_connGeometry`). The builder draws no arrowhead on connectors, so none is added. They go first in
  the file because the builder draws them beneath every overlay.
- **Links**: web links stay links; `#slide:<sid>` becomes a jump to that slide in the file.
- **Stacking**: the overlays array order (connectors underneath, as above).
- **Background**: a solid slide background (`_slideBgs`) is the native slide background (white when unset).

## What becomes a picture, and why

| Item | Why | How |
|---|---|---|
| Chart (`chart`) | No native equivalent of the builder's chart engine | html2canvas of the live slide with everything but that element hidden, cropped to its box (`_pxShootElement`) |
| Live-tool embed (`embed`) | An iframe of a hub tool | `_presShootIframe` (same as the image export), contained in the box on white; Runway v Demand uses the B/S still, Houses view (`PP_BSS.rvdShot`). If no still can be had: a labelled dashed placeholder box, counted |
| Gradient shape | PptxGenJS 3.12 has no gradient fill | the builder's own SVG (`shapeSVG`) rasterised, including its centred stroke |
| Gradient / image slide background | same | the base slide captured with overlays hidden, as the slide background picture |
| Page drawn by a layout (`fn` not `blank`) | the page is HTML from its `fn` | base captured with overlays hidden as the background; its overlays still go on top natively |
| Any other overlay type | unknown | element picture, counted as "other" |

The builder has no rotation, shape opacity, speaker notes or hidden slides, so there is nothing to export
for them.

## Known differences (the file was checked by structure, never opened in PowerPoint here)

- Montserrat must be installed where the file is opened; otherwise PowerPoint substitutes it and wrapping
  changes. Weights collapse to regular / bold (600+). SemiBold or ExtraBold would need a face name such as
  "Montserrat SemiBold".
- Wrapping and line breaks come from PowerPoint's text engine, not the browser's, so a line can break at a
  different word. Line height is exported as EXACT spacing (CSS line-height x the largest size in the
  paragraph, the browser's line box). The first line can sit a few px higher or lower.
- No autofit: text that ran past its box in the builder runs past it in PowerPoint too.
- Bullet markers hang at the left of the 2.4em indent (PowerPoint hanging indent) instead of right beside
  the text.
- Hyperlink colour: the run keeps its colour in PowerPoint 2019+ (the `hlinkClr="tx"` extension).
  Older versions show the theme hyperlink colour.
- Lines have flat caps (no round caps in PptxGenJS). Dash patterns map to `sysDot` or `dash`, not the exact
  dasharray. Arrowheads use PowerPoint's medium triangle.
- Star and heart are PowerPoint presets, which stretch to the box. The builder's star is drawn regular
  inside a non-square box, and the heart's curve differs.
- Table borders: the builder uses border-collapse (the wider rule wins); PowerPoint draws each cell's edges.
- Embed stills come from html2canvas over the tool page: form controls can look odd (Market cycles' range
  slider shows as a white bar). The image export has the same behaviour. Runway v Demand gives one picture
  (Houses) in the embed box, where the image export makes two pages in the content band.

## Library and two workarounds

- PptxGenJS **3.12.0** from jsDelivr, `https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js`,
  `sha384-Cck14aA9cifjYolcnjebXRfWGkz5ltHMBiG4px/j8GS+xQcb7OhNQWZYyWjQ+UwQ` (477,529 bytes; same bytes on
  unpkg). cdnjs does not carry PptxGenJS. Loaded on demand with `_presLoadScript` only when this export runs.
- The bundle includes JSZip and sets `window.JSZip`. The image exports only load the cdnjs JSZip 3.10.1 when
  `window.JSZip` is missing, and both are 3.x, so the two downloads work in either order in one session
  (checked: image → editable → image).
- PptxGenJS writes an `<a:pPr>` for every RUN, so a paragraph with several runs has several (schema-invalid).
  It also gives tables shape ids that clash with text boxes. `_pxTidyPptx` unzips the result, keeps the first
  `<a:pPr>` per paragraph and renumbers `cNvPr` ids per slide.
- Paragraphs: PptxGenJS splits a new paragraph on every bulleted run unless `align` is set, so every run carries
  `align`, and only `breakLine` ends a paragraph.
- Units: text `margin` is points in the order [left, right, bottom, top]. Table cell `margin` is
  [top, right, bottom, left], read as points if the first value is ≥ 1, else inches. The export always
  passes inches. `rectRadius` is written as the preset's `adj` guide for ANY preset, which is how the
  parallelogram slant is set.

## Where the code is (`tools/presentation.html`, around lines 22524–23232)

- Menu rows: the `#pres-dl-menu` buttons (`data-fmt="pptx"` / `"pptx-edit"`, around line 4146); click routing in the
  menu handler (`pptx-edit` → `downloadDeckEditable()`).
- `downloadDeckEditable()` — the driver: busy state, library load, per slide: background, connectors, then
  each overlay by type; `_pxTidyPptx`; `_presSaveBlob`; toast. Leaves `window.__presEditableSummary =
  { slides, counts, message }` for test harnesses.
- Text: `_pxHtmlParas` (html → paragraphs), `_pxInlineStyle`, `_pxRuns`, `_pxRunOpts`, `_pxAddText`.
- Shapes: `_pxAddShape`, `_pxShapePicture`. Tables: `_pxAddTable`. Connectors: `_pxAddConnector`.
- Pictures: `_pxImage`, `_pxShootBase`, `_pxShootElement`, `_pxShootEmbed`, `_pxPlaceholder`.
- Helpers: `_pxColor` (any CSS colour via canvas), `_pxLen`, `_pxFontFace`, `_pxLink`, `_pxFitRect`,
  `_pxSvgPng`, `_pxSummary`.

Porting: the logic is plain functions over the deck payload (`{deck, overlays, slideBgs}`). It needs the
live page only for the pictures (charts, embeds, layout pages, gradient backgrounds), where it renders the
slide and uses html2canvas. A server-side port could do the native parts without a browser.

## How to check

`node scratch/pptx-edit/check.mjs` with the local server on http://localhost:8123 and the hub test account in
`.env` (`HUB_TEST_EMAIL` / `HUB_TEST_PASSWORD`, read in-process). It serves `scratch/pptx-edit/test-deck.json`
in place of a deck row, blocks every write, drives the menu (image → editable → image), captures the files at
`_presSaveBlob`, and checks: zip structure and slide order, slide size, well-formed XML with no
`undefined`/`NaN`, one `<a:pPr>` per paragraph, text words/typeface/sizes/bullets/letter-spacing,
text box geometry within 1px, shapes, picture media, table cells and merges, hyperlinks and slide jumps,
pictures counted in the summary, the image export still one picture per slide, `_presBuildPptx`
byte-identical to HEAD, every inline script parses, no page errors, no deck save. It writes
`scratch/pptx-edit/out/test-deck (editable).pptx` for opening in PowerPoint. JSZip for node comes from the
same cdnjs file the page uses, refused unless it matches the page's SRI digest (`jszip-node.mjs`).

## Changelog

- 2026-11-19 — Built: "PowerPoint, editable (.pptx)" menu row and `downloadDeckEditable`. The image row's
  sub-line changed to "One image per page, exact look"; its behaviour is unchanged. PptxGenJS 3.12.0 from
  jsDelivr (cdnjs does not host it). Checked by structure only; not yet opened in PowerPoint.
