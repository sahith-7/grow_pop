# 05 · API conventions

The machine-readable contract is `openapi.yaml` (OpenAPI 3.1, 91 operations, validated with Redocly). This page holds the rules every endpoint follows.

## Base, auth, tenancy
- Browser path `/api/v1/...`; Next.js proxies to the API's `/v1/...` on the internal network (Phase 1). No CORS.
- Auth is the Phase 1 `__Host-` session cookie. Webhooks are the only unauthenticated writes and use HMAC.
- Tenant id never appears in any request. Ids from another tenant return **404**.
- Every operation has `x-permission`; CI fails if a route lacks `requires()`.

## Shapes
- JSON, camelCase fields. Money and quantities are **decimal strings** (`"1299.00"`, `"2.500"`); never JSON numbers.
- Timestamps ISO-8601 UTC (`2026-10-12T10:00:00Z`); dates `YYYY-MM-DD` interpreted in the tenant timezone.
- Lists: `?limit=` (≤100, default 25) and `?cursor=`; response `{ items, nextCursor }`. Cursor is opaque (base64 of last sort key + id). No offset pagination: it is slow on the ledger and unstable under inserts.
- Request schemas are zod; unknown fields are rejected (400), not ignored, so typos fail loudly.

## Writes
- **Idempotency-Key** (UUID) header: required on POS sale, return, dispatch, invoice void; optional on other creates. Stored in `idempotency_keys (tenant_id, key, request_hash, response, created_at)` for 24 h. Same key + same body → original response; same key + different body → 422 `IDEMPOTENCY_KEY_REUSED`.
- **Optimistic concurrency** on editable records (products, variants, POs): responses carry `ETag: "<version>"`; PATCH sends `If-Match`; stale → 412 `VERSION_CONFLICT`.
- **Commands** are explicit sub-resources (`/submit`, `/post`, `/dispatch`) rather than PATCHing a status field, so each transition has its own permission and audit entry.
- Server computes every total, tax and stock figure. Client-sent totals are only used for the `expectedTotal` check at POS (409 `PRICE_CHANGED`).

## Error envelope (Phase 1 shape, unchanged)
```json
{ "code": "INSUFFICIENT_STOCK", "message": "Only 2 available at Shop floor",
  "fieldErrors": { "lines.0.qty": ["exceeds available 2"] },
  "correlationId": "c0a8…", "retryable": false }
```

| HTTP | code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | schema/field errors (`fieldErrors` set) |
| 401 | `UNAUTHENTICATED` | no/expired session |
| 401 | `WEBHOOK_SIGNATURE_INVALID` | bad HMAC |
| 403 | `FORBIDDEN` | missing permission |
| 403 | `CSRF_REJECTED` | Phase 1 origin check |
| 403 | `DISCOUNT_LIMIT` | discount above role limit |
| 403 | `TENANT_SUSPENDED` | write while suspended |
| 404 | `NOT_FOUND` | missing or other tenant's id |
| 409 | `SKU_DUPLICATE`, `BARCODE_DUPLICATE` | catalog uniqueness |
| 409 | `INSUFFICIENT_STOCK` | would breach sellable/reserved |
| 409 | `INVALID_STATE` | transition not allowed from current status |
| 409 | `PRICE_CHANGED` | POS total mismatch |
| 409 | `PICK_MISMATCH` | wrong item or over-pick |
| 409 | `RETURN_EXCEEDS_SOLD` | return qty too high |
| 409 | `SEAT_LIMIT` | plan seats used |
| 412 | `VERSION_CONFLICT` | stale If-Match |
| 422 | `IDEMPOTENCY_KEY_REUSED` | key reused with different body |
| 429 | `RATE_LIMITED` | Phase 1 limiter |
| 502 | `WOOCOMMERCE_UNAVAILABLE` | only on synchronous `/test`; `retryable: true` |
| 503 | `WOOCOMMERCE_RATE_LIMITED` | only on synchronous calls; `retryable: true` |
| 500 | `INTERNAL_ERROR` | anything else; message is generic |

`SYNC_RETRY_PENDING` from the PRD is a **job state**, not an HTTP error: the API never blocks a user write on WooCommerce, so it surfaces as `webUpdatePending` / `publishState` on resources.

## Rate limits (per Phase 1 limiter; move to Redis when >1 API instance)
| Scope | Limit |
|---|---|
| Default per session | 300/min (Phase 1) |
| Auth endpoints per IP | Phase 1 values |
| Webhook per endpoint token | 600/min, burst 100 |
| Exports and report CSV per tenant | 10/hour |
| `/lookup` per session | 1200/min (scanners are fast) |
| `/integrations/woocommerce/test` per tenant | 10/hour |

## Webhooks (inbound)
1. Path token → `woo_endpoint_lookup()` → tenant (404 with empty body if unknown).
2. Read raw body (Fastify `addContentTypeParser` with `parseAs: 'buffer'` for this route only; max 1 MB). The Next.js proxy must pass the body through unmodified.
3. `timingSafeEqual(base64(HMAC_SHA256(secret, raw)), header)`.
4. `event_key = topic + ':' + resource id + ':' + date_modified_gmt` (fallback delivery id). Insert into `webhook_events`; unique violation = duplicate → 200.
5. `NOTIFY jobs`; respond 200. All business logic runs in the worker.

## Versioning
`/v1` stays backward compatible: add fields and endpoints freely; never remove or retype a field. Breaking change = `/v2` route for that resource, both served for at least one release. The OpenAPI file is generated from zod schemas at build and diffed in CI against the committed one; an unexpected diff fails the build.
