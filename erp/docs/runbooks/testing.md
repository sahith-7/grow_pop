# Testing

| Layer | Where | When | Pass means |
|---|---|---|---|
| Unit + integration (Vitest, real Postgres) | `apps/api/test`, CI job `api` | every push and pull request | all green |
| Store isolation (AC-01) | `b7-isolation.test.ts`: every route, as another store, by id | same | no route returns or changes another store's data |
| Row-level security, roles, definer functions, backup role | `b3-rls`, `b7-rls` | same | every store table has RLS + policy; no unexpected cross-store function; backup role reads all, writes nothing |
| Concurrency | `b7-concurrency.test.ts` | same | two tills, a till and a web order, two dispatches, two pick lists: never double-sold, never double-dispatched |
| Dependencies | CI job `audit`: `npm audit --omit=dev --audit-level=high` | same | no high/critical advisories in runtime packages |
| Secrets in git | CI job `audit`: gitleaks over the whole history | same | nothing found |
| Images | CI job `images`: Trivy on both images | same | no fixable HIGH/CRITICAL |
| Browser (Playwright) | `tests/e2e`, workflow `e2e` | after each staging deploy, or by hand | counter sale + return, phone layout, account page, console suspend → pay → active |
| Load (k6) | `tests/load/pos-load.js` | before launch, then before big releases | p95 < 500 ms for reads and writes, < 1% failed |
| Web scan (OWASP ZAP baseline) | workflow `zap` | weekly on staging | read the report; nothing new above Low |
| Restore drill | backup-restore.md | before launch, then quarterly | restored within 4 hours, integrity OK |

## Locally

```sh
npm test                                           # needs DATABASE_URL and MIGRATION_DATABASE_URL, as CI sets them
cd tests/e2e && npm ci && npx playwright install chromium && npx playwright test   # app running on :3000
```

CI migrates and runs as `erp_mig`, a non-superuser owner like RDS's master user (D77), because a superuser ignores
row-level security and once hid a production-only bug (D74). Test assertions that must read across stores use
`TEST_SUPERUSER_URL`. To reproduce locally:

```sql
CREATE ROLE erp_mig LOGIN CREATEROLE PASSWORD 'mig';
CREATE DATABASE erp_ci OWNER erp_mig;
```
then `MIGRATION_DATABASE_URL=postgres://erp_mig:mig@localhost:5432/erp_ci`,
`DATABASE_URL=postgres://erp_app:runtime@localhost:5432/erp_ci`,
`TEST_SUPERUSER_URL=postgres://postgres:<pw>@localhost:5432/erp_ci`.

## Browser tests on staging

Set repository variable `E2E_BASE_URL` (staging's URL) and, for the console test, secrets `E2E_ADMIN_EMAIL`,
`E2E_ADMIN_PASSWORD`, `E2E_ADMIN_TOTP_SECRET` for a console account that **exists only on staging**. The tests sign up
new stores each run; that's why they never run against production.

## Load test

Through Cloudflare, every request from your machine has your one address, so 100 simulated people share one rate-limit
budget (1,200 a minute per address, D75) and you'd measure the limit, not the app. Run it **on the staging server**,
straight at web:

```sh
# Session Manager on the staging server
docker run --rm --network erp_default -v /opt/erp/load:/s:ro grafana/k6 run \
  -e BASE_URL=http://web:3000 -e ORIGIN=https://<staging domain> /s/pos-load.js
```
(copy `tests/load/pos-load.js` to `/opt/erp/load/` first). It signs up 20 test stores. Staging is a t4g.small, half of
production's t4g.medium, so passing there is a safe margin.

B7 harness result (not AWS, 20 products per store): 87,748 requests in 5 minutes, 0% failed, read p95 17.7 ms, write
p95 44.4 ms. The staging run is the one that counts.

## ZAP

The weekly scan is passive: it browses staging and reads the responses. It reports missing headers, cookie flags,
information leaks. To silence an accepted finding or make one fail the job, list it in `.zap/rules.tsv`
(`<rule id>\tIGNORE\t<reason>` or `FAIL`).
