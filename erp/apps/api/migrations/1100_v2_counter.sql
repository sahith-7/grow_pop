-- GroPop v2 phase 2 · billing at the counter (D104 to D108).
--
-- 1. Every counter bill names its customer (name and mobile number) or is marked Walk-in by the cashier (D104).
-- 2. Held bills: a cart parked at one outlet so the next customer can be billed, picked up again later (D105).
-- 3. Discount approval: a cashier above their limit asks an owner or manager, who approves with their PIN at the till or
--    from their own screen. The approval covers that exact cart and nothing else (D107).
-- 4. Exchange: the old bill's credit note pays for the new bill (D108).

-- ------------------------------------------------------------------ 1. customer on every bill
ALTER TABLE sales_settings ADD COLUMN require_customer boolean NOT NULL DEFAULT true;

-- ------------------------------------------------------------------ 2. held bills
-- The cart exactly as the till sent it (items, quantities, discounts, customer); it is priced again when picked up, so a
-- price change in between is never billed at the old price. No stock is set aside.
CREATE TABLE pos_held_bills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  outlet_id     uuid NOT NULL,
  label         text CHECK (length(label) BETWEEN 1 AND 60),
  cart          jsonb NOT NULL CHECK (jsonb_typeof(cart) = 'object' AND pg_column_size(cart) <= 65536),
  item_count    integer NOT NULL CHECK (item_count BETWEEN 1 AND 200),
  total         numeric(14,2) CHECK (total >= 0),
  customer_name text CHECK (length(customer_name) <= 200),
  held_by       uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, held_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX pos_held_bills_outlet_idx ON pos_held_bills (tenant_id, outlet_id, created_at);

-- ------------------------------------------------------------------ 3. discount approval
-- A PIN per person (owners and managers approve with it at the till). argon2id, like passwords; locked for 15 minutes
-- after 5 wrong tries.
CREATE TABLE pos_pins (
  user_id      uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  pin_hash     text NOT NULL CHECK (pin_hash LIKE '$argon2id$%'),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);

-- One request = one cart (cart_hash: items, quantities, prices and discounts). Approved requests expire after 15 minutes
-- and are used by exactly one sale, in that sale's transaction.
CREATE TABLE discount_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  outlet_id      uuid NOT NULL,
  requested_by   uuid NOT NULL,
  cart_hash      text NOT NULL CHECK (cart_hash ~ '^[0-9a-f]{64}$'),
  summary        jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object' AND pg_column_size(summary) <= 65536),
  discount_total numeric(14,2) NOT NULL CHECK (discount_total > 0),
  max_pct        numeric(5,2) NOT NULL CHECK (max_pct > 0 AND max_pct <= 100),
  reason         text NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'used')),
  decided_by     uuid,
  decided_via    text CHECK (decided_via IN ('pin', 'remote')),
  decided_at     timestamptz,
  decision_note  text CHECK (length(decision_note) <= 200),
  invoice_id     uuid,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  CHECK ((status IN ('approved', 'rejected', 'used')) = (decided_by IS NOT NULL AND decided_via IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (decided_by IS DISTINCT FROM requested_by),
  CHECK ((status = 'used') = (invoice_id IS NOT NULL))
);
CREATE INDEX discount_requests_open_idx ON discount_requests (tenant_id, status, created_at) WHERE status = 'pending';
CREATE INDEX discount_requests_outlet_idx ON discount_requests (tenant_id, outlet_id, created_at);

-- ------------------------------------------------------------------ 4. exchange
-- A credit note can pay for a new bill: the old order gets a refund row 'exchange', the new order a payment row
-- 'exchange', both pointing at the credit note. Nothing else can use that method.
ALTER TABLE payments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE payments DROP CONSTRAINT payments_method_check,
  ADD CONSTRAINT payments_method_check CHECK (method IN ('cash', 'card', 'upi', 'other', 'original', 'exchange')),
  ADD COLUMN credit_note_id uuid,
  ADD FOREIGN KEY (tenant_id, credit_note_id) REFERENCES credit_notes (tenant_id, id),
  ADD CONSTRAINT payments_exchange_cn CHECK ((method = 'exchange') = (credit_note_id IS NOT NULL));
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE INDEX payments_credit_note_idx ON payments (tenant_id, credit_note_id) WHERE credit_note_id IS NOT NULL;
-- At most one new-bill payment per credit note.
CREATE UNIQUE INDEX payments_exchange_once ON payments (tenant_id, credit_note_id) WHERE method = 'exchange' AND kind = 'payment';

ALTER TABLE customer_returns DROP CONSTRAINT customer_returns_refund_method_check,
  ADD CONSTRAINT customer_returns_refund_method_check CHECK (refund_method IN ('cash', 'card', 'upi', 'other', 'original', 'none', 'exchange'));

-- ------------------------------------------------------------------ row level security and grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pos_held_bills', 'pos_pins', 'discount_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
                     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Held bills are parked and picked up (deleted), never edited. PINs are set, changed and removed. Approval requests
-- move through their states and are kept as the record of who allowed which discount.
REVOKE UPDATE, TRUNCATE ON pos_held_bills FROM erp_rt;
REVOKE TRUNCATE ON pos_pins FROM erp_rt;
REVOKE DELETE, TRUNCATE ON discount_requests FROM erp_rt;

SELECT erp_backup_grants();
