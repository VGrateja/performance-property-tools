# RBA cash rate on the median price charts — feature note for the pp-os port

Request (advisers, via Van, 2026-11-09): overlay the RBA cash rate against median price movements in all selling and
buying slides and all research reports. This note records what the pp-os port must copy. It is not a full description of
the charts.

## The rule, everywhere

- **One line, "RBA cash rate"**: `rdp_raw_series` `source='rba'`, `metric='cash_rate'`, `region_slug='australia'`.
  Brand Cobalt Blue `#233AE7`, solid, 2px, symbols only on hover. (A purple first draft was changed for a colour that
  sits with the teal/black/orange series, the red recession lines and the shaded bands.)
- **Yearly value = the year-end rate**: the `freq='A'` row (`YYYY-01-01`, December's target, or the latest month for the
  current year). This is the same `cash_rate` the report feed carries per year (`shared/report-feed-calc.js`), so pages
  that already hold the feed read it from there. Values are fractions; display ×100 to 2 decimals.
- **Starts in 1990** (the series' first year). Earlier years are a gap, never back-filled.
- **Right-hand "Interest rate" axis**: min 0, max = the line's peak rounded up to the next even number plus 2 (the 1990
  peak of 12% gives 14%), steps of 2, labels like `4%`. The price axis on the left is unchanged.
- Legend entry at the top with the existing legend; the tooltip ends with "RBA cash rate 4.60%".
- On year-on-year charts the price axis goes negative and the rate axis starts at 0, so the two zero lines do not align.
  Accepted as is.

## Where it is

| Tool | Charts | How |
|---|---|---|
| `online-reports.html` (Full + Lite, all regions) | p3 Median Price, p4 Year on Year Price Movement | `renderMedianPrice()`; p4 wraps `assets/Reports/charts/chart-yoy-price.js` (`wrapYoyWithCashRate`). Right margin kept at 25 so the crisis lines and hand-placed boxes do not move. Drawn before `PPA_LIVE_BOOT_DONE`, so cached PDFs include it from the next monthly render. |
| `national-report.html` | p2, p3, p4 median price charts | `_addCashRateOverlay()` in the page, not in `national-charts.js` |
| `buying-selling-slides.html` (sell + buy, Full + Summary) | Median Price slide; House v Unit slide; NEW "Year on Year Price Movement" slide (`yoy_price`) | `getCashRateA()` loader; House v Unit is post-processed in the page, not in `shared/bss-slides.js` (its rate axis is a third axis, outside "% Difference H v U"). Yield v Variable Rate (bank_rate) is unchanged. |

### The new B/S slide `yoy_price`

The requester's chart is the cash rate against the YEAR ON YEAR median price change, and the decks had none. `yoy_price`
draws house (teal `#00A0B4`) and unit (`#171B24`) % change year on year as lines from the same feed medians as Median
Price (`mp[y]/mp[y-1]-1`, adjacent years only, from 1980), a 0% line, and the cash rate on the right axis. It sits
directly BEFORE Yield v Variable Rate in both `SLIDE_DEFS` (Full) and `SUMMARY_ORDER` (Van, 2026-11-09).

No deck has authored chrome for the new key, so `BSS_DEFAULT_CHROME.yoy_price` (title, disclaimer, rule, logo, source —
copies of every deck's `median_combined` chrome) is drawn by `renderOverlays()` whenever a deck has no overlays for a
key: locked, never saved, replaced as soon as anyone authors overlays for it. A deck with a saved custom order (one: the
`--davidm` Adelaide variant) gets the new slide at the end until it is dragged into place. Nothing is keyed by slide
number.
| `presentation.html` | `median-price`, `yoy-price` and `national-p2/p3/p4` modules in decks | page-local wrappers around `PpaCharts.registry`; `cashRate` attached in `buildReportChartSpec`; deck open refreshes charts from their source, exports wait for that refresh, thumbnails redraw |
| `market-compare.html` | "Median price — indexed" | cash rate from each market's feed years |

The Commercial report has no median price chart.

## For the port

- Copy the rule, not the hub's wrappers: in pp-os the overlay belongs in the shared chart builders once, with the
  report, slide and deck renderers all using them.
- Decks: the first writer open re-saves a deck's refreshed chart (new "Updated" date, cached PDF replaced). The hub's
  deck PDF cache needs `RENDER_ALL=1 node scripts/render-decks.mjs` once to pick the line up without a writer open.

## Changelog

- 2026-11-09 — RBA cash rate line added to every hub median price chart (research reports, National report, B/S
  Median Price and House v Unit slides, Presentation builder modules, Market Compare).
