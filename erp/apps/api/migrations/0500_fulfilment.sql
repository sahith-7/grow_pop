-- B6 · Fulfilment of web orders: pick lists, packing, shipments, and the WooCommerce "completed + tracking" update.
-- Conventions: docs/design/03-data-model.md §3.9. Grants at the end of this file.
-- Order states used here already exist (0300): ready_to_pick → picking → packed → dispatched → completed.

-- ------------------------------------------------------------------ pick lists
-- One list can cover several orders (batch picking). Lines are one per order line, holding what its reservation holds.
CREATE TABLE pick_lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  number      text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'picking', 'picked', 'cancelled')),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX pick_lists_open_idx ON pick_lists (tenant_id, created_at DESC) WHERE status IN ('open', 'picking');

-- state 'removed': the order left the list (cancelled in the shop, changed during picking, or taken off by a person).
CREATE TABLE pick_list_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  pick_list_id   uuid NOT NULL,
  order_id       uuid NOT NULL,
  order_line_id  uuid NOT NULL,
  variant_id     uuid NOT NULL,
  location_id    uuid NOT NULL,
  qty_required   numeric(14,3) NOT NULL CHECK (qty_required > 0),
  qty_picked     numeric(14,3) NOT NULL DEFAULT 0,
  state          text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'removed')),
  picked_at      timestamptz,
  picked_by      uuid,
  UNIQUE (tenant_id, id),
  CHECK (qty_picked >= 0 AND qty_picked <= qty_required),
  FOREIGN KEY (tenant_id, pick_list_id) REFERENCES pick_lists (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, picked_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX pick_list_lines_list_idx ON pick_list_lines (pick_list_id);
-- An order line is on at most one live pick list at a time.
CREATE UNIQUE INDEX pick_list_lines_live_idx ON pick_list_lines (tenant_id, order_line_id) WHERE state = 'active';

-- ------------------------------------------------------------------ shipments
-- One shipment per order in V1 (no split deliveries). No carrier integration: carrier and tracking number are typed in.
-- woo_update_state: 'pending' until WooCommerce accepts "completed" + the tracking note; 'not_needed' when the shop
-- already said completed, or is no longer connected.
CREATE TABLE shipments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  order_id          uuid NOT NULL,
  carrier           text NOT NULL CHECK (length(carrier) BETWEEN 1 AND 60),
  service           text CHECK (length(service) <= 60),
  tracking_no       text CHECK (length(tracking_no) <= 60),
  shipped_at        timestamptz NOT NULL,
  dispatched_by     uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  woo_update_state  text NOT NULL DEFAULT 'pending' CHECK (woo_update_state IN ('pending', 'synced', 'failed', 'not_needed')),
  woo_synced_at     timestamptz,
  woo_error         text CHECK (length(woo_error) <= 1000),
  woo_note_id       bigint,                    -- the tracking note, once Woo has it: a retry never posts it twice
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, order_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, dispatched_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX shipments_pending_idx ON shipments (tenant_id, created_at) WHERE woo_update_state IN ('pending', 'failed');

-- ------------------------------------------------------------------ B2/B4 tables B6 extends
ALTER TABLE doc_sequences DROP CONSTRAINT doc_sequences_doc_type_check;
ALTER TABLE doc_sequences ADD CONSTRAINT doc_sequences_doc_type_check CHECK (doc_type IN ('PO', 'GRN', 'ADJ', 'TRF', 'ST', 'SR', 'RET', 'PK'));

ALTER TABLE sync_jobs DROP CONSTRAINT sync_jobs_kind_check;
ALTER TABLE sync_jobs ADD CONSTRAINT sync_jobs_kind_check
  CHECK (kind IN ('import', 'woo.product', 'woo.stock', 'woo.inbound', 'woo.reconcile', 'woo.match', 'woo.fulfilment'));

-- Packing is recorded on the order (substitutions are off in V1, so packed quantity = reserved quantity).
ALTER TABLE sales_orders
  ADD COLUMN packed_at timestamptz,
  ADD COLUMN packed_by uuid,
  ADD FOREIGN KEY (tenant_id, packed_by) REFERENCES users (tenant_id, id);
-- The fulfilment queue reads ready/picking/packed orders oldest paid first.
CREATE INDEX sales_orders_fulfil_idx ON sales_orders (tenant_id, status, placed_at)
  WHERE status IN ('ready_to_pick', 'picking', 'packed', 'dispatched', 'stock_exception');

-- ------------------------------------------------------------------ row-level security (same template as 0100–0400, D26)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pick_lists', 'pick_list_lines', 'shipments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
                     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ------------------------------------------------------------------ grants (runtime role)
-- 001 gives erp_rt SELECT, INSERT, UPDATE, DELETE on every new table by default. Take back what B6 never needs.
-- A shipment is a record of goods leaving: only its WooCommerce update columns ever change.
REVOKE DELETE, TRUNCATE ON pick_lists, pick_list_lines, shipments FROM erp_rt;
REVOKE UPDATE ON shipments FROM erp_rt;
GRANT UPDATE (woo_update_state, woo_synced_at, woo_error, woo_note_id) ON shipments TO erp_rt;
