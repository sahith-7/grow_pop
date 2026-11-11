# GroPop

Retail ERP for Indian stores as a multi-store SaaS: counter billing with GST invoices, products and barcodes, stock and
purchasing, stocktakes, WooCommerce sync with web orders, picking and dispatch, reports, plans and billing, and a
platform console. Stack: Fastify + TypeScript + PostgreSQL (row-level security) for the API, Next.js for the web app.

## Run it on your laptop

```
cp .env.example .env          # set the two passwords; add WOO_ENC_KEY (openssl rand -base64 32)
npm install                   # once, and after any package.json change (writes package-lock.json)
docker compose up --build -d  # web on http://localhost:3000
docker compose logs migrate   # should end with "applied 0700_owner_totp.sql"
```

Open http://localhost:3000/register and create a store. Always start the stack with `docker compose up -d` and no
service name, so the background worker starts too.

Tests need a Postgres with the roles from `docker/initdb.sh` (see `docs/runbooks/testing.md`), then
`npm run typecheck`, `npm run build -w apps/api`, `npm run migrate -w apps/api`, `npm test`.

## Layout

```
apps/api/migrations   SQL migrations 001 → 0700, applied in order by the owner role (never edit an applied one)
apps/api/src          config, db, server, worker; lib/ (session, permissions, audit, crypto, totp, secret-box, …);
                      modules/ (auth, users, settings, audit, catalog, imports, inventory, purchasing, woocommerce,
                      sales, pos, billing, returns, fulfilment, reports, account, platform, saas)
apps/api/test         232 API tests: isolation, permissions, sign-in, GST, stock, sync, concurrency
apps/web/app          (auth)/[mode] sign-in pages; (app)/ the store app; pos/ the counter; pick/; platform/ console
apps/web/src/styles   design tokens and components (the only place colours and fonts live)
docs/                 decisions.md (D1–D86), design/, api/, runbooks/ (production setup, backups, incidents, …)
ops/                  deploy, backup and integrity scripts for the AWS server
site/                 the public website (Cloudflare Pages)
tests/e2e, tests/load browser tests (Playwright) and a load test (k6)
```

## Security model, in short

- Every store's rows are fenced by Postgres row-level security keyed on `app.tenant_id`, set per transaction. The
  runtime role owns no table, so a missing `WHERE` cannot leak another store's data.
- Sessions are random tokens in an HttpOnly, SameSite=Lax, `__Host-` cookie (only the SHA-256 is stored), 12-hour
  sliding expiry. Passwords are argon2id. Accounts lock after 5 wrong passwords; sign-in routes have per-address limits.
- Owners also need an authenticator code (D83). The platform console needs a password and a code, and sits behind
  Cloudflare Access in production.
- Every non-GET request must come from the app's own origin (CSRF). The browser only talks to the web origin; `/api`
  is proxied, so there is no CORS.
- Permissions are checked by the API on every route. The menu only hides what a role can't use.
- Audit rows are written in the same transaction as the change and can't be edited by the app.
- Tax documents and the stock ledger are append-only by database grants.

What is decided and why: `docs/decisions.md`. Deploying: `docs/runbooks/production-setup.md`.
