-- Integrity checks (B7): run after every restore drill, and whenever stock looks wrong. Read-only.
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/integrity.sql
-- Prints "integrity OK" and row counts, and writes files-in-db.txt (every stored file's key) for the S3 comparison in
-- docs/runbooks/backup-restore.md. Stops with an error naming the store and the check that failed.
-- FORCE row-level security hides rows from the owner role too, so it checks one store at a time.
\set QUIET on
CREATE TEMP TABLE integrity_counts (tbl text PRIMARY KEY, n bigint NOT NULL DEFAULT 0);
CREATE TEMP TABLE integrity_files (object_key text);
INSERT INTO integrity_counts (tbl) VALUES ('products'), ('product_variants'), ('stock_ledger'), ('sales_orders'),
  ('invoices'), ('credit_notes'), ('payments'), ('customers'), ('audit_events'), ('files');

DO $$
DECLARE t uuid; bad bigint; stores int := 0; r record; cnt bigint;
BEGIN
  FOR t IN SELECT tenant_id FROM subscriptions ORDER BY tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    stores := stores + 1;

    -- 1. Each balance equals the sum of its ledger rows (on_hand = sellable bucket, non_sellable = the other).
    SELECT count(*) INTO bad FROM stock_balances b
      FULL JOIN (SELECT variant_id, location_id,
                        coalesce(sum(qty_delta) FILTER (WHERE bucket = 'sellable'), 0) AS s,
                        coalesce(sum(qty_delta) FILTER (WHERE bucket = 'non_sellable'), 0) AS ns
                   FROM stock_ledger GROUP BY 1, 2) l USING (variant_id, location_id)
     WHERE coalesce(b.on_hand, 0) <> coalesce(l.s, 0) OR coalesce(b.non_sellable, 0) <> coalesce(l.ns, 0);
    IF bad > 0 THEN RAISE EXCEPTION 'store %: % stock balances differ from the ledger', t, bad; END IF;

    -- 2. The newest ledger row's balance_after is the balance.
    SELECT count(*) INTO bad FROM (
      SELECT DISTINCT ON (variant_id, location_id, bucket) variant_id, location_id, bucket, balance_after
        FROM stock_ledger ORDER BY variant_id, location_id, bucket, seq DESC) last
      JOIN stock_balances b USING (variant_id, location_id)
     WHERE last.balance_after <> CASE last.bucket WHEN 'sellable' THEN b.on_hand ELSE b.non_sellable END;
    IF bad > 0 THEN RAISE EXCEPTION 'store %: % ledger running balances do not end at the balance', t, bad; END IF;

    -- 3. Reserved equals the active web-order reservations.
    SELECT count(*) INTO bad FROM stock_balances b
      LEFT JOIN (SELECT variant_id, location_id, sum(qty) AS q FROM stock_reservations WHERE state = 'active' GROUP BY 1, 2) res
             USING (variant_id, location_id)
     WHERE b.reserved <> coalesce(res.q, 0);
    IF bad > 0 THEN RAISE EXCEPTION 'store %: % reserved quantities differ from active reservations', t, bad; END IF;

    FOR r IN SELECT tbl FROM integrity_counts LOOP
      EXECUTE format($q$SELECT count(*) FROM %I$q$, r.tbl) INTO cnt;
      UPDATE integrity_counts SET n = integrity_counts.n + cnt WHERE tbl = r.tbl;
    END LOOP;
    INSERT INTO integrity_files SELECT object_key FROM files;
  END LOOP;
  RAISE NOTICE 'integrity OK: % stores checked', stores;
END $$;

\set QUIET off
SELECT tbl AS "table", n AS "rows" FROM integrity_counts ORDER BY tbl;
\copy (SELECT object_key FROM integrity_files ORDER BY 1) TO 'files-in-db.txt'
