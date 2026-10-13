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

## Changelog

- 2026-10-13: Saskia's saves stamp the edition with the save month; the edition badge is redesigned, enlarged and no longer editable.
