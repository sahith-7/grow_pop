#!/bin/sh
# Deploys one release on the server (B7, D78). Run by .github/workflows/deploy.yml through AWS Systems Manager, as
# root, from /opt/erp:   sh deploy.sh <staging|production> <tag> <registry>
# 1. writes app.env, migrate.env and tunnel.env from SSM Parameter Store (/erp/<env>/app|migrate|tunnel/<NAME>)
# 2. pulls the images, runs migrations, starts the new release
# 3. checks /health/ready through web; if that fails, starts the previous release again
# Migrations are never undone: every release must work with the schema of the next one (docs/runbooks/rollback.md).
set -eu
ENV_NAME=$1 TAG=$2 REGISTRY=$3
case "$ENV_NAME" in staging|production) ;; *) echo "unknown environment $ENV_NAME" >&2; exit 2 ;; esac
cd /opt/erp
umask 077

params() {   # NAME=value lines for every parameter under a path; values must not contain $ or newlines
  aws ssm get-parameters-by-path --region ap-south-1 --path "/erp/$ENV_NAME/$1/" --recursive --with-decryption \
    --query 'Parameters[].[Name,Value]' --output text | awk -F'\t' '{ n = $1; sub(".*/", "", n); print n "=" $2 }'
}
for part in app migrate tunnel; do
  params "$part" > "$part.env.new"
  [ -s "$part.env.new" ] || { echo "no parameters under /erp/$ENV_NAME/$part/" >&2; exit 1; }
  if grep -q '\$' "$part.env.new"; then echo "a value under /erp/$ENV_NAME/$part/ contains \$" >&2; exit 1; fi
  mv "$part.env.new" "$part.env"
done

aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
PREV=$(cat current-tag 2>/dev/null || true)
export ERP_ENV="$ENV_NAME" ERP_REGISTRY="$REGISTRY"

up() { ERP_TAG=$1 docker compose -f docker-compose.prod.yml up -d --remove-orphans; }
ready() {
  i=0
  while [ $i -lt 30 ]; do
    if ERP_TAG=$1 docker compose -f docker-compose.prod.yml exec -T web \
      node -e "fetch('http://localhost:3000/api/health/ready').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; then
      return 0
    fi
    i=$((i + 1)); sleep 4
  done
  return 1
}

ERP_TAG=$TAG docker compose -f docker-compose.prod.yml pull
if up "$TAG" && ready "$TAG"; then
  echo "$TAG" > current-tag
  # Not secret. docker compose reads .env for ${...} in the compose file, so later hand-run commands need no exports.
  printf 'ERP_ENV=%s\nERP_REGISTRY=%s\nERP_TAG=%s\n' "$ENV_NAME" "$REGISTRY" "$TAG" > .env
  docker image prune -af --filter "until=720h" >/dev/null || true
  echo "deployed $TAG to $ENV_NAME"
  exit 0
fi

echo "release $TAG is not healthy" >&2
ERP_TAG=$TAG docker compose -f docker-compose.prod.yml logs --tail 80 migrate api web >&2 || true
if [ -n "$PREV" ]; then
  echo "starting $PREV again" >&2
  up "$PREV" && ready "$PREV" && echo "rolled back to $PREV" >&2
fi
exit 1
