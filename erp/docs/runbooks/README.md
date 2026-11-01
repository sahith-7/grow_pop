# Runbooks

What to do, step by step, when running the service. Written for one person running it alone; every step says where.

| Runbook | Use it when |
|---|---|
| [production-setup.md](production-setup.md) | Setting up AWS, Cloudflare and GitHub for staging, then again for production |
| [console-and-billing.md](console-and-billing.md) | Creating console accounts, recording a store's UPI payment, support access, suspending or closing a store |
| [backup-restore.md](backup-restore.md) | The nightly backup, the restore drill (before launch, then every quarter), restoring one store's data |
| [rollback.md](rollback.md) | A release is bad |
| [incident-response.md](incident-response.md) | Something may have leaked or been broken into (CERT-In: report within 6 hours) |
| [testing.md](testing.md) | Running the test layers: CI, browser tests, load test, ZAP, secret and image scans |
| [launch-checklist.md](launch-checklist.md) | Before the first paying store, and before each later big release |

Scripts these refer to live in `ops/` (deploy, backup, integrity check) and `.github/workflows/`.
