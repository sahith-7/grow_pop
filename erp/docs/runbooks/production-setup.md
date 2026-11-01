# Production setup (AWS Mumbai, Cloudflare, GitHub)

Do everything here for **staging** first, with `staging` wherever this says `production`, and run CHECK-B7 against
it. Then repeat for production in the same AWS account (or a second one later). Nothing here is automated yet
(no Terraform); each step names the console page. Untested against a real AWS account: expect to fix small things on
staging, and write the fix back into this file.

What you end up with:

```
shop browser ── Cloudflare (DNS, TLS, WAF) ══ tunnel ══> cloudflared ─> web (Next.js) ─> api ─> RDS PostgreSQL 16
                                                          one EC2 server, docker compose        (private, TLS only)
                                                          no inbound ports at all               worker ─> S3, SES
GitHub Actions ─(OIDC, no keys)─> ECR images + SSM "run deploy.sh" on the server
Nightly: server ─ pg_dump as erp_dump ─> backup account S3 (Object Lock)
```

## 1. AWS account (once)

1. **Root user**: sign in as root once. Turn on MFA (an authenticator app, or a hardware key). Delete any root access
   keys (Security credentials page; there should be none). Set alternate contacts (Account page) to your email. Then
   stop using root.
2. **Your daily login**: IAM Identity Center → enable (region ap-south-1) → create a user for yourself with MFA
   required → give it `AdministratorAccess` for the account. Bookmark the access portal URL. Use this, never root.
3. **Bills**: Billing → Budgets → a monthly cost budget at 120% of the plan's estimate, emailing you.
4. **CloudTrail**: CloudTrail → Trails → create `org-trail`: all regions, management events, **log file validation
   on**, new S3 bucket `<yourname>-cloudtrail` (keep 1 year with a lifecycle rule). CloudTrail's 90-day event history is
   not enough for an investigation.
5. **GuardDuty**: enable (30-day free trial, then a few hundred rupees a month at this size). It flags stolen
   credentials and crypto-mining, which you would otherwise not notice.
6. Region for everything below: **ap-south-1 (Mumbai)**, so stores' data stays in India.

## 2. Network and server

1. Use the default VPC. **Security group `erp-server`: no inbound rules at all.** Outbound: all. You get a shell
   through Systems Manager (Session Manager), never SSH, so there is no port 22 and no key pair.
2. **IAM role `erp-server`** (EC2 trusted entity) with:
   - `AmazonSSMManagedInstanceCore` (Session Manager and Run Command)
   - an inline policy: `ssm:GetParametersByPath` and `ssm:GetParameter` on `arn:aws:ssm:ap-south-1:<acct>:parameter/erp/production/*`,
     `kms:Decrypt` on the AWS-managed `alias/aws/ssm` key, `ecr:GetAuthorizationToken` (resource `*`),
     `ecr:BatchGetImage` + `ecr:GetDownloadUrlForLayer` on the two repositories, `s3:GetObject` on
     `arn:aws:s3:::<deploy-bucket>/*`, `s3:PutObject` + `s3:PutObjectRetention` on `arn:aws:s3:::<backup-bucket>/*`,
     `logs:CreateLogStream` + `logs:PutLogEvents` on the `/erp/production` log group, and read/write on the app bucket
     (`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `arn:aws:s3:::<app-bucket>/*`).
3. **EC2**: t4g.medium (staging t4g.small), Amazon Linux 2023 arm64, 30 GB gp3 encrypted, role `erp-server`, group
   `erp-server`, **IMDSv2 required** (Advanced details → Metadata version: V2 only). Then in Session Manager:
   ```sh
   sudo dnf install -y docker && sudo systemctl enable --now docker
   sudo mkdir -p /usr/local/lib/docker/cli-plugins /opt/erp/certs
   # docker compose plugin: download the arm64 binary for a pinned release from github.com/docker/compose/releases,
   # check its sha256 against the release's checksums file, then install it as /usr/local/lib/docker/cli-plugins/docker-compose
   sudo curl -fsSo /opt/erp/certs/rds-ca.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
   ```
4. **CloudWatch log group** `/erp/production`, retention **180 days** (CERT-In requires logs kept 180 days in India).
5. **ECR**: repositories `erp-api` and `erp-web`, tag immutability on, scan on push on, lifecycle rule "keep the last
   15 images".
6. **Deploy bucket** `<yourname>-erp-deploy`: private, lifecycle "expire after 30 days". Holds each release's
   `deploy.sh` and `docker-compose.prod.yml`.

## 3. Database (RDS PostgreSQL 16)

1. RDS → Create: PostgreSQL 16, db.t4g.small (staging db.t4g.micro), 20 GB gp3, single-AZ for now, **Public access:
   No**, new security group `erp-db` allowing 5432 **only from the `erp-server` group**, initial database name `erp`,
   master user `erp_owner` with a password from `openssl rand -hex 24`. **Encryption on, deletion protection on,
   backup retention 14 days** (staging 7), Performance Insights on (free tier), auto minor upgrade on.
2. Parameter group `erp-pg16` (family postgres16): `rds.force_ssl = 1`, `log_min_duration_statement = 1000`. Attach it,
   reboot once.
3. Create the roles. From Session Manager on the server:
   ```sh
   docker run --rm -it -v /opt/erp/certs:/certs:ro postgres:16 psql \
     "postgres://erp_owner@<endpoint>:5432/erp?sslmode=verify-full&sslrootcert=/certs/rds-ca.pem"
   ```
   ```sql
   CREATE ROLE erp_rt NOLOGIN;
   CREATE ROLE erp_app LOGIN PASSWORD '<openssl rand -hex 24>' IN ROLE erp_rt;      -- the api and worker
   CREATE ROLE erp_backup NOLOGIN;
   CREATE ROLE erp_dump LOGIN PASSWORD '<openssl rand -hex 24>' IN ROLE erp_backup; -- the nightly backup only
   ```
   `erp_owner` runs migrations and owns every table. It is **not** a superuser on RDS, which is why CI now migrates as a
   non-superuser too (D77) and why the backup needs its own role (D79).
4. Every connection string ends with `?sslmode=verify-full&sslrootcert=/certs/rds-ca.pem`. The api refuses to start in
   production with a remote database URL that lacks `sslmode=verify-full`.

## 4. Files and email

1. **App bucket** `<yourname>-erp-files` (ap-south-1): Block Public Access on (all four), versioning on, default
   encryption SSE-S3, lifecycle "noncurrent versions expire after 30 days". Later (plan, layer 3): replication to a
   second region.
   The api uses the server's role; leave `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` unset.
2. **SES** in ap-south-1: verify your domain (DKIM records go in Cloudflare DNS), request production access (out of
   the sandbox), create SMTP credentials. `SMTP_URL` = `smtps://<user>:<url-encoded password>@email-smtp.ap-south-1.amazonaws.com:465`.
   `MAIL_FROM` = `no-reply@<your domain>`.

## 5. Secrets: SSM Parameter Store (D80)

All secrets are **SecureString** parameters (Systems Manager → Parameter Store), encrypted by the AWS-managed KMS key.
`ops/deploy.sh` writes them into `app.env`, `migrate.env` and `tunnel.env` (mode 600) on each deploy. Values must not
contain `$` or newlines; `openssl rand -hex` output is safe.

| Parameter (`/erp/production/...`) | Value |
|---|---|
| `app/NODE_ENV` | `production` |
| `app/DATABASE_URL` | `postgres://erp_app:<pw>@<endpoint>:5432/erp?sslmode=verify-full&sslrootcert=/certs/rds-ca.pem` |
| `app/WEB_ORIGIN` | `https://app.<your domain>` |
| `app/WOO_ENC_KEY` | `openssl rand -base64 32`, **never changed afterwards** (changing it makes every saved shop key unreadable). Write it down in your password manager too |
| `app/WOO_WEBHOOK_BASE_URL` | `https://app.<your domain>/api` |
| `app/S3_BUCKET`, `app/S3_REGION` | `<yourname>-erp-files`, `ap-south-1` |
| `app/SMTP_URL`, `app/MAIL_FROM` | from SES |
| `app/BILLING_UPI_ID`, `app/BILLING_UPI_NAME` | your business UPI ID and payee name, shown to store owners |
| `app/BILLING_GST_PERCENT` | leave unset until you register for GST; then the rate your CA gives you (e.g. 18) |
| `app/SUPPORT_EMAIL`, `app/SUPPORT_WHATSAPP` | where stores reach you |
| `app/PLATFORM_ALERT_EMAIL` | you: daily summary of stores going past due or suspended |
| `migrate/MIGRATION_DATABASE_URL` | `postgres://erp_owner:<pw>@<endpoint>:5432/erp?sslmode=verify-full&sslrootcert=/certs/rds-ca.pem` |
| `tunnel/TUNNEL_TOKEN` | from Cloudflare, step 6 |
| `backup/DATABASE_URL` | `postgres://erp_dump:<pw>@...` same suffix |
| `backup/BUCKET` | the backup account's bucket, step 8 |
| `backup/HEARTBEAT_URL` | optional: a heartbeat URL from your uptime monitor |

Any other variable your Phase 1 `.env.example` lists goes under `app/` the same way. Do not set `TRUST_PROXY`: the
production compose file fixes it at `1` (D76).

## 6. Cloudflare

1. Add the domain to Cloudflare (free plan), move the nameservers. SSL/TLS mode: **Full (strict)**. Always Use HTTPS
   on. Minimum TLS 1.2. HSTS: on after launch, once everything works on https (max-age 6 months, include subdomains).
2. **Tunnel** (D78): Zero Trust → Networks → Tunnels → Create a tunnel (cloudflared) `erp-production`. Copy the token
   into `tunnel/TUNNEL_TOKEN`. Public hostname: `app.<your domain>` → service `http://web:3000`. The server needs no
   open port: cloudflared, inside the compose project, connects out.
3. **WAF**: Security → WAF → Rate limiting rule (free plan allows one): path `/api/v1/auth/` and `/api/v1/platform/login`,
   10 requests per 10 seconds per IP → block for 10 seconds. The api has its own limits too.
4. **Console path**: Zero Trust → Access → Applications → self-hosted `app.<your domain>/platform*` with a policy
   "emails: you". The console already needs a password and an authenticator code; this keeps it invisible to everyone
   else. Add the API path `app.<your domain>/api/v1/platform*` to the same application.
5. The public website goes on Cloudflare Pages (see `site/README.md`), not on the server.

**Client addresses** (D76): Cloudflare appends the visitor's real address to `X-Forwarded-For`; web passes the header
through unchanged; the api trusts exactly one hop (web) and so takes Cloudflare's entry. This is only safe because
nothing can reach web except through the tunnel. Check after the first deploy: sign in to the console and open its
log; the address shown must be your own public address (search "what is my ip"), not a 172.x/10.x one.

## 7. GitHub

1. **OIDC**: IAM → Identity providers → add OpenID Connect, URL `https://token.actions.githubusercontent.com`,
   audience `sts.amazonaws.com`. Role `erp-deploy-production`, trust policy:
   ```json
   { "Effect": "Allow", "Principal": { "Federated": "arn:aws:iam::<acct>:oidc-provider/token.actions.githubusercontent.com" },
     "Action": "sts:AssumeRoleWithWebIdentity",
     "Condition": { "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                                       "token.actions.githubusercontent.com:sub": "repo:<owner>/<repo>:environment:production" } } }
   ```
   (staging role: `...:environment:staging`). Permissions: push to the two ECR repositories (`ecr:GetAuthorizationToken`,
   `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`,
   `ecr:PutImage`, `ecr:BatchGetImage`, `ecr:DescribeImages`), `s3:PutObject` on the deploy bucket, `ssm:SendCommand` on the instance and on
   `arn:aws:ssm:ap-south-1::document/AWS-RunShellScript`, `ssm:GetCommandInvocation`. Nothing else.
2. **Environments** (Settings → Environments): `staging` and `production`. On `production`: required reviewer = you,
   deployment tags `v*` only. Variables on each: `AWS_DEPLOY_ROLE_ARN`, `ECR_REGISTRY`
   (`<acct>.dkr.ecr.ap-south-1.amazonaws.com`), `DEPLOY_BUCKET`, `INSTANCE_ID`. Then the repository variable
   `DEPLOY_ENABLED` = `true` (the deploy workflow does nothing until it is set).
3. **Branch protection** on `main` (Settings → Rules → Rulesets): require a pull request, require status checks `api`,
   `web`, `audit`, `images`, block force pushes and deletion. Include administrators (you), so a tired late-night push
   still goes through CI.
4. **Security** (Settings → Code security): Dependabot alerts and security updates on, secret scanning and **push
   protection** on, private vulnerability reporting on.
5. Actions → General: "Read repository contents" as the default token permission; do not allow Actions to approve
   pull requests.
6. Your GitHub account: 2FA with an authenticator app or passkey, not SMS.

## 8. Backup account (separate AWS login)

1. Create a second AWS account (Organizations → add account, or a fresh signup with another email). Root MFA as in §1.
2. Bucket `<yourname>-erp-backup` in ap-south-1: **Object Lock on** (only possible at creation), versioning on,
   Block Public Access on, lifecycle: `daily/` expire after 36 days, `monthly/` after 400 days, noncurrent versions
   after 1 day. Default retention: none (the backup script sets 35 or 366 days per file, COMPLIANCE mode: nobody,
   including you, can delete them early).
3. Bucket policy: allow the production account's role `erp-server` **only** `s3:PutObject` and `s3:PutObjectRetention`.
   No read, list or delete. Restores are done by you, signed in to the backup account.
4. On the server: copy `ops/backup.sh` to `/opt/erp/backup.sh` and `ops/erp-backup.service` + `ops/erp-backup.timer` to
   `/etc/systemd/system/`, then `systemctl daemon-reload && systemctl enable --now erp-backup.timer`. Run it once by
   hand (`systemctl start erp-backup && journalctl -u erp-backup`) and check the file appears in the backup bucket.

## 9. First deploy

1. Push to `main` (staging) or tag `v0.1.0` (production). The deploy workflow builds both images, pushes them, and
   runs `deploy.sh` on the server through Systems Manager. The first run also creates the tables.
2. Create your console account (console-and-billing.md §1).
3. Run CHECK-B7. Then the restore drill (backup-restore.md) before any real store signs up.
