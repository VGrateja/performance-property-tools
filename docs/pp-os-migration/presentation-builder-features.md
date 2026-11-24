# Presentation Builder — features added for native deck rebuilds (hub)

Feature note for the pp-os migration. Hub file: `tools/presentation.html`.

## Why

Decks recreated from Google Slides are rebuilt as native, editable elements, and any look the
builder cannot draw is added to the builder rather than approximated (owner's rule, 2026-07-07).
The "Wholesale Client Consultation - October 2026 - Refresh" deck (deck id `user-wholesale-oct26`,
2026-10-26) needed three.

## What

| Feature | Stored as | Where |
|---|---|---|
| Source Serif 4 font option (optical size 14, the cut Google Slides draws) | text `fontFamily: "'Source Serif 4', serif"` (quoted: the name ends in a digit); also offered for big numbers | Google Fonts link in the head; Text Settings and big-number font selects |
| Parallelogram shape (the brand slash) | shape `kind: 'parallelogram'`, `slant` = fraction of the width (default 0.25) | `shapeSVG` (editor, present, rail, picker card, PDF/JPG/PPTX exports); shape picker button; "Slant %" row in the Shape panel |
| Rounded image corners | image `radius` (px of the 1280-wide slide; 0 or unset = square) | `_applyImageRadius`, beside `_applyImageCrop` in all three image renderers; "Corners" row in the Image panel |
| Links between slides (e.g. a table of contents) | every slide entry carries a permanent `sid` (`s_…`); text link = `<a href="#slide:<sid>" class="pres-slide-link">` (no `target`); shape link = `o.link = '#slide:<sid>'`. Web links unchanged (`target="_blank"`) | "Links between slides" block after `saveActiveDeckIfCustom`: `_ensureSlideSids`, `_backfillSlideSids` (open-time, once, saved through the guarded save; an ids-only write keeps `lastUpdated` via `_sidsOnlySig` in `_persistDeckRow`), one delegated click handler (View / Present; Edit = Ctrl/Cmd-click), toast on a missing target. Text Settings "Link…" → Web address… / Slide in this deck; Shape Settings → Link tabs. Paste gives new sids and remaps links inside the pasted batch; Duplicate deck keeps sids; delete warns when other slides link to the slide. `?deck=<id>&slide=<number or sid>` opens on that slide |
| Slide number (page-number footers) | the token `{page}` typed in any text box; the stored text keeps the token | `presResolveTokens(html, page)`: `{page}` → the slide's 1-based position, resolved before (and without) the Forge token data, so it renumbers itself on add / delete / reorder. Passed by `buildOverlayEl` (editor, Present, and the PDF / picture-PowerPoint / JPG exports, which capture the live slide), `buildThumbOverlayEl(o, page)` (rail), `_buildThumbOverlay` (library card = slide 1) and `_pxAddText(…, page)` (editable PowerPoint: the number as plain text, not a PowerPoint field). Shown raw while the box is being edited, like every token. Not resolved in table cells or slide-link titles. Listed in the Text Settings "Data tokens" cheat sheet |
| Calibri falls back to Carlito | text / cell `fontFamily: "Calibri"` (unchanged) | Carlito (metric-compatible, 400/700 + italics) added to the Google Fonts link; `_presFontCss()` turns the stored "Calibri" into the CSS stack `Calibri, Carlito` in every renderer (editor, rail, library card, table cells). Before this, a machine without Calibri (Mac, Linux — including the nightly PDF renderer — phones) drew Calibri text in the browser's default serif. The stored value, the font picker and the editable PowerPoint (`_pxFontFace` takes the first family) still say Calibri |
| Lining figures for Playfair Display | text / cell `fontFamily: "Playfair Display"` (unchanged) | Playfair draws old-style figures (2013 with a descending 3) unless a page asks for `lnum`, and html2canvas (PDF / JPG / picture PowerPoint) cannot ask. So "PP Lining Figures" — Playfair's own `lnum` glyphs as the default glyphs of 0–9, digits only, 12 files (400–900, upright + italic, about 5 KB each) in `assets/fonts/pp-lining-figures/` with the OFL (renamed: "Playfair Display" is a Reserved Font Name) — is declared with `unicode-range: U+0030-0039`, and `_presFontCss()` turns "Playfair Display" into `"PP Lining Figures", "Playfair Display"`. Digits come from the new font, everything else from Playfair; screen and canvas both draw lining figures, line heights unchanged, digits about 4% wider. The editable PowerPoint still names Playfair Display, so PowerPoint draws its own (old-style) figures. Built by `scratch/pp-lining-figures-build.cjs` (opentype.js, from Google Fonts' static Playfair files) |

## pp-os

pp-os Presentations needs all three for a copied deck to look the same:
`docs/plans/2026-10-26-presentations-hub-deck-parity.md` (approved 2026-10-26) adds them, plus
native drawing of raw ECharts bar overlays, the hub's thin-line padding, and a one-deck copy
(`backfill --deck=<id>`).

Links between slides: the pp-os slide contract (`presentationSlide`, `.catchall`) already keeps
`sid` on a copy, but pp-os does not follow `#slide:<sid>` yet — it needs the same click handling
(find the slide by `sid`, go there; toast when it is gone), new sids on every created/pasted slide
with links remapped inside a pasted batch, sids kept on deck duplicate, and the two link pickers.
Not built in the hub: internal links in the PDF download (the cached PDF comes from the server
renderer and the live one from html2canvas images, so a link would exist in one and not the other).

Slide number and Calibri → Carlito (2026-11-23): pp-os needs the same `{page}` token wherever it
resolves deck text (editor, Present, thumbnails, exports — it must come from the slide's position at
render time, never be stored as a number), and the same `Calibri, Carlito` stack with Carlito loaded.
Lining figures for Playfair Display (2026-11-24): pp-os needs the same twelve font files and the
same `"PP Lining Figures", "Playfair Display"` stack wherever Presentations sets a Playfair font.
`font-variant-numeric: lining-nums` alone is not enough if pp-os rasterises slides on a canvas.

## Changelog

- 2026-10-26 — Source Serif 4, parallelogram + slant, image corner radius (for the Wholesale
  October 2026 Refresh deck).
- 2026-10-27 — Links between slides (text + shapes), permanent slide ids with a once-per-deck
  backfill on open that keeps the "Updated" date, and the `&slide=` deep link (for the Advisors
  Manual table of contents).
- 2026-11-23 — `{page}` slide-number token and the Calibri → Carlito fallback (for the dark restyle of
  "Summary of PPA proprietary tools", `user-ppa-tools-oct28`; restyle script
  `scratch/ppa-tools-cycles/restyle-dark.mjs`, not yet written to the deck).
- 2026-11-24 — Lining figures for Playfair Display ("PP Lining Figures", owner: "do the playfair
  digits"). Checked on the PPA tools deck (20 slides) in the editor, rail, Present and the PDF
  download: level digits everywhere, no new text overflow (slide 10's table headers already
  overflowed before this change).
