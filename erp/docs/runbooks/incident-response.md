# Incident response

An incident is anything that may have let someone see, change or destroy data they shouldn't, or that takes the
service down for stores: a leaked password or key, an unknown console login, one store seeing another's data, a
defaced page, ransomware, a lost laptop with access, a GuardDuty high finding, a database restore that lost data.

**Clock: CERT-In requires a report within 6 hours of noticing** (CERT-In Directions of 28 April 2022, for service
providers in India). Report first, investigate after; an early report can say "under investigation".

Have your lawyer confirm, before launch, what applies to you: CERT-In's list of reportable incidents, and which Digital
Personal Data Protection Act 2023 duties are in force (telling the Data Protection Board and the affected people about
a personal data breach). For stores' customers' data you are processing on the stores' behalf: tell the affected
stores at once so they can meet their own duties.

## First hour

1. **Write down the time you noticed** and keep a running log (a plain text file, with times) of everything you see and
   do. You will need it for the report and for stores.
2. **Contain, without destroying evidence.** Pick what fits:
   - leaked or suspected password/key: rotate it (below). Don't delete the old one's logs.
   - unknown console sign-in: `platform-admin.js disable <email>` for that account, then rotate your own password and
     reset your authenticator (`reset-code`).
   - one store sees another's data: suspend nothing yet; take the api down only if it's still happening
     (`docker compose -f docker-compose.prod.yml stop api web` on the server). A maintenance outage is better than an
     ongoing leak.
   - server compromised: in EC2, **create a snapshot of the volume first**, then stop (don't terminate) the instance;
     replace it with a fresh one from production-setup.md; rotate every secret.
3. **Don't** wipe logs, reinstall in place, or "clean up" the database before you have copies. CloudTrail, CloudWatch
   (180 days) and the console log are your evidence.

## Within 6 hours: report to CERT-In

- Form and email address: cert-in.org.in → "Report an incident" (incident reporting form; email incident@cert-in.org.in).
  Check the address on the site at the time; it is quoted here for convenience.
- Say: what happened as far as you know, when you noticed, systems affected (an AWS-hosted web application, Mumbai
  region), whether personal data is involved, what you have done. "Investigation ongoing" is fine.
- Keep the acknowledgement.

## Rotating secrets

| Secret | How | Effect |
|---|---|---|
| `erp_app`, `erp_owner`, `erp_dump` DB passwords | `ALTER ROLE ... PASSWORD '<new>'` as erp_owner, update the SSM parameter, redeploy | brief errors until redeployed |
| SMTP credentials | SES → new SMTP user, delete old, update `app/SMTP_URL`, redeploy | none |
| Tunnel token | Cloudflare → tunnel → refresh token, update `tunnel/TUNNEL_TOKEN`, redeploy | brief outage |
| Store sessions | `DELETE FROM sessions;` as erp_owner (everyone signs in again) | all users signed out |
| Console sessions | `DELETE FROM platform_sessions;` as erp_owner | you sign in again |
| A shop's WooCommerce keys | the store owner regenerates them in WooCommerce and reconnects | that shop's sync pauses until reconnected |
| `WOO_ENC_KEY` | **Can't simply be changed**: every saved shop key would become unreadable, and every store would have to reconnect. Only if the key itself leaked; then ask every online store to reconnect | all online stores' sync stops until each reconnects |
| GitHub | revoke sessions and tokens in GitHub settings; the deploy role uses OIDC, so there's no AWS key to rotate | none |

## After

1. Tell affected stores (email from `SUPPORT_EMAIL`, plus WhatsApp for the owner): what happened, what data, what you
   did, what they should do. Plain words, no hedging.
2. Write a short post-incident note in `docs/incidents/YYYY-MM-DD.md`: timeline, cause, what fixed it, what changes so
   it can't happen again. Then make that change.
3. If the cause was code: a test that would have caught it goes in the same pull request as the fix.

## Contacts (fill in before launch)

| Who | For | Contact |
|---|---|---|
| CERT-In | 6-hour report | cert-in.org.in |
| Your lawyer | DPDP duties, wording to stores | |
| AWS Support | account compromise | AWS console → Support (Basic plan covers account and billing) |
| Cloudflare | DDoS, tunnel | dashboard → Support |
