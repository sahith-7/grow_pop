-- B4 · WooCommerce: connection, product/variant mappings, webhook inbox, change outbox, web orders and stock reservations.
-- Conventions: docs/design/03-data-model.md §3.6, §3.8; 06-security-and-backup.md T2–T4, T11. Grants at the end of this file.

-- ------------------------------------------------------------------ connection (TEN-04/05, A-01: one shop per tenant)
CREATE TABLE woo_connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL UNIQUE REFERENCES tenants(id),
  site_url            text NOT NULL CHECK (site_url ~ '^https?://[^/?#]+(/[^?#]*)?$'),
  key_hint            text NOT NULL,                       -- 'ck_…3f2a'; the only part of the key the API ever returns
  key_enc             bytea,                               -- AES-256-GCM (lib/secret-box.ts); NULL after disconnect
  secret_enc          bytea,
  webhook_secret_enc  bytea,
  endpoint_token_hash bytea UNIQUE,                        -- sha256 of the random token in the webhook URL (D17)
  status              text NOT NULL CHECK (status IN ('connected', 'error', 'disconnected')),
  woo_version         text,
  currency            text,
  weight_unit         text,
  dimension_unit      text,
  prices_include_tax  boolean,
  online_location_id  uuid NOT NULL,                       -- web orders reserve here; Woo is shown what is available here (D20)
  webhook_ids         jsonb NOT NULL DEFAULT '{}',          -- topic -> Woo webhook id
  webhooks_ok         boolean,                             -- last reconcile found all of them active (Woo disables a webhook after repeated failures)
  connected_by        uuid NOT NULL,
  connected_at        timestamptz NOT NULL DEFAULT now(),
  last_success_at     timestamptz,
  last_error          text,
  last_error_at       timestamptz,
  orders_synced_to    timestamptz,                         -- reconcile pulls orders modified after this (minus overlap)
  reconcile_due_at    timestamptz NOT NULL DEFAULT now(),
  last_reconcile      jsonb,                               -- what the last reconcile run found and fixed (AC-12)
  match_state         text NOT NULL DEFAULT 'not_started' CHECK (match_state IN ('not_started', 'running', 'ready', 'confirmed', 'failed')),
  match_result        jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, online_location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, connected_by) REFERENCES users (tenant_id, id),
  CONSTRAINT secrets_only_when_connected CHECK (status = 'disconnected' OR (key_enc IS NOT NULL AND secret_enc IS NOT NULL AND webhook_secret_enc IS NOT NULL))
);

-- ------------------------------------------------------------------ mappings (ERP id <-> Woo id)
CREATE TABLE woo_product_map (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  product_id      uuid NOT NULL,
  woo_product_id  bigint NOT NULL,
  woo_type        text NOT NULL CHECK (woo_type IN ('simple', 'variable')),
  state           text NOT NULL DEFAULT 'linked' CHECK (state IN ('linked', 'deleted_in_woo')),
  last_pushed_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id),
  UNIQUE (tenant_id, woo_product_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

CREATE TABLE woo_variant_map (
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  variant_id        uuid NOT NULL,
  woo_product_id    bigint NOT NULL,
  woo_variation_id  bigint NOT NULL DEFAULT 0,             -- 0 = the variant is a simple product
  last_pushed_stock integer,                               -- what Woo was last told; skips pushes that change nothing
  last_pushed_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, variant_id),
  UNIQUE (tenant_id, woo_product_id, woo_variation_id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants (tenant_id, id)
);

CREATE TABLE woo_category_map (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  category_id     uuid NOT NULL,
  woo_category_id bigint NOT NULL,
  PRIMARY KEY (tenant_id, category_id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id)
);

ALTER TABLE product_images ADD COLUMN woo_file_id uuid;     -- the file woo_media_id was uploaded from; a new file = a new upload

-- ------------------------------------------------------------------ webhook inbox (AC-08)
CREATE TABLE webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  event_key     text NOT NULL,                              -- topic + sha256 of the raw body: a replay is a no-op
  topic         text NOT NULL,
  resource_id   bigint,
  delivery_id   text,
  payload       jsonb,                                      -- purged after 90 days (customer PII, T12)
  status        text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed', 'ignored_stale', 'ignored')),
  last_error    text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  UNIQUE (tenant_id, event_key),
  UNIQUE (tenant_id, id)
);
CREATE INDEX webhook_events_list_idx ON webhook_events (tenant_id, received_at DESC);

-- ------------------------------------------------------------------ change outbox
-- Triggers below add a row when something Woo shows changes. The worker turns rows into sync jobs.
-- Plain inserts with no unique key, so stock postings never wait on each other here.
CREATE TABLE woo_outbox (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  kind       text NOT NULL CHECK (kind IN ('product', 'stock')),
  ref_id     uuid NOT NULL,                                 -- product id or variant id
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX woo_outbox_tenant_idx ON woo_outbox (tenant_id, kind, id);

-- ------------------------------------------------------------------ customers and orders (B4 web orders; B5 extends for POS)
CREATE TABLE customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  name             text NOT NULL DEFAULT '' CHECK (length(name) <= 200),
  phone            text CHECK (length(phone) <= 30),
  email            text CHECK (length(email) <= 254),
  woo_customer_id  bigint,
  billing_address  jsonb,
  shipping_address jsonb,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX customers_woo_uq ON customers (tenant_id, woo_customer_id) WHERE woo_customer_id IS NOT NULL;

CREATE TABLE sales_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  number            text NOT NULL,
  channel           text NOT NULL CHECK (channel IN ('pos', 'woocommerce')),
  external_id       text,
  woo_status        text,
  woo_modified_at   timestamptz,
  status            text NOT NULL CHECK (status IN ('awaiting_payment', 'on_hold', 'paid', 'stock_exception', 'ready_to_pick', 'picking',
                      'packed', 'dispatched', 'completed', 'cancelled', 'failed', 'refunded', 'needs_review')),
  payment_state     text NOT NULL CHECK (payment_state IN ('awaiting', 'paid', 'failed', 'refunded', 'partially_refunded')),
  payment_method    text,
  exception_reason  text,
  customer_id       uuid,
  customer_snapshot jsonb NOT NULL DEFAULT '{}',
  subtotal          numeric(14,2) NOT NULL DEFAULT 0,
  discount_total    numeric(14,2) NOT NULL DEFAULT 0,
  shipping_total    numeric(14,2) NOT NULL DEFAULT 0,
  tax_total         numeric(14,2) NOT NULL DEFAULT 0,
  total             numeric(14,2) NOT NULL DEFAULT 0,
  currency          char(3) NOT NULL DEFAULT 'INR',
  placed_at         timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel, external_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
CREATE INDEX sales_orders_list_idx ON sales_orders (tenant_id, placed_at DESC, id);
CREATE INDEX sales_orders_status_idx ON sales_orders (tenant_id, status, placed_at);

CREATE TABLE sales_order_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  order_id         uuid NOT NULL,
  position         integer NOT NULL,
  variant_id       uuid,                                    -- NULL: the Woo SKU matches nothing in the ERP
  woo_line_id      bigint,
  woo_product_id   bigint,
  woo_variation_id bigint,
  sku              text NOT NULL DEFAULT '',
  name             text NOT NULL,
  qty              numeric(14,3) NOT NULL CHECK (qty >= 0),  -- 0 = removed from the order in Woo
  unit_price       numeric(14,4) NOT NULL DEFAULT 0,
  line_total       numeric(14,2) NOT NULL DEFAULT 0,
  tax_total        numeric(14,2) NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (order_id, woo_line_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants (tenant_id, id)
);
CREATE INDEX sales_order_lines_order_idx ON sales_order_lines (tenant_id, order_id, position);

-- What happened to an order, for the order screen. Append-only.
CREATE TABLE sales_order_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  order_id   uuid NOT NULL,
  kind       text NOT NULL,
  message    text NOT NULL,
  actor_id   uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id)
);
CREATE INDEX sales_order_events_order_idx ON sales_order_events (tenant_id, order_id, id);

-- ------------------------------------------------------------------ reservations (D3, D20, INV-01)
-- stock_balances.reserved is always the sum of active rows here (v_reservation_reconciliation).
CREATE TABLE stock_reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  order_id      uuid NOT NULL,
  order_line_id uuid NOT NULL,
  variant_id    uuid NOT NULL,
  location_id   uuid NOT NULL,
  qty           numeric(14,3) NOT NULL CHECK (qty > 0),
  state         text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'released', 'converted')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES sales_order_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  CHECK ((state = 'active') = (closed_at IS NULL))
);
CREATE UNIQUE INDEX stock_reservations_active_line_uq ON stock_reservations (order_line_id) WHERE state = 'active';
CREATE INDEX stock_reservations_order_idx ON stock_reservations (tenant_id, order_id);

CREATE VIEW v_reservation_reconciliation WITH (security_invoker = true) AS
SELECT b.variant_id, b.location_id, b.reserved, coalesce(r.qty, 0) AS active_reservations
  FROM stock_balances b
  LEFT JOIN (SELECT variant_id, location_id, sum(qty) AS qty FROM stock_reservations WHERE state = 'active'
              GROUP BY variant_id, location_id) r ON r.variant_id = b.variant_id AND r.location_id = b.location_id
 WHERE b.reserved <> coalesce(r.qty, 0);

-- ------------------------------------------------------------------ B2/B3 tables B4 extends
ALTER TABLE sync_jobs DROP CONSTRAINT sync_jobs_kind_check;
ALTER TABLE sync_jobs ADD CONSTRAINT sync_jobs_kind_check
  CHECK (kind IN ('import', 'woo.product', 'woo.stock', 'woo.inbound', 'woo.reconcile', 'woo.match'));

-- A web order completed in WooCommerce leaves the shop: the ledger records it against the order, with no human actor.
ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_source_type_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_source_type_check
  CHECK (source_type IN ('adjustment', 'transfer', 'stocktake', 'goods_receipt', 'supplier_return', 'sales_order'));
ALTER TABLE stock_ledger ALTER COLUMN posted_by DROP NOT NULL;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_actor_check CHECK (posted_by IS NOT NULL OR source_type = 'sales_order');

-- ------------------------------------------------------------------ change capture triggers
-- SECURITY INVOKER: they run as the caller under RLS, so they only ever see the caller's tenant.

-- Stock: only changes at the online location, only for variants that are on the website.
CREATE FUNCTION woo_outbox_stock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM woo_variant_map m WHERE m.tenant_id = NEW.tenant_id AND m.variant_id = NEW.variant_id)
     AND EXISTS (SELECT 1 FROM woo_connections c WHERE c.tenant_id = NEW.tenant_id AND c.status <> 'disconnected'
                                                   AND c.online_location_id = NEW.location_id) THEN
    INSERT INTO woo_outbox (tenant_id, kind, ref_id) VALUES (NEW.tenant_id, 'stock', NEW.variant_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER woo_outbox_stock AFTER UPDATE OF on_hand, reserved ON stock_balances FOR EACH ROW
  WHEN (OLD.on_hand IS DISTINCT FROM NEW.on_hand OR OLD.reserved IS DISTINCT FROM NEW.reserved)
  EXECUTE FUNCTION woo_outbox_stock();

-- Products: anything Woo shows, for products marked for the website or already on it.
CREATE FUNCTION woo_outbox_product(p_tenant uuid, p_product uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM woo_connections c WHERE c.tenant_id = p_tenant AND c.status <> 'disconnected')
     AND (EXISTS (SELECT 1 FROM products p WHERE p.id = p_product AND p.publish_to_web)
          OR EXISTS (SELECT 1 FROM woo_product_map m WHERE m.tenant_id = p_tenant AND m.product_id = p_product)) THEN
    INSERT INTO woo_outbox (tenant_id, kind, ref_id) VALUES (p_tenant, 'product', p_product);
  END IF;
END $$;

CREATE FUNCTION woo_outbox_products() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM woo_outbox_product(NEW.tenant_id, NEW.id); RETURN NULL; END $$;
CREATE TRIGGER woo_outbox_products_ins AFTER INSERT ON products FOR EACH ROW EXECUTE FUNCTION woo_outbox_products();
CREATE TRIGGER woo_outbox_products_upd AFTER UPDATE OF name, description, category_id, status, publish_to_web, archived_at ON products
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.description IS DISTINCT FROM NEW.description
                     OR OLD.category_id IS DISTINCT FROM NEW.category_id OR OLD.status IS DISTINCT FROM NEW.status
                     OR OLD.publish_to_web IS DISTINCT FROM NEW.publish_to_web OR OLD.archived_at IS DISTINCT FROM NEW.archived_at)
  EXECUTE FUNCTION woo_outbox_products();

CREATE FUNCTION woo_outbox_variants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM woo_outbox_product(NEW.tenant_id, NEW.product_id); RETURN NULL; END $$;
CREATE TRIGGER woo_outbox_variants_ins AFTER INSERT ON product_variants FOR EACH ROW EXECUTE FUNCTION woo_outbox_variants();
CREATE TRIGGER woo_outbox_variants_upd AFTER UPDATE OF sku, attributes, price, status, weight_g, length_mm, width_mm, height_mm, position, archived_at
  ON product_variants FOR EACH ROW
  WHEN (OLD.sku IS DISTINCT FROM NEW.sku OR OLD.attributes IS DISTINCT FROM NEW.attributes OR OLD.price IS DISTINCT FROM NEW.price
        OR OLD.status IS DISTINCT FROM NEW.status OR OLD.weight_g IS DISTINCT FROM NEW.weight_g OR OLD.length_mm IS DISTINCT FROM NEW.length_mm
        OR OLD.width_mm IS DISTINCT FROM NEW.width_mm OR OLD.height_mm IS DISTINCT FROM NEW.height_mm
        OR OLD.position IS DISTINCT FROM NEW.position OR OLD.archived_at IS DISTINCT FROM NEW.archived_at)
  EXECUTE FUNCTION woo_outbox_variants();

-- Images: the worker's own sync_state / woo_media_id writes are not in the column list, so they never loop.
CREATE FUNCTION woo_outbox_images() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM woo_outbox_product(r.tenant_id, r.product_id);
  RETURN NULL;
END $$;
CREATE TRIGGER woo_outbox_images_ins_del AFTER INSERT OR DELETE ON product_images FOR EACH ROW EXECUTE FUNCTION woo_outbox_images();
CREATE TRIGGER woo_outbox_images_upd AFTER UPDATE OF file_id, variant_id, sort_order, is_primary, alt_text ON product_images
  FOR EACH ROW EXECUTE FUNCTION woo_outbox_images();

-- ------------------------------------------------------------------ cross-tenant functions (04-tenancy-and-permissions.md §1.3, T11)
-- #5: the webhook route knows only the token from its URL. Returns ids only.
CREATE FUNCTION woo_endpoint_lookup(p_hash bytea) RETURNS TABLE (tenant_id uuid, connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT c.tenant_id, c.id FROM woo_connections c WHERE c.endpoint_token_hash = p_hash AND c.status <> 'disconnected' $$;

-- #6: tenants the worker's sweeper has to look at (outbox rows waiting, or a reconcile due). Returns ids only.
CREATE FUNCTION woo_due_tenants(n integer) RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.tenant_id FROM (
    SELECT DISTINCT o.tenant_id FROM woo_outbox o
    UNION
    SELECT c.tenant_id FROM woo_connections c WHERE c.status <> 'disconnected' AND c.reconcile_due_at <= now()
  ) t LIMIT least(greatest(n, 1), 500)
$$;

REVOKE ALL ON FUNCTION woo_endpoint_lookup(bytea), woo_due_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION woo_endpoint_lookup(bytea), woo_due_tenants(integer) TO erp_rt;

-- ------------------------------------------------------------------ row-level security (same template as 0100/0200, D26)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['woo_connections', 'woo_product_map', 'woo_variant_map', 'woo_category_map', 'webhook_events', 'woo_outbox',
                           'customers', 'sales_orders', 'sales_order_lines', 'sales_order_events', 'stock_reservations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
                     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ------------------------------------------------------------------ grants (runtime role)
-- 001 gives erp_rt SELECT, INSERT, UPDATE, DELETE on every new table by default. Take back what B4 never needs.
REVOKE UPDATE, DELETE ON sales_order_events FROM erp_rt;                                  -- append-only timeline
REVOKE DELETE ON woo_connections, customers, sales_orders, sales_order_lines,
                 stock_reservations, webhook_events FROM erp_rt;                          -- disconnect wipes secrets; nothing is deleted
REVOKE UPDATE ON woo_outbox FROM erp_rt;                                                  -- rows are inserted, then deleted once handled
-- The three map tables keep DELETE: connecting a different shop, or a product deleted in Woo, unlinks and starts again.
REVOKE INSERT, UPDATE, DELETE ON v_reservation_reconciliation FROM erp_rt;
