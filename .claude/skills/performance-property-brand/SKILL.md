---
name: performance-property-brand
description: Performance Property Group brand guidelines — colors, typography, logo rules, tone of voice, imagery, and icon standards. ALWAYS use this skill whenever creating ANY deliverable for Performance Property or its sub-brands (Property for Doctors, Performance Asset Management), including but not limited to - PowerPoint/PDF/Word documents, websites, web apps, UI components, social media banners, email signatures, infographics, illustrations, marketing copy, presentations, or any visual or written asset. Trigger even if the user doesn't explicitly mention "brand" — if the deliverable is for Performance Property, this skill applies.
---

# Performance Property Group — Brand Skill

Apply these rules to every deliverable. Machine-readable values are in `tokens/brand.tokens.json`, `tokens/brand.css`, and `tokens/tailwind.brand.js` in this folder. Full detail: `BRAND_GUIDELINES.md`.

## Colors (hex)

- **Primary:** Teal `#00A0B4`, Dark Teal `#171B24`
- **Secondary:** White `#FFFFFF`, Light Gray `#D9D9D6`, Dark Gray `#63666A`
- **Accents (use sparingly):** Celestial Blue `#54A6DE`, Eucalyptus `#3E7967`, Yellow `#FFA91F`, Green `#71B357`, Red `#E72347`, Purple `#C445C4`, Cobalt Blue `#233AE7`, Bright Blue `#00C4F5`
- **Tone ramps:** every accent has an 11-step light→dark ramp for illustrations, infographics, and UI shading — read them from `tokens/brand.tokens.json` → `color.tones`. Use ramp steps (50–950) for backgrounds, hovers, borders, and chart series instead of inventing new colors.
- Hierarchy: Teal leads, Dark Teal grounds, neutrals do the everyday work, accents punctuate. Never let an accent dominate a layout.
- Sub-brand **Asset Management** uses Eucalyptus `#3E7967` + Dark Teal instead of Teal.

## Typography

- **Montserrat** for design pieces (web, slides-as-design, posters, banners, apps). Any weight EXCEPT **Montserrat Condensed — prohibited**.
- **Arial** (Regular/Bold only) for PowerPoint, Word, email, newsletters.
- Italics in either face only for quotes, accented words, or titles of works.
- Headlines: **sentence case** (never Title Case), short, **no ending punctuation**.

## Logo

- Teal + Dark Teal only; variants: standard → inverted → black (pick by legibility).
- Safe area = the symbol's own height/width on all sides. Min height: 6 mm print / 35 px digital.
- Never distort, recolor, outline, shadow, rotate, remove the tagline, or rearrange elements. Scale proportionally only.
- NEVER redraw, recreate, or approximate a logo in SVG/HTML/code. ALWAYS use the real files.

**Fetching logos (IMPORTANT):** all logo files are publicly hosted. Base URL:
`https://raw.githubusercontent.com/Performance-Property/pp-brand-assets/main/logos/`

- **Documents (docx/pptx/pdf):** download the needed PNG from its URL (e.g. `curl -o logo.png <url>`) and embed the actual image. Do not use placeholders and do not ask the user to attach the logo.
- **Web output (HTML/email):** reference the URL directly in `<img src>`.
- **Local repo work (Claude Code):** prefer the local files in `assets/logos/` (or `brand/assets/logos/` via submodule).

| Brand | File (append to base URL) | Use on |
|---|---|---|
| Performance Property | `performance-property/pp-logo-standard.png` | White/light backgrounds |
| Performance Property | `performance-property/pp-logo-inverted.png` | Dark backgrounds (e.g. Dark Teal) |
| Performance Property | `performance-property/pp-logo-white.png` | Photos/strong color backgrounds (all-white) |
| Performance Property | `performance-property/pp-logo-black.png` | Grayscale/single-color print |
| Property for Doctors | `property-for-doctors/pfd-logo-black.png` | White/light backgrounds; grayscale print |
| Property for Doctors | `property-for-doctors/pfd-logo-white.png` | Dark or colored backgrounds |
| Asset Management | `asset-management/pam-logo-standard.png` | White/light backgrounds |
| Asset Management | `asset-management/pam-logo-inverted.png` | Dark backgrounds |
| Asset Management | `asset-management/pam-logo-standard-inverted.png` | Alternate inverted lockup |
| Asset Management | `asset-management/pam-logo-white.png` | Eucalyptus `#3E7967` background (the ONLY background permitted for the green treatment); also photos/dark surfaces |
| Asset Management | `asset-management/pam-logo-black.png` | Grayscale/single-color print |

- Variant selection rule: white/light background → standard (or black for PFD); Dark Teal or dark surfaces → inverted (or white); photos/strong colors → white; grayscale or single-color print → black.

## Voice & copy

Authoritative, strategic, solution-oriented; professional yet approachable. Audience: high-net-worth investors, corporates, family offices, medical professionals. Data-driven and clear — no jargon walls, no fluff. Consultative, client-first framing.

## Imagery

Candid, unposed, people-oriented, vibrant, diverse; subjects should look like credible experts. NEVER black & white, desaturated, or sepia. No cluttering overlays; no clichés; avoid stiff poses (e.g., crossed arms).

## Icons

Simple outlined style, one consistent set, **one color per set** (any brand color or gray). Reverse treatments (colored bg, white icon) OK. Never multi-color within an icon or mixed colors across a set.

## Per-deliverable quick rules

- **PPTX/DOCX/PDF:** Arial for body text in PPT/Word; Montserrat acceptable in designed PDFs. Dark charcoal/Dark Teal + Teal scheme; generous whitespace; don't overload slides/pages.
- **Web/UI:** import `tokens/brand.css` or extend Tailwind with `tokens/tailwind.brand.js`. Montserrat via Google Fonts. Use tone ramps for states and data viz.
- **Social banners:** short headline, sentence case, no end punctuation, clear CTA.
- **Email signature pattern:** Name (bold) / Title / Phone / Email / Website.
