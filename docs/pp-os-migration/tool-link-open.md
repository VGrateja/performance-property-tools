# Tools that open from a link while staying hidden in the hub (`linkOpen`)

Hub only. Owner, 2026-11-19: a deck's tool slides link to the tools (the picture and "Open the tool"). Three of the
five tools sit in the Vault, so a staff member whose group does not hold them was sent back to the hub when they
followed the link. "Even they're in the vault, if a normal user clicked the image on that presentation slide, they will
still be directed to the tool. So it's like they have view access but the tool is just hidden."

## What it is

A registry flag, `linkOpen: true`, on the tools deck slides link to. The group gate in `shared/auth-gate.js` lets a
page whose key carries the flag load for any signed-in staff member, whatever their group holds. Nothing else changes:

- The group tick still decides the hub card, the dock icon and search, so the tool stays hidden where it is not ticked.
- It is viewing only. What a person may change is still decided by their role and by the database's row-level rules.
- A person still has to be signed in; the sign-in gate is untouched.

Flagged today: `runway-workbook`, `vr-projection`, `population-forecast`, `demand-score`, `market-cycles`
(`market-cycles` also keeps `embedOpen`, which covers the page drawn inside a slide).

**Never set it on a page that loads client records** (Sold Check, the IRR Calculator, the Returns editor). The flag
makes a page reachable by anyone on staff who has its address.

## Where

| What | Path |
|---|---|
| The flag and its comment | `shared/tool-registry.js` (`PP_TOOL_REGISTRY.TOOLS`) |
| The gate line | `shared/auth-gate.js` (group deep-link gate, beside the `embedOpen` line) |

## Check

`node scratch/_link-open-check.mjs` (`LO_BASE=<site>` picks staging or the live site; `LO_EXPECT=before` shows the same
pages bounce without the change). It signs in as the staff test account, whose group holds none of these tools, walks
from the hub to each tool in one tab, and expects the five to stay open, an unflagged Vault tool to be turned back, and
the registry to carry the flag on exactly those five. The gate only knows a person's group once the hub has resolved it
in that tab (a brand-new tab fails open by design), which is why the check walks from the hub.
`node scratch/_link-open-view-probe.mjs` shows each of the five loads its data for that viewer with no failed requests
and no write buttons on screen.

## For the port

The replacement system should carry the same idea as a per-tool setting: "anyone on staff may open this by link",
separate from "show it in this group's menu".

## Changelog

- 2026-11-19: built. Found while fixing a deck whose three tool slides pointed at addresses that do not exist on the
  hub (`/vr-projection`, `/demand-score`, `/runway-workbook`); those links were corrected in the deck itself.
- 2026-11-25 (owner: "Since in VR Slide the image shows Brisbane, make Brisbane as default when opening the tool"):
  `tools/vr-projection.html` reads `?region=<slug>` on load and opens on that market; no region, or one it does not
  know, opens on Adelaide as before (the default for everyone else is unchanged). The PPA tools deck's vacancy slide
  links `vr-projection.html?region=brisbane`. Same pattern as Population Forecast's `?region=&view=` (hub PR #37).
  pp-os: its VR Projection does not read a region from the address yet; carry this when the deck is copied there.
- 2026-11-25, later (owner: "Runway page when clicking the image should show Brisbane too"): `tools/runway-workbook.html`
  reads `?region=<slug>` the same way (no or an unknown region opens on Adelaide as before); the deck's runway slide
  links `runway-workbook.html?region=brisbane`. pp-os: same note as VR Projection above.
