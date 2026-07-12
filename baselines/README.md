# Baselines — “before” exports (the regression yardstick)

Before an export-capable tool is reskinned, capture its exports from the
**current design** (localhost:8123 or the live site) and drop the files here,
named `<tool>-<what>-YYYY-MM-DD.<ext>`. After the reskin we export the same
thing from :8124 and compare side-by-side — content identical, only chrome may
differ.

Capture list (do each just before that tool’s session — Van + Claude together):

- [ ] `property-clock-clock-jpeg-…` — Clock → export JPEG
- [ ] `property-clock-pdf-…` — Clock → export PDF
- [ ] `runway-demand-jpeg-…` / `runway-demand-pdf-…`
- [ ] `online-reports-full-pdf-…` — one region (Melbourne), Full download
- [ ] `online-reports-lite-pdf-…` — same region, Lite
- [ ] `national-report-pdf-…` / `commercial-report-pdf-…`
- [ ] `tenant-summary-onepager-…`
- [ ] `demand-score-csv-…` (text — quick diff)

Files here are local-only test artifacts (gitignored on this branch).
