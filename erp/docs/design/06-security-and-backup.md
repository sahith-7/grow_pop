# 06 · Security and backup plan

Builds on the Phase 1 controls (RLS, argon2id, opaque cookie sessions, Origin check, helmet, rate limits, audit in-transaction, private S3, read-only non-root containers). This file covers what Phase 2+ adds and what must exist before go-live (PRD 14.1, 15.1, 17.1).

## 1. Threats introduced by the new modules, and the control for each

| # | Threat | Where | Control |
|---|---|---|---|
| T1 | Cross-tenant read/write via guessed ids, exports, reports | all modules | RLS + composite FKs + 404 on foreign ids; reports are `security_invoker` views; export jobs run in `tenantTx`. AC-01 test suite runs every list/detail/export endpoint as tenant B against tenant A's ids. |
| T2 | **SSRF via the WooCommerce site URL** (tenant-controlled host our server calls) | woocommerce | HTTPS only, port 443 only; resolve DNS ourselves and reject private, loopback, link-local, CGNAT and metadata ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, ::1, fc00::/7); connect to the **resolved IP** (prevents DNS rebinding); no redirects followed; 10 s timeout; 5 MB response cap. Same guard for every Woo call, not just `/test`. |
| T3 | Forged or replayed webhooks | woocommerce | Unguessable endpoint token (hash stored), HMAC over raw body with constant-time compare, event-key uniqueness (replay = no-op, AC-08), per-token rate limit, invalid signature audited and alerted (PRD 17.1). |
| T4 | Woo credentials leak | woocommerce | AES-256-GCM envelope encryption: per-record data key, wrapped by a KMS key (AWS KMS `ap-south-1` or equivalent). Decrypted only inside the worker/API process for the call; never returned by the API (`keyHint` only), never logged (pino redact paths for `consumerKey`, `consumerSecret`, `authorization`, `oauth_*`). Rotate on disconnect, user revoke of an owner, or suspected exposure. |
| T5 | Malicious file upload (XSS via SVG, polyglots, zip bombs, CSV formula injection) | files, imports, exports | Allow-list JPEG/PNG/WebP only for images (no SVG); verify magic bytes server-side; re-encode images when creating thumbnails (strips EXIF/GPS and payloads); size caps enforced by presigned PUT conditions; downloads served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`; CSV exports prefix cells starting with `= + - @ \t \r` with `'`; XLSX import parsed with a streaming reader, row cap 20k. |
| T6 | Cost/price leakage to cashiers | catalog, reports | Response serializer strips cost fields without `cost.view`; tested per role (AC-15). |
| T7 | Stock or invoice tampering | inventory, invoicing | Append-only tables (no UPDATE/DELETE grant), reversal-only corrections, `invoice_series` row lock, nightly ledger/balance check with alert. |
| T8 | Double-submission / race | POS, dispatch, reservation | Idempotency keys, row locks in fixed order, `WHERE state='active'` guarded transitions; concurrency tests AC-07/08/09/10/20. |
| T9 | Price manipulation from the client | POS | Server prices every line; client total only compared (`PRICE_CHANGED`). |
| T10 | Abuse of expensive endpoints | exports, reports, lookup | Per-tenant limits (conventions.md), statement timeout 5 s for API role, 60 s for worker role. |
| T11 | Webhook processing as a privilege bridge | worker | Worker runs as `erp_app` under RLS; the two cross-tenant functions return ids only. |
| T12 | PII over-collection | sales | Store only name, phone, email, addresses, GSTIN; never card data (Woo payment reference only). Raw webhook payloads purged at 90 days. |
| T13 | Barcode/label print injection | labels | Labels rendered as text nodes in React; no HTML from data. |

### Headers and browser
Phase 1 helmet defaults plus a strict CSP on the web app: `default-src 'self'; img-src 'self' https://<bucket-host> data:; script-src 'self' 'nonce-…'; connect-src 'self'; frame-ancestors 'none'`. Images are shown through signed URLs from the bucket host only.

### Supply chain and CI (extends Phase 1 `ci.yml`)
- Keep `npm audit --omit=dev --audit-level=high`. Add: `gitleaks` on every push; Dependabot weekly; `trivy image` scan on the built API and web images with HIGH/CRITICAL failing the build.
- New CI checks from this design: route-permission test, SECURITY DEFINER allow-list grep, OpenAPI drift check, RLS check (every table in `public` with a `tenant_id` column has RLS enabled and forced, queried from `pg_class`).
- Pin GitHub Actions by commit SHA.

### Secrets handling
- The `.env` file you uploaded alongside `.env.example` contains real passwords. Even if they are local-only, do not commit it, rotate any value that was reused anywhere else, and use the platform's secret manager for staging and production. None of those values were copied into this pack.
- Production secrets: DB passwords, SMTP URL, S3 keys, KMS key id. Each environment has its own; nothing shared between staging and production.

## 2. Authentication additions

Phase 1 deferred MFA. Recommend **TOTP MFA required for the Owner role before go-live** (owner can connect integrations, export everything and void invoices). Optional for others. Recovery codes hashed like passwords. This is the only auth change in scope; it can ship in B7.

## 3. Backup and restore

Targets: PRD planning targets are RPO ≤ 24 h and RTO ≤ 8 h. Recommend tighter **RPO ≤ 5 min, RTO ≤ 4 h**, because managed Postgres gives point-in-time recovery for roughly the same cost as nightly dumps, and losing up to a day of sales and invoices for a retailer is worse than the PRD target implies. Product owner decides (D11).

| Asset | Method | Frequency / retention | Notes |
|---|---|---|---|
| PostgreSQL | Managed service PITR (continuous WAL) | 7–14 days PITR window | Primary recovery path |
| PostgreSQL | Logical dump (`pg_dump -Fc`) to a **separate account/bucket**, encrypted, object-lock (WORM) | Daily, keep 35 daily + 12 monthly | Protects against account compromise or provider-level deletion; also feeds the restore drill |
| S3 media/PDFs | Bucket versioning + lifecycle (non-current versions 30 days) + cross-region replication | Continuous | Invoice PDFs can be re-rendered from snapshots, so images are the irreplaceable part |
| Imports/exports | Not backed up | Expire after 7 days | Transient |
| Config/secrets | Secret manager versioning | — | KMS key has deletion protection (30-day window) |
| Code/migrations | Git | — | Already |

Encryption: storage encryption at rest on DB and bucket (provider KMS); TLS in transit, including API→DB (`sslmode=verify-full` in production; Phase 1 compose is plain TCP on an internal network, which is fine locally only).

### Restore drill (AC-18), quarterly and before launch
1. Restore the latest daily dump into a fresh staging database; run `migrate` (should be a no-op).
2. Point a staging API at it with a staging bucket restored to the same timestamp.
3. Run the integrity script: row counts per table vs production snapshot, ledger/balance reconciliation query returns zero rows, every `product_images.file_id` and `invoices.pdf_file_id` resolves to an existing object.
4. Record time taken (must be under RTO) and data age (under RPO) in `docs/runbooks.md`. A backup that has never been restored does not count (SRS 4.12).

### Tenant-level restore
Full-database PITR rewinds every tenant. For one tenant's mistake, restore to a side database and copy that tenant's rows back with a reviewed script. Never PITR production for a single tenant.

## 4. Retention

| Data | Retention | Reason |
|---|---|---|
| Invoices, credit notes, ledger, payments | ≥ 8 years after the financial year ends | Indian GST record-keeping (72 months from the annual return due date, longer under appeal) — confirm with tax adviser |
| Audit events | 3 years online, then archive to cold storage | Security investigations |
| Webhook payloads | 90 days | Debugging only; contain customer PII |
| Done sync jobs | 30 days | |
| Sessions | Phase 1 (30-day cap) | |
| Closed tenant data | Export window 30 days, then delete except tax records kept under the row above | D13 |

## 5. Monitoring and alerts (PRD 17.1, made concrete)

| Signal | Alert when | Severity |
|---|---|---|
| Pending `woo.stock` jobs, oldest age | > 5 min while jobs pending | high |
| High-priority job wait | > 60 s | medium |
| Dead jobs | any new | medium |
| Webhook signature failures | > 10 in 5 min per tenant | high (security) |
| Ledger/balance mismatch (nightly) | any row | critical |
| Negative sellable balance without override | any | critical |
| Backup job | missed or failed | critical |
| API 5xx rate | > 1% over 5 min | high |
| API p95 latency (list/detail) | > 500 ms over 15 min | medium |
| DB storage / connections | > 80% | medium |

Logs: pino JSON with `correlationId`, `tenantId`, `userId`, never bodies of auth/webhook requests. Ship to a managed log store with 30-day retention.

## 6. Operational access and incident response

- Production DB: no human logins day-to-day. Break-glass `erp_support` role (04 §1) with ticket id, 2-hour window, pgaudit on.
- Access review monthly: who has cloud console, DB, secret-manager access.
- Incident steps (write into `docs/runbooks.md` in B7): detect → contain (revoke sessions, rotate keys, pause workers with a feature flag) → assess which tenants are affected using `audit_events` and logs → notify affected tenants. Under India's CERT-In directions, reportable cyber incidents must be reported within 6 hours of noticing them; confirm obligations with counsel before launch.
- Woo credential compromise runbook: disconnect (deletes webhooks and secrets), ask the tenant to revoke the key in WooCommerce, reconnect with a new key.

## 7. Go-live security checklist (B7)

- [ ] AC-01 isolation suite green, including exports and reports
- [ ] Route-permission and RLS checks green in CI
- [ ] External penetration test or at minimum OWASP ZAP baseline against staging, no high findings
- [ ] Owner MFA live
- [ ] KMS-wrapped Woo secrets; no plaintext secret in DB, logs or repo (gitleaks clean)
- [ ] TLS to DB verified; API not publicly reachable
- [ ] PITR enabled; daily off-account dumps landing; restore drill done and recorded
- [ ] Alerts above wired to a person (named owner, D11)
- [ ] Privacy notice and data-processing terms for tenants (India DPDP Act applies to customer personal data)
