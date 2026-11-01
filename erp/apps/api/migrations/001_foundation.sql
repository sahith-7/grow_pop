-- Phase 1 foundation: tenants, users, sessions, tokens, audit. Tenant isolation via RLS.
-- Runtime role `erp_rt` (group) is NOT the table owner, so RLS always applies to it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_rt') THEN CREATE ROLE erp_rt NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO erp_rt;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_rt;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO erp_rt;

CREATE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE plans (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  max_users  int  NOT NULL CHECK (max_users > 0),
  features   jsonb NOT NULL DEFAULT '{}'
);
INSERT INTO plans (id, name, max_users) VALUES ('starter', 'Starter', 3);

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  legal_name text NOT NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  plan_id    text NOT NULL DEFAULT 'starter' REFERENCES plans(id),
  timezone   text NOT NULL DEFAULT 'Asia/Kolkata',
  locale     text NOT NULL DEFAULT 'en-IN',
  currency   char(3) NOT NULL DEFAULT 'INR',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE store_settings (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  address     text, city text, state text, postal_code text, phone text, email text,
  gstin       text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  name          text NOT NULL,
  password_hash text,
  role          text NOT NULL CHECK (role IN ('owner','manager','inventory','cashier','fulfillment')),
  status        text NOT NULL CHECK (status IN ('invited','active','disabled')),
  failed_logins int  NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
-- exactly one owner per tenant in V1
CREATE UNIQUE INDEX users_one_owner ON users (tenant_id) WHERE role = 'owner';

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX sessions_user ON sessions (user_id);

-- one-time tokens: invitations and password resets
CREATE TABLE user_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('invite','reset')),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE audit_events (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  actor_user_id uuid,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  summary       jsonb NOT NULL DEFAULT '{}',
  request_id    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_id ON audit_events (tenant_id, id DESC);
-- append-only for the runtime role
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM erp_rt;

-- Row-level security (owner role bypasses; erp_rt does not)
ALTER TABLE tenants        ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_tokens    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events   ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants USING (id = app_tenant()) WITH CHECK (id = app_tenant());
CREATE POLICY tenant_isolation ON store_settings USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE POLICY tenant_isolation ON users USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE POLICY tenant_isolation ON sessions USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE POLICY tenant_isolation ON user_tokens USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE POLICY tenant_isolation ON audit_events USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

-- The only cross-tenant reads: narrow, key-based lookups needed before the tenant is known.
CREATE FUNCTION auth_user_by_email(p_email text) RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT u.id, u.tenant_id FROM users u WHERE u.email = p_email $$;

CREATE FUNCTION auth_session_lookup(p_hash bytea) RETURNS TABLE (
  session_id uuid, tenant_id uuid, user_id uuid, last_seen_at timestamptz,
  role text, name text, email text, user_status text, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT s.id, s.tenant_id, s.user_id, s.last_seen_at, u.role, u.name, u.email, u.status, t.status
   FROM sessions s JOIN users u ON u.id = s.user_id JOIN tenants t ON t.id = s.tenant_id
   WHERE s.token_hash = p_hash AND s.expires_at > now() AND s.created_at > now() - interval '30 days' $$;

CREATE FUNCTION auth_token_lookup(p_hash bytea) RETURNS TABLE (id uuid, tenant_id uuid, user_id uuid, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT k.id, k.tenant_id, k.user_id, k.kind FROM user_tokens k
   WHERE k.token_hash = p_hash AND k.used_at IS NULL AND k.expires_at > now() $$;

REVOKE ALL ON FUNCTION auth_user_by_email(text), auth_session_lookup(bytea), auth_token_lookup(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_by_email(text), auth_session_lookup(bytea), auth_token_lookup(bytea) TO erp_rt;
