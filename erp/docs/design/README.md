# Phase 2 · Product and architecture design

Design pack for the retail ERP, built on the PRD v1.0 (12 Oct 2026) and the deployed Phase 1 foundation. No application code.

| Deliverable | File |
|---|---|
| Architecture document, module boundaries, PRD conflicts | [01-architecture.md](01-architecture.md) |
| User journeys and navigation | [02-journeys-and-navigation.md](02-journeys-and-navigation.md) |
| Database model | [03-data-model.md](03-data-model.md) |
| Tenant and permission rules | [04-tenancy-and-permissions.md](04-tenancy-and-permissions.md) |
| API specification | [05-api/openapi.yaml](05-api/openapi.yaml) (OpenAPI 3.1, 91 operations, Redocly-valid) + [05-api/conventions.md](05-api/conventions.md) |
| Security and backup plan | [06-security-and-backup.md](06-security-and-backup.md) |
| Wireframes (12 screens) | [wireframes.html](wireframes.html) · published at https://claude.ai/artifact/WTnyqwYe1RJ5vjwbGiYuLd |
| Visual language: design system, tokens, components, final-style screens | [07-visual-language.md](07-visual-language.md) · [design-system.html](design-system.html) · [screens.html](screens.html) |

## Decisions you need to make (blocking the next build stage)

1. **Keep Phase 1's stack over the PRD's NestJS/Prisma/JWT/BullMQ** (D2-r, D14, D15). Recommended yes. Needs a line in `docs/decisions.md`.
2. **No Redis in V1; Postgres-backed queues** (D15). Recommended yes.
3. **Brand, colours and fonts** (D1, then D87 and D92). The product is **GroPop** (2026-11-08) and the v2 look replaced the "Ledger" palette: action blue #1769D2, navy #0B2447, Plus Jakarta Sans. See [07-visual-language.md](07-visual-language.md). Layout patterns follow common retail ERPs; no other product's logo, colours or wording is copied (trade-dress risk).
4. **RPO/RTO** (D11): PRD planning target 24 h / 8 h; this pack recommends 5 min / 4 h using managed PITR.
5. Still open from the PRD and not solvable by design: tax examples and invoice numbering signed by a tax adviser (D7), pilot Woo versions and gateways (D6), scanner/printer models (D9), historical order import window (D5).

## Phase numbering
Your Phase 2 (design) is the PRD's Phase 0. Build stages in this pack are B2 (catalog) to B7 (hardening), matching PRD phases 2–7.
