-- B5 · POS sales, GST invoices, credit notes, customer returns and payments.
-- Conventions: docs/design/03-data-model.md §3.6, §3.7. Grants at the end of this file.
-- Money is numeric(14,2) (paise). Invoices, credit notes, their lines, payments and returns are never updated or deleted:
-- a mistake is corrected by a credit note (CGST Act s.34), never by changing the original.

-- ------------------------------------------------------------------ billing settings (one row per store)
-- The seller's legal name, GSTIN and address stay in Phase 1 (tenants.legal_name, store_settings). This table holds
-- only what B5 adds. gst_scheme is NULL until the owner chooses it; POS refuses to sell before that.
CREATE TABLE sales_settings (
  tenant_id                     uuid PRIMARY KEY REFERENCES tenants(id),
  gst_scheme                    text CHECK (gst_scheme IN ('regular', 'composition', 'unregistered')),
  state_code                    text CHECK (state_code ~ '^[0-9]{2}$'),
  prices_include_tax            boolean NOT NULL DEFAULT true,
  round_off                     boolean NOT NULL DEFAULT true,
  pos_location_id               uuid,
  discount_reason_threshold_pct numeric(5,2) NOT NULL DEFAULT 10 CHECK (discount_reason_threshold_pct BETWEEN 0 AND 100),
  cashier_discount_limit_pct    numeric(5,2) NOT NULL DEFAULT 10 CHECK (cashier_discount_limit_pct BETWEEN 0 AND 100),
  manager_discount_limit_pct    numeric(5,2) NOT NULL DEFAULT 100 CHECK (manager_discount_limit_pct BETWEEN 0 AND 100),
  invoice_prefix                text NOT NULL DEFAULT 'INV' CHECK (invoice_prefix ~ '^[A-Za-z0-9-]{1,6}$'),
  credit_note_prefix            text NOT NULL DEFAULT 'CN' CHECK (credit_note_prefix ~ '^[A-Za-z0-9-]{1,6}$'),
  invoice_web_orders            boolean NOT NULL DEFAULT true,
  receipt_footer                text CHECK (length(receipt_footer) <= 300),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, pos_location_id) REFERENCES locations (tenant_id, id)
);

-- ------------------------------------------------------------------ invoice and credit-note numbering (CGST Rule 46(b))
-- One series per document type per financial year. Numbers are consecutive and gap-free: next_number is taken under a
-- row lock in the same transaction as the document, so a rolled-back sale gives its number back.
CREATE TABLE invoice_series (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  doc_type       text NOT NULL CHECK (doc_type IN ('invoice', 'credit_note')),
  financial_year text NOT NULL CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  prefix         text NOT NULL CHECK (prefix ~ '^[A-Za-z0-9/-]{0,12}$'),
  start_number   integer NOT NULL DEFAULT 1 CHECK (start_number >= 1),
  next_number    integer NOT NULL CHECK (next_number >= start_number),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, doc_type, financial_year),
  -- Rule 46(b): a number is at most 16 characters. invoices.number checks every number issued.
  CHECK (length(prefix) + length(start_number::text) <= 16)
);

-- ------------------------------------------------------------------ customers, orders: what POS adds to B4's tables
ALTER TABLE customers
  ADD COLUMN gstin      text CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ADD COLUMN state_code text CHECK (state_code ~ '^[0-9]{2}$'),
  ADD COLUMN address    text CHECK (length(address) <= 500),
  ADD COLUMN created_by uuid;
CREATE INDEX customers_phone_idx ON customers (tenant_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX customers_name_idx ON customers (tenant_id, lower(name));

ALTER TABLE sales_orders
  ADD COLUMN created_by  uuid,                                   -- the cashier, for POS sales
  ADD COLUMN location_id uuid,                                   -- where a POS sale took the stock from
  ADD COLUMN invoice_state text CHECK (invoice_state IN ('issued', 'pending', 'not_needed')),
  ADD COLUMN invoice_note text CHECK (length(invoice_note) <= 500),
  ADD FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id);
-- A POS order's number is its invoice number (unique on invoices). Not unique here: the order row is written before the
-- number is taken, so stock rows are always locked before the series row (same order as web orders: no deadlock).
CREATE INDEX sales_orders_number_idx ON sales_orders (tenant_id, lower(number));

ALTER TABLE sales_order_lines
  ADD COLUMN list_price      numeric(14,4),                      -- the catalogue price when the line was sold (POS)
  ADD COLUMN discount        numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  ADD COLUMN discount_reason text CHECK (length(discount_reason) <= 200);

-- ------------------------------------------------------------------ invoices (Rule 46, 46A, 49)
-- doc_kind is the printed title: 'tax_invoice', 'invoice_cum_bos' (taxable and exempt goods together, Rule 46A),
-- 'bill_of_supply' (only exempt goods, or a composition seller, Rule 49) or 'bill' (seller not registered for GST).
CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  number          text NOT NULL CHECK (length(number) BETWEEN 1 AND 16),
  series_id       uuid NOT NULL,
  financial_year  text NOT NULL,
  order_id        uuid NOT NULL,
  doc_kind        text NOT NULL CHECK (doc_kind IN ('tax_invoice', 'invoice_cum_bos', 'bill_of_supply', 'bill')),
  gst_scheme      text NOT NULL CHECK (gst_scheme IN ('regular', 'composition', 'unregistered')),
  seller          jsonb NOT NULL,                                -- legal name, GSTIN, address, state as they were when issued
  buyer           jsonb NOT NULL DEFAULT '{}',
  place_of_supply text NOT NULL CHECK (place_of_supply ~ '^[0-9]{2}$'),
  supply_type     text NOT NULL CHECK (supply_type IN ('intra', 'inter')),
  prices_include_tax boolean NOT NULL,
  taxable_total   numeric(14,2) NOT NULL,
  cgst            numeric(14,2) NOT NULL DEFAULT 0,
  sgst            numeric(14,2) NOT NULL DEFAULT 0,              -- printed as UTGST in union territories without a legislature
  igst            numeric(14,2) NOT NULL DEFAULT 0,
  cess            numeric(14,2) NOT NULL DEFAULT 0,
  round_off       numeric(14,2) NOT NULL DEFAULT 0 CHECK (round_off > -1 AND round_off < 1),
  total           numeric(14,2) NOT NULL CHECK (total >= 0),
  issued_at       timestamptz NOT NULL DEFAULT now(),
  issued_by       uuid,                                          -- NULL: issued when WooCommerce completed a web order
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, financial_year, number),
  UNIQUE (tenant_id, order_id),                                  -- one invoice per order; corrections are credit notes
  FOREIGN KEY (tenant_id, series_id) REFERENCES invoice_series (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, issued_by) REFERENCES users (tenant_id, id),
  CHECK (total = taxable_total + cgst + sgst + igst + cess + round_off),
  CHECK (supply_type = 'inter' OR igst = 0),
  CHECK (supply_type = 'intra' OR (cgst = 0 AND sgst = 0)),
  CHECK (gst_scheme = 'regular' OR (cgst = 0 AND sgst = 0 AND igst = 0))
);
CREATE INDEX invoices_list_idx ON invoices (tenant_id, issued_at DESC, id);
CREATE INDEX invoices_number_idx ON invoices (tenant_id, lower(number));

CREATE TABLE invoice_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  invoice_id    uuid NOT NULL,
  position      integer NOT NULL,
  kind          text NOT NULL DEFAULT 'item' CHECK (kind IN ('item', 'shipping')),
  order_line_id uuid,
  variant_id    uuid,
  sku           text NOT NULL DEFAULT '',
  description   text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  hsn_code      text CHECK (hsn_code ~ '^[0-9]{4,8}$'),
  uqc           text NOT NULL,                                   -- GST unit code (D23)
  qty           numeric(14,3) NOT NULL CHECK (qty > 0),
  unit_price    numeric(14,4) NOT NULL CHECK (unit_price >= 0),  -- as charged: incl. GST when prices_include_tax
  gross         numeric(14,2) NOT NULL CHECK (gross >= 0),       -- qty × unit_price, before discount
  discount      numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0 AND discount <= gross),
  taxable_value numeric(14,2) NOT NULL CHECK (taxable_value >= 0),
  gst_rate      numeric(5,2) NOT NULL CHECK (gst_rate >= 0 AND gst_rate <= 100),
  cgst          numeric(14,2) NOT NULL DEFAULT 0,
  sgst          numeric(14,2) NOT NULL DEFAULT 0,
  igst          numeric(14,2) NOT NULL DEFAULT 0,
  line_total    numeric(14,2) NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (invoice_id, position),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES sales_order_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants (tenant_id, id),
  CHECK (line_total = taxable_value + cgst + sgst + igst)
);
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (tenant_id, invoice_id, position);

-- ------------------------------------------------------------------ customer returns (5.7, AC-14)
CREATE TABLE customer_returns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  number        text NOT NULL,
  order_id      uuid NOT NULL,
  invoice_id    uuid NOT NULL,
  location_id   uuid NOT NULL,
  reason        text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  refund_method text NOT NULL CHECK (refund_method IN ('cash', 'card', 'upi', 'other', 'original', 'none')),
  posted_by     uuid NOT NULL,
  posted_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX customer_returns_list_idx ON customer_returns (tenant_id, posted_at DESC, id);

CREATE TABLE customer_return_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  return_id       uuid NOT NULL,
  invoice_line_id uuid NOT NULL,
  variant_id      uuid,
  qty             numeric(14,3) NOT NULL CHECK (qty > 0),
  condition       text NOT NULL CHECK (condition IN ('resellable', 'damaged', 'not_returned')),
  UNIQUE (tenant_id, id),
  UNIQUE (return_id, invoice_line_id),
  FOREIGN KEY (tenant_id, return_id) REFERENCES customer_returns (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_line_id) REFERENCES invoice_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants (tenant_id, id)
);

-- ------------------------------------------------------------------ credit notes (s.34, Rule 53)
-- kind 'void' cancels everything still uncredited on an invoice (owner only); an invoice has at most one.
CREATE TABLE credit_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  number          text NOT NULL CHECK (length(number) BETWEEN 1 AND 16),
  series_id       uuid NOT NULL,
  financial_year  text NOT NULL,
  invoice_id      uuid NOT NULL,
  return_id       uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('return', 'void')),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  seller          jsonb NOT NULL,
  buyer           jsonb NOT NULL DEFAULT '{}',
  taxable_total   numeric(14,2) NOT NULL,
  cgst            numeric(14,2) NOT NULL DEFAULT 0,
  sgst            numeric(14,2) NOT NULL DEFAULT 0,
  igst            numeric(14,2) NOT NULL DEFAULT 0,
  cess            numeric(14,2) NOT NULL DEFAULT 0,
  round_off       numeric(14,2) NOT NULL DEFAULT 0 CHECK (round_off > -1 AND round_off < 1),
  total           numeric(14,2) NOT NULL CHECK (total >= 0),
  issued_at       timestamptz NOT NULL DEFAULT now(),
  issued_by       uuid NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, financial_year, number),
  UNIQUE (tenant_id, return_id),
  FOREIGN KEY (tenant_id, series_id) REFERENCES invoice_series (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, return_id) REFERENCES customer_returns (tenant_id, id),
  FOREIGN KEY (tenant_id, issued_by) REFERENCES users (tenant_id, id),
  CHECK (total = taxable_total + cgst + sgst + igst + cess + round_off)
);
CREATE UNIQUE INDEX credit_notes_one_void_uq ON credit_notes (tenant_id, invoice_id) WHERE kind = 'void';
CREATE INDEX credit_notes_invoice_idx ON credit_notes (tenant_id, invoice_id);
CREATE INDEX credit_notes_list_idx ON credit_notes (tenant_id, issued_at DESC, id);

CREATE TABLE credit_note_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  credit_note_id  uuid NOT NULL,
  position        integer NOT NULL,
  invoice_line_id uuid NOT NULL,
  description     text NOT NULL,
  hsn_code        text,
  uqc             text NOT NULL,
  qty             numeric(14,3) NOT NULL CHECK (qty > 0),
  taxable_value   numeric(14,2) NOT NULL CHECK (taxable_value >= 0),
  gst_rate        numeric(5,2) NOT NULL,
  cgst            numeric(14,2) NOT NULL DEFAULT 0,
  sgst            numeric(14,2) NOT NULL DEFAULT 0,
  igst            numeric(14,2) NOT NULL DEFAULT 0,
  line_total      numeric(14,2) NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (credit_note_id, position),
  FOREIGN KEY (tenant_id, credit_note_id) REFERENCES credit_notes (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_line_id) REFERENCES invoice_lines (tenant_id, id),
  CHECK (line_total = taxable_value + cgst + sgst + igst)
);
CREATE INDEX credit_note_lines_invoice_line_idx ON credit_note_lines (tenant_id, invoice_line_id);

-- ------------------------------------------------------------------ payments (money in and out at the counter)
-- amount is what was applied to the sale or refunded; tendered is the cash handed over (change = tendered − amount).
CREATE TABLE payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  order_id    uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('payment', 'refund')),
  method      text NOT NULL CHECK (method IN ('cash', 'card', 'upi', 'other', 'original')),
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  tendered    numeric(14,2) CHECK (tendered >= amount),
  reference   text CHECK (length(reference) <= 100),
  return_id   uuid,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id),
  FOREIGN KEY (tenant_id, return_id) REFERENCES customer_returns (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES users (tenant_id, id),
  CHECK (tendered IS NULL OR (method = 'cash' AND kind = 'payment')),
  CHECK ((kind = 'refund') = (return_id IS NOT NULL))
);
CREATE INDEX payments_order_idx ON payments (tenant_id, order_id);
CREATE INDEX payments_day_idx ON payments (tenant_id, recorded_at);

-- ------------------------------------------------------------------ B3/B4 tables B5 extends
ALTER TABLE doc_sequences DROP CONSTRAINT doc_sequences_doc_type_check;
ALTER TABLE doc_sequences ADD CONSTRAINT doc_sequences_doc_type_check CHECK (doc_type IN ('PO', 'GRN', 'ADJ', 'TRF', 'ST', 'SR', 'RET'));

-- Customer returns put stock back against the return document (movement 'return_in'), always by a person.
ALTER TABLE stock_ledger DROP CONSTRAINT stock_ledger_source_type_check;
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_source_type_check
  CHECK (source_type IN ('adjustment', 'transfer', 'stocktake', 'goods_receipt', 'supplier_return', 'sales_order', 'customer_return'));

-- ------------------------------------------------------------------ row-level security (same template as 0100–0300, D26)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_settings', 'invoice_series', 'invoices', 'invoice_lines', 'customer_returns',
                           'customer_return_lines', 'credit_notes', 'credit_note_lines', 'payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
                     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ------------------------------------------------------------------ grants (runtime role)
-- 001 gives erp_rt SELECT, INSERT, UPDATE, DELETE on every new table by default. Take back what B5 never needs.
-- Tax documents, payments and returns are append-only: even a bug in the API cannot rewrite an issued invoice.
REVOKE UPDATE, DELETE, TRUNCATE ON invoices, invoice_lines, credit_notes, credit_note_lines, payments,
                                   customer_returns, customer_return_lines FROM erp_rt;
REVOKE DELETE, TRUNCATE ON sales_settings, invoice_series FROM erp_rt;
