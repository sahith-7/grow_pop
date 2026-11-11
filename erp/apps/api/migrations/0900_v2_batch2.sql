-- GroPop v2 batch 2 · bill formats, label defaults, bulk price updates (D97–D100).

-- Store-wide print choices, beside the other billing settings. bill_format is what the POS prints after a sale and what an
-- invoice page opens with (D99). label_settings holds the label screen's defaults (D98); the API validates its shape.
ALTER TABLE sales_settings
  ADD COLUMN bill_format    text  NOT NULL DEFAULT '80mm' CHECK (bill_format IN ('57mm', '80mm', 'a4', 'a5')),
  ADD COLUMN label_settings jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(label_settings) = 'object' AND pg_column_size(label_settings) < 8192);

-- ------------------------------------------------------------------ bulk price updates (D97)
-- One row per run, with every changed variant's old and new values, so a run can be checked later and undone.
CREATE TABLE price_updates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  source        text NOT NULL CHECK (source IN ('rule', 'sheet')),
  description   text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  variant_count integer NOT NULL CHECK (variant_count > 0),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  undone_at     timestamptz,
  undone_by     uuid,
  undone_count  integer CHECK (undone_count >= 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, undone_by) REFERENCES users (tenant_id, id),
  CHECK ((undone_at IS NULL) = (undone_by IS NULL))
);
CREATE INDEX price_updates_recent_idx ON price_updates (tenant_id, created_at DESC);

CREATE TABLE price_update_lines (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  update_id  uuid NOT NULL,
  variant_id uuid NOT NULL,
  old_price  numeric(14,4) NOT NULL,
  new_price  numeric(14,4) NOT NULL,
  old_mrp    numeric(14,4),
  new_mrp    numeric(14,4),
  old_cost   numeric(14,4),
  new_cost   numeric(14,4),
  PRIMARY KEY (update_id, variant_id),
  FOREIGN KEY (tenant_id, update_id) REFERENCES price_updates (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants (tenant_id, id)
);
CREATE INDEX price_update_lines_variant_idx ON price_update_lines (tenant_id, variant_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['price_updates', 'price_update_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
                     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- 001 gives erp_rt every privilege on new tables by default. A run is history: its lines never change and nothing is
-- deleted; the run row itself is only updated once, when it is undone.
REVOKE UPDATE, DELETE ON price_update_lines FROM erp_rt;
REVOKE DELETE ON price_updates FROM erp_rt;

-- Contacts (D96): each customer's and supplier's history, newest first.
CREATE INDEX IF NOT EXISTS sales_orders_customer_idx ON sales_orders (tenant_id, customer_id, placed_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS goods_receipts_supplier_idx ON goods_receipts (tenant_id, supplier_id, posted_at DESC);

SELECT erp_backup_grants();
