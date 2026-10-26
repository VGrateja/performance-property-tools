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

## pp-os

pp-os Presentations needs all three for a copied deck to look the same:
`docs/plans/2026-10-26-presentations-hub-deck-parity.md` (approved 2026-10-26) adds them, plus
native drawing of raw ECharts bar overlays, the hub's thin-line padding, and a one-deck copy
(`backfill --deck=<id>`).

## Changelog

- 2026-10-26 — Source Serif 4, parallelogram + slant, image corner radius (for the Wholesale
  October 2026 Refresh deck).
