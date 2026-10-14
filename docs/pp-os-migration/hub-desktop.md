# Hub desktop (Performance OS) — feature note for the pp-os port

This note records hub desktop changes that the pp-os port must copy. It is not a full description of the hub.

Source of truth in the hub repo: `index.html`, the `APPS` list inside `ppOsDesktop()` (one entry per dock section, each with
its `tools` cards).

## Vault tools in alphabetical order (2026-10-14)

The Vault window and its dock fly-out list their tools A–Z by display name (`localeCompare`, case-insensitive). The list is
sorted once, right after `APPS` is defined and before anything renders, so card clicks (which look tools up by index) and the
fly-out use the same order. New Vault tools need no placement: they sort into place. Pins are unaffected (they resolve by
section and name).

## Changelog

- 2026-10-14: Vault tools sorted alphabetically.
