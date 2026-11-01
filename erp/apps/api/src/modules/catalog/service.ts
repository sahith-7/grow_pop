import type { Tx } from '../../db.js';
import { audit } from '../../lib/phase1.js';
import { ean13 } from '../../lib/barcode.js';
import { fmtMoney } from '../../lib/decimal.js';
import { appError } from '../../lib/phase1.js';
import { mapUniqueViolation } from '../../lib/pg-errors.js';
import { assertFile } from '../files/service.js';
import * as repo from './repo.js';
import type { ProductInput, ProductPatch, VariantInput, VariantPatch } from './schemas.js';

export interface Ctx { userId: string; showCost: boolean }

const invalid = (fieldErrors: Record<string, string[]>) => appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', fieldErrors);
const notFound = (what = 'Product') => appError(404, 'NOT_FOUND', `${what} not found`);
const forbiddenCost = () => appError(403, 'FORBIDDEN', 'You do not have permission to set cost');

const UNIQUE_ERRORS = {
  variants_sku_uq: () => appError(409, 'SKU_DUPLICATE', 'This SKU is already used by another product'),
  variants_barcode_uq: () => appError(409, 'BARCODE_DUPLICATE', 'This barcode is already used by another product'),
  variants_attributes_uq: () => appError(409, 'VARIANT_DUPLICATE', 'Another variant already has these attributes'),
};

/** Drops empty attribute values so {size:'M'} and {size:'M', colour: undefined} are the same variant. */
function cleanAttributes(a: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined && v !== '')) as Record<string, string>;
}
const attrKeySet = (a: Record<string, string>) => Object.keys(a).sort().join(',');

// ------------------------------------------------------------------ categories & brands

type RefTable = 'categories' | 'brands';

export async function listRefs(tx: Tx, table: RefTable, includeArchived: boolean) {
  const parent = table === 'categories' ? 'parent_id' : 'NULL::uuid AS parent_id';
  const { rows } = await tx.query(
    `SELECT id, name, ${parent}, archived_at FROM ${table} ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY lower(name)`);
  return rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id, archivedAt: r.archived_at }));
}

/** Categories are at most two levels deep (Department > Category) so filters and reports stay simple. */
async function checkParent(tx: Tx, id: string | null, parentId: string | null | undefined) {
  if (!parentId) return;
  const { rows } = await tx.query('SELECT parent_id, archived_at FROM categories WHERE id = $1', [parentId]);
  if (!rows[0] || rows[0].archived_at) throw invalid({ parentId: ['Parent category not found'] });
  if (rows[0].parent_id) throw invalid({ parentId: ['Categories can only be two levels deep'] });
  if (id) {
    const kids = await tx.query('SELECT 1 FROM categories WHERE parent_id = $1 LIMIT 1', [id]);
    if (kids.rowCount) throw invalid({ parentId: ['This category has sub-categories, so it cannot move under another'] });
  }
}

const dupName = () => appError(409, 'NAME_DUPLICATE', 'That name is already used');

export async function createRef(tx: Tx, table: RefTable, input: { name: string; parentId?: string | null }) {
  if (table === 'categories') await checkParent(tx, null, input.parentId);
  const cols = table === 'categories' ? '(tenant_id, name, parent_id)' : '(tenant_id, name)';
  const vals = table === 'categories' ? "(current_setting('app.tenant_id')::uuid, $1, $2)" : "(current_setting('app.tenant_id')::uuid, $1)";
  const params = table === 'categories' ? [input.name, input.parentId ?? null] : [input.name];
  try {
    const { rows } = await tx.query(`INSERT INTO ${table} ${cols} VALUES ${vals} RETURNING id`, params);
    return (await listRefs(tx, table, true)).find((r) => r.id === rows[0].id)!;
  } catch (e) { mapUniqueViolation(e, { categories_name_uq: dupName, brands_name_uq: dupName }); }
}

export async function patchRef(tx: Tx, table: RefTable, id: string, input: { name: string; parentId?: string | null; archived?: boolean }) {
  if (table === 'categories' && input.parentId !== undefined) {
    if (input.parentId === id) throw invalid({ parentId: ['A category cannot be its own parent'] });
    await checkParent(tx, id, input.parentId);
  }
  const sets = ['name = $2', 'updated_at = now()'];
  const params: unknown[] = [id, input.name];
  if (table === 'categories' && input.parentId !== undefined) { params.push(input.parentId); sets.push(`parent_id = $${params.length}`); }
  if (input.archived !== undefined) sets.push(input.archived ? 'archived_at = coalesce(archived_at, now())' : 'archived_at = NULL');
  try {
    const { rowCount } = await tx.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1`, params);
    if (!rowCount) throw notFound(table === 'categories' ? 'Category' : 'Brand');
  } catch (e) { mapUniqueViolation(e, { categories_name_uq: dupName, brands_name_uq: dupName }); }
  return (await listRefs(tx, table, true)).find((r) => r.id === id)!;
}

export async function listUnits(tx: Tx) {
  const { rows } = await tx.query('SELECT code, name, abbr, allow_fraction FROM units ORDER BY allow_fraction, name');
  return rows.map((r) => ({ code: r.code, name: r.name, abbr: r.abbr, allowFraction: r.allow_fraction }));
}

// ------------------------------------------------------------------ products

async function checkRefs(tx: Tx, p: { categoryId?: string | null; brandId?: string | null; unitCode?: string }) {
  const errors: Record<string, string[]> = {};
  if (p.categoryId) {
    const r = await tx.query('SELECT 1 FROM categories WHERE id = $1 AND archived_at IS NULL', [p.categoryId]);
    if (!r.rowCount) errors.categoryId = ['Category not found'];
  }
  if (p.brandId) {
    const r = await tx.query('SELECT 1 FROM brands WHERE id = $1 AND archived_at IS NULL', [p.brandId]);
    if (!r.rowCount) errors.brandId = ['Brand not found'];
  }
  if (p.unitCode !== undefined) {
    const r = await tx.query('SELECT 1 FROM units WHERE code = $1', [p.unitCode]);
    if (!r.rowCount) errors.unitCode = ['Unknown unit'];
  }
  if (Object.keys(errors).length) throw invalid(errors);
}

/** Field errors for SKUs/barcodes already used in this tenant, so the form can point at the exact variant row. */
async function checkCodesFree(tx: Tx, variants: { sku?: string; barcode?: string | null }[], prefix: string, excludeVariantId?: string) {
  const skus = variants.map((v) => v.sku?.toLowerCase()).filter(Boolean) as string[];
  const codes = variants.map((v) => v.barcode).filter(Boolean) as string[];
  const { rows } = await tx.query(
    `SELECT lower(sku) AS sku, barcode FROM product_variants
      WHERE (lower(sku) = ANY($1) OR barcode = ANY($2)) AND id IS DISTINCT FROM $3`, [skus, codes, excludeVariantId ?? null]);
  const usedSku = new Set(rows.map((r) => r.sku));
  const usedCode = new Set(rows.map((r) => r.barcode));
  const errors: Record<string, string[]> = {};
  variants.forEach((v, i) => {
    const at = prefix ? `${prefix}.${i}.` : '';
    if (v.sku && usedSku.has(v.sku.toLowerCase())) errors[`${at}sku`] = ['This SKU is already used'];
    if (v.barcode && usedCode.has(v.barcode)) errors[`${at}barcode`] = ['This barcode is already used'];
  });
  if (Object.keys(errors).length) {
    const code = Object.keys(errors).some((k) => k.endsWith('sku')) ? 'SKU_DUPLICATE' : 'BARCODE_DUPLICATE';
    throw appError(409, code, code === 'SKU_DUPLICATE' ? 'A SKU is already used by another product' : 'A barcode is already used by another product', errors);
  }
}

function variantValues(v: VariantInput) {
  return {
    sku: v.sku, barcode: v.barcode ?? null, attributes: cleanAttributes(v.attributes), price: v.price, mrp: v.mrp ?? null,
    cost: v.cost ?? null, weightG: v.weightG ?? null, dims: v.dimensionsMm ?? null, reorderLevel: v.reorderLevel ?? null,
  };
}

function checkMrp(v: { price?: string; mrp?: string | null }, field: string, errors: Record<string, string[]>) {
  if (v.price && v.mrp && Number(v.price) > Number(v.mrp)) errors[field] = ['Selling price cannot be above MRP'];
}

export async function getProduct(tx: Tx, id: string, ctx: Ctx) {
  const p = await repo.productById(tx, id);
  if (!p) throw notFound();
  // One client runs one query at a time, so these are sequential.
  const variants = await repo.variantsOf(tx, id);
  const images = await repo.imagesOf(tx, id);
  return {
    id: p.id, name: p.name, description: p.description, categoryId: p.category_id, brandId: p.brand_id, unitCode: p.unit_code,
    type: p.type, status: p.status, hsnCode: p.hsn_code, gstRate: p.gst_rate === null ? null : String(Number(p.gst_rate)),
    publishToWeb: p.publish_to_web, publishState: p.publish_state, publishError: p.publish_error, version: p.version,
    variants: variants.map((v) => repo.variantOut(v, ctx.showCost)), images,
    createdAt: p.created_at, updatedAt: p.updated_at, archivedAt: p.archived_at,
  };
}

export async function createProduct(tx: Tx, ctx: Ctx, input: ProductInput) {
  if (!ctx.showCost && input.variants.some((v) => v.cost !== undefined)) throw forbiddenCost();
  const errors: Record<string, string[]> = {};
  const values = input.variants.map(variantValues);
  if (input.type === 'simple') {
    if (values.length !== 1) errors.variants = ['A simple product has exactly one variant'];
    else if (Object.keys(values[0].attributes).length) errors['variants.0.attributes'] = ['A simple product has no size/colour; make it variable'];
  } else {
    const keys = attrKeySet(values[0].attributes);
    values.forEach((v, i) => {
      if (!Object.keys(v.attributes).length) errors[`variants.${i}.attributes`] = ['Each variant needs at least one attribute'];
      else if (attrKeySet(v.attributes) !== keys) errors[`variants.${i}.attributes`] = ['All variants need the same attributes'];
    });
  }
  const seenSku = new Map<string, number>();
  const seenCode = new Map<string, number>();
  const seenAttrs = new Map<string, number>();
  values.forEach((v, i) => {
    const s = v.sku.toLowerCase();
    if (seenSku.has(s)) errors[`variants.${i}.sku`] = ['Same SKU as another variant'];
    seenSku.set(s, i);
    if (v.barcode) { if (seenCode.has(v.barcode)) errors[`variants.${i}.barcode`] = ['Same barcode as another variant']; seenCode.set(v.barcode, i); }
    const a = JSON.stringify(Object.entries(v.attributes).sort());
    if (input.type === 'variable' && seenAttrs.has(a)) errors[`variants.${i}.attributes`] = ['Same attributes as another variant'];
    seenAttrs.set(a, i);
    checkMrp(v, `variants.${i}.price`, errors);
  });
  if (Object.keys(errors).length) throw invalid(errors);
  await checkRefs(tx, input);
  await checkCodesFree(tx, values, 'variants');

  const { rows } = await tx.query(
    `INSERT INTO products (tenant_id, name, description, category_id, brand_id, unit_code, type, status, hsn_code, gst_rate, publish_to_web, created_by)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [input.name, input.description, input.categoryId, input.brandId, input.unitCode, input.type, input.status, input.hsnCode,
      input.gstRate, input.publishToWeb, ctx.userId]);
  const id = rows[0].id as string;
  try {
    for (const v of values) await repo.insertVariant(tx, id, v);
  } catch (e) { mapUniqueViolation(e, UNIQUE_ERRORS); }
  await audit(tx, { actorId: ctx.userId, action: 'product.create', entityType: 'product', entityId: id,
    summary: { name: input.name, variants: values.map((v) => ({ sku: v.sku, price: v.price, barcode: v.barcode })) } });
  return getProduct(tx, id, ctx);
}

/** Lock the row and check If-Match. 404 before 412 so another tenant's id never reveals anything. */
async function lockProduct(tx: Tx, id: string, version?: number) {
  const p = await repo.productById(tx, id, true);
  if (!p) throw notFound();
  if (version !== undefined && p.version !== version) throw appError(412, 'VERSION_CONFLICT', 'Someone else changed this product. Reload and try again.');
  return p;
}

const PRODUCT_COLS: Record<keyof ProductPatch, keyof repo.ProductRow> = {
  name: 'name', description: 'description', categoryId: 'category_id', brandId: 'brand_id', unitCode: 'unit_code',
  status: 'status', hsnCode: 'hsn_code', gstRate: 'gst_rate', publishToWeb: 'publish_to_web',
};

export async function patchProduct(tx: Tx, ctx: Ctx, id: string, version: number, patch: ProductPatch) {
  const p = await lockProduct(tx, id, version);
  if (p.status === 'archived') throw appError(409, 'INVALID_STATE', 'Restore this product before editing it');
  await checkRefs(tx, patch);
  const changes: Record<string, [unknown, unknown]> = {};
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [k, col] of Object.entries(PRODUCT_COLS) as [keyof ProductPatch, keyof repo.ProductRow][]) {
    if (patch[k] === undefined) continue;
    const before = col === 'gst_rate' && p.gst_rate !== null ? String(Number(p.gst_rate)) : p[col];
    if (before === patch[k]) continue;
    changes[k] = [before, patch[k]];
    params.push(patch[k]);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length) {
    await tx.query(`UPDATE products SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE id = $1`, params);
    await audit(tx, { actorId: ctx.userId, action: 'product.update', entityType: 'product', entityId: id, summary: changes });
  }
  return getProduct(tx, id, ctx);
}

export async function setProductArchived(tx: Tx, ctx: Ctx, id: string, archived: boolean) {
  const p = await lockProduct(tx, id);
  if (archived === (p.status === 'archived')) return getProduct(tx, id, ctx);
  await tx.query(
    archived
      ? "UPDATE products SET status = 'archived', archived_at = now(), version = version + 1, updated_at = now() WHERE id = $1"
      : "UPDATE products SET status = 'draft', archived_at = NULL, version = version + 1, updated_at = now() WHERE id = $1", [id]);
  await audit(tx, { actorId: ctx.userId, action: archived ? 'product.archive' : 'product.restore', entityType: 'product', entityId: id, summary: { name: p.name } });
  return getProduct(tx, id, ctx);
}

// ------------------------------------------------------------------ variants

export async function addVariant(tx: Tx, ctx: Ctx, productId: string, input: VariantInput) {
  if (!ctx.showCost && input.cost !== undefined) throw forbiddenCost();
  const p = await lockProduct(tx, productId);
  if (p.status === 'archived') throw appError(409, 'INVALID_STATE', 'Restore this product before adding variants');
  if (p.type === 'simple') throw appError(409, 'INVALID_STATE', 'A simple product has one variant. Create a variable product for sizes or colours.');
  const v = variantValues(input);
  const errors: Record<string, string[]> = {};
  checkMrp(v, 'price', errors);
  const existing = (await repo.variantsOf(tx, productId)).filter((x) => x.status === 'active');
  if (existing.length && attrKeySet(existing[0].attributes) !== attrKeySet(v.attributes))
    errors.attributes = [`Use the same attributes as the other variants (${Object.keys(existing[0].attributes).join(', ')})`];
  if (!Object.keys(v.attributes).length) errors.attributes = ['A variant needs at least one attribute'];
  if (Object.keys(errors).length) throw invalid(errors);
  await checkCodesFree(tx, [v], '');
  let row: repo.VariantRow;
  try { row = await repo.insertVariant(tx, productId, v); } catch (e) { mapUniqueViolation(e, UNIQUE_ERRORS); }
  await audit(tx, { actorId: ctx.userId, action: 'variant.create', entityType: 'product', entityId: productId,
    summary: { sku: v.sku, price: v.price, barcode: v.barcode, attributes: v.attributes } });
  return repo.variantOut(row, ctx.showCost);
}

const VARIANT_FIELDS = ['sku', 'barcode', 'price', 'mrp', 'cost', 'weightG', 'reorderLevel'] as const;
const VARIANT_COLS: Record<(typeof VARIANT_FIELDS)[number], keyof repo.VariantRow> = {
  sku: 'sku', barcode: 'barcode', price: 'price', mrp: 'mrp', cost: 'cost', weightG: 'weight_g', reorderLevel: 'reorder_level',
};
const sameNumber = (a: string | null, b: string | null | undefined) => (a === null || b == null ? a === (b ?? null) : Number(a) === Number(b));

async function lockVariant(tx: Tx, id: string, version?: number) {
  const v = await repo.variantById(tx, id, true);
  if (!v) throw notFound('Variant');
  if (version !== undefined && v.version !== version) throw appError(412, 'VERSION_CONFLICT', 'Someone else changed this variant. Reload and try again.');
  return v;
}

export async function patchVariant(tx: Tx, ctx: Ctx, id: string, version: number, patch: VariantPatch) {
  if (!ctx.showCost && patch.cost !== undefined) throw forbiddenCost();
  const v = await lockVariant(tx, id, version);
  const product = await lockProduct(tx, v.product_id);
  if (product.status === 'archived' || v.status === 'archived') throw appError(409, 'INVALID_STATE', 'Restore this product before editing it');
  const errors: Record<string, string[]> = {};
  checkMrp({ price: patch.price ?? v.price, mrp: patch.mrp === undefined ? v.mrp : patch.mrp }, 'price', errors);
  let attrs: Record<string, string> | undefined;
  if (patch.attributes !== undefined) {
    attrs = cleanAttributes(patch.attributes);
    if (product.type === 'simple' && Object.keys(attrs).length) errors.attributes = ['A simple product has no size/colour'];
    if (product.type === 'variable' && attrKeySet(attrs) !== attrKeySet(v.attributes)) errors.attributes = ['Keep the same attributes; change only their values'];
  }
  if (Object.keys(errors).length) throw invalid(errors);
  await checkCodesFree(tx, [{ sku: patch.sku, barcode: patch.barcode }], '', id);

  const changes: Record<string, [unknown, unknown]> = {};
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  for (const f of VARIANT_FIELDS) {
    if (patch[f] === undefined) continue;
    const before = v[VARIANT_COLS[f]] as string | number | null;
    const after = patch[f] ?? null;
    const same = ['price', 'mrp', 'cost', 'reorderLevel'].includes(f) ? sameNumber(before as string | null, after as string | null) : before === after;
    if (same) continue;
    changes[f] = f === 'cost' ? [fmtMoney(before as string | null), after] : [before, after];
    set(VARIANT_COLS[f], after);
  }
  if (attrs && JSON.stringify(attrs) !== JSON.stringify(v.attributes)) { changes.attributes = [v.attributes, attrs]; set('attributes', JSON.stringify(attrs)); }
  if (patch.dimensionsMm !== undefined) {
    const d = patch.dimensionsMm;
    set('length_mm', d?.l ?? null); set('width_mm', d?.w ?? null); set('height_mm', d?.h ?? null);
    changes.dimensionsMm = [null, d];
  }
  if (sets.length) {
    try {
      await tx.query(`UPDATE product_variants SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE id = $1`, params);
    } catch (e) { mapUniqueViolation(e, UNIQUE_ERRORS); }
    await audit(tx, { actorId: ctx.userId, action: 'variant.update', entityType: 'product', entityId: v.product_id, summary: { sku: v.sku, ...changes } });
  }
  return repo.variantOut((await repo.variantById(tx, id))!, ctx.showCost);
}

export async function setVariantArchived(tx: Tx, ctx: Ctx, id: string, archived: boolean) {
  const v = await lockVariant(tx, id);
  await lockProduct(tx, v.product_id);
  if (archived && v.status === 'active') {
    const { rows } = await tx.query("SELECT count(*)::int AS n FROM product_variants WHERE product_id = $1 AND status = 'active'", [v.product_id]);
    if (rows[0].n <= 1) throw appError(409, 'INVALID_STATE', 'This is the last variant. Archive the product instead.');
  }
  if (archived !== (v.status === 'archived')) {
    await tx.query(
      `UPDATE product_variants SET status = $2, archived_at = CASE WHEN $2 = 'archived' THEN now() END, version = version + 1, updated_at = now() WHERE id = $1`,
      [id, archived ? 'archived' : 'active']);
    await audit(tx, { actorId: ctx.userId, action: archived ? 'variant.archive' : 'variant.restore', entityType: 'product', entityId: v.product_id, summary: { sku: v.sku } });
  }
  return repo.variantOut((await repo.variantById(tx, id))!, ctx.showCost);
}

// ------------------------------------------------------------------ list, lookup

export async function listProducts(tx: Tx, f: repo.ListFilter) {
  const rows = await repo.listProducts(tx, f);
  const more = rows.length > f.limit;
  const page = rows.slice(0, f.limit);
  return {
    items: page.map((r) => ({
      id: r.id, name: r.name, status: r.status, category: r.category, variantCount: r.variant_count, skus: r.skus ?? [],
      priceRange: r.min_price === null ? null : { min: fmtMoney(r.min_price), max: fmtMoney(r.max_price) },
      thumbnailUrl: repo.fileUrl(r.thumb), publishState: r.publish_state,
    })),
    last: more ? [page.at(-1)!.sort_name, page.at(-1)!.id] as [string, string] : null,
  };
}

/** Scanner lookup (AC-04): exact barcode first, then SKU (case-insensitive). Archived products never match. */
export async function lookup(tx: Tx, code: string, ctx: Ctx) {
  const { rows } = await tx.query(
    `SELECT v.id, CASE WHEN v.barcode = $1 THEN 'barcode' ELSE 'sku' END AS matched_on,
            p.id AS product_id, p.name AS product_name, p.status AS product_status, p.gst_rate
       FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE (v.barcode = $1 OR lower(v.sku) = lower($1)) AND v.status = 'active' AND p.status <> 'archived'
      ORDER BY (v.barcode = $1) DESC LIMIT 1`, [code]);
  const r = rows[0];
  if (!r) throw appError(404, 'NOT_FOUND', 'No product has this barcode or SKU');
  const v = (await repo.variantById(tx, r.id))!;
  return {
    matchedOn: r.matched_on, productId: r.product_id, productName: r.product_name, productStatus: r.product_status,
    gstRate: r.gst_rate === null ? null : String(Number(r.gst_rate)), variant: repo.variantOut(v, ctx.showCost),
  };
}

// ------------------------------------------------------------------ images (CAT-05/06)

const MAX_IMAGES = 10;

export async function addImage(tx: Tx, _ctx: Ctx, productId: string, input: { fileId: string; thumbFileId?: string | null; variantId?: string | null; altText: string; isPrimary?: boolean }) {
  await lockProduct(tx, productId);
  await assertFile(tx, input.fileId, 'product_image', 'fileId');
  if (input.thumbFileId) await assertFile(tx, input.thumbFileId, 'product_image', 'thumbFileId');
  if (input.variantId) {
    const v = await repo.variantById(tx, input.variantId);
    if (!v || v.product_id !== productId) throw invalid({ variantId: ['Variant not found on this product'] });
  }
  const { rows } = await tx.query('SELECT count(*)::int AS n, coalesce(max(sort_order), -1) AS last FROM product_images WHERE product_id = $1', [productId]);
  if (rows[0].n >= MAX_IMAGES) throw appError(409, 'IMAGE_LIMIT', `A product can have at most ${MAX_IMAGES} images`);
  const primary = input.isPrimary || rows[0].n === 0;
  if (primary) await tx.query('UPDATE product_images SET is_primary = false WHERE product_id = $1 AND is_primary', [productId]);
  const ins = await tx.query(
    `INSERT INTO product_images (tenant_id, product_id, variant_id, file_id, thumb_file_id, sort_order, is_primary, alt_text)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [productId, input.variantId ?? null, input.fileId, input.thumbFileId ?? null, rows[0].last + 1, primary, input.altText]);
  await touch(tx, productId);
  return (await repo.imagesOf(tx, productId)).find((i) => i.id === ins.rows[0].id)!;
}

export async function patchImage(tx: Tx, productId: string, imageId: string, input: { fileId?: string; thumbFileId?: string | null; altText?: string }) {
  await lockProduct(tx, productId);
  if (input.fileId) await assertFile(tx, input.fileId, 'product_image', 'fileId');
  if (input.thumbFileId) await assertFile(tx, input.thumbFileId, 'product_image', 'thumbFileId');
  const { rowCount } = await tx.query(
    `UPDATE product_images SET file_id = coalesce($3, file_id),
            thumb_file_id = CASE WHEN $3::uuid IS NOT NULL OR $5 THEN $4 ELSE thumb_file_id END,
            alt_text = coalesce($6, alt_text), sync_state = 'pending'
      WHERE id = $2 AND product_id = $1`,
    [productId, imageId, input.fileId ?? null, input.thumbFileId ?? null, input.thumbFileId !== undefined, input.altText ?? null]);
  if (!rowCount) throw notFound('Image');
  await touch(tx, productId);
  return (await repo.imagesOf(tx, productId)).find((i) => i.id === imageId)!;
}

export async function deleteImage(tx: Tx, productId: string, imageId: string) {
  await lockProduct(tx, productId);
  const { rows } = await tx.query('DELETE FROM product_images WHERE id = $2 AND product_id = $1 RETURNING is_primary', [productId, imageId]);
  if (!rows[0]) throw notFound('Image');
  if (rows[0].is_primary)
    await tx.query(`UPDATE product_images SET is_primary = true WHERE id = (SELECT id FROM product_images WHERE product_id = $1 ORDER BY sort_order LIMIT 1)`, [productId]);
  await touch(tx, productId);
}

export async function reorderImages(tx: Tx, productId: string, imageIds: string[], primaryId: string) {
  await lockProduct(tx, productId);
  const current = (await repo.imagesOf(tx, productId)).map((i) => i.id);
  if (current.length !== imageIds.length || new Set(imageIds).size !== imageIds.length || !imageIds.every((id) => current.includes(id)))
    throw invalid({ imageIds: ['List every image of this product exactly once'] });
  if (!imageIds.includes(primaryId)) throw invalid({ primaryImageId: ['Pick one of the listed images'] });
  await tx.query('UPDATE product_images SET is_primary = false WHERE product_id = $1', [productId]);
  await tx.query(
    `UPDATE product_images i SET sort_order = o.ord - 1, is_primary = (i.id = $2)
       FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, ord) WHERE i.id = o.id`, [imageIds, primaryId]);
  await touch(tx, productId);
  return repo.imagesOf(tx, productId);
}

/** Image changes bump the product version so an open edit form notices them. */
const touch = (tx: Tx, productId: string) => tx.query('UPDATE products SET version = version + 1, updated_at = now() WHERE id = $1', [productId]);

// ------------------------------------------------------------------ barcodes & labels (AC-04)

/** Reserve `count` in-store EAN-13 codes, skipping any already on a variant (e.g. imported from an old system). */
export async function generateBarcodes(tx: Tx, count: number) {
  await tx.query(`INSERT INTO barcode_sequences (tenant_id) VALUES (current_setting('app.tenant_id')::uuid) ON CONFLICT DO NOTHING`);
  const { rows } = await tx.query('SELECT prefix, next_value FROM barcode_sequences FOR UPDATE');
  const { prefix } = rows[0];
  let next = Number(rows[0].next_value);
  const out: string[] = [];
  while (out.length < count) {
    const batch: string[] = [];
    for (let i = 0; i < count - out.length; i++) {
      if (next > 999_999_999) throw appError(409, 'BARCODE_RANGE_EXHAUSTED', 'No in-store barcodes left in this prefix');
      batch.push(ean13(prefix, next++));
    }
    const used = await tx.query('SELECT barcode FROM product_variants WHERE barcode = ANY($1)', [batch]);
    const taken = new Set(used.rows.map((r) => r.barcode));
    out.push(...batch.filter((c) => !taken.has(c)));
  }
  await tx.query('UPDATE barcode_sequences SET next_value = $1', [next]);
  return out;
}

/** Label data; the browser draws the barcode (EAN-13 when valid, otherwise Code 128 of the barcode or SKU). */
export async function labels(tx: Tx, items: { variantId: string; copies: number }[]) {
  const total = items.reduce((n, i) => n + i.copies, 0);
  if (total > 2000) throw invalid({ items: ['Print at most 2000 labels at a time'] });
  const { rows } = await tx.query(
    `SELECT v.id, v.sku, v.barcode, v.attributes, v.price, v.mrp, p.name
       FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ANY($1)`, [items.map((i) => i.variantId)]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = items.findIndex((i) => !byId.has(i.variantId));
  if (missing >= 0) throw invalid({ [`items.${missing}.variantId`]: ['Variant not found'] });
  return items.map((i) => {
    const r = byId.get(i.variantId)!;
    const attrs = Object.values(r.attributes as Record<string, string>).join(' / ');
    return {
      variantId: r.id, copies: i.copies, code: r.barcode ?? r.sku, codeSource: r.barcode ? 'barcode' : 'sku',
      sku: r.sku, name: attrs ? `${r.name} · ${attrs}` : r.name, price: fmtMoney(r.price), mrp: fmtMoney(r.mrp),
    };
  });
}

// ------------------------------------------------------------------ bulk create (CSV import)

export interface ImportedProduct {
  name: string; type: 'simple' | 'variable'; category: string[] | null; brand: string | null; unitCode: string;
  hsnCode: string | null; gstRate: string | null; status: 'active' | 'draft'; description: string;
  variants: { sku: string; barcode: string | null; price: string; mrp: string | null; cost: string | null;
    attributes: Record<string, string>; reorderLevel: string | null; weightG: number | null }[];
}

/**
 * Insert already-validated products. Missing categories and brands are created (matched case-insensitively,
 * archived ones are reused and un-archived). A uniqueness race with a concurrent edit aborts the whole batch.
 */
export async function insertImportedProducts(tx: Tx, userId: string, products: ImportedProduct[]) {
  const cats = new Map<string, string>();
  const brands = new Map<string, string>();
  const findOrCreate = async (table: RefTable, name: string, parentId: string | null) => {
    const cache = table === 'brands' ? brands : cats;
    const key = `${parentId ?? ''}/${name.toLowerCase()}`;
    if (cache.has(key)) return cache.get(key)!;
    const where = table === 'categories' ? 'AND parent_id IS NOT DISTINCT FROM $2' : '';
    const params = table === 'categories' ? [name, parentId] : [name];
    let { rows } = await tx.query(`UPDATE ${table} SET archived_at = NULL WHERE lower(name) = lower($1) ${where} RETURNING id`, params);
    if (!rows[0]) {
      const cols = table === 'categories' ? '(tenant_id, name, parent_id)' : '(tenant_id, name)';
      const vals = table === 'categories' ? '$1, $2' : '$1';
      ({ rows } = await tx.query(`INSERT INTO ${table} ${cols} VALUES (current_setting('app.tenant_id')::uuid, ${vals}) RETURNING id`, params));
    }
    cache.set(key, rows[0].id);
    return rows[0].id as string;
  };
  let variants = 0;
  for (const p of products) {
    let categoryId: string | null = null;
    if (p.category) {
      categoryId = await findOrCreate('categories', p.category[0], null);
      if (p.category[1]) categoryId = await findOrCreate('categories', p.category[1], categoryId);
    }
    const brandId = p.brand ? await findOrCreate('brands', p.brand, null) : null;
    const { rows } = await tx.query(
      `INSERT INTO products (tenant_id, name, description, category_id, brand_id, unit_code, type, status, hsn_code, gst_rate, created_by)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [p.name, p.description, categoryId, brandId, p.unitCode, p.type, p.status, p.hsnCode, p.gstRate, userId]);
    try {
      for (const v of p.variants) {
        await repo.insertVariant(tx, rows[0].id, { ...v, dims: null });
        variants++;
      }
    } catch (e) { mapUniqueViolation(e, UNIQUE_ERRORS); }
  }
  return { products: products.length, variants };
}

/** Facts the CSV validator needs about the existing catalog. */
export async function importRefs(tx: Tx, skus: string[], barcodes: string[]) {
  const s = await tx.query('SELECT lower(sku) AS v FROM product_variants WHERE lower(sku) = ANY($1)', [skus.map((x) => x.toLowerCase())]);
  const b = await tx.query('SELECT barcode AS v FROM product_variants WHERE barcode = ANY($1)', [barcodes]);
  const u = await tx.query('SELECT code, abbr, name FROM units');
  const units = new Map<string, string>();
  for (const r of u.rows) for (const k of [r.code, r.abbr, r.name]) units.set(String(k).toLowerCase(), r.code);
  for (const [alias, code] of [['pc', 'NOS'], ['piece', 'NOS'], ['nos', 'NOS'], ['kgs', 'KGS'], ['ltr', 'LTR'], ['mtr', 'MTR'], ['dozen', 'DOZ']])
    units.set(alias, code);
  return { skus: new Set<string>(s.rows.map((r) => r.v)), barcodes: new Set<string>(b.rows.map((r) => r.v)), units };
}

/** Every variant with its product fields, for CSV export. */
export async function exportRows(tx: Tx) {
  const { rows } = await tx.query(
    `SELECT p.name AS product_name, v.sku, v.price, v.mrp, v.cost, v.barcode,
            CASE WHEN pc.name IS NOT NULL THEN pc.name || ' > ' || c.name ELSE c.name END AS category,
            b.name AS brand, u.abbr AS unit, p.hsn_code, p.gst_rate, v.attributes, v.reorder_level, v.weight_g,
            p.status, p.description
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       JOIN units u ON u.code = p.unit_code
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN categories pc ON pc.id = c.parent_id
       LEFT JOIN brands b ON b.id = p.brand_id
      WHERE v.status = 'active' AND p.status <> 'archived'
      ORDER BY lower(p.name), p.id, v.position`);
  return rows;
}
