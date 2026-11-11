# Checking that B7 works

> **GroPop:** these click-throughs were written per build stage. GroPop already contains every stage, so skip the install, copy and commit steps (they point to INSTALL files that no longer exist), then work through the rest. Use the store you created in INSTALL-GROPOP section 4.

Work through the steps in order. Each step says what you should see. The first time something looks different, stop
and send me what the step's **If not** line asks for.

Sections A–G run on your laptop. Section H is for staging once you have set it up (docs/runbooks/production-setup.md).

## A. Install

**1. Install B7** with [INSTALL-B7.md](INSTALL-B7.md) steps 1–9.

**2. Tests.** `npm test`. You should see every test file marked ✓, including 6 new `b7-*` files (29 tests).
If not: send me the names of the failing tests and their error text.

## B. A store's Account page

**3. Menu.** Sign in as an owner. You should see **Account** in the menu. Sign in as a cashier or manager in another
browser: no Account item.

**4. Account page.** Open **Account** as the owner. You should see:
- the store's state **Trial** and when it ends (90 days from the install for existing stores)
- your 6-character store code
- the plans table (Store, Store + Online) with monthly and yearly prices
- **How to pay**, with your `BILLING_UPI_ID` and the store code to put in the note
- **Download all your data**, **Support access**, and the payment history (empty)
If not: a screenshot.

**5. Getting started.** Open **Dashboard**. Above the tiles you should see a Getting started checklist (store details,
billing, products, barcodes, shop, staff, first sale) with the steps you've already done ticked. **Hide** removes it in
that browser.

**6. Security headers.** In Chrome, open DevTools (F12) → Console, then visit Dashboard, Products, POS, Account,
Reports, Settings, Team and the audit log. You should see **no** red "Content Security Policy" errors.
If not: copy the first error line. (A page of yours that loads fonts or scripts from another site will show up here.)

**7. Phone.** DevTools → device toolbar → 390 px wide. Open Dashboard and Account. Nothing should need sideways
scrolling. Below 860 px the side menu folds behind a **Menu** button.
If not: a screenshot, and tell me which part sticks out.

## C. The console

**8. Sign in.** `http://localhost:3000/platform`, with the account from INSTALL step 8. A wrong code: "E-mail,
password or code is wrong". A code used once can't be used again.

**9. Find the store.** **Stores** lists every store with state, plan and owner email. Search by the store code from step 4.

**10. Suspend.** Open the store → **Change state or plan** → **Make read-only (suspend)**, reason "test". In the store's
browser, reload: a red banner says the store is read-only. Try to save a product change: refused with a message. The POS
shows the same banner and refuses a sale. Viewing still works, and so do Account → Download all your data.

**11. Reactivate without paying.** In the console the **Reactivate** choice is not offered (the store has no paid time).

**12. Record a payment.** Console → the store → **Record a payment**: method UPI, amount 999, reference `TEST-UTR-1`,
months 1, plan Store. The store becomes **Active**, paid until a month from today. Recording `TEST-UTR-1` again is refused.
In the store's browser, reload: no banner; Account shows the payment with a receipt number like `R-000001`.

**13. Plan limit.** The store is now on Store (no online shop). Settings → WooCommerce (or wherever your shop
connection is): connecting is refused: "Your plan does not include the online shop." If the shop was already connected, its sync
pauses; it resumes when you change the plan to Store + Online in the console (**Change plan without a payment**).

**14. Console log.** **Console log** lists every step above with your email and address.

## D. Support access

**15. Not allowed yet.** Console → the store → **Support view**: refused, "The store owner has not given support access, or it has run out."

**16. Allow.** As the owner: Account → Support access → **Allow support access** for 2 hours, reason "test". Console →
**Support view** now shows counts, sync and job state and recent actions.

**17. The owner sees it.** In the store, the audit log shows `support.viewed` with your console email. Account →
Support access lists the look. **Stop access now** ends it; the console's Support view is refused again.

## E. Data export

**18.** Account → **Prepare a download**. Within a minute it shows **Download**. The ZIP opens in Excel: `README.txt`
plus one CSV per kind of record. `users.csv` has no password column; there is no `sessions.csv`. A fourth export in one
day is refused.
If not: `docker compose logs worker --tail 50`.

## F. Store states over time (optional, needs psql)

**19.** To see the ticker move a store along without waiting 30 days, as the owner role:
```sql
UPDATE subscriptions SET trial_ends_at = now() - interval '1 minute' WHERE store_code = '<code>';
```
Within 10 minutes the store shows **Payment due** with a banner, and the owner gets an email (or the worker log says the
email couldn't be sent if `SMTP_URL` isn't set).

## G. CI

**20.** GitHub → Actions → the B7 push: `api`, `web`, `audit`, `images` green.

## H. On staging (after production-setup.md)

**21. Deploy.** A push to `main` runs **deploy**; its last log lines say `deployed <sha> to staging`.

**22. Real address.** Sign in to the console on staging; **Console log** shows your own public address, not 10.x or 172.x.

**23. Backup.** `systemctl start erp-backup` on the server, then the file is in the backup bucket.

**24. Restore drill.** docs/runbooks/backup-restore.md, timed, logged.

**25. Browser tests and load test.** docs/runbooks/testing.md.

**26. Website.** Cloudflare Pages shows the site; every "[to be filled]" marker is gone (a release build refuses to run
until they are); the demo form opens WhatsApp with your details filled in.
