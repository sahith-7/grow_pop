-- B2 · Catalog: files, categories, brands, units, products, variants, images, barcodes,
-- CSV imports, the background job table and idempotency keys.
-- Conventions: docs/design/03-data-model.md §1. Tenant isolation: docs/design/04-tenancy-and-permissions.md.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ------------------------------------------------------------------ units (global, read-only)
-- GST invoices must print a Unique Quantity Code (UQC), so units are a fixed national list, not tenant data.
CREATE TABLE units (
  code           text PRIMARY KEY,               -- GST UQC
  name           text NOT NULL,
  abbr           text NOT NULL UNIQUE,
  allow_fraction boolean NOT NULL
);
INSERT INTO units (code, name, abbr, allow_fraction) VALUES
  ('NOS', 'Pieces',     'pcs',  false),
  ('BOX', 'Box',        'box',  false),
  ('PAC', 'Pack',       'pack', false),
  ('PRS', 'Pair',       'pair', false),
  ('SET', 'Set',        'set',  false),
  ('DOZ', 'Dozen',      'doz',  false),
  ('BTL', 'Bottle',     'btl',  false),
  ('ROL', 'Roll',       'roll', false),
  ('KGS', 'Kilogram',   'kg',   true),
  ('GMS', 'Gram',       'g',    true),
  ('LTR', 'Litre',      'l',    true),
  ('MLT', 'Millilitre', 'ml',   true),
  ('MTR', 'Metre',      'm',    true),
  ('CMS', 'Centimetre', 'cm',   true);

-- ------------------------------------------------------------------ files
CREATE TABLE files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  kind          text NOT NULL CHECK (kind IN ('product_image', 'import')),
  object_key    text NOT NULL UNIQUE,
  content_type  text NOT NULL,
  byte_size     bigint NOT NULL CHECK (byte_size > 0),
  sha256        text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  original_name text,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- ------------------------------------------------------------------ categories, brands
CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  parent_id   uuid,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES categories (tenant_id, id),
  CHECK (parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX categories_name_uq ON categories (tenant_id, lower(name), coalesce(parent_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE brands (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX brands_name_uq ON brands (tenant_id, lower(name));

-- ------------------------------------------------------------------ products, variants
CREATE TABLE products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description    text NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  category_id    uuid,
  brand_id       uuid,
  unit_code      text NOT NULL DEFAULT 'NOS' REFERENCES units(code),
  type           text NOT NULL CHECK (type IN ('simple', 'variable')),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  hsn_code       text CHECK (hsn_code ~ '^[0-9]{4,8}$'),
  gst_rate       numeric(5,2) CHECK (gst_rate >= 0 AND gst_rate <= 100),
  tracking       text NOT NULL DEFAULT 'none' CHECK (tracking IN ('none', 'batch', 'serial')),
  publish_to_web boolean NOT NULL DEFAULT false,
  publish_state  text NOT NULL DEFAULT 'not_published'
                 CHECK (publish_state IN ('not_published', 'queued', 'synced', 'failed', 'needs_review')),
  publish_error  text,
  version        integer NOT NULL DEFAULT 1,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands (tenant_id, id)
);
CREATE INDEX products_list_idx ON products (tenant_id, status, lower(name), id);
CREATE INDEX products_name_trgm ON products USING gin (lower(name) gin_trgm_ops);
CREATE INDEX products_category_idx ON products (tenant_id, category_id);
CREATE INDEX products_brand_idx ON products (tenant_id, brand_id);

CREATE TABLE product_variants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  product_id    uuid NOT NULL,
  sku           text NOT NULL CHECK (length(sku) BETWEEN 1 AND 64),
  barcode       text CHECK (barcode ~ '^[0-9A-Za-z-]{4,64}$'),
  attributes    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(attributes) = 'object'),
  price         numeric(14,4) NOT NULL CHECK (price >= 0),
  mrp           numeric(14,4) CHECK (mrp >= 0),
  cost          numeric(14,4) CHECK (cost >= 0),
  weight_g      integer CHECK (weight_g >= 0),
  length_mm     integer CHECK (length_mm >= 0),
  width_mm      integer CHECK (width_mm >= 0),
  height_mm     integer CHECK (height_mm >= 0),
  reorder_level numeric(14,3) CHECK (reorder_level >= 0),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  position      integer NOT NULL DEFAULT 0,      -- display order within the product (S, M, L, not alphabetical)
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  -- Legal Metrology: a retailer may not charge more than the printed MRP.
  CONSTRAINT variant_price_within_mrp CHECK (mrp IS NULL OR price <= mrp)
);
CREATE UNIQUE INDEX variants_sku_uq ON product_variants (tenant_id, lower(sku));
CREATE UNIQUE INDEX variants_barcode_uq ON product_variants (tenant_id, barcode) WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX variants_attributes_uq ON product_variants (product_id, attributes);
CREATE INDEX variants_product_idx ON product_variants (tenant_id, product_id);

CREATE TABLE product_images (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  product_id    uuid NOT NULL,
  variant_id    uuid,
  file_id       uuid NOT NULL,
  thumb_file_id uuid,
  sort_order    integer NOT NULL DEFAULT 0,
  is_primary    boolean NOT NULL DEFAULT false,
  alt_text      text NOT NULL DEFAULT '' CHECK (length(alt_text) <= 200),
  sync_state    text NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending', 'synced', 'failed')),
  woo_media_id  bigint,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants (tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES files (tenant_id, id),
  FOREIGN KEY (tenant_id, thumb_file_id) REFERENCES files (tenant_id, id)
);
CREATE UNIQUE INDEX product_images_primary_uq ON product_images (product_id) WHERE is_primary;
CREATE INDEX product_images_product_idx ON product_images (tenant_id, product_id, sort_order);

-- In-store EAN-13: prefix (200–299 is GS1's restricted-circulation range) + 9-digit sequence + check digit.
CREATE TABLE barcode_sequences (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id),
  prefix     text NOT NULL DEFAULT '200' CHECK (prefix ~ '^2[0-9]{2}$'),
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value BETWEEN 1 AND 999999999)
);

-- ------------------------------------------------------------------ imports
CREATE TABLE import_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  kind          text NOT NULL CHECK (kind IN ('products')),
  file_id       uuid NOT NULL,
  mapping       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'validating'
                CHECK (status IN ('validating', 'validated', 'importing', 'done', 'failed')),
  total_rows    integer NOT NULL DEFAULT 0,
  valid_rows    integer NOT NULL DEFAULT 0,
  error_rows    integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  errors        jsonb NOT NULL DEFAULT '[]',   -- [{row, column, message}], capped
  failure       text,                           -- whole-file failure (bad header, too many rows)
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES files (tenant_id, id)
);
CREATE INDEX import_jobs_list_idx ON import_jobs (tenant_id, created_at DESC);

-- ------------------------------------------------------------------ background jobs (D15, D21)
CREATE TABLE sync_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  kind            text NOT NULL CHECK (kind IN ('import')),   -- B4 extends this list
  resource_id     uuid NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'dead')),
  priority        smallint NOT NULL DEFAULT 5,
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 8,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_by       text,
  locked_at       timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  done_at         timestamptz
);
CREATE UNIQUE INDEX sync_jobs_pending_uq ON sync_jobs (tenant_id, kind, resource_id) WHERE status = 'pending';
CREATE INDEX sync_jobs_due_idx ON sync_jobs (priority, next_attempt_at) WHERE status = 'pending';
CREATE INDEX sync_jobs_running_idx ON sync_jobs (locked_at) WHERE status = 'running';

-- Wake workers when a job is queued. NOTIFY is delivered on commit, so a rolled-back enqueue never wakes anyone.
CREATE FUNCTION sync_jobs_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_notify('jobs', NEW.kind); RETURN NULL; END $$;
CREATE TRIGGER sync_jobs_notify AFTER INSERT ON sync_jobs FOR EACH ROW EXECUTE FUNCTION sync_jobs_notify();

-- Cross-tenant function #4 (04-tenancy-and-permissions.md). Returns ids only, never business data.
-- Claims due jobs and reclaims jobs whose worker stopped heartbeating for 5 minutes.
CREATE FUNCTION claim_jobs(worker text, n integer)
RETURNS TABLE (id uuid, tenant_id uuid, kind text, resource_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE sync_jobs j
     SET status = 'running', locked_by = worker, locked_at = now(), attempts = j.attempts + 1
   WHERE j.id IN (
     SELECT s.id FROM sync_jobs s
      WHERE (s.status = 'pending' AND s.next_attempt_at <= now())
         OR (s.status = 'running' AND s.locked_at < now() - interval '5 minutes')
      ORDER BY s.priority, s.next_attempt_at
      LIMIT least(greatest(n, 1), 50)
      FOR UPDATE SKIP LOCKED)
  RETURNING j.id, j.tenant_id, j.kind, j.resource_id
$$;
REVOKE ALL ON FUNCTION claim_jobs(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_jobs(text, integer) TO erp_rt;

-- ------------------------------------------------------------------ idempotency keys (shared)
CREATE TABLE idempotency_keys (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  key          uuid NOT NULL,
  request_hash text NOT NULL,
  status_code  integer,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- ------------------------------------------------------------------ row-level security
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['files', 'categories', 'brands', 'products', 'product_variants', 'product_images',
                           'barcode_sequences', 'import_jobs', 'idempotency_keys', 'sync_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- nullif: once a pooled connection has run a tenantTx, the unset setting reads as '' (not NULL) and ''::uuid
    -- would raise an error instead of matching zero rows.
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
                     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    -- sync_jobs is the one table without FORCE: claim_jobs() runs as the owner and must see every tenant's queue.
    IF t <> 'sync_jobs' THEN EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t); END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------------ grants (runtime role)
GRANT SELECT ON units TO erp_rt;
GRANT SELECT, INSERT ON files TO erp_rt;
GRANT SELECT, INSERT, UPDATE ON categories, brands, products, product_variants, barcode_sequences,
                                import_jobs, idempotency_keys, sync_jobs TO erp_rt;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_images TO erp_rt;
