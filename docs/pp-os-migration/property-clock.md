# National Property Clock — feature note for the pp-os port

This note records Property Clock changes that the pp-os port must copy. It is not a full description of the tool.

Source of truth in the hub repo: `tools/property-clock.html`. The clock is one row, `public.clock_state` id 1; the header text
is `payload.hdr` (`title`, `subtitleL` for Houses, `subtitleR` for Units).

## Edition stamp on Saskia's saves, and a bigger edition badge (2026-10-13)

- **Stamp.** On a cloud Save (`saveState`), if the signed-in email is `saskia@performanceproperty.com.au`, both edition texts
  become `EDITION <month> – <year>`, using the save date in Melbourne time (`_stampEditionIfOwner`). October is edition 10, and
  every save in October keeps 10. Anyone else's save leaves the edition as it is. Offline saves don't stamp.
- **Not editable.** The two edition badges are not `.hdr-editable`, so nobody can type over them, in view or edit mode. Only
  Saskia's saves change them. (The title stays editable.)
- **Badge.** `applyHdr` renders "EDITION <n> – <yyyy>" as a teal pill: the number in a dark disc (22px), then "EDITION" and the
  year. Any other text (an older saved value) shows as a plain pill. The JPG and PDF capture draw it the same way.

## Copy PDF Link (2026-11-11)

- **Why.** The monthly online Property Clock PDF lives on the company docs site
  (`docs.performanceproperty.com.au/research/Clocks/<year>/…`), not in this repo. It used to be reachable from the hub's
  Documents tool, which is gone, so nothing in the hub or pp-os linked to it any more.
- **Button.** "Copy PDF Link" sits right after "Download PDF (A4)" in the toolbar. It is a `.tbtn.pdf-btn`, so it shows to
  exactly the people who see Download PDF (everyone who can open the tool; `applyAccessRestrictions` would hide it only for
  the dormant client/guest tiers). A click copies the URL and toasts "PDF link copied". If the clipboard API is refused it
  falls back to a hidden textarea + `execCommand('copy')`, and if that fails too, a prompt shows the URL to copy by hand.
- **Stored link.** The URL is the `public.reports_state` row `region = 'property-clock-pdf'`, payload
  `{ url, edition, updated_at }`. RLS is the table's own: any signed-in user reads, `is_writer()` inserts/updates. It is
  deliberately NOT in `clock_state`, because a clock Save and the backfill job overwrite that payload whole. If the row is
  missing or the read fails, the page uses the Edition 10 URL hard-coded as `CLOCK_PDF_DEFAULT_URL`. The row was seeded on
  2026-11-11 with Edition 10 (`…/2026/Clock_diagram_Smooth&Workforce_Edition_10_2026-idutw04.pdf`).
- **Updating it each edition.** A writer (dev/admin) switches to Edit, clicks "Edit PDF Link", pastes the new URL from the
  docs site and confirms. The page upserts the row; `edition` is read from the `Edition_<n>` part of the URL (null if absent).
  No code change and no deploy. The docs site assigns the URL suffix, so the new URL has to be copied from there.
- **pp-os.** The clock screen is `apps/performance-os/web/src/app/property-clock/clock.tsx`: put the button after its
  "Download PDF" button in the `property-clock.toolbar` row, shown to everyone with `view:advisory-tools`. The link needs a
  small read procedure (`view:advisory-tools`) and a write (`view:research-tools`, the clock's existing edit rung) in
  `apps/performance-os/api/src/clock/router.ts`, stored apart from the versioned `clock_document`, with the same
  hard-coded fallback. Read the hub row above once to carry the current URL across.

## Changelog

- 2026-10-13: Saskia's saves stamp the edition with the save month; the edition badge is redesigned, enlarged and no longer editable.
- 2026-11-11: "Copy PDF Link" button right of Download PDF copies the online Property Clock PDF URL. The URL is stored in
  `reports_state` row `property-clock-pdf` (`{url, edition, updated_at}`, seeded with Edition 10, default hard-coded as a
  fallback); writers change it each edition from Edit mode → "Edit PDF Link", no code change.
