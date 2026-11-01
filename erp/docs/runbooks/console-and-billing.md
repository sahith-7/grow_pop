# Console, billing and store states

The console is at `https://app.<your domain>/platform`. It is for you (and anyone who later helps you run the service),
never for stores. It has its own accounts, separate from store logins.

## 1. Console accounts

The app's database role cannot create console accounts; only the migration role can, from the server.

**Local (docker compose on your laptop):**
```sh
docker compose run --rm migrate node dist/scripts/platform-admin.js add you@example.com "Your Name"
```

**Staging or production** (Session Manager on the server). Use `docker run`, not `docker compose run`: compose would
send the output, which includes the authenticator key, to CloudWatch.
```sh
sudo -i
cd /opt/erp && . ./.env
docker run --rm -it --env-file app.env --env-file migrate.env -v /opt/erp/certs:/certs:ro \
  "$ERP_REGISTRY/erp-api:$ERP_TAG" node dist/scripts/platform-admin.js add you@example.com "Your Name"
```

It asks for a password twice (at least 14 characters; use your password manager) and prints a setup key and an
`otpauth://` link. Add it to an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Aegis),
then clear the terminal. Other commands, same way: `reset-code <email>` (lost phone), `password <email>`,
`disable <email>`, `enable <email>`, `list`.

Sign-in: email, password and a fresh 6-digit code. Five wrong attempts lock the account for 15 minutes. A session lasts
8 hours at most and ends after 30 idle minutes. Every action is in the console's Log page, with your address.

## 2. Store states (D67, D68)

| State | How a store gets there | What the store can do |
|---|---|---|
| trial | Signing up (30 days). Stores that existed before B7 got 90 days | Everything; plan Store + Online features included |
| active | You record a payment | Everything its plan allows |
| past_due | Trial or paid period ended (the ticker checks every 10 minutes) | Everything, with a red banner; owner gets an email |
| suspended | 7 days in past_due, or you suspend it | Read-only: sees everything, can export, can't change anything. Web orders still arrive and wait |
| closed | Only you, by hand | Can sign in, see the banner and the Account page, and export. Nothing else; webhooks get 410 |

Nothing closes a store automatically. Owners get reminders 7 days and 1 day before a trial or paid period ends.

## 3. Recording a UPI payment (D69)

Owners see your UPI ID, payee name and the plan prices on their Account page, with their 6-character store code (e.g. `4F7K2Q`)
to put in the payment note.

1. Check the money arrived in your bank or UPI app. Note the UTR (UPI transaction reference).
2. Console → Stores → search the store code → Record payment: amount, method UPI, reference = the UTR, paid on, months
   (1 or 12), plan.
3. The store becomes active at once; its paid period runs from the later of today and its current paid-until date, so
   paying early never loses days. The owner can see a receipt number (`R-000001`) on their Account page.

The same UTR can't be recorded twice. A mistake can't be edited: record what happened in the store's notes and ask for a
correction feature if it becomes common.

**Receipts are not GST invoices.** While your turnover is under the GST registration threshold, a receipt is enough. Once
you register for GST you must issue tax invoices for subscriptions (SAC 998314 or as your CA advises); that is not built.
Ask your CA before you register.

## 4. Other changes

- **Extend a trial**: Store → Trial ends → a date (the trial ends at the end of that day, India time). Needs a reason.
- **Change plan** without a payment (a downgrade, or a goodwill upgrade): Store → Plan. Needs a reason.
- **Suspend** (e.g. a chargeback or abuse): Store → Action, with a reason. **Reactivate** is offered only while the store
  still has paid time left; otherwise record a payment, or set a trial end date as a goodwill gesture.
- **Close**: only when the owner asks, or months after suspension. First tell the owner to download their export
  (Account → Data export): they can still do that after closing.

## 5. Support access (D71)

You can't see inside a store unless its owner allows it: Account → Support access → "Allow access" for 1 to 72 hours
with a reason. Then Console → Store → Support view shows read-only diagnostics (record counts, sync and job state). Each
look is written to the console log **and** to the store's own audit log, so the owner sees it. The owner can end access
at any time. There is no way to sign in as a store user, by design.

## 6. Closed stores and deletion

Plan: closed stores are exported and then deleted after 30 days, except tax records (invoices, credit notes, payments,
ledger), which GST law requires you to keep for at least 72 months after the annual return's due date. **Deletion is not
built yet.** Until it is, a closed store's data stays in the database, readable by no one but its owner's export.
Ask for it to be built before the first store closes, and have your lawyer confirm the retention periods in your
Privacy Policy.
