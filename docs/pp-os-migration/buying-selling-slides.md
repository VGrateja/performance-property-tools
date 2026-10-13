# Buying/Selling Slides — feature note for the pp-os port

This note records B/S Slides changes that the pp-os port must copy. It is not a full description of the tool.

Source of truth in the hub repo: `tools/buying-selling-slides.html` (`SLIDE_DEFS` = the Full Report, `SUMMARY_ORDER` = the
Summary deck that viewers see; the Full Report needs editor rights). Each deck's authored overlays live in `reports_state`
rows `bss-<slug>-<sell|buy>`, keyed by slide key.

## Stock on Market v ADOM back in the Demand section (2026-10-13)

The chart that slide `f11` carried before the 2026-07-21 restructure is back, now in the Demand section of both decks, right
after Total Dwellings:

- Full Report: `SLIDE_DEFS` entry `{ key:'f11', render: chartSlideBare(56), mount: mountStockDom }` after `stub_dwellings`.
- Summary: `'f11'` in `SUMMARY_ORDER` between `stub_dwellings` and `vr_proj`.

The key `f11` is reused on purpose: the content is the same chart, and all 73 sell/buy decks still hold its authored chrome
(title "STOCK ON MARKET v. ADOM", disclaimer, rule, logo). No data write was needed.

The chart (`getSomDom` / `renderStockDomChart`) reads `rdp_raw_series` directly: `sqm som_h` and `som_u` for the House and Unit
bars, and `corelogic adom_h` for the House Days-on-Market line, one point per year. Unlike the Online Reports chart, it does
not clip days on market to 2017.

Data caveat: the stock bars up to 2025 are SQM's stock on market. 2026 is Cotality's "# listings (1 month)", written under the
same `sqm` tag on each PUBLISH (`scripts/sync-cotality-medians-to-rdp.mjs`). The jump into 2026 can be the change of source
rather than the market.

A deck with a saved custom order (`payload.order`) shows a new key at the end of its order until someone moves it.

## Changelog

- 2026-10-13: Stock on Market v ADOM (`f11`) restored to the Demand section of the Full Report and the Summary deck.
