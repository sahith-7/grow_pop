-- GroPop v2 batch 1 · product form and categories (D88, D89).

-- Net weight / net content as printed on the pack (Legal Metrology), separate from the shipping weight in weight_g.
ALTER TABLE product_variants
  ADD COLUMN net_weight      numeric(12,3) CHECK (net_weight > 0),
  ADD COLUMN net_weight_unit text CHECK (net_weight_unit IN ('g', 'kg', 'ml', 'l')),
  ADD CONSTRAINT variant_net_weight_pair CHECK ((net_weight IS NULL) = (net_weight_unit IS NULL));

-- Categories and brands may now be deleted, but only while nothing uses them (catalog/service.ts deleteRef checks
-- products, sub-categories and the shop's category map in the same transaction). 0101 took DELETE away; give it back
-- for these two tables only. Products and variants are still archived, never deleted.
GRANT DELETE ON categories, brands TO erp_rt;

-- v2 (D93): every store runs on India Standard Time. Phase 1's settings page could save the first zone in the list
-- (Africa/Abidjan) by mistake, which shifted every "today", report day and invoice date by 5½ hours. tenants has RLS
-- without FORCE, so the owner role running migrations updates every store here.
UPDATE tenants SET timezone = 'Asia/Kolkata' WHERE timezone IS DISTINCT FROM 'Asia/Kolkata';
ALTER TABLE tenants ALTER COLUMN timezone SET DEFAULT 'Asia/Kolkata';

-- Dashboard overview filters sales by the counter's location and by day.
CREATE INDEX IF NOT EXISTS sales_orders_location_idx ON sales_orders (tenant_id, location_id, placed_at);
CREATE INDEX IF NOT EXISTS goods_receipt_lines_location_idx ON goods_receipt_lines (tenant_id, location_id);
