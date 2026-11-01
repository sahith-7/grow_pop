-- B7 · The SaaS layer: plans and limits, store states (trial → active → past due → suspended → closed), manual payments,
-- the platform admin console, support access granted by the store owner, data exports and email alert de-duplication.
-- Decisions D67–D74. Grants at the end of this file.
--
-- The runtime role (erp_rt) can READ a store's own subscription, payments and history, but can never change them: every
-- change goes through a SECURITY DEFINER function below that either has no inputs (the daily lifecycle tick) or checks a
-- platform admin session first. A bug in the app therefore cannot make a store "paid".

-- ------------------------------------------------------------------ plans (prices and limits as configuration, D67)
ALTER TABLE plans
  ADD COLUMN price_month_paise integer CHECK (price_month_paise >= 0),
  ADD COLUMN price_year_paise  integer CHECK (price_year_paise >= 0),
  ADD COLUMN sort_order        integer NOT NULL DEFAULT 0,
  ADD COLUMN is_public         boolean NOT NULL DEFAULT true;

UPDATE plans SET name = 'Store', price_month_paise = 99900, price_year_paise = 999900, sort_order = 1,
                 features = features || '{"online": false}'::jsonb
 WHERE id = 'starter';
INSERT INTO plans (id, name, max_users, features, price_month_paise, price_year_paise, sort_order)
VALUES ('online', 'Store + Online', 5, '{"online": true}', 199900, 1999900, 2)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------ subscriptions: one row per store
CREATE TABLE subscriptions (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants(id),
  state            text NOT NULL CHECK (state IN ('trial', 'active', 'past_due', 'suspended', 'closed')),
  store_code       text NOT NULL UNIQUE,              -- short code the store puts in the UPI note, so a payment is matched to it
  trial_ends_at    timestamptz,
  paid_until       timestamptz,
  past_due_since   timestamptz,
  closed_at        timestamptz,
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'trial' OR trial_ends_at IS NOT NULL),
  CHECK (state <> 'closed' OR closed_at IS NOT NULL)
);

-- History of every state change, by the system or by a platform admin. The owner sees it on the Account page.
CREATE TABLE subscription_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  from_state  text,
  to_state    text NOT NULL,
  actor       text NOT NULL,                        -- 'system' or 'admin:<email>'
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_events_tenant ON subscription_events (tenant_id, id DESC);

-- Manual payments (UPI, bank transfer) recorded by a platform admin. Receipts, not GST invoices (D69).
CREATE SEQUENCE subscription_receipt_seq;
CREATE TABLE subscription_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  receipt_no    text NOT NULL UNIQUE,
  amount_paise  integer NOT NULL CHECK (amount_paise > 0),
  method        text NOT NULL CHECK (method IN ('upi', 'bank', 'cash', 'other')),
  reference     text NOT NULL CHECK (length(reference) BETWEEN 1 AND 100),   -- UPI transaction id (UTR) or bank reference
  paid_on       date NOT NULL,
  plan_id       text NOT NULL REFERENCES plans(id),
  months        integer NOT NULL CHECK (months BETWEEN 1 AND 36),
  period_from   timestamptz NOT NULL,
  period_to     timestamptz NOT NULL,
  note          text,
  recorded_by   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (method, reference)                       -- the same UTR cannot be recorded twice
);
CREATE INDEX subscription_payments_tenant ON subscription_payments (tenant_id, created_at DESC);

-- ------------------------------------------------------------------ platform admin (the console for the people who run the service)
-- No tenant, no row in users. erp_rt has no grants on these tables at all; only the platform_* functions read them.
CREATE TABLE platform_admins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE CHECK (email = lower(email)),
  name            text NOT NULL,
  password_hash   text NOT NULL,                     -- argon2id
  totp_secret_enc bytea NOT NULL,                    -- AES-256-GCM (lib/secret-box.ts), field 'platform-totp'
  totp_last_step  bigint NOT NULL DEFAULT 0,         -- a code is accepted once (replay protection)
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_sessions (
  token_hash   bytea PRIMARY KEY,
  admin_id     uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  user_agent   text,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);

CREATE TABLE platform_audit (
  id         bigserial PRIMARY KEY,
  admin_id   uuid REFERENCES platform_admins(id),
  admin_email text,
  action     text NOT NULL,
  tenant_id  uuid REFERENCES tenants(id),
  detail     jsonb NOT NULL DEFAULT '{}',
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ support access, granted by the store owner (D71)
CREATE TABLE support_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  granted_by  uuid NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  revoked_by  uuid,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '72 hours'),
  FOREIGN KEY (tenant_id, granted_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX support_grants_tenant ON support_grants (tenant_id, created_at DESC);

-- ------------------------------------------------------------------ data exports (owner downloads everything, D72)
CREATE TABLE data_exports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  requested_by  uuid NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'ready', 'failed', 'expired')),
  object_key    text,
  size_bytes    bigint,
  row_counts    jsonb,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '7 days',
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX data_exports_tenant ON data_exports (tenant_id, created_at DESC);

ALTER TABLE sync_jobs DROP CONSTRAINT sync_jobs_kind_check;
ALTER TABLE sync_jobs ADD CONSTRAINT sync_jobs_kind_check
  CHECK (kind IN ('import', 'woo.product', 'woo.stock', 'woo.inbound', 'woo.reconcile', 'woo.match', 'woo.fulfilment', 'export'));

-- ------------------------------------------------------------------ alert e-mails sent, so each is sent once (D73)
CREATE TABLE alert_log (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  kind       text NOT NULL,
  key        text NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, key)
);

-- ------------------------------------------------------------------ helpers (not callable by erp_rt)
CREATE FUNCTION saas_new_store_code() RETURNS text LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE c text;
BEGIN
  LOOP
    -- 6 characters from an alphabet without 0/O/1/I, easy to read out over the phone
    SELECT string_agg(substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 1 + floor(random() * 32)::int, 1), '') INTO c FROM generate_series(1, 6);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM subscriptions WHERE store_code = c);
  END LOOP;
  RETURN c;
END $$;

CREATE FUNCTION saas_set_state(p_tenant uuid, p_to text, p_actor text, p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE v_from text;
BEGIN
  SELECT state INTO v_from FROM subscriptions WHERE tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no subscription for tenant %', p_tenant; END IF;
  IF v_from = p_to THEN RETURN; END IF;
  UPDATE subscriptions SET state = p_to, state_changed_at = now(),
         past_due_since = CASE WHEN p_to = 'past_due' THEN now() WHEN p_to IN ('active', 'trial') THEN NULL ELSE past_due_since END,
         closed_at = CASE WHEN p_to = 'closed' THEN now() WHEN v_from = 'closed' THEN NULL ELSE closed_at END
   WHERE tenant_id = p_tenant;
  INSERT INTO subscription_events (tenant_id, from_state, to_state, actor, reason) VALUES (p_tenant, v_from, p_to, p_actor, p_reason);
END $$;

-- Raises 42501 unless the hash is a live platform session (8 h hard limit, 30 min idle); bumps last_seen_at.
CREATE FUNCTION platform_admin_of(p_hash bytea) RETURNS platform_admins
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid; a platform_admins;
BEGIN
  UPDATE platform_sessions s SET last_seen_at = now()
   WHERE s.token_hash = p_hash AND s.expires_at > now() AND s.last_seen_at > now() - interval '30 minutes'
  RETURNING s.admin_id INTO v_id;
  SELECT * INTO a FROM platform_admins x WHERE x.id = v_id AND x.status = 'active';
  IF a.id IS NULL THEN RAISE EXCEPTION 'platform session invalid' USING ERRCODE = '42501'; END IF;
  RETURN a;
END $$;

CREATE FUNCTION platform_log(a platform_admins, p_action text, p_tenant uuid, p_detail jsonb, p_ip text) RETURNS void
LANGUAGE sql VOLATILE SET search_path = pg_catalog, public AS $$
  INSERT INTO platform_audit (admin_id, admin_email, action, tenant_id, detail, ip) VALUES (a.id, a.email, p_action, p_tenant, coalesce(p_detail, '{}'), p_ip)
$$;

REVOKE ALL ON FUNCTION saas_new_store_code(), saas_set_state(uuid, text, text, text), platform_admin_of(bytea),
                       platform_log(platform_admins, text, uuid, jsonb, text) FROM PUBLIC;

-- ------------------------------------------------------------------ SECURITY DEFINER functions #7–#21 (04-tenancy-and-permissions.md §1.3, D70)
-- #7: every new store starts a trial. A trigger, so Phase 1's sign-up needs no change. Not callable directly.
CREATE FUNCTION saas_on_tenant_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO subscriptions (tenant_id, state, store_code, trial_ends_at) VALUES (NEW.id, 'trial', saas_new_store_code(), now() + interval '30 days');
  INSERT INTO subscription_events (tenant_id, from_state, to_state, actor, reason) VALUES (NEW.id, NULL, 'trial', 'system', 'signed up');
  RETURN NEW;
END $$;
CREATE TRIGGER saas_on_tenant_insert AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION saas_on_tenant_insert();

-- Stores that exist before B7 (pilots): a 90-day trial from today.
INSERT INTO subscriptions (tenant_id, state, store_code, trial_ends_at)
SELECT t.id, 'trial', saas_new_store_code(), now() + interval '90 days' FROM tenants t
 WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id);
INSERT INTO subscription_events (tenant_id, from_state, to_state, actor, reason)
SELECT s.tenant_id, NULL, 'trial', 'system', 'B7 migration: existing store' FROM subscriptions s
 WHERE NOT EXISTS (SELECT 1 FROM subscription_events e WHERE e.tenant_id = s.tenant_id);

-- #8: the worker's lifecycle tick. No inputs: trial over or paid period over → past due; 7 days past due → suspended.
-- Never closes a store; only a platform admin does that.
CREATE FUNCTION saas_lifecycle_tick() RETURNS TABLE (tenant_id uuid, from_state text, to_state text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT s.tenant_id AS t, s.state AS st,
                  CASE WHEN s.state = 'trial' AND s.trial_ends_at <= now() THEN 'past_due'
                       WHEN s.state = 'active' AND s.paid_until <= now() THEN 'past_due'
                       WHEN s.state = 'past_due' AND s.past_due_since <= now() - interval '7 days' THEN 'suspended' END AS nxt
             FROM subscriptions s
            WHERE (s.state = 'trial' AND s.trial_ends_at <= now()) OR (s.state = 'active' AND s.paid_until <= now())
               OR (s.state = 'past_due' AND s.past_due_since <= now() - interval '7 days')
            ORDER BY s.tenant_id FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM saas_set_state(r.t, r.nxt, 'system',
      CASE r.nxt WHEN 'suspended' THEN 'payment overdue by 7 days' ELSE CASE r.st WHEN 'trial' THEN 'trial ended' ELSE 'paid period ended' END END);
    tenant_id := r.t; from_state := r.st; to_state := r.nxt; RETURN NEXT;
  END LOOP;
END $$;

-- #9: stores the worker sends reminders and alerts to (every state but closed). Returns ids only.
CREATE FUNCTION saas_live_tenants() RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT s.tenant_id FROM subscriptions s WHERE s.state <> 'closed' ORDER BY s.tenant_id $$;

-- #10: platform sign-in, step 1. The API checks the password and code itself (argon2 and TOTP are not in Postgres).
CREATE FUNCTION platform_login_lookup(p_email text)
RETURNS TABLE (id uuid, password_hash text, totp_secret_enc bytea, totp_last_step bigint, locked_until timestamptz, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT a.id, a.password_hash, a.totp_secret_enc, a.totp_last_step, a.locked_until, a.status FROM platform_admins a WHERE a.email = lower(p_email) $$;

-- #11: platform sign-in, step 2. Records a failure (5 in a row lock the account for 15 minutes), or uses up the code's
-- time step and creates an 8-hour session. Returns false when the step was already used (a replayed code).
CREATE FUNCTION platform_login_result(p_admin uuid, p_ok boolean, p_step bigint, p_session_hash bytea, p_user_agent text, p_ip text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a platform_admins;
BEGIN
  IF NOT p_ok THEN
    UPDATE platform_admins SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
     WHERE id = p_admin RETURNING * INTO a;
    IF a.id IS NOT NULL THEN PERFORM platform_log(a, 'platform.login_failed', NULL, '{}', p_ip); END IF;
    RETURN false;
  END IF;
  UPDATE platform_admins SET totp_last_step = p_step, failed_logins = 0, locked_until = NULL
   WHERE id = p_admin AND status = 'active' AND totp_last_step < p_step AND (locked_until IS NULL OR locked_until <= now())
  RETURNING * INTO a;
  IF a.id IS NULL THEN RETURN false; END IF;
  DELETE FROM platform_sessions WHERE admin_id = p_admin AND (expires_at <= now() OR last_seen_at <= now() - interval '30 minutes');
  INSERT INTO platform_sessions (token_hash, admin_id, user_agent, ip, expires_at)
  VALUES (p_session_hash, p_admin, left(p_user_agent, 300), p_ip, now() + interval '8 hours');
  PERFORM platform_log(a, 'platform.login', NULL, '{}', p_ip);
  RETURN true;
END $$;

-- #12: who is signed in to the console.
CREATE FUNCTION platform_whoami(p_hash bytea) RETURNS TABLE (id uuid, email text, name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a platform_admins := platform_admin_of(p_hash);
BEGIN id := a.id; email := a.email; name := a.name; RETURN NEXT; END $$;

-- #13: sign out (no error if the session is already gone).
CREATE FUNCTION platform_logout(p_hash bytea) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ DELETE FROM platform_sessions WHERE token_hash = p_hash $$;

-- #14: every store, for the console's list. Owner e-mail is there so the admin can contact them.
CREATE FUNCTION platform_tenants(p_hash bytea)
RETURNS TABLE (id uuid, name text, created_at timestamptz, state text, store_code text, plan_id text, plan_name text,
               trial_ends_at timestamptz, paid_until timestamptz, owner_email text, users integer, last_seen_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM platform_admin_of(p_hash);
  RETURN QUERY
  SELECT t.id, t.name, t.created_at, s.state, s.store_code, t.plan_id, p.name, s.trial_ends_at, s.paid_until,
         (SELECT u.email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner'),
         (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.status <> 'disabled'),
         (SELECT max(x.last_seen_at) FROM sessions x WHERE x.tenant_id = t.id)
    FROM tenants t JOIN subscriptions s ON s.tenant_id = t.id JOIN plans p ON p.id = t.plan_id
   ORDER BY t.created_at DESC;
END $$;

-- #15: one store's subscription, payments, history and support grants. Nothing from the store's business data.
CREATE FUNCTION platform_tenant(p_hash bytea, p_tenant uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r jsonb;
BEGIN
  PERFORM platform_admin_of(p_hash);
  SELECT jsonb_build_object(
    'id', t.id, 'name', t.name, 'legalName', t.legal_name, 'createdAt', t.created_at, 'timezone', t.timezone,
    'planId', t.plan_id, 'state', s.state, 'storeCode', s.store_code, 'trialEndsAt', s.trial_ends_at, 'paidUntil', s.paid_until,
    'pastDueSince', s.past_due_since, 'closedAt', s.closed_at, 'stateChangedAt', s.state_changed_at,
    'owner', (SELECT jsonb_build_object('name', u.name, 'email', u.email) FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner'),
    'users', (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.status <> 'disabled'),
    'payments', coalesce((SELECT jsonb_agg(jsonb_build_object('receiptNo', x.receipt_no, 'amountPaise', x.amount_paise, 'method', x.method,
                   'reference', x.reference, 'paidOn', x.paid_on, 'planId', x.plan_id, 'months', x.months, 'periodTo', x.period_to,
                   'recordedBy', x.recorded_by, 'createdAt', x.created_at) ORDER BY x.created_at DESC)
                 FROM subscription_payments x WHERE x.tenant_id = t.id), '[]'),
    'events', coalesce((SELECT jsonb_agg(jsonb_build_object('from', e.from_state, 'to', e.to_state, 'actor', e.actor, 'reason', e.reason,
                   'at', e.created_at) ORDER BY e.id DESC) FROM (SELECT * FROM subscription_events e WHERE e.tenant_id = t.id ORDER BY e.id DESC LIMIT 50) e), '[]'),
    'supportGrant', (SELECT jsonb_build_object('expiresAt', g.expires_at, 'reason', g.reason) FROM support_grants g
                      WHERE g.tenant_id = t.id AND g.revoked_at IS NULL AND g.expires_at > now() ORDER BY g.expires_at DESC LIMIT 1))
    INTO r
    FROM tenants t JOIN subscriptions s ON s.tenant_id = t.id WHERE t.id = p_tenant;
  RETURN r;
END $$;

-- #16: record a manual payment. Makes the store active and extends its paid period from the later of now and paid_until.
CREATE FUNCTION platform_record_payment(p_hash bytea, p_tenant uuid, p_amount_paise integer, p_method text, p_reference text,
                                        p_paid_on date, p_plan text, p_months integer, p_note text, p_ip text)
RETURNS TABLE (receipt_no text, period_from timestamptz, period_to timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a platform_admins := platform_admin_of(p_hash); s subscriptions; v_from timestamptz; v_to timestamptz; v_no text;
BEGIN
  SELECT * INTO s FROM subscriptions x WHERE x.tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store not found' USING ERRCODE = 'P0002'; END IF;
  IF s.state = 'closed' THEN RAISE EXCEPTION 'store is closed; reopen it first' USING ERRCODE = '55000'; END IF;
  v_from := greatest(coalesce(s.paid_until, now()), now());
  v_to := v_from + make_interval(months => p_months);
  v_no := 'R-' || lpad(nextval('subscription_receipt_seq')::text, 6, '0');
  INSERT INTO subscription_payments (tenant_id, receipt_no, amount_paise, method, reference, paid_on, plan_id, months, period_from, period_to, note, recorded_by)
  VALUES (p_tenant, v_no, p_amount_paise, p_method, p_reference, p_paid_on, p_plan, p_months, v_from, v_to, p_note, 'admin:' || a.email);
  UPDATE tenants SET plan_id = p_plan WHERE id = p_tenant;
  UPDATE subscriptions SET paid_until = v_to WHERE tenant_id = p_tenant;
  PERFORM saas_set_state(p_tenant, 'active', 'admin:' || a.email, 'payment ' || v_no);
  PERFORM platform_log(a, 'platform.payment_recorded', p_tenant,
    jsonb_build_object('receiptNo', v_no, 'amountPaise', p_amount_paise, 'method', p_method, 'reference', p_reference, 'months', p_months, 'planId', p_plan), p_ip);
  receipt_no := v_no; period_from := v_from; period_to := v_to; RETURN NEXT;
END $$;

-- #17: change a store's state by hand: suspend, reactivate, close, reopen. Every change needs a reason.
CREATE FUNCTION platform_set_state(p_hash bytea, p_tenant uuid, p_state text, p_reason text, p_ip text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a platform_admins := platform_admin_of(p_hash); v_from text; v_paid timestamptz;
BEGIN
  IF p_state NOT IN ('active', 'past_due', 'suspended', 'closed') THEN RAISE EXCEPTION 'bad state' USING ERRCODE = '22023'; END IF;
  IF coalesce(length(trim(p_reason)), 0) < 3 THEN RAISE EXCEPTION 'reason required' USING ERRCODE = '22023'; END IF;
  SELECT state, paid_until INTO v_from, v_paid FROM subscriptions WHERE tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store not found' USING ERRCODE = 'P0002'; END IF;
  -- Active without paid time would either never end (never paid) or fall back to past due within minutes.
  IF p_state = 'active' AND (v_paid IS NULL OR v_paid <= now()) THEN
    RAISE EXCEPTION 'this store has no paid time left: record a payment, or set a trial end date' USING ERRCODE = '55000';
  END IF;
  PERFORM saas_set_state(p_tenant, p_state, 'admin:' || a.email, p_reason);
  PERFORM platform_log(a, 'platform.state_changed', p_tenant, jsonb_build_object('from', v_from, 'to', p_state, 'reason', p_reason), p_ip);
END $$;

-- #18: give a store a longer (or shorter) trial; puts it back in trial if it was past due or suspended.
CREATE FUNCTION platform_set_trial(p_hash bytea, p_tenant uuid, p_until timestamptz, p_reason text, p_ip text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a platform_admins := platform_admin_of(p_hash); v_from text;
BEGIN
  IF p_until <= now() OR p_until > now() + interval '366 days' THEN RAISE EXCEPTION 'trial end out of range' USING ERRCODE = '22023'; END IF;
  SELECT state INTO v_from FROM subscriptions WHERE tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store not found' USING ERRCODE = 'P0002'; END IF;
  IF v_from NOT IN ('trial', 'past_due', 'suspended') THEN RAISE EXCEPTION 'only a store in trial, past due or suspended can be given a trial' USING ERRCODE = '55000'; END IF;
  UPDATE subscriptions SET trial_ends_at = p_until WHERE tenant_id = p_tenant;
  PERFORM saas_set_state(p_tenant, 'trial', 'admin:' || a.email, p_reason);
  IF v_from = 'trial' THEN
    INSERT INTO subscription_events (tenant_id, from_state, to_state, actor, reason) VALUES (p_tenant, 'trial', 'trial', 'admin:' || a.email, p_reason);
  END IF;
  PERFORM platform_log(a, 'platform.trial_set', p_tenant, jsonb_build_object('until', p_until, 'reason', p_reason), p_ip);
END $$;

-- #19: change a store's plan (no payment involved, e.g. a downgrade).
CREATE FUNCTION platform_set_plan(p_hash bytea, p_tenant uuid, p_plan text, p_reason text, p_ip text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a platform_admins := platform_admin_of(p_hash); v_old text;
BEGIN
  SELECT plan_id INTO v_old FROM tenants WHERE id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'store not found' USING ERRCODE = 'P0002'; END IF;
  UPDATE tenants SET plan_id = p_plan WHERE id = p_tenant;
  PERFORM platform_log(a, 'platform.plan_changed', p_tenant, jsonb_build_object('from', v_old, 'to', p_plan, 'reason', p_reason), p_ip);
END $$;

-- #20: support view. Only while the owner's grant is live; read-only diagnostics; logged in the console's log AND in the
-- store's own audit log, so the owner sees every look.
CREATE FUNCTION platform_support_view(p_hash bytea, p_tenant uuid, p_ip text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a platform_admins := platform_admin_of(p_hash); g support_grants; r jsonb; v_prev text;
BEGIN
  SELECT * INTO g FROM support_grants x WHERE x.tenant_id = p_tenant AND x.revoked_at IS NULL AND x.expires_at > now()
   ORDER BY x.expires_at DESC LIMIT 1;
  IF g.id IS NULL THEN RAISE EXCEPTION 'no support access granted' USING ERRCODE = '42501', HINT = 'no_grant'; END IF;
  -- Many store tables FORCE row-level security, which binds this function's owner too unless it is a superuser (RDS).
  -- Scope the rest of this call to the one store; the caller's own setting is put back below.
  v_prev := current_setting('app.tenant_id', true);
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT jsonb_build_object(
    'grant', jsonb_build_object('expiresAt', g.expires_at, 'reason', g.reason),
    'counts', jsonb_build_object(
      'products', (SELECT count(*) FROM products WHERE tenant_id = p_tenant),
      'variants', (SELECT count(*) FROM product_variants WHERE tenant_id = p_tenant),
      'locations', (SELECT count(*) FROM locations WHERE tenant_id = p_tenant),
      'users', (SELECT count(*) FROM users WHERE tenant_id = p_tenant),
      'webOrders', (SELECT count(*) FROM sales_orders WHERE tenant_id = p_tenant),
      'invoices', (SELECT count(*) FROM invoices WHERE tenant_id = p_tenant)),
    'woo', (SELECT jsonb_build_object('siteUrl', c.site_url, 'status', c.status, 'lastSuccessAt', c.last_success_at, 'lastError', c.last_error,
                   'lastErrorAt', c.last_error_at, 'webhooksOk', c.webhooks_ok, 'lastReconcile', c.last_reconcile)
              FROM woo_connections c WHERE c.tenant_id = p_tenant),
    'jobs', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', j.kind, 'status', j.status, 'count', j.n, 'oldest', j.oldest))
              FROM (SELECT kind, status, count(*) AS n, min(created_at) AS oldest FROM sync_jobs
                     WHERE tenant_id = p_tenant AND status <> 'done' GROUP BY kind, status) j), '[]'),
    'failedJobs', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', j.kind, 'status', j.status, 'attempts', j.attempts, 'lastError', j.last_error,
              'updatedAt', j.next_attempt_at)) FROM (SELECT * FROM sync_jobs WHERE tenant_id = p_tenant AND status IN ('failed', 'dead')
              ORDER BY id DESC LIMIT 20) j), '[]'),
    'recentAudit', coalesce((SELECT jsonb_agg(jsonb_build_object('action', e.action, 'entityType', e.entity_type, 'at', e.created_at))
              FROM (SELECT * FROM audit_events WHERE tenant_id = p_tenant ORDER BY id DESC LIMIT 30) e), '[]'))
    INTO r;
  INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, summary)
  VALUES (p_tenant, NULL, 'support.viewed', 'support_grant', g.id::text, jsonb_build_object('by', a.email));
  PERFORM platform_log(a, 'platform.support_viewed', p_tenant, jsonb_build_object('grantId', g.id), p_ip);
  PERFORM set_config('app.tenant_id', coalesce(v_prev, ''), true);
  RETURN r;
END $$;

-- #21: the console's own log.
CREATE FUNCTION platform_audit_log(p_hash bytea, p_limit integer)
RETURNS TABLE (id bigint, admin_email text, action text, tenant_id uuid, detail jsonb, ip text, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM platform_admin_of(p_hash);
  RETURN QUERY SELECT x.id, x.admin_email, x.action, x.tenant_id, x.detail, x.ip, x.created_at FROM platform_audit x
                ORDER BY x.id DESC LIMIT least(greatest(p_limit, 1), 500);
END $$;

-- #22: stores holding a finished export past its 7 days, closed stores included, so the ticker deletes the file.
CREATE FUNCTION saas_expired_export_tenants() RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT DISTINCT e.tenant_id FROM data_exports e WHERE e.status = 'ready' AND e.expires_at < now() $$;

REVOKE ALL ON FUNCTION saas_on_tenant_insert(), saas_lifecycle_tick(), saas_live_tenants(), saas_expired_export_tenants(),
  platform_login_lookup(text),
  platform_login_result(uuid, boolean, bigint, bytea, text, text), platform_whoami(bytea), platform_logout(bytea), platform_tenants(bytea),
  platform_tenant(bytea, uuid), platform_record_payment(bytea, uuid, integer, text, text, date, text, integer, text, text),
  platform_set_state(bytea, uuid, text, text, text), platform_set_trial(bytea, uuid, timestamptz, text, text),
  platform_set_plan(bytea, uuid, text, text, text), platform_support_view(bytea, uuid, text), platform_audit_log(bytea, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saas_lifecycle_tick(), saas_live_tenants(), saas_expired_export_tenants(), platform_login_lookup(text),
  platform_login_result(uuid, boolean, bigint, bytea, text, text), platform_whoami(bytea), platform_logout(bytea), platform_tenants(bytea),
  platform_tenant(bytea, uuid), platform_record_payment(bytea, uuid, integer, text, text, date, text, integer, text, text),
  platform_set_state(bytea, uuid, text, text, text), platform_set_trial(bytea, uuid, timestamptz, text, text),
  platform_set_plan(bytea, uuid, text, text, text), platform_support_view(bytea, uuid, text), platform_audit_log(bytea, integer) TO erp_rt;

-- ------------------------------------------------------------------ row-level security
-- ENABLE but not FORCE: the cross-tenant functions above run as the table owner, and on a managed database (RDS) the owner
-- is not a superuser, so FORCE would hide every row from them too. erp_rt is not the owner, so RLS always applies to it.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions', 'subscription_events', 'subscription_payments', 'support_grants', 'data_exports', 'alert_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
                     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
-- Fix for B4 (D74): woo_endpoint_lookup and woo_due_tenants read these two tables across stores. With FORCE they return
-- nothing when migrations run as a non-superuser (RDS), so every webhook would get 404 and the sweeper would never run.
ALTER TABLE woo_connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE woo_outbox NO FORCE ROW LEVEL SECURITY;
-- Platform tables: RLS on with no policy, and no grants, so erp_rt sees nothing even if a grant is added by mistake.
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------ grants (runtime role)
-- 001 gives erp_rt SELECT, INSERT, UPDATE, DELETE on every new table by default. Take back everything B7 never needs.
REVOKE ALL ON platform_admins, platform_sessions, platform_audit FROM erp_rt;
REVOKE ALL ON SEQUENCE platform_audit_id_seq, subscription_receipt_seq FROM erp_rt;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON subscriptions, subscription_events, subscription_payments FROM erp_rt;   -- read only
REVOKE UPDATE, DELETE, TRUNCATE ON alert_log FROM erp_rt;
REVOKE DELETE, TRUNCATE ON support_grants, data_exports FROM erp_rt;
REVOKE UPDATE ON support_grants FROM erp_rt;
GRANT UPDATE (revoked_at, revoked_by) ON support_grants TO erp_rt;
-- Plans are configuration, changed by migrations only.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON plans FROM erp_rt;
-- A store must not be able to change its own plan or Phase 1 status. erp_rt keeps UPDATE on every other tenants column,
-- whatever columns Phase 1 has, so Phase 1's settings screen is unaffected.
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ') INTO cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name NOT IN ('id', 'status', 'plan_id');
  EXECUTE 'REVOKE UPDATE ON tenants FROM erp_rt';
  EXECUTE format('GRANT UPDATE (%s) ON tenants TO erp_rt', cols);
END $$;

-- ------------------------------------------------------------------ backup reader (D79)
-- pg_dump must read every store's rows. On RDS no role can have BYPASSRLS (that needs a real superuser), and FORCE
-- hides rows from the owner too, so the nightly dump runs as a login role in erp_backup, which holds SELECT on
-- everything plus a read-only "see all rows" policy on every RLS table. It can never write.
-- Every later migration that creates a table must end with: SELECT erp_backup_grants();  (a test checks this)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_backup') THEN CREATE ROLE erp_backup NOLOGIN; END IF;
END $$;

CREATE FUNCTION erp_backup_grants() RETURNS void LANGUAGE plpgsql AS $$
DECLARE t text;
BEGIN
  EXECUTE 'GRANT USAGE ON SCHEMA public TO erp_backup';
  EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO erp_backup';
  EXECUTE 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_backup';
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
              AND NOT EXISTS (SELECT FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'backup_read') LOOP
    EXECUTE format('CREATE POLICY backup_read ON %I FOR SELECT TO erp_backup USING (true)', t);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION erp_backup_grants() FROM PUBLIC;
SELECT erp_backup_grants();
