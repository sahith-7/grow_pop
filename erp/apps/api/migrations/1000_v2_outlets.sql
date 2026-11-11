-- GroPop v2 phase 1 · outlets: several shops inside one store account (D101).
--
-- An outlet is one shop: its own address, stock rooms (locations), POS stock location and bill series. Every store has a
-- main outlet, made here for existing stores and on first use for new ones; its address, GSTIN, bill prefixes and POS
-- location stay where they always were (Settings, Billing & GST), so nothing changes for a store with one shop.
-- Outlets in another state carry their own GSTIN (GST registration is per state). Extra outlets are a paid add-on: the
-- platform console sets how many a store may have (subscriptions.extra_outlets).

CREATE TABLE outlets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  is_main            boolean NOT NULL DEFAULT false,
  active             boolean NOT NULL DEFAULT true,
  address            text CHECK (length(address) BETWEEN 1 AND 300),
  city               text CHECK (length(city) <= 80),
  state_code         text CHECK (state_code ~ '^[0-9]{2}$'),
  postal_code        text CHECK (postal_code ~ '^[1-9][0-9]{5}$'),
  phone              text CHECK (length(phone) <= 20),
  gstin              text CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  invoice_prefix     text CHECK (invoice_prefix ~ '^[A-Za-z0-9-]{1,6}$'),
  credit_note_prefix text CHECK (credit_note_prefix ~ '^[A-Za-z0-9-]{1,6}$'),
  pos_location_id    uuid,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  -- The main outlet's details are the store's own settings; every other outlet needs its own.
  CHECK (is_main OR (address IS NOT NULL AND state_code IS NOT NULL AND invoice_prefix IS NOT NULL AND credit_note_prefix IS NOT NULL)),
  CHECK (NOT is_main OR active),
  CHECK (gstin IS NULL OR state_code IS NULL OR left(gstin, 2) = state_code)
);
CREATE UNIQUE INDEX outlets_one_main ON outlets (tenant_id) WHERE is_main;
CREATE UNIQUE INDEX outlets_name_uq ON outlets (tenant_id, lower(name));
CREATE UNIQUE INDEX outlets_invoice_prefix_uq ON outlets (tenant_id, upper(invoice_prefix)) WHERE invoice_prefix IS NOT NULL;
CREATE UNIQUE INDEX outlets_cn_prefix_uq ON outlets (tenant_id, upper(credit_note_prefix)) WHERE credit_note_prefix IS NOT NULL;

INSERT INTO outlets (tenant_id, name, is_main) SELECT id, 'Main outlet', true FROM tenants;

/** The store's main outlet, made on first use (a store signed up after this migration has none until something asks). */
CREATE FUNCTION main_outlet_id(p_tenant uuid) RETURNS uuid LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE v uuid;
BEGIN
  SELECT id INTO v FROM outlets WHERE tenant_id = p_tenant AND is_main;
  IF v IS NULL THEN
    INSERT INTO outlets (tenant_id, name, is_main) VALUES (p_tenant, 'Main outlet', true)
      ON CONFLICT (tenant_id) WHERE is_main DO NOTHING RETURNING id INTO v;
    IF v IS NULL THEN SELECT id INTO v FROM outlets WHERE tenant_id = p_tenant AND is_main; END IF;
  END IF;
  RETURN v;
END $$;

-- A location or a bill series made without an outlet (every insert written before outlets existed) belongs to the main one.
CREATE FUNCTION default_outlet() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.outlet_id IS NULL THEN NEW.outlet_id := main_outlet_id(NEW.tenant_id); END IF;
  RETURN NEW;
END $$;

-- ------------------------------------------------------------------ stock rooms and bill series belong to an outlet
-- The table owner skips RLS only without FORCE, so the backfill turns FORCE off for its own UPDATE and back on.
ALTER TABLE locations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE locations ADD COLUMN outlet_id uuid;
UPDATE locations l SET outlet_id = o.id FROM outlets o WHERE o.tenant_id = l.tenant_id AND o.is_main;
ALTER TABLE locations ALTER COLUMN outlet_id SET NOT NULL,
  ADD FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id);
ALTER TABLE locations FORCE ROW LEVEL SECURITY;
CREATE INDEX locations_outlet_idx ON locations (tenant_id, outlet_id);
CREATE TRIGGER locations_default_outlet BEFORE INSERT ON locations FOR EACH ROW EXECUTE FUNCTION default_outlet();

-- One series per outlet, document type and financial year. Numbers stay unique per store and year (invoices' own key),
-- which the different prefixes guarantee.
ALTER TABLE invoice_series NO FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_series ADD COLUMN outlet_id uuid;
UPDATE invoice_series s SET outlet_id = o.id FROM outlets o WHERE o.tenant_id = s.tenant_id AND o.is_main;
ALTER TABLE invoice_series ALTER COLUMN outlet_id SET NOT NULL,
  ADD FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  DROP CONSTRAINT invoice_series_tenant_id_doc_type_financial_year_key,
  ADD CONSTRAINT invoice_series_outlet_doc_year_key UNIQUE (tenant_id, outlet_id, doc_type, financial_year);
ALTER TABLE invoice_series FORCE ROW LEVEL SECURITY;
CREATE TRIGGER invoice_series_default_outlet BEFORE INSERT ON invoice_series FOR EACH ROW EXECUTE FUNCTION default_outlet();

ALTER TABLE outlets ADD FOREIGN KEY (tenant_id, pos_location_id) REFERENCES locations (tenant_id, id);

-- ------------------------------------------------------------------ who works where
-- Owners and managers work at every outlet. Anyone else with rows here sells only at those outlets; with none, at all
-- of them (so staff added before outlets keep working).
CREATE TABLE user_outlets (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL,
  outlet_id  uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, outlet_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id)
);
CREATE INDEX user_outlets_outlet_idx ON user_outlets (tenant_id, outlet_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outlets', 'user_outlets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
                     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Outlets are closed, never deleted: bills and stock rooms point at them. Assignments come and go.
REVOKE DELETE, TRUNCATE ON outlets FROM erp_rt;
REVOKE TRUNCATE ON user_outlets FROM erp_rt;
REVOKE UPDATE ON user_outlets FROM erp_rt;
REVOKE ALL ON FUNCTION main_outlet_id(uuid), default_outlet() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION main_outlet_id(uuid), default_outlet() TO erp_rt;

-- ------------------------------------------------------------------ the paid limit
-- One outlet is included; each extra one is paid for and switched on in the console. Read-only for the app (0600 revoked
-- UPDATE on subscriptions from erp_rt, and that covers new columns).
ALTER TABLE subscriptions ADD COLUMN extra_outlets integer NOT NULL DEFAULT 0 CHECK (extra_outlets BETWEEN 0 AND 50);
-- Placeholder price per extra outlet a month (D101): change it with a migration, like the plan prices (D67).
ALTER TABLE plans ADD COLUMN outlet_price_month_paise integer CHECK (outlet_price_month_paise >= 0);
UPDATE plans SET outlet_price_month_paise = 49900;

-- #23: how many extra outlets a store may have. Lowering it below what the store has open is refused.
CREATE FUNCTION platform_set_outlets(p_hash bytea, p_tenant uuid, p_extra integer, p_reason text, p_ip text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a platform_admins := platform_admin_of(p_hash); v_old integer; v_open integer; v_prev text;
BEGIN
  IF p_extra IS NULL OR p_extra < 0 OR p_extra > 50 THEN RAISE EXCEPTION 'extra outlets must be 0 to 50' USING ERRCODE = '22023'; END IF;
  IF coalesce(length(trim(p_reason)), 0) < 3 THEN RAISE EXCEPTION 'reason required' USING ERRCODE = '22023'; END IF;
  SELECT extra_outlets INTO v_old FROM subscriptions WHERE tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store not found' USING ERRCODE = 'P0002'; END IF;
  v_prev := current_setting('app.tenant_id', true);
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT count(*) INTO v_open FROM outlets WHERE tenant_id = p_tenant AND active;
  PERFORM set_config('app.tenant_id', coalesce(v_prev, ''), true);
  IF 1 + p_extra < v_open THEN
    RAISE EXCEPTION 'this store has % open outlets; the owner must close some first', v_open USING ERRCODE = '55000';
  END IF;
  UPDATE subscriptions SET extra_outlets = p_extra WHERE tenant_id = p_tenant;
  PERFORM platform_log(a, 'platform.outlets_changed', p_tenant, jsonb_build_object('from', v_old, 'to', p_extra, 'reason', p_reason), p_ip);
END $$;

-- #24: a store's outlets for the console: names and whether each is open. No addresses, no business data.
CREATE FUNCTION platform_tenant_outlets(p_hash bytea, p_tenant uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r jsonb; v_prev text;
BEGIN
  PERFORM platform_admin_of(p_hash);
  v_prev := current_setting('app.tenant_id', true);
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT jsonb_build_object(
    'extraOutlets', (SELECT extra_outlets FROM subscriptions WHERE tenant_id = p_tenant),
    'outlets', coalesce((SELECT jsonb_agg(jsonb_build_object('name', o.name, 'main', o.is_main, 'active', o.active, 'createdAt', o.created_at)
                         ORDER BY NOT o.is_main, o.created_at) FROM outlets o WHERE o.tenant_id = p_tenant), '[]'))
    INTO r;
  PERFORM set_config('app.tenant_id', coalesce(v_prev, ''), true);
  RETURN r;
END $$;

REVOKE ALL ON FUNCTION platform_set_outlets(bytea, uuid, integer, text, text), platform_tenant_outlets(bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_set_outlets(bytea, uuid, integer, text, text), platform_tenant_outlets(bytea, uuid) TO erp_rt;

SELECT erp_backup_grants();
