# Launch checklist (before the first paying store)

Tick each line with the date. A line you decide to skip gets a reason, not a blank.

## Code

- [ ] TRIDENT committed to its own repository; CI green on `main` (api, web, audit, images)
- [ ] INSTALL-TRIDENT section 4 click-through done on staging, not only on a laptop
- [ ] Your own owner account has its authenticator app on (D83), and a second console account exists for recovery
- [ ] No CSP errors in the browser console on any screen
- [ ] Phone check on a real phone: sign-in, dashboard, menu, stock look-up and picking fit without sideways scrolling
- [ ] Your CA approved `docs/design/gst-worked-examples.md` (B5)

## Infrastructure (production-setup.md)

- [ ] Root MFA, no root keys, Identity Center login with MFA, budget alert, CloudTrail with validation, GuardDuty
- [ ] Server with no inbound ports, IMDSv2, Session Manager works; RDS private, TLS forced, deletion protection, 14-day PITR
- [ ] Secrets only in SSM Parameter Store; `WOO_ENC_KEY` also in your password manager
- [ ] Cloudflare: Full (strict), tunnel, WAF rate rule on sign-in, Access on `/platform`
- [ ] Console log shows your real public address (TRUST_PROXY check)
- [ ] GitHub: ruleset on `main`, environments with required reviewer on production, push protection, Dependabot, 2FA
- [ ] Backup account with Object Lock; nightly backup ran and the heartbeat alert works (pause it once to see the alert)
- [ ] **Restore drill done and logged, under 4 hours**
- [ ] Uptime monitor on `https://app.<domain>/api/health/ready` every minute, alerting your phone
- [ ] Logs reach CloudWatch with 180-day retention

## Testing (testing.md)

- [ ] e2e workflow green on staging, including the console test
- [ ] k6 on staging: p95 < 500 ms, < 1% failed. Write the numbers here: ______
- [ ] ZAP report read; nothing above Low left unexplained
- [ ] Ran `ops/integrity.sql` on production after the pilot's first week: `integrity OK`

## Business and legal

- [ ] Final product name chosen; trademark search done (classes 9 and 42); domain bought
- [ ] Legal form decided (sole proprietor or company); bank account and UPI ID in the business's name
- [ ] GST: registered or not (ask your CA). If registered, subscriptions need tax invoices, which the console doesn't make yet
- [ ] Terms, Privacy, Refund policies: the drafts in `site/` reviewed and corrected **by a lawyer**; physical address
      on the Contact page
- [ ] Data processing terms for stores (you process their customers' data for them), from the lawyer
- [ ] The Terms and Privacy drafts promise deletion 30 days after a store closes. That is not built (console-and-billing.md §6): build it before the first store closes, or change the policies
- [ ] Incident contacts in incident-response.md filled in; you know where the CERT-In form is
- [ ] Support email and WhatsApp number answered daily

## Day one

- [ ] Your console account works; a second recovery console account exists (kept offline) in case you lose your phone
- [ ] Pilot store signed up through the public site's sign-up link, on a trial; you have their WhatsApp
- [ ] You watched them make their first sale
