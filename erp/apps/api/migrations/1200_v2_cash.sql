-- GroPop v2 phase 3 · cash control (D109 to D114).
--
-- 1. Payment methods: the store's own list (Cash, UPI, Card, Other, plus its own such as "Paytm machine 2"), each on or
--    off, and off at chosen outlets (a broken card machine at one shop) (D109).
-- 2. Tills and registers: each outlet has tills; a register session is one drawer from opening count to closing count.
--    Every counter payment, refund and drawer movement belongs to the session open at that till (D110).
-- 3. Drawer movements: cash added, cash taken out, and till expenses with limits; an expense above the limit waits for
--    an owner or manager (D111).
-- 4. Closing: notes and coins counted, short or extra with a reason, a summary for the owner (D112, notifications).
-- 5. Return and exchange rules the owner sets: days allowed, categories that can't come back, money back or exchange
--    only (D113).
-- Everything is per outlet, so the outlet switcher planned next can filter it (D114).

-- ------------------------------------------------------------------ settings
ALTER TABLE sales_settings
  ADD COLUMN require_register   boolean NOT NULL DEFAULT true,
  ADD COLUMN expense_limit_each numeric(14,2) NOT NULL DEFAULT 500 CHECK (expense_limit_each >= 0),
  ADD COLUMN expense_limit_day  numeric(14,2) NOT NULL DEFAULT 1000 CHECK (expense_limit_day >= 0),
  ADD COLUMN return_days        integer CHECK (return_days BETWEEN 1 AND 365),
  ADD COLUMN return_money_back  boolean NOT NULL DEFAULT true;

ALTER TABLE categories NO FORCE ROW LEVEL SECURITY;
ALTER TABLE categories ADD COLUMN no_returns boolean NOT NULL DEFAULT false;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------ 1. payment methods
-- kind is what the money is (cash counts in the drawer; UPI, card and other don't). The four built-in ones are made on
-- first use and can be renamed or switched off but not removed; a store's own methods can be switched off too.
CREATE TABLE payment_methods (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  kind       text NOT NULL CHECK (kind IN ('cash', 'upi', 'card', 'other')),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  builtin    boolean NOT NULL DEFAULT false,
  active     boolean NOT NULL DEFAULT true,
  position   integer NOT NULL DEFAULT 100 CHECK (position BETWEEN 0 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX payment_methods_name_uq ON payment_methods (tenant_id, lower(name));
CREATE UNIQUE INDEX payment_methods_builtin_uq ON payment_methods (tenant_id, kind) WHERE builtin;

-- A method switched off at one outlet only.
CREATE TABLE payment_method_off (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  method_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, method_id, outlet_id),
  FOREIGN KEY (tenant_id, method_id) REFERENCES payment_methods (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id)
);

-- ------------------------------------------------------------------ 2. tills and register sessions
CREATE TABLE tills (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  outlet_id  uuid NOT NULL,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id)
);
CREATE UNIQUE INDEX tills_name_uq ON tills (tenant_id, outlet_id, lower(name));

-- One drawer from opening to closing. Counts are notes and coins by face value, as counted. kept_cash is what stays in
-- the drawer for the next session; the rest of the counted cash is taken out at closing.
CREATE TABLE register_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  outlet_id       uuid NOT NULL,
  till_id         uuid NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_by       uuid NOT NULL,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  opening_cash    numeric(14,2) NOT NULL CHECK (opening_cash >= 0),
  opening_counts  jsonb CHECK (opening_counts IS NULL OR jsonb_typeof(opening_counts) = 'object'),
  expected_opening numeric(14,2) CHECK (expected_opening >= 0),   -- what the last closing at this till left in the drawer
  opening_note    text CHECK (length(opening_note) BETWEEN 3 AND 200),
  previous_id     uuid,
  closed_by       uuid,
  closed_at       timestamptz,
  counted_cash    numeric(14,2) CHECK (counted_cash >= 0),
  closing_counts  jsonb CHECK (closing_counts IS NULL OR jsonb_typeof(closing_counts) = 'object'),
  expected_cash   numeric(14,2),
  difference      numeric(14,2),
  kept_cash       numeric(14,2) CHECK (kept_cash >= 0),
  close_note      text CHECK (length(close_note) BETWEEN 3 AND 300),
  summary         jsonb,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, till_id) REFERENCES tills (tenant_id, id),
  FOREIGN KEY (tenant_id, opened_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, previous_id) REFERENCES register_sessions (tenant_id, id),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL AND counted_cash IS NOT NULL AND expected_cash IS NOT NULL
                                AND difference IS NOT NULL AND kept_cash IS NOT NULL AND summary IS NOT NULL)),
  CHECK (kept_cash IS NULL OR kept_cash <= counted_cash),
  CHECK (difference IS NULL OR difference = counted_cash - expected_cash)
);
CREATE UNIQUE INDEX register_sessions_one_open ON register_sessions (tenant_id, till_id) WHERE status = 'open';
CREATE INDEX register_sessions_outlet_idx ON register_sessions (tenant_id, outlet_id, opened_at DESC);

-- ------------------------------------------------------------------ 3. drawer movements
-- cash_in adds to the drawer (float, change from the bank), cash_out takes from it (bank deposit, owner), expense pays
-- for something from it. Only 'posted' rows change what should be in the drawer.
CREATE TABLE cash_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  outlet_id     uuid NOT NULL,
  session_id    uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('cash_in', 'cash_out', 'expense')),
  category      text NOT NULL CHECK (length(category) BETWEEN 1 AND 40),
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  reason        text NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  status        text NOT NULL CHECK (status IN ('posted', 'pending', 'rejected', 'cancelled')),
  recorded_by   uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid,
  decided_via   text CHECK (decided_via IN ('pin', 'remote')),
  decided_at    timestamptz,
  decision_note text CHECK (length(decision_note) <= 200),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES register_sessions (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users (tenant_id, id),
  CHECK (status <> 'pending' OR kind = 'expense'),
  CHECK (decided_by IS DISTINCT FROM recorded_by),
  CHECK (status <> 'rejected' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'pending' OR decided_by IS NULL),
  CHECK ((decided_by IS NULL) = (decided_via IS NULL AND decided_at IS NULL))
);
CREATE INDEX cash_movements_session_idx ON cash_movements (tenant_id, session_id, created_at);
CREATE INDEX cash_movements_pending_idx ON cash_movements (tenant_id, created_at) WHERE status = 'pending';
CREATE INDEX cash_movements_outlet_idx ON cash_movements (tenant_id, outlet_id, created_at DESC);

-- ------------------------------------------------------------------ payments know their method and their till
ALTER TABLE payments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE payments
  ADD COLUMN method_id uuid,
  ADD COLUMN session_id uuid,
  ADD FOREIGN KEY (tenant_id, method_id) REFERENCES payment_methods (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, session_id) REFERENCES register_sessions (tenant_id, id);
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE INDEX payments_session_idx ON payments (tenant_id, session_id) WHERE session_id IS NOT NULL;

-- A counter bill knows the register it was billed at (bills per register at closing).
ALTER TABLE sales_orders NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sales_orders ADD COLUMN session_id uuid, ADD FOREIGN KEY (tenant_id, session_id) REFERENCES register_sessions (tenant_id, id);
ALTER TABLE sales_orders FORCE ROW LEVEL SECURITY;
CREATE INDEX sales_orders_session_idx ON sales_orders (tenant_id, session_id) WHERE session_id IS NOT NULL;

-- ------------------------------------------------------------------ 4. in-app notifications
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('register_closed')),
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body       text NOT NULL CHECK (length(body) <= 1000),
  link       text CHECK (link ~ '^/[A-Za-z0-9/_?=&.-]*$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX notifications_user_idx ON notifications (tenant_id, user_id, created_at DESC);

-- The closing summary e-mail goes through the job queue, so it is sent only if the closing commits.
ALTER TABLE sync_jobs DROP CONSTRAINT sync_jobs_kind_check;
ALTER TABLE sync_jobs ADD CONSTRAINT sync_jobs_kind_check
  CHECK (kind IN ('import', 'woo.product', 'woo.stock', 'woo.inbound', 'woo.reconcile', 'woo.match', 'woo.fulfilment', 'export', 'mail.register'));

-- ------------------------------------------------------------------ row level security and grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_methods', 'payment_method_off', 'tills', 'register_sessions', 'cash_movements', 'notifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
                     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Methods and tills are switched off, never deleted (payments and sessions point at them); "off at an outlet" rows come
-- and go. A register session is closed once and kept; drawer movements are the cash record and are never deleted.
-- Notifications are marked read, never deleted by the app.
REVOKE DELETE, TRUNCATE ON payment_methods FROM erp_rt;
REVOKE UPDATE, TRUNCATE ON payment_method_off FROM erp_rt;
REVOKE DELETE, TRUNCATE ON tills FROM erp_rt;
REVOKE DELETE, TRUNCATE ON register_sessions FROM erp_rt;
REVOKE DELETE, TRUNCATE ON cash_movements FROM erp_rt;
REVOKE DELETE, TRUNCATE ON notifications FROM erp_rt;

SELECT erp_backup_grants();
