#!/bin/bash
# Nightly logical backup (B7, backup layer 2; D79). Runs on the production server from erp-backup.timer, as root.
# Dumps the whole database as erp_dump (a member of erp_backup: read-only, sees every store) and uploads it to the
# bucket in the separate backup AWS account, where Object Lock keeps it even if this account is taken over.
# The server can only add files there; it can't read, change or delete them.
# Parameters (SSM, ap-south-1): /erp/production/backup/DATABASE_URL (SecureString; erp_dump, sslmode=verify-full),
# /erp/production/backup/BUCKET, and optionally /erp/production/backup/HEARTBEAT_URL (pinged only on success, so a
# missed or failed night raises an alert in the monitoring service).
set -euo pipefail
export AWS_REGION=ap-south-1
param() { aws ssm get-parameter --name "/erp/production/backup/$1" --with-decryption --query Parameter.Value --output text; }
URL=$(param DATABASE_URL)
BUCKET=$(param BUCKET)
HEARTBEAT=$(param HEARTBEAT_URL 2>/dev/null || true)

day=$(date -u +%F)
prefix=daily; retain=$(date -u -d '+35 days' +%FT%TZ)
if [ "$(date -u +%d)" = 01 ]; then prefix=monthly; retain=$(date -u -d '+366 days' +%FT%TZ); fi
work=$(mktemp -d /var/tmp/erp-backup.XXXXXX)
trap 'rm -rf "$work"' EXIT

docker run --rm --network host -e PGURL="$URL" -v /opt/erp/certs:/certs:ro -v "$work:/out" \
  postgres:16@sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d \
  sh -c 'pg_dump --enable-row-security -Fc -d "$PGURL" -f /out/erp.dump && pg_restore --list /out/erp.dump > /dev/null'

key="$prefix/erp-$day.dump"
aws s3api put-object --bucket "$BUCKET" --key "$key" --body "$work/erp.dump" --checksum-algorithm SHA256 \
  --object-lock-mode COMPLIANCE --object-lock-retain-until-date "$retain" > /dev/null
echo "backup $key $(du -h "$work/erp.dump" | cut -f1) uploaded"
[ -n "$HEARTBEAT" ] && curl -fsS -m 10 --retry 3 "$HEARTBEAT" > /dev/null || true
