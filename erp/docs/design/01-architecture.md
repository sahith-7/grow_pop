# 01 · Architecture and module boundaries

Status: Phase 2 design, for review. Extends the Phase 1 foundation that is already deployed. Requirement IDs (TEN-, CAT-, PUR-, INV-, AC-) refer to the PRD v1.0 (12 Oct 2026).

## 1. Decisions this design makes against the PRD

The PRD's Part B scaffold (NestJS + Prisma + JWT + BullMQ) was never compiled. Phase 1 replaced it with a smaller, safer foundation. This design keeps Phase 1 and records where it departs from the PRD. Each row needs to go into `docs/decisions.md`.

| # | PRD says | Phase 1 / this design | Why |
|---|---|---|---|
| D2-r | NestJS + Prisma (D2) | **Fastify + `pg` + SQL migrations** (as built) | Prisma does not set `app.tenant_id` per transaction cleanly; Phase 1 `tenantTx()` makes RLS the primary guard. Rewriting a deployed foundation buys nothing. |
| D14 | JWT bearer stored in `sessionStorage` (`lib/api.ts`) | **Opaque `__Host-` HttpOnly session cookie** (as built), `/api/*` proxied by Next.js | Token in JS storage is stealable by any XSS; cookie sessions allow instant revocation (section 4 of PRD). |
| D15 | Redis + BullMQ for queues | **PostgreSQL-backed inbox/outbox, workers claim with `FOR UPDATE SKIP LOCKED`, woken by `LISTEN/NOTIFY`** | The PRD already makes `SyncJob`/`WebhookEvent` tables the durable record; BullMQ would be a second queue that can disagree with them. SMB volumes (1–3 users, one Woo site per tenant) are far below what Postgres queues handle. Redis is added only when the API scales past one instance (rate limits). |
| D16 | Prisma camelCase columns | **snake_case tables and columns** | Matches Phase 1 (`audit_events`, `app.tenant_id`). |
| D17 | Webhook URL `/webhooks/woocommerce/{tenantId}` | `/api/v1/webhooks/woocommerce/{endpointToken}` (random 32-byte token per connection) | Tenant ids are not secrets; an unguessable path token cuts unauthenticated load before HMAC work. |
| D18 | `RolePermission` table seeded from code | **Role→permission map stays in code** (as built); five fixed tenant roles in V1 | No custom roles in V1 scope; a table adds a query per request and a migration per change. |
| D19 | Every stock move also writes an `AuditEvent` | Ledger entry **is** the audit record for system moves; `audit_events` only for human-initiated stock actions (adjust, write-off, override, stocktake post, manual retry) | Halves write volume on the hottest path; AC-16 is met because the ledger stores `balance_after`. |
| D20 | Reserve at "first active location by name" | Reserve at the tenant's configured **online fulfilment location** (`store_settings.online_location_id`) | Deterministic and visible to the user. |
| D21 | `SyncJob` unique on `(tenant, kind, resource, status)` | Partial unique index on `(tenant_id, kind, resource_id) WHERE status = 'pending'` | The PRD constraint fails on the second completed job for the same product, and the scaffold hides that with `.catch(() => {})`. |

Phase numbering: your "Phase 2 — design" is the PRD's **Phase 0 (Discovery/design)**. The PRD's own "Phase 2" is Catalog + barcodes. This pack uses build stages B2–B7 below to avoid that clash.

Three PRD Phase 0 exit items cannot be closed by design alone and stay OPEN: tax examples signed by a tax adviser (D7), supported Woo versions/gateways from pilot stores (D6), and scanner/printer models (D9).

## 2. System shape

Modular monolith, one repo, two deployables plus one new process.

```
Browser ──HTTPS──> web (Next.js)  ──/api/* proxy (internal network)──> api (Fastify)
                                                                         │
WooCommerce ──HTTPS──> web /api/v1/webhooks/... ──proxy──> api ──insert inbox row──┐
                                                                         │          │
                                                       PostgreSQL 16 <───┴──────────┘
                                                       (RLS, ledger, inbox, outbox)
                                                                         ▲
                                       worker (same api image, `node dist/worker.js`)
                                         - claims inbox/outbox jobs (SKIP LOCKED)
                                         - calls WooCommerce REST, S3, PDF render
                                         - scheduled: reconcile, ledger check, purge
                                                                         │
                                                         S3 (private bucket, tenant-prefixed keys)
```

- **web**: Next.js App Router. Server components fetch through the same proxy; no API secrets in the browser bundle.
- **api**: Fastify. Only process that serves HTTP. Stateless except in-memory rate limiter (one instance in V1).
- **worker** (new in B4, but the outbox is introduced in B2 for image thumbnails): same image and codebase, different entrypoint. Runs as `erp_app` like the API. Scales independently. Graceful shutdown finishes the current job.
- **migrate**: unchanged; owner role.

No Redis in V1. Add it when either (a) the API runs more than one instance, or (b) queue p95 wait exceeds 2 s. Both are measurable.

### Request path (unchanged from Phase 1)

1. `onRequest`: Origin check for non-GET (CSRF). **Change:** skip the Origin check for `/v1/webhooks/*` only; those are authenticated by HMAC instead.
2. Session cookie → `sessions` lookup by SHA-256 hash (SECURITY DEFINER) → `{userId, tenantId, role}`.
3. `requires('perm')` on the route.
4. Handler opens `tenantTx(tenantId, …)`; every query runs under RLS.
5. Audit row (where required) and outbox row are written inside the same transaction.

### Background job path

1. Claim: `SELECT … FROM claim_jobs($worker, $limit)` — a SECURITY DEFINER function that atomically marks up to N due jobs `running` across tenants and returns `(id, tenant_id, kind, resource_id)`. This is the fourth cross-tenant function (Phase 1 has three); it returns ids only, never business data.
2. Each job runs in `tenantTx(job.tenant_id, …)`, so the worker sees one tenant at a time under RLS.
3. Wake-up: the API does `NOTIFY jobs` after commit; workers also poll every 5 s as a fallback. This meets the 10 s stock-sync target (NFR) without Redis.
4. Retry: exponential backoff with jitter, max 8 attempts; 400/422 from Woo = `failed` (needs user fix, no retry); exhausted = `dead`. `Retry-After` respected.

## 3. Module boundaries

Rule (PRD 11.1): a module owns its tables. Other modules call its exported service functions, never its tables. Enforce with an ESLint `no-restricted-imports` rule: `modules/*/repo.ts` may only be imported from inside its own folder.

Folder per module: `apps/api/src/modules/<name>/{routes.ts, service.ts, repo.ts, schemas.ts}`. `schemas.ts` holds zod request/response schemas, which also generate the OpenAPI document.

| Module | Owns (tables) | Exposes (service functions other modules may call) | Calls | Emits (outbox kinds) | Stage |
|---|---|---|---|---|---|
| **auth** *(Phase 1)* | sessions, auth_tokens | `currentUser(req)` | — | — | done |
| **tenants** *(Phase 1 users + settings)* | tenants, plans, users, store_settings, invoice_series* | `getSettings()`, `assertSeatAvailable()` | audit | — | done (+ B5 series) |
| **audit** *(Phase 1)* | audit_events | `record(tx, event)` | — | — | done |
| **files** *(Phase 1 storage lib → module)* | files | `createUpload()`, `signedGet(key, ttl)`, `confirmUpload()` | — | `thumbnail` | B2 |
| **catalog** | categories, brands, units, products, product_variants, product_images, barcode_sequences, import_jobs | `getVariant()`, `findByCode(code)`, `assertSellable(variantId)`, `variantSnapshot()` | files, audit | `woo.product`, `woo.image` | B2 |
| **inventory** | locations, stock_balances, stock_ledger, stock_reservations, adjustments, transfers, stocktakes(+lines) | `post(tx, movements[])`, `reserve(tx, …)`, `release(tx, …)`, `convert(tx, …)`, `availability(variantIds)` | catalog (read), audit | `woo.stock` | B3 |
| **purchasing** | suppliers, purchase_orders(+lines), goods_receipts(+lines), supplier_returns(+lines) | `outstanding(variantId)` | inventory, catalog, audit | — | B3 |
| **woocommerce** | woo_connections, external_mappings, webhook_events (inbox), sync_jobs (outbox, shared runner) | `enqueue(tx, kind, resourceId)`, `connectionStatus()` | catalog, inventory, sales, fulfilment | — (it is the consumer) | B4 |
| **sales** | customers, sales_orders(+lines), payments, returns(+lines) | `applyWooOrder(tx, payload)`, `orderForFulfilment(id)` | inventory, invoicing, catalog, audit | `woo.stock` (via inventory) | B4 (Woo orders) / B5 (POS) |
| **invoicing** | invoices(+lines), credit_notes(+lines) | `issueInvoice(tx, source)`, `issueCreditNote(tx, invoiceId, lines)`, `computeTax(input)` (pure) | tenants (series, settings), files | `pdf` | B5 |
| **fulfilment** | pick_lists(+lines), shipments | `startPicking()`, `dispatch()` | inventory, sales | `woo.fulfilment` | B6 |
| **reports** | none (read-only SQL views/queries) | — | reads through views granted to erp_rt | `export` | B6 |
| **jobs** (shared runner) | sync_jobs table is owned by woocommerce; runner code is generic | `register(kind, handler)` | — | — | B2 |

\* `invoice_series` lives in tenants because it is configuration; only invoicing increments it.

Reports read across modules. That is allowed only through **SQL views** (`v_inventory_summary`, `v_stock_movements`, `v_sales_summary`, `v_sync_health`), which are the reporting contract. Views are `security_invoker = true` so RLS still applies.

### Invariants each module must hold

- **inventory** is the only writer of `stock_balances`, `stock_ledger`, `stock_reservations`. Every write locks the balance row (`SELECT … FOR UPDATE`) in a fixed order (sorted by `variant_id, location_id`) to avoid deadlocks on multi-line documents.
- **inventory.post** writes the ledger row and balance update in the caller's transaction; callers never commit a document without its movements.
- **invoicing** is the only writer of invoice numbers; it increments `invoice_series.next_number` under a row lock in the same transaction as the invoice insert (AC-20).
- **woocommerce** never changes stock directly; it calls `sales.applyWooOrder`, which calls `inventory.reserve/release`.
- Posted rows (`stock_ledger`, `invoices`, `credit_notes`, posted `goods_receipts`) have no UPDATE/DELETE grant for `erp_rt`.

## 4. Core flows (sequence)

**POS sale (B5)**, one transaction, idempotency key from the client:
`sales.createPosSale` → validate prices server-side → `inventory.post(sale movements)` → `invoicing.issueInvoice` → `payments` insert → `enqueue('woo.stock', variants)` → audit if discount/override → commit → respond with invoice id. PDF renders in the worker.

**Woo paid order (B4)**: webhook → verify HMAC → insert `webhook_events` (unique event key; duplicate = 200, no-op) → NOTIFY → worker → `sales.applyWooOrder` (ignores payloads older than stored `woo_modified_at`) → if trusted paid: `inventory.reserve` per line at online location, all-or-exception → order `ready_to_pick` or `stock_exception` → `enqueue('woo.stock')`.

**Dispatch (B6)**: `fulfilment.dispatch` → `inventory.convert(reservations)` (state `active` → `converted`, guarded by `WHERE state='active'`, so a second call is a no-op) → `shipments` insert → `enqueue('woo.fulfilment')`. UI shows "ERP fulfilled – website update pending" until that job is `done`.

**Product publish (B4)**: save in ERP → `enqueue('woo.product', productId)` → worker upserts product/variations using `external_mappings` (create only when no mapping exists, and even then search Woo by SKU first, so a crash between Woo's create and saving the mapping adopts the existing product instead of duplicating it, AC-02) → then `enqueue('woo.image')` per image. Woo pulls images from a **10-minute presigned S3 URL** because the bucket is private.

## 5. Build stages after this design

| Stage | PRD phase | Scope | Exit (PRD) |
|---|---|---|---|
| B2 | 2 | files module, jobs runner, catalog, barcodes, labels, CSV import/export | AC-03, AC-04, AC-17 |
| B3 | 3 | locations, ledger, balances, adjustments, transfers, stocktakes, suppliers, POs, receipts, supplier returns | AC-05, AC-06, AC-16, ledger reconciliation + concurrency tests |
| B4 | 4 | Woo connection, publish, webhooks, order import, reservation, stock sync, reconciliation | AC-02, 07, 08, 09, 11, 12 |
| B5 | 5 | POS, payments, GST, invoices, credit notes, returns, PDFs | AC-13, 14, 20 (tax examples signed off) |
| B6 | 6 | pick/pack/dispatch, reports, audit UI polish | AC-10, 15, 19 |
| B7 | 7 | security review, load test, restore drill, UAT | AC-01, AC-18, launch checklist |

Do not start B4 before B3's concurrency tests pass (PRD section 1).

## 6. What is deliberately left out

Platform-admin console (Phase 1 also deferred it; operators use audited SQL with a break-glass role until it exists), multi-store, accounting, offline POS, AI assistant (PRD 13, after B7), carrier integrations, e-invoicing.
