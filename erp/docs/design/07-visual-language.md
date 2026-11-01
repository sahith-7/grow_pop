# 07 · Visual language (design system and screens)

Part of the Phase 2 design pack. Status: **for approval**. Like the rest of Phase 2 this is design, not shipped code: `styles/tokens.css` and `styles/components.css` live in `docs/` now and are copied into `apps/web` when B2 starts.

## Deliverables

| File | What it is |
|---|---|
| [styles/tokens.css](styles/tokens.css) | The only file with raw values: colours, fonts, type scale, 4 px spacing, sizes, radius, focus ring, motion, z-index. Dark theme defined but off. |
| [styles/components.css](styles/components.css) | Reusable components, all prefixed `ui-` (shell, buttons, fields, scan field, badges, alerts, tables, KPIs, tabs, steps, dialog, drawer, toast, empty/loading/error). Uses tokens only. |
| [design-system.html](design-system.html) | Reference page: directions explored, name and identity, colour, type, spacing, every component and state, responsive and accessibility rules. Published: https://claude.ai/artifact/HTaF2zwe16i2BHvKdFF9Ki |
| [screens.html](screens.html) | Final-style screens: dashboard, products table, product form, POS (counter), order detail, pick & pack (counter), stock on phone. Published: https://claude.ai/artifact/TkyLDj7Yq8JZtumJN9Aa83 |

`wireframes.html` stays as the layout reference for all 12 screens; where its colours differ from these pages, these pages win.

## Decisions (D1)

1. **Direction A "Ledger"** (ink blue #2F45B8, marigold accent, IBM Plex). Recommended. B "Haat" and C "Counter" are shown on the reference page and rejected for stated reasons.
2. **Name: TRIDENT** (chosen 2026-10-21; replaced the working name "TRIDENT"). Not cleared yet: run an IP India trademark search in classes 9 and 42 and check the domains before using it publicly. The name lives in `apps/web/lib/brand.ts`, `APP_NAME` and `site/site.config.json`.
3. **Not VasyERP's look.** Their exact colours/fonts were never available, and copying a competitor's trade dress is a legal risk. This is an original identity.
4. **Dark mode deferred** past V1. Tokens exist so it is cheap later.
5. **POS not supported on phones** in V1. Counter screens target a 10-inch tablet or desktop with a keyboard-wedge scanner. Phones get stock lookup and pick lists.

## Rules

- Indian number grouping via `Intl.NumberFormat('en-IN')`; numbers right-aligned in tabular figures.
- Two densities: office (36 px controls, 40 px rows) and counter (48 px controls, 52 px rows).
- Breakpoints 1280 / 1024 / 768. Tables with `data-collapse` become stacked cards below 768 px.
- Status colour is never the only signal. All text pairs meet WCAG 2.2 AA; control borders 3.1:1.
- POS shortcuts: F2 scan, F4 customer, F8 discount, F9 pay, Esc exit.
- Fonts self-hosted as woff2 in production (the preview pages load Google Fonts only for convenience). Icons: Lucide.

## At B2 (not now)

Copy `docs/design/styles/tokens.css` and `components.css` to `apps/web/src/styles/`, import both once in the root layout, and check for clashes with any Phase 1 global styles on `body`, headings and form elements. Every class is `ui-` prefixed to make clashes unlikely.
