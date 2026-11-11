# 04 · Tenant and permission rules

## 1. Tenant isolation (three layers, all required)

| Layer | Mechanism | Failure it catches |
|---|---|---|
| 1. Identity | Tenant id comes **only** from the session row (Phase 1). Never from a path, query, body or header. | Client sends another tenant's id |
| 2. Database | RLS on every tenant table, `FORCE ROW LEVEL SECURITY`, runtime role `erp_app` (member of `erp_rt`) is not the owner and has no `BYPASSRLS`. Policy below. | Missing `WHERE tenant_id` in a query |
| 3. References | Composite FKs `(tenant_id, x_id) → x(tenant_id, id)` | Child row pointing at another tenant's parent |

Policy template, applied by a migration helper to every new table:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <t>
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

`current_setting(..., true)` returns NULL outside `tenantTx()`, so a query without a tenant context sees **zero rows** instead of erroring into a fallback path.

### Cross-tenant functions (the complete list)

Each is `SECURITY DEFINER`, owned by the migration role, `SET search_path = pg_catalog, public`, returns the minimum columns, and is covered by a test.

| # | Function | Returns | Phase |
|---|---|---|---|
| 1–3 | login by email, session by token hash, token by hash | (as Phase 1) | done |
| 4 | `claim_jobs(worker text, n int)` | `(id, tenant_id, kind, resource_id)` of claimed jobs | B2 |
| 5 | `woo_endpoint_lookup(token_hash text)` | `(tenant_id, connection_id)` or nothing | B4 |
| 6 | B7 store lifecycle and platform console functions (`platform_*`, `saas_*`) | see D70 | B7 |
| 7 | `platform_set_outlets(…)`, `platform_tenant_outlets(…)`: the console's paid outlet limit, checked with `platform_admin_of` and logged | — | v2, D101 |

A sixth function needs an explicit decision record. CI fails if a migration creates a `SECURITY DEFINER` function that is not on this list (grep check).

### Tenant lifecycle

| State | Login | Webhooks | Workers | Data |
|---|---|---|---|---|
| active | yes | processed | run | — |
| suspended (non-payment) | read-only (all writes 403 `TENANT_SUSPENDED`) | **still received and stored** in inbox, processed on reactivation | outbound Woo jobs paused | kept |
| closed | no | rejected 410 | none | export offered for 30 days, then deleted (D13 to confirm) |

Storing webhooks during suspension answers the PRD edge case "subscription suspended while order events arrive": nothing is lost, nothing is acted on.

### Platform admin

Not a tenant role, no row in `users`, no access through the app in V1. Support work uses a separate DB role `erp_support` (`BYPASSRLS`, read-only grants, login disabled by default). Enabling it requires a ticket id, is time-boxed (2 h) and every statement is captured by `pgaudit`. Review monthly.

## 2. Roles and permissions

Five fixed tenant roles (PRD 4). Map lives in `apps/api/src/lib/permissions.ts` (Phase 1). The keys below extend Phase 1's; where Phase 1 already uses a key with a different spelling for the same capability, keep Phase 1's.

| Permission | What it unlocks | Owner | Manager | Inventory | Cashier | Fulfilment |
|---|---|:-:|:-:|:-:|:-:|:-:|
| `product.read` | products, variants, images, barcode lookup (no cost) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `product.write` | create/edit/archive products, images, barcodes, CSV import, labels | ✓ | ✓ | ✓ | | |
| `cost.view` | cost fields, valuation, margin (CAT-12) | ✓ | ✓ | ✓ | | |
| `stock.read` | stock screens, movement history | ✓ | ✓ | ✓ | | ✓ |
| `stock.adjust` | adjustments (correction, opening) | ✓ | ✓ | ✓ | | |
| `stock.writeoff` | damage/expiry/loss write-offs | ✓ | ✓ | | | |
| `stock.transfer` | location transfers | ✓ | ✓ | ✓ | | |
| `stock.override_negative` | post below zero (INV-08) | ✓ | | | | |
| `stocktake.count` | create stocktake, enter counts, submit | ✓ | ✓ | ✓ | | |
| `stocktake.approve` | approve & post variance | ✓ | ✓ | | | |
| `purchase.manage` | suppliers, POs, supplier returns | ✓ | ✓ | | | |
| `purchase.receive` | goods receipts | ✓ | ✓ | ✓ | | |
| `pos.sell` | POS sale, receipt reprint | ✓ | ✓ | | ✓ | |
| `pos.discount` | line/cart discount up to limit | ✓ | ✓ | | ✓ | |
| `pos.price_override` | change unit price | ✓ | ✓ | | | |
| `pos.discount_approve` | Approve a discount above a cashier's limit, by PIN at the till or from Discount approvals, up to the approver's own limit; set one's own approval PIN (v2, D107). Exchanges at the counter need `pos.sell` and `return.manage` (D108) | ✓ | ✓ | | | |
| `cash.manage` | Cash control: tills, payment methods, every register and the cash book; close any register; take cash out of a drawer; approve till expenses (PIN at the till or Approvals); no expense limit (v2, D109–D111). Opening a register, adding cash and expenses within the limits need only `pos.sell` at that outlet | ✓ | ✓ | | | |
| `order.read` | orders list/detail | ✓ | ✓ | | ✓ | ✓ |
| `order.fulfil` | pick, pack, dispatch | ✓ | ✓ | | | ✓ |
| `return.manage` | customer returns + credit notes | ✓ | ✓ | | ✓ | |
| `invoice.read` | invoices, credit notes, PDFs | ✓ | ✓ | | ✓ | |
| `invoice.void` | void by reversal | ✓ | | | | |
| `report.view` | reports (valuation also needs `cost.view`) | ✓ | ✓ | ✓ | | |
| `report.export` | CSV export of reports and products | ✓ | ✓ | | | |
| `contacts.view` | Contacts page: customers and suppliers with their bills, receipts and totals (v2, D96). Supplier purchase totals also need `cost.view`; contact CSV also needs `report.export` | ✓ | ✓ | | | |
| `price.bulk` | Bulk price update by rule or price sheet, its history and undo (v2, D97). Changing cost prices also needs `cost.view` | ✓ | ✓ | | | |
| (outlets) | Outlets use existing permissions (v2, D101): `settings.read` lists them and opens one; `settings.manage` (owner) creates, edits, closes and reopens; `users.manage` (owner) chooses who sells where. The counter needs `pos.sell` and an outlet the person may sell at | | | | | |
| (outlet in view) | The outlet switcher (v2, D115) needs no permission: it only narrows what the person may already read. Owners, managers and staff ticked at no outlet see every outlet; staff ticked at outlets see only those, whatever the `gp_outlet` cookie says, and post stock only into those outlets' rooms (a transfer may send stock from theirs to another). Checked by the API on every request (`outlets/scope.ts`, `activeLocation`) | | | | | |
| `sync.manage` | Woo sync screen, retry, reconcile, publish | ✓ | ✓ | | | |
| `woo.connect` | Woo URL and credentials, disconnect | ✓ | | | | |
| `user.manage` | invite, change role, revoke | ✓ | | | | |
| `settings.manage` | business, tax, invoice series, locations | ✓ | | | | |
| `audit.view` | audit log | ✓ | ✓ | | | |

Differences from the PRD's `ROLE_DEFAULTS`, with reasons:

- **Manager loses `woo.connect` and `invoice.void`.** PRD says managers get "no owner/security settings"; integration credentials and voiding tax documents are both. Manager keeps retry/reconcile through `sync.manage`.
- **Inventory gains `stock.transfer`, `stocktake.count`, `stock.read`; loses `stock.writeoff` and stocktake approval.** The PRD gave Inventory a single `stocktake.manage`, which lets the person who counted also approve the variance. Splitting count from approve gives two-person control where the shop has two people; an owner alone still holds both.
- **Cashier gains `invoice.read`** (reprint) and does **not** get `stock.read`. POS shows available qty through the product lookup only.
- **Fulfilment gains `stock.read`** to see bin/location stock while picking; still no adjust (PRD: "cannot edit … stock manually").
- **`stock.override_negative` is owner-only** and always requires a reason; it is audited (INV-08).

### Enforcement rules

1. Every route declares `requires(...)`. A route test enumerates the Fastify route table and fails CI if any `/v1/*` route (except auth, health, webhooks) has no permission.
2. **Field-level:** responses go through a serializer per role class; `cost`, `unit_cost`, valuation and margin fields are removed when the user lacks `cost.view`. Writes that include `cost` without `cost.view` → 403, not silently dropped.
3. **Value-level:** `pos.discount` allows up to `store_settings.discount_reason_threshold_pct` without a reason and up to 100% with a reason; anything above the user's limit → 403 `DISCOUNT_LIMIT`. Limits by role are settings, not code. Above the limit, the sale goes through only with an approved, unused `discount_requests` row whose cart hash matches the bill, approved by someone else holding `pos.discount_approve` whose own limit covers it (v2, D107). Till expenses above `sales_settings.expense_limit_each` or, summed for the day, `expense_limit_day` wait for someone with `cash.manage` (D111). Return rules (days, no-return categories, exchange only) bind everyone but the owner (D113).
4. **Object-level (IDOR):** every `/{id}` lookup runs inside `tenantTx`, so another tenant's id returns 404, never 403 (no existence leak, AC-01).
5. **Revocation:** role change or revoke deletes the user's sessions in the same transaction (Phase 1). Permission sets are read from the session's user row each request, so a role change takes effect on the next request.
6. **Seat limit:** inviting beyond `plans.max_users` → 409 `SEAT_LIMIT`.

### Audited actions (minimum)

Login success/failure, password reset, invite, role change, revoke; settings and invoice series changes; Woo connect/disconnect and credential rotation; product create/archive, price change, barcode change (5.3), cost change; adjustment, write-off, transfer, negative override, stocktake approve/post; PO submit/cancel, receipt post; discount above threshold, price override; discount request, approval or refusal, PIN set/removed/locked; bill held, picked up or discarded; exchange; return, credit note, invoice void; manual retry, reconcile, publish; every CSV export (who, what, row count). Audit stores a before/after **summary** (changed field names and values) and never secrets, full card data or passwords.
