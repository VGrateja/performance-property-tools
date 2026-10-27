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

## Changelog

- 2026-10-26 — Source Serif 4, parallelogram + slant, image corner radius (for the Wholesale
  October 2026 Refresh deck).
- 2026-10-27 — Links between slides (text + shapes), permanent slide ids with a once-per-deck
  backfill on open that keeps the "Updated" date, and the `&slide=` deep link (for the Advisors
  Manual table of contents).
