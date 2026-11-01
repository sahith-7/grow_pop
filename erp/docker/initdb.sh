#!/bin/bash
# Runs once, when the local database volume is first created (docker-compose.yml mounts it into postgres's init folder).
# erp_rt is the runtime group the app's tables are granted to; erp_app is the login the api and worker use. Neither owns
# a table, so row-level security always applies to them. Migrations run as the owner (postgres locally, erp_mig on RDS).
set -euo pipefail
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v pw="$APP_DB_PASSWORD" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_rt') THEN CREATE ROLE erp_rt NOLOGIN; END IF;
END $$;
SELECT format('CREATE ROLE erp_app LOGIN PASSWORD %L IN ROLE erp_rt', :'pw') \gexec
SQL
