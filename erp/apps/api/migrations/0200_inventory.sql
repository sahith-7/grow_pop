-- B3 · Inventory and purchasing: locations, stock balances, the stock ledger, adjustments, transfers, stocktakes,
-- suppliers, purchase orders, goods receipts and supplier returns.
-- Conventions: docs/design/03-data-model.md §1, §3.4, §3.5. Grants at the end of this file.
-- Quantities are numeric(14,3); unit costs numeric(14,4). Posted documents and the ledger are never updated or deleted.

-- ------------------------------------------------------------------ document numbers (PO-00001, GRN-00001, …)
CREATE TABLE doc_sequences (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  doc_type   text NOT NULL CHECK (doc_type IN ('PO', 'GRN', 'ADJ', 'TRF', 'ST', 'SR')),
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  PRIMARY KEY (tenant_id, doc_type)
);

-- ------------------------------------------------------------------ locations (INV-06)
CREATE TABLE locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  type        text NOT NULL CHECK (type IN ('shop_floor', 'back_room', 'quarantine')),
  is_sellable boolean NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT quarantine_not_sellable CHECK (type <> 'quarantine' OR NOT is_sellable)
);
CREATE UNIQUE INDEX locations_name_uq ON locations (tenant_id, lower(name));

-- Every existing store gets the two default locations. New stores get them on first use (inventory/service.ts).
INSERT INTO locations (tenant_id, name, type, is_sellable)
SELECT t.id, l.name, l.type, true FROM tenants t
 CROSS JOIN (VALUES ('Shop floor', 'shop_floor'), ('Back room', 'back_room')) AS l(name, type);

-- ------------------------------------------------------------------ balances and ledger (INV-01/02/03/10)
-- One row per variant and location. Only inventory.post() writes it, always together with ledger rows.
-- on_hand may go below zero only through an owner's audited override (INV-08), so it has no CHECK.
CREATE TABLE stock_balances (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  variant_id   uuid NOT NULL,
  location_id  uuid NOT NULL,
  on_hand      numeric(14,3) NOT NULL DEFAULT 0,
  reserved     numeric(14,3) NOT NULL DEFAULT 0 CHECK (reserved >= 0),     -- web-order reservations, from B4
  non_sellable numeric(14,3) NOT NULL DEFAULT 0 CHECK (non_sellable >= 0), -- damaged, awaiting return or write-off
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, variant_id, location_id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX stock_balances_location_idx ON stock_balances (tenant_id, location_id);

CREATE TABLE stock_ledger (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,  -- stable order inside one transaction
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  variant_id     uuid NOT NULL,
  location_id    uuid NOT NULL,
  bucket         text NOT NULL CHECK (bucket IN ('sellable', 'non_sellable')),
  qty_delta      numeric(14,3) NOT NULL CHECK (qty_delta <> 0),
  balance_after  numeric(14,3) NOT NULL,                      -- AC-16: before = balance_after - qty_delta
  movement_type  text NOT NULL CHECK (movement_type IN ('opening', 'receipt', 'sale', 'dispatch', 'adjustment', 'writeoff',
                   'transfer_out', 'transfer_in', 'return_in', 'supplier_return', 'stocktake', 'reversal')),
  source_type    text NOT NULL CHECK (source_type IN ('adjustment', 'transfer', 'stocktake', 'goods_receipt', 'supplier_return')),
  source_id      uuid NOT NULL,
  source_line_id uuid,
  reversal_of_id uuid,
  reason_code    text,
  note           text CHECK (length(note) <= 500),
  unit_cost      numeric(14,4) CHECK (unit_cost >= 0),
  posted_at      timestamptz NOT NULL DEFAULT now(),
  posted_by      uuid NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, reversal_of_id) REFERENCES stock_ledger (tenant_id, id),
  CHECK ((movement_type = 'reversal') = (reversal_of_id IS NOT NULL))
);
-- A movement can be reversed once.
CREATE UNIQUE INDEX stock_ledger_reversal_uq ON stock_ledger (reversal_of_id) WHERE reversal_of_id IS NOT NULL;
CREATE INDEX stock_ledger_variant_idx ON stock_ledger (tenant_id, variant_id, location_id, seq DESC);
CREATE INDEX stock_ledger_source_idx ON stock_ledger (tenant_id, source_type, source_id);
CREATE INDEX stock_ledger_list_idx ON stock_ledger (tenant_id, seq DESC);

-- ------------------------------------------------------------------ adjustments and transfers (INV-04/06/08)
CREATE TABLE adjustments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  number            text NOT NULL,
  location_id       uuid NOT NULL,
  reason_code       text NOT NULL CHECK (reason_code IN ('damage', 'expiry', 'loss', 'correction', 'opening')),
  note              text CHECK (length(note) <= 500),
  override_negative boolean NOT NULL DEFAULT false,
  posted_at         timestamptz NOT NULL DEFAULT now(),
  posted_by         uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users (tenant_id, id),
  CHECK (NOT override_negative OR length(note) >= 3)
);

CREATE TABLE transfers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  number           text NOT NULL,
  from_location_id uuid NOT NULL,
  to_location_id   uuid NOT NULL,
  note             text CHECK (length(note) <= 500),
  posted_at        timestamptz NOT NULL DEFAULT now(),
  posted_by        uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, from_location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, to_location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users (tenant_id, id),
  CHECK (from_location_id <> to_location_id)
);

-- ------------------------------------------------------------------ stocktakes (INV-05, AC-06)
CREATE TABLE stocktakes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  number       text NOT NULL,
  location_id  uuid NOT NULL,
  category_ids uuid[] NOT NULL DEFAULT '{}',   -- empty = every product at the location
  blind        boolean NOT NULL DEFAULT true,  -- counters do not see expected quantities
  status       text NOT NULL DEFAULT 'counting' CHECK (status IN ('counting', 'review', 'posted', 'cancelled')),
  -- expected quantities are read at snapshot_at; movements between it and a line's counted_at are "moved during count"
  snapshot_at  timestamptz NOT NULL DEFAULT now(),
  note         text CHECK (length(note) <= 500),
  created_by   uuid NOT NULL,
  submitted_by uuid,
  submitted_at timestamptz,
  closed_by    uuid,                            -- who posted or cancelled
  closed_at    timestamptz,
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
-- One open stocktake per location, so two counts cannot post over each other.
CREATE UNIQUE INDEX stocktakes_open_uq ON stocktakes (tenant_id, location_id) WHERE status IN ('counting', 'review');
CREATE INDEX stocktakes_list_idx ON stocktakes (tenant_id, snapshot_at DESC);

CREATE TABLE stocktake_lines (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  stocktake_id       uuid NOT NULL,
  variant_id         uuid NOT NULL,
  expected_qty       numeric(14,3) NOT NULL,
  counted_qty        numeric(14,3) CHECK (counted_qty >= 0),
  counted_by         uuid,
  counted_at         timestamptz,
  moved_during_count numeric(14,3),            -- fixed when the stocktake is posted
  PRIMARY KEY (tenant_id, stocktake_id, variant_id),
  FOREIGN KEY (tenant_id, stocktake_id) REFERENCES stocktakes (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants (tenant_id, id)
);

-- ------------------------------------------------------------------ suppliers (PUR)
CREATE TABLE suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  phone       text CHECK (length(phone) <= 20),
  email       text CHECK (length(email) <= 200),
  gstin       text CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state_code  text CHECK (state_code ~ '^[0-9]{2}$'),
  address     text CHECK (length(address) <= 500),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX suppliers_name_uq ON suppliers (tenant_id, lower(name));

-- ------------------------------------------------------------------ purchase orders (PUR-01/02/06)
CREATE TABLE purchase_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  number        text NOT NULL,
  supplier_id   uuid NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'partial', 'closed', 'cancelled')),
  expected_date date,
  notes         text CHECK (length(notes) <= 1000),
  version       integer NOT NULL DEFAULT 1,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX purchase_orders_list_idx ON purchase_orders (tenant_id, created_at DESC, id);
CREATE INDEX purchase_orders_supplier_idx ON purchase_orders (tenant_id, supplier_id);

-- Unit cost excludes GST. received/accepted are written only by goods-receipt posting.
CREATE TABLE purchase_order_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  po_id        uuid NOT NULL,
  variant_id   uuid NOT NULL,
  position     integer NOT NULL,
  ordered_qty  numeric(14,3) NOT NULL CHECK (ordered_qty > 0),
  received_qty numeric(14,3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  accepted_qty numeric(14,3) NOT NULL DEFAULT 0 CHECK (accepted_qty >= 0 AND accepted_qty <= received_qty),
  unit_cost    numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (po_id, variant_id),
  FOREIGN KEY (tenant_id, po_id) REFERENCES purchase_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants (tenant_id, id),
  CONSTRAINT po_line_not_over_accepted CHECK (accepted_qty <= ordered_qty)
);

-- Lines can be removed only while their PO is a draft. Enforced here as well as in the service.
CREATE FUNCTION po_lines_guard_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM purchase_orders WHERE id = OLD.po_id) <> 'draft' THEN
    RAISE EXCEPTION 'purchase order lines can only be removed from a draft' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER po_lines_guard_delete BEFORE DELETE ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION po_lines_guard_delete();

-- ------------------------------------------------------------------ goods receipts (PUR-03/04, AC-05)
CREATE TABLE goods_receipts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  number              text NOT NULL,
  po_id               uuid,
  supplier_id         uuid NOT NULL,
  supplier_invoice_no text CHECK (length(supplier_invoice_no) <= 40),
  note                text CHECK (length(note) <= 500),
  posted_at           timestamptz NOT NULL DEFAULT now(),
  posted_by           uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, po_id) REFERENCES purchase_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX goods_receipts_po_idx ON goods_receipts (tenant_id, po_id);
CREATE INDEX goods_receipts_list_idx ON goods_receipts (tenant_id, posted_at DESC, id);

-- received = what arrived; accepted goes to sellable stock, the rest (damaged) to non-sellable.
CREATE TABLE goods_receipt_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  receipt_id   uuid NOT NULL,
  po_line_id   uuid,
  variant_id   uuid NOT NULL,
  location_id  uuid NOT NULL,
  received_qty numeric(14,3) NOT NULL CHECK (received_qty > 0),
  accepted_qty numeric(14,3) NOT NULL CHECK (accepted_qty >= 0 AND accepted_qty <= received_qty),
  damaged_qty  numeric(14,3) GENERATED ALWAYS AS (received_qty - accepted_qty) STORED,
  unit_cost    numeric(14,4) CHECK (unit_cost >= 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES goods_receipts (tenant_id, id),
  FOREIGN KEY (tenant_id, po_line_id) REFERENCES purchase_order_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX goods_receipt_lines_receipt_idx ON goods_receipt_lines (tenant_id, receipt_id);

-- ------------------------------------------------------------------ supplier returns (PUR-05)
CREATE TABLE supplier_returns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  number      text NOT NULL,
  supplier_id uuid NOT NULL,
  receipt_id  uuid,
  reason      text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  posted_at   timestamptz NOT NULL DEFAULT now(),
  posted_by   uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES goods_receipts (tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users (tenant_id, id)
);

CREATE TABLE supplier_return_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  return_id   uuid NOT NULL,
  variant_id  uuid NOT NULL,
  location_id uuid NOT NULL,
  bucket      text NOT NULL CHECK (bucket IN ('sellable', 'non_sellable')),
  qty         numeric(14,3) NOT NULL CHECK (qty > 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, return_id) REFERENCES supplier_returns (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);

-- ------------------------------------------------------------------ reconciliation (INV-09, data model §3.4)
-- Balances that disagree with the ledger. Must always be empty; never auto-fixed.
CREATE VIEW v_stock_reconciliation WITH (security_invoker = true) AS
SELECT b.variant_id, b.location_id, b.on_hand, b.non_sellable,
       coalesce(l.sellable, 0) AS ledger_sellable, coalesce(l.non_sellable, 0) AS ledger_non_sellable
  FROM stock_balances b
  LEFT JOIN (SELECT variant_id, location_id,
                    sum(qty_delta) FILTER (WHERE bucket = 'sellable') AS sellable,
                    sum(qty_delta) FILTER (WHERE bucket = 'non_sellable') AS non_sellable
               FROM stock_ledger GROUP BY variant_id, location_id) l
    ON l.variant_id = b.variant_id AND l.location_id = b.location_id
 WHERE b.on_hand <> coalesce(l.sellable, 0) OR b.non_sellable <> coalesce(l.non_sellable, 0);

-- ------------------------------------------------------------------ row-level security (same template as 0100, D26)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['doc_sequences', 'locations', 'stock_balances', 'stock_ledger', 'adjustments', 'transfers',
                           'stocktakes', 'stocktake_lines', 'suppliers', 'purchase_orders', 'purchase_order_lines',
                           'goods_receipts', 'goods_receipt_lines', 'supplier_returns', 'supplier_return_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
                     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ------------------------------------------------------------------ grants (runtime role)
-- 001 gives erp_rt SELECT, INSERT, UPDATE, DELETE on every new table by default. Take back what B3 never needs.
-- The ledger and posted documents are append-only (INV-03): no UPDATE, no DELETE.
REVOKE UPDATE, DELETE ON stock_ledger, adjustments, transfers, goods_receipts, goods_receipt_lines,
                         supplier_returns, supplier_return_lines FROM erp_rt;
-- Mutable, but never deleted: archive or cancel instead.
REVOKE DELETE ON doc_sequences, locations, stock_balances, stocktakes, stocktake_lines, suppliers, purchase_orders FROM erp_rt;
-- purchase_order_lines keeps DELETE for editing drafts; the trigger above refuses it after submit.
REVOKE INSERT, UPDATE, DELETE ON v_stock_reconciliation FROM erp_rt;
