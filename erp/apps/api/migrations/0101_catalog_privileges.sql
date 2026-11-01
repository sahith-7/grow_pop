-- B2 · Phase 1 sets default privileges (SELECT, INSERT, UPDATE, DELETE on every new table) for erp_rt,
-- so 0100's GRANTs only added to them. Take back what B2's runtime code never needs.
REVOKE INSERT, UPDATE, DELETE ON units FROM erp_rt;                       -- fixed GST unit list (D23)
REVOKE UPDATE, DELETE ON files FROM erp_rt;                               -- uploads are write-once
REVOKE DELETE ON categories, brands, products, product_variants, barcode_sequences,
                 import_jobs, idempotency_keys, sync_jobs FROM erp_rt;   -- archive, never delete
-- product_images keeps DELETE: removing a photo is a real delete.
