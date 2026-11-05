# Brochures — PDF brochure links for the EAs and Advisors (hub)

Feature note for the pp-os migration. Hub files: `index.html` (dock tile, search entry, dock sizing),
`tools/whitepapers-strategies.html` (the folder).

## Why

Staff asked (2026-10-21) for every brochure to be on the hub, with the strategy consult's hyperlinks
pointing at the right, up-to-date brochure — "important for both EA and Advisors". Brochures are PDFs that
already live elsewhere (Google Drive, `docs.performanceproperty.com.au`), so the hub holds their LINKS, the
same way the Videos folder holds video links. Van's call: a widget beside Strategies & Frameworks where the
editors paste PDF links, like Videos.

## What it is

- **Dock tile** `wp-brochures` ("Brochures", folded-leaflet glyph), between Strategies & Frameworks and
  Videos; `data-gate="documents"` like the other folder tiles, so no new registry key and no Groups tick.
  Opens `tools/whitepapers-strategies.html?section=brochures`. The dock is now sized for 11 tiles
  (`--dock-tile: … / 11`); measured one row inside the viewport at 1600, 1280 and 1024 px.
- **Search palette** entry "Brochures" (keywords brochure, pdf, flyer, pack, send, client, ea, advisor).
- **Data** = a section in `documents_state.payload.sections`:
  `{ id:'brochures', icon:'📄', title:'Brochures', subsections:[{ id:'brochures-sub', kind:'brochure', items:[] }] }`,
  appended by `_ensureSubsections` when missing (an editor's first visit saves it to the cloud). No
  migration, no RLS change. Item: `{ title, url, blurb, category, status, date }` — `date` shows as
  "Updated dd/mm/yyyy"; it is set to today when the row is added and again whenever an editor pastes a
  different link, so replacing a brochure dates it without anyone typing a date.
- **Brands.** Brochures come in families, and the title's first word says which: **PPA** (Performance
  Property, Purple `#C445C4`), **PFD** (Property for Doctors, Teal `#00A0B4`), **Wholesale** (Yellow `#FFA91F`).
  The list is grouped under a heading per brand (in that order, unbranded titles last under "Other"), each
  row's thumbnail slot is a dark tile with a 2px border and the code in the brand colour, and the displayed
  title drops the brand word ("PPA Residential Property Acquisition" shows as "Residential Property Acquisition" next
  to a PPA tile). No stored field: renaming a title moves it. `_WSX_BRANDS` / `_wsxBrand()`.
- **View** reuses the Videos row (`_wsxRenderVideos` with a per-folder config, `_WSX_LINK_KINDS`): status
  dot · brand tile (unbranded: Drive's first-page thumbnail, else a page glyph) · title (opens the PDF in a new
  tab) + category chip · "Google Drive · Updated …" · two-line blurb · **Preview** · **Copy link**. No Copy
  email and no pin (Van, 2026-10-21 — Videos keeps both). Preview = the PDF in a tall modal: a Drive link
  through Drive's `/preview`, any other https link framed with `#view=Fit&navpanes=0` so Chrome's viewer
  shows the whole page centred with its thumbnail sidebar closed. Search filters title, blurb and category.
  Hidden from the Documents picker in view mode (it has its own tile).
- **Edit** (editors only, as for every Documents folder): one row per brochure — Status · Title · PDF link ·
  Category — plus a blurb box; "+ Add brochure"; saves as you type. The note tells editors to start the title
  with PPA, PFD or Wholesale.

Verified: `scratch/_verify-brochures-folder.mjs` (test account, samples injected in-page only, nothing
saved; runs on the real brochure list read from the cloud plus one in-page sample) — 20/20;
`scratch/_verify-videos-folder.mjs` passes for Videos except its best-effort Vimeo
thumbnail check, whose sample video now answers 404 on Vimeo's oEmbed.

## Case Studies (2026-11-05)

Van: add Case Studies to the folder and rename it **Brochures & Case Studies** (dock tile, page title, app
bar, search). The section id stays `brochures` (so `?section=brochures` and the stored data are unchanged).
The section gains a second subsection `{ id: 'case-studies-sub', title: 'Case Studies', kind: 'casestudy' }`,
added on load when missing, and a stored title of exactly "Brochures" is renamed. The page shows two tabs,
Brochures and Case Studies, each with its count; `?tab=case-studies` opens the second, and the hub search
has a "Case Studies" entry that goes there. Case studies are property case studies — one A–Z list, no
groups and no brand tiles (Van: "We don't need to separate the case studies for now"). Same item shape and
row as a brochure (status, title, link, category, blurb, "Updated" date that follows the link; Preview +
Copy link), but the link may be Google Drive, a PDF or a web page. Edit mode keeps the tabs and edits only
the open list. Verified: `scratch/_verify-case-studies.mjs` (test account, samples in-page only, cloud
writes off) — all checks pass.

## pp-os

pp-os mirror owed: a Brochures entry in Advisory beside Strategies & Frameworks and Videos, the same item
shape, brand groups + brand tiles from the title prefix, Preview of a PDF link (fit, no sidebar), Copy link,
editor-only edit. Carry the hub items across when it
lands (they are in `documents_state` → section `brochures`).

## Changelog

- 2026-10-21 — built (dock tile, search entry, Brochures folder, "Updated" date follows the link).
- 2026-10-21 — Copy email and pin removed; PPA / PFD / Wholesale groups and brand tiles; Preview shows the
  whole page centred (fit, sidebar closed, frame no longer 16:9-wide).
- 2026-10-21 — PPA and PFD colours swapped (PPA purple, PFD teal); tiles outlined in the brand colour instead of filled.
- 2026-11-05 — Case Studies: renamed Brochures & Case Studies; a Case Studies tab (one A–Z list) beside Brochures; `?tab=case-studies`; search entry.
- 2026-11-05 (later) — Case studies drop Status and Category (Van): no status dot or legend, editor columns Title | Link | Portfolio Value | Size; the row's sub line reads "Portfolio Value … · Size … · Updated …". New fields `portfolioValue`, `size` (free text); old `status` values on case studies are kept but not shown.
- 2026-11-05 (later) — A case study stored with status "updating" is no longer locked as "Being updated" (case studies have no status, and the editor no longer offers one to clear it): `_wsxVideoState(item, K)` skips the status check when `K.caseStudy`.
- 2026-11-05 (later) — Case-study rows: Portfolio Value and Size move out of the sub line into their own column before the buttons (label over a large teal figure, "—" when empty, aligned on every row); no "Updated" date on case studies; an empty sub line is left out.
