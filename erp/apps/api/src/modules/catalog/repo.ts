import type { Tx } from '../../db.js';
import { fmtMoney, fmtQty } from '../../lib/decimal.js';

// SQL for the catalog module. Only this module's service may import it (01-architecture.md §3).

export const fileUrl = (fileId: string | null) => (fileId ? `/api/v1/files/${fileId}/content` : null);

const VARIANT_COLS = `id, product_id, sku, barcode, attributes, price, mrp, cost, weight_g, length_mm, width_mm, height_mm,
  reorder_level, status, version`;

export interface VariantRow {
  id: string; product_id: string; sku: string; barcode: string | null; attributes: Record<string, string>;
  price: string; mrp: string | null; cost: string | null; weight_g: number | null;
  length_mm: number | null; width_mm: number | null; height_mm: number | null;
  reorder_level: string | null; status: 'active' | 'archived'; version: number;
}

export function variantOut(r: VariantRow, showCost: boolean) {
  return {
    id: r.id,
    sku: r.sku,
    barcode: r.barcode,
    attributes: r.attributes,
    price: fmtMoney(r.price)!,
    mrp: fmtMoney(r.mrp),
    ...(showCost ? { cost: fmtMoney(r.cost) } : {}),
    weightG: r.weight_g,
    dimensionsMm: r.length_mm === null && r.width_mm === null && r.height_mm === null
      ? null : { l: r.length_mm ?? 0, w: r.width_mm ?? 0, h: r.height_mm ?? 0 },
    reorderLevel: fmtQty(r.reorder_level),
    status: r.status,
    version: r.version,
  };
}

export async function variantsOf(tx: Tx, productId: string): Promise<VariantRow[]> {
  const { rows } = await tx.query(`SELECT ${VARIANT_COLS} FROM product_variants WHERE product_id = $1 ORDER BY status, position, created_at`, [productId]);
  return rows;
}

export async function variantById(tx: Tx, id: string, lock = false): Promise<VariantRow | undefined> {
  const { rows } = await tx.query(`SELECT ${VARIANT_COLS} FROM product_variants WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0];
}

export async function insertVariant(tx: Tx, productId: string, v: {
  sku: string; barcode: string | null; attributes: Record<string, string>; price: string; mrp: string | null; cost: string | null;
  weightG: number | null; dims: { l: number; w: number; h: number } | null; reorderLevel: string | null;
}): Promise<VariantRow> {
  const { rows } = await tx.query(
    `INSERT INTO product_variants (tenant_id, product_id, sku, barcode, attributes, price, mrp, cost, weight_g, length_mm, width_mm, height_mm, reorder_level, position)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             (SELECT coalesce(max(position) + 1, 0) FROM product_variants WHERE product_id = $1))
     RETURNING ${VARIANT_COLS}`,
    [productId, v.sku, v.barcode, JSON.stringify(v.attributes), v.price, v.mrp, v.cost, v.weightG,
      v.dims?.l ?? null, v.dims?.w ?? null, v.dims?.h ?? null, v.reorderLevel]);
  return rows[0];
}

export interface ProductRow {
  id: string; name: string; description: string; category_id: string | null; brand_id: string | null; unit_code: string;
  type: 'simple' | 'variable'; status: 'draft' | 'active' | 'archived'; hsn_code: string | null; gst_rate: string | null;
  publish_to_web: boolean; publish_state: string; publish_error: string | null; version: number;
  created_at: Date; updated_at: Date; archived_at: Date | null;
}

export async function productById(tx: Tx, id: string, lock = false): Promise<ProductRow | undefined> {
  const { rows } = await tx.query(`SELECT * FROM products WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0];
}

export async function imagesOf(tx: Tx, productId: string) {
  const { rows } = await tx.query(
    `SELECT id, file_id, thumb_file_id, variant_id, sort_order, is_primary, alt_text, sync_state, last_error
       FROM product_images WHERE product_id = $1 ORDER BY sort_order, created_at`, [productId]);
  return rows.map((r) => ({
    id: r.id as string,
    url: fileUrl(r.file_id)!,
    thumbnailUrl: fileUrl(r.thumb_file_id ?? r.file_id)!,
    variantId: r.variant_id as string | null,
    sortOrder: r.sort_order as number,
    isPrimary: r.is_primary as boolean,
    altText: r.alt_text as string,
    syncState: r.sync_state as string,
    lastError: r.last_error as string | null,
  }));
}

export interface ListFilter {
  q?: string; status?: string; categoryId?: string; brandId?: string; limit: number; after: [string, string] | null;
}

/** Product list (CAT-01): name contains q, or a variant's SKU/barcode equals q. Sorted by name for stable cursors. */
export async function listProducts(tx: Tx, f: ListFilter) {
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = [];
  if (f.status) where.push(`p.status = ${p(f.status)}`);
  else where.push(`p.status <> 'archived'`);
  if (f.categoryId) where.push(`(p.category_id = ${p(f.categoryId)} OR p.category_id IN (SELECT id FROM categories WHERE parent_id = $${params.length}))`);
  if (f.brandId) where.push(`p.brand_id = ${p(f.brandId)}`);
  if (f.q) {
    const like = p(`%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const exact = p(f.q);
    where.push(`(lower(p.name) LIKE ${like} OR EXISTS (SELECT 1 FROM product_variants pv
                 WHERE pv.product_id = p.id AND (lower(pv.sku) = lower(${exact}) OR pv.barcode = ${exact})))`);
  }
  if (f.after) where.push(`(lower(p.name), p.id) > (${p(f.after[0])}, ${p(f.after[1])}::uuid)`);
  const { rows } = await tx.query(
    `SELECT p.id, p.name, lower(p.name) AS sort_name, p.status, p.publish_state, c.name AS category,
            v.n AS variant_count, v.skus, v.min_price, v.max_price, img.file_id AS thumb
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS n, (array_agg(sku ORDER BY position))[1:3] AS skus, min(price) AS min_price, max(price) AS max_price
           FROM product_variants WHERE product_id = p.id AND status = 'active') v
       LEFT JOIN LATERAL (
         SELECT coalesce(thumb_file_id, file_id) AS file_id FROM product_images WHERE product_id = p.id AND is_primary) img ON true
      WHERE ${where.join(' AND ')}
      ORDER BY lower(p.name), p.id
      LIMIT ${p(f.limit + 1)}`, params);
  return rows;
}
