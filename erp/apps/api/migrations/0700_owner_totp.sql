-- TRIDENT · Owner sign-in with an authenticator code (D83) and the second step of that sign-in.
-- The secret is sealed with the app's encryption key (lib/secret-box.ts), bound to the store and the user, so a value
-- copied into another row does not decrypt. totp_last_step makes every code single-use.

ALTER TABLE users
  ADD COLUMN totp_secret_enc  bytea,
  ADD COLUMN totp_pending_enc bytea,                 -- set while the owner is scanning the QR code, before the first code
  ADD COLUMN totp_enabled_at  timestamptz,
  ADD COLUMN totp_last_step   bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT users_totp_enabled_has_secret CHECK (totp_enabled_at IS NULL OR totp_secret_enc IS NOT NULL);

-- Password accepted, code still to come. Lives 5 minutes, 5 tries, used once. The token is "<tenant id>.<random>"; only
-- the random part's hash is stored, and the tenant id just picks the store, so no cross-store lookup function is needed.
CREATE TABLE login_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,
  attempts    int NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX login_challenges_user ON login_challenges (user_id);
ALTER TABLE login_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON login_challenges USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
REVOKE DELETE, TRUNCATE ON login_challenges FROM erp_rt;

-- The session lookup now also says whether the user has an authenticator app, so the owner check costs no extra query.
-- Same name and same columns as Phase 1's, plus totp_enabled at the end.
DROP FUNCTION auth_session_lookup(bytea);
CREATE FUNCTION auth_session_lookup(p_hash bytea) RETURNS TABLE (
  session_id uuid, tenant_id uuid, user_id uuid, last_seen_at timestamptz,
  role text, name text, email text, user_status text, tenant_status text, totp_enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT s.id, s.tenant_id, s.user_id, s.last_seen_at, u.role, u.name, u.email, u.status, t.status, u.totp_enabled_at IS NOT NULL
   FROM sessions s JOIN users u ON u.id = s.user_id JOIN tenants t ON t.id = s.tenant_id
   WHERE s.token_hash = p_hash AND s.expires_at > now() AND s.created_at > now() - interval '30 days' $$;
REVOKE ALL ON FUNCTION auth_session_lookup(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_session_lookup(bytea) TO erp_rt;

SELECT erp_backup_grants();
