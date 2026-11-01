# 02 · User journeys and navigation

Each journey lists the happy path, the failure states the UI must show, and the requirement it serves. Screens referenced are in `wireframes.html`.

## 1. Journeys by role

### Owner (tenant admin)

**J1 · First-day setup** (TEN-01..05, done in Phase 1 up to step 3)
1. Register → verify email link → set password. *(Phase 1)*
2. Business settings: legal name, address, **state + GST state code**, GSTIN (optional, validated format), timezone, currency. *(Phase 1, extended with GST fields in B5)*
3. Invite team (seat limit from plan). *(Phase 1)*
4. Inventory locations: "Shop floor" and "Back room" created by default; choose **online fulfilment location** (D20).
5. Import products and opening stock from CSV (J4).
6. Connect WooCommerce (J9).
Failure states: seat limit reached; GSTIN format invalid; Woo connection test fails with the actual reason (DNS, TLS, 401, plugin missing).

**J2 · Daily check** — Dashboard answers four questions (PRD 12): today's sales vs yesterday; stock value and low-stock count; needs attention (stock exceptions, failed sync jobs, orders ready to pick, stocktakes awaiting approval); quick actions. Every attention tile links to a filtered list.

**J3 · Approve and correct** — Open stocktake in review → see variances sorted by value → approve → posted as adjustments (AC-06). Or: review a stock exception order → receive stock or cancel in Woo.

### Inventory staff

**J4 · Import catalog** (CAT-10, AC-17): Upload CSV → map columns (auto-matched by header) → **preview**: valid rows, rows with errors and the reason per cell → download error report → import valid rows or fix and re-upload. Nothing is written until "Import N rows". Opening stock rows post as `opening` ledger movements in the same job.

**J5 · Create product** (CAT-01..08): Products → New → name, category, brand, unit, HSN, GST rate, tracking → type simple/variable → for variable: pick attributes (size, colour…) and values → variant grid generated (SKU auto-suggested, barcode scan or generate, price, cost if permitted) → images: drag to upload, set primary, order → Save as draft or Activate → Publish to website toggle. Duplicate SKU/barcode is checked on blur and on save (CAT-02, `SKU_DUPLICATE`).

**J6 · Receive a purchase order** (PUR-03/04, AC-05): Purchasing → PO → Receive → scan items (each scan +1 on the matching line; unknown code → not-found panel) → for each line enter accepted / damaged / short → choose location → Post receipt. Only accepted qty enters sellable stock; damaged goes to non-sellable. PO status becomes `partial` or `closed`.

**J7 · Stocktake** (INV-05): New stocktake → scope (location, category or all) → expected qty is **snapshotted at start** → count by scanning or typing → submit for review. Movements posted after the snapshot are shown as "moved during count" and included in variance math so live sales don't create false variances.

**J8 · Adjust / transfer / print labels** (INV-04/06, 5.3): Stock → variant → Adjust (reason required: damage, expiry, loss, correction) or Transfer (from → to, qty). Labels: select variants → qty per variant → label size → browser print.

### Owner / manager (integration)

**J9 · Connect WooCommerce** (TEN-04/05): Integrations → enter site URL → paste consumer key/secret (read/write) → Test connection (server-side; shows Woo version, currency, whether webhooks can be created) → Save → ERP creates its webhooks (order.created, order.updated, product.deleted) → choose: import open orders from last N days (D5 default 0) → initial product match by SKU: matched / ERP-only / Woo-only list, user confirms.

**J10 · Fix sync failures** (6.5, AC-11/12): WooCommerce Sync → failed jobs grouped by kind → each row: resource, attempts, last error (redacted), next attempt → Retry, or Open product to fix a validation error. Reconcile now → shows differences found and repairs ERP-owned fields.

### Cashier

**J11 · POS sale** (5.6): POS opens with scan focus → scan or search → line added (price, tax, total from server) → change qty → discount (only with `pos.discount`; reason required above the threshold) → customer (optional; required for B2B invoice with GSTIN) → Pay: cash/card/UPI/other, split allowed, reference → Confirm → invoice number shown, Print receipt. Double-click or network retry is safe (idempotency key). Insufficient stock blocks the line with the available qty shown.

**J12 · Customer return** (5.7, AC-14): Returns → find sale by invoice no., phone or scan receipt → select lines and qty → condition: resellable / damaged / quarantine → refund method → Post → credit note issued; only resellable lines restock.

### Fulfilment staff

**J13 · Pick, pack, dispatch** (6.6, AC-10): Fulfilment → Ready to pick (oldest paid first) → open order or batch pick list → scan each item (wrong item = red flash + sound, over-pick blocked) → all lines picked → Pack: confirm qty → Dispatch: carrier, tracking no., date → Done. Website status shows "update pending" until Woo confirms.

### Platform admin (operator)

**J14 · Support access** — Not a UI in V1. Operator uses a break-glass DB role with a ticket reference; every session is logged (see 05-security-and-backup.md §6).

## 2. Navigation

Layout (PRD 12): persistent left sidebar, top bar, content area. Sidebar collapses to icons at < 1280 px and to a drawer at < 768 px. POS and Fulfilment pick screens hide the sidebar for full-screen counter use (Esc or the back arrow returns).

Top bar: global search (products by name/SKU/barcode, orders by number, invoices by number; scan works here too), store name, user menu (profile, sign out).

| Group | Item | Route | Shown when user has | Stage |
|---|---|---|---|---|
| Overview | Dashboard | `/dashboard` | any | done |
| Sell | POS | `/pos` | `pos.sell` | B5 |
| | Orders | `/orders` | `order.read` | B4 |
| | Fulfilment | `/fulfilment` | `order.fulfil` | B6 |
| | Returns | `/returns` | `return.manage` | B5 |
| | Invoices | `/invoices` | `invoice.read` | B5 |
| Inventory | Products | `/products` | `product.read` | B2 |
| | Stock | `/stock` | `stock.read` | B3 |
| | Stocktakes | `/stocktakes` | `stocktake.count` | B3 |
| | Purchasing | `/purchasing` | `purchase.manage` **or** `purchase.receive` | B3 |
| | Suppliers | `/suppliers` | `purchase.manage` | B3 |
| Insights | Reports | `/reports` | `report.view` | B6 |
| | WooCommerce Sync | `/integrations/woocommerce` | `sync.manage` | B4 |
| Management | Team & Permissions | `/settings/team` | `user.manage` | done |
| | Business Settings | `/settings` | `settings.manage` | done |
| | Audit Log | `/settings/audit` | `audit.view` | done |

Changes from PRD `navigation.ts`:
- **Invoices** added under Sell; the PRD lists invoice screens in the handoff checklist (19) but has no nav entry for them.
- **Purchasing** also shows with `purchase.receive`; otherwise Inventory Staff, who receive goods, could not reach the receive screen.
- **Stock** uses `stock.read`, not `product.read`; otherwise Cashiers see stock and valuation screens.
- **Woo Sync** uses `sync.manage` instead of `woo.manage` (credentials split out as `woo.connect`).
- Hidden future items (Accounting, CRM, AI) are not rendered at all, not greyed out.

Empty states: every list has one with the next action ("No products yet · Import CSV · Add product"). Error states always show the `correlationId` in small text so support can trace it.
