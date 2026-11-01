# Backups and the restore drill

Target: lose at most 5 minutes of data, and be running again within 4 hours. A backup that has never been restored
does not count, so the drill below runs **before launch and then every quarter**, and its times go in the log at the
bottom of this file.

## The three layers

| Layer | What | Kept | Protects against |
|---|---|---|---|
| 1. RDS point-in-time recovery | AWS streams every change | 14 days | Bad deploy, accidental delete, corruption |
| 2. Nightly `pg_dump` (ops/backup.sh) | Whole database, to the backup account, Object Lock | 35 daily + 12 monthly | This AWS account hacked or closed |
| 3. S3 versioning (+ replica later) | Product images, import files, exports | Old versions 30 days | Files deleted or overwritten |

**Why the dump runs as `erp_dump` (D79).** On RDS no role can bypass row-level security, and FORCE RLS hides rows from
the table owner too, so `pg_dump` as the owner fails with "query would be affected by row-level security policy". The
`erp_backup` role has SELECT on everything and a read-only "see every row" policy on every RLS table; `erp_dump` logs
in as it, and `pg_dump --enable-row-security` then reads all stores. A test fails CI if a new table is not readable by
it (`SELECT erp_backup_grants();` at the end of every migration that creates tables).

Checked in the B7 harness: dump as `erp_dump`, restore into an empty database as a non-superuser owner, integrity
script passes and every row count matches.

## Every morning (one minute)

Your uptime monitor's heartbeat for the backup did not alert. If it did: `journalctl -u erp-backup -n 50` on the server
(Session Manager). A missed night is a critical incident only if it happens twice in a row.

## Restore drill (before launch, then every quarter)

Start a timer. Write down each step's time.

1. **Pick the dump.** Sign in to the **backup account**. S3 → the backup bucket → `daily/` → yesterday's file →
   Download (or `aws s3 cp` from your laptop with backup-account credentials).
2. **Make an empty database** on the staging RDS (never production):
   ```sql
   CREATE DATABASE erp_drill;   -- as the staging master user
   ```
   The roles `erp_rt`, `erp_app`, `erp_backup` already exist there. On a brand new instance, create them first
   (production-setup.md §3).
3. **Restore** (from the staging server, Session Manager; copy the dump there with `aws s3 cp` or Session Manager file
   transfer):
   ```sh
   docker run --rm -i -v /opt/erp/certs:/certs:ro -v "$PWD:/in:ro" postgres:16 \
     pg_restore --no-owner --exit-on-error -d "postgres://erp_owner:<pw>@<staging endpoint>:5432/erp_drill?sslmode=verify-full&sslrootcert=/certs/rds-ca.pem" /in/erp-YYYY-MM-DD.dump
   ```
4. **Migrations change nothing**: point a one-off migrate at `erp_drill` (as in console-and-billing.md §1, with
   `node dist/migrate.js` and `MIGRATION_DATABASE_URL` set to erp_drill); it must report no new migrations.
5. **Integrity**: `psql "<erp_drill as erp_owner>" -v ON_ERROR_STOP=1 -f ops/integrity.sql` must print
   `integrity OK`. Run the same script against production (read-only, safe at a quiet hour) and compare the row counts:
   production may be higher by one night's work, never lower.
6. **Files**: the script wrote `files-in-db.txt`. Compare with the bucket:
   ```sh
   aws s3 ls s3://<app-bucket> --recursive | awk '{print $4}' | sort > files-in-s3.txt
   sort files-in-db.txt | comm -23 - files-in-s3.txt     # must print nothing
   ```
7. **The app runs on it**: temporarily point staging's `app/DATABASE_URL` at `erp_drill` and redeploy staging. Sign in
   to the console (not as a store: you don't have stores' passwords and must not), open the store list, and compare
   the store count and a few stores' last activity dates with production. Staging's ticker will send real emails to
   real owners from this copy, so set staging's `app/SMTP_URL` to an invalid value first. Staging can't talk to real
   shops because its `WOO_ENC_KEY` differs from production's, so the saved shop keys don't decrypt there. Never copy
   production's key to staging.
8. Stop the timer. Put staging back, `DROP DATABASE erp_drill;`, delete the downloaded dump from the server.

Over 4 hours means the plan is wrong: write down which step was slow and fix that before launch.

## Restoring production for real

**Never rewind the whole production database for one store's mistake.** Everyone else would lose their work since then.

- **One store deleted or broke something**: restore point-in-time (RDS → Restore to point in time) to a **new**
  instance at a time before the mistake, then copy that store's affected rows back by hand, in a transaction, as the
  owner role with `SET app.tenant_id`. Ask for help writing that SQL; it is easy to get wrong.
- **Whole database lost or corrupted**: RDS point-in-time restore to a new instance at the last good minute → change
  `app/DATABASE_URL`, `migrate/MIGRATION_DATABASE_URL`, `backup/DATABASE_URL` to the new endpoint → redeploy.
- **AWS account lost**: new account, follow production-setup.md, restore the newest dump from the backup account
  (steps 2–5 above, into the new production database).

After any real restore: incident-response.md applies if data was lost, and stores must be told what period to re-enter.

## Drill log

| Date | Dump date | Restore time | Integrity | Files | Total time | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |
