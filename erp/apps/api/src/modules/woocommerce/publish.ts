import { tenantTx, type Tx } from '../../db.js';
import { withJobLock } from '../../jobs/lock.js';
import { PermanentJobError } from '../../jobs/runner.js';
import { ATTRIBUTE_KEYS } from '../catalog/schemas.js';
import { WooClient, WooError } from './client.js';
import { clientFor, noteResult } from './connection.js';
import { imageUrl } from './media.js';

// woo.product (CAT-07/08, AC-02): make the Woo product match the ERP product.
// - ERP owns: name, SKU, price, stock, variations, status. Description, category, weight/size and images are sent only
//   when the ERP has a value, so adopting an existing Woo product never blanks what the shop already shows.
// - No mapping yet: look the SKUs up in Woo first and adopt what is there, so a crash between Woo's create and saving the
//   mapping never makes a duplicate. Variable parents carry _erp_product_id for the same reason.
// - Taken off the website (unticked, archived): the Woo product goes to draft; it is never deleted.

const ATTR_LABEL: Record<(typeof ATTRIBUTE_KEYS)[number], string> = { size: 'Size', colour: 'Colour', model: 'Model', material: 'Material' };
const META_KEY = '_erp_product_id';
const NEW_IMAGES_PER_CALL = 3;   // Woo downloads every new image inside the request; keep each call well under the timeout
const IMAGE_TIMEOUT_MS = 60_000;

interface Snap {
  product: Record<string, any>; variants: Record<string, any>[]; images: Record<string, any>[];
  productMap: { woo_product_id: string; woo_type: string; state: string } | undefined;
  variantMaps: Map<string, { woo_product_id: string; woo_variation_id: string }>;
  category: { id: string; name: string; parent: { id: string; name: string } | null } | null;
  stock: Map<string, number>;
}

async function snapshot(tx: Tx, productId: string, onlineLocationId: string): Promise<Snap | null> {
  const { rows: [product] } = await tx.query('SELECT * FROM products WHERE id = $1', [productId]);
  if (!product) return null;
  const { rows: variants } = await tx.query('SELECT * FROM product_variants WHERE product_id = $1 ORDER BY position, sku', [productId]);
  const { rows: images } = await tx.query(
    `SELECT i.*, f.content_type FROM product_images i JOIN files f ON f.id = i.file_id
      WHERE i.product_id = $1 ORDER BY i.is_primary DESC, i.sort_order, i.created_at`, [productId]);
  const { rows: [productMap] } = await tx.query('SELECT woo_product_id, woo_type, state FROM woo_product_map WHERE product_id = $1', [productId]);
  const { rows: vm } = await tx.query('SELECT variant_id, woo_product_id, woo_variation_id FROM woo_variant_map WHERE variant_id = ANY($1)', [variants.map((v) => v.id)]);
  let category: Snap['category'] = null;
  if (product.category_id) {
    const { rows: [c] } = await tx.query(
      'SELECT c.id, c.name, p.id AS pid, p.name AS pname FROM categories c LEFT JOIN categories p ON p.id = c.parent_id WHERE c.id = $1', [product.category_id]);
    if (c) category = { id: c.id, name: c.name, parent: c.pid ? { id: c.pid, name: c.pname } : null };
  }
  const { rows: st } = await tx.query(
    'SELECT variant_id, greatest(0, floor(on_hand - reserved))::int AS avail FROM stock_balances WHERE location_id = $1 AND variant_id = ANY($2)',
    [onlineLocationId, variants.map((v) => v.id)]);
  return {
    product, variants, images, productMap, category,
    variantMaps: new Map(vm.map((r) => [r.variant_id, r])),
    stock: new Map(st.map((r) => [r.variant_id, r.avail])),
  };
}

const isLive = (p: Record<string, any>) => p.publish_to_web && p.status === 'active' && !p.archived_at;
const variantLive = (v: Record<string, any>) => v.status === 'active' && !v.archived_at;

// Woo stores weight and size in the shop's own units.
const WEIGHT: Record<string, number> = { kg: 1000, g: 1, lbs: 453.59237, oz: 28.349523125 };
const LENGTH: Record<string, number> = { m: 1000, cm: 10, mm: 1, in: 25.4, yd: 914.4 };
const num = (n: number) => String(Math.round(n * 1000) / 1000);
function shipping(v: Record<string, any>, weightUnit: string | null, dimUnit: string | null) {
  const out: Record<string, unknown> = {};
  if (v.weight_g != null) out.weight = num(v.weight_g / (WEIGHT[weightUnit ?? 'kg'] ?? 1000));
  if (v.length_mm != null && v.width_mm != null && v.height_mm != null) {
    const d = LENGTH[dimUnit ?? 'cm'] ?? 10;
    out.dimensions = { length: num(v.length_mm / d), width: num(v.width_mm / d), height: num(v.height_mm / d) };
  }
  return out;
}

const price = (p: string) => String(Number(p).toFixed(2));

async function ensureCategory(client: WooClient, tenantId: string, cat: { id: string; name: string }, parentWooId: number | null): Promise<number> {
  const saved = await tenantTx(tenantId, (tx) => tx.query('SELECT woo_category_id FROM woo_category_map WHERE category_id = $1', [cat.id]));
  if (saved.rows[0]) return Number(saved.rows[0].woo_category_id);
  const found = await client.get<{ id: number; name: string; parent: number }[]>('/products/categories', { search: cat.name, per_page: 100, _fields: 'id,name,parent' });
  const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"');
  let id = found.find((c) => decode(c.name).toLowerCase() === cat.name.toLowerCase() && c.parent === (parentWooId ?? 0))?.id;
  if (!id) id = (await client.post('/products/categories', { name: cat.name, ...(parentWooId ? { parent: parentWooId } : {}) })).id as number;
  await tenantTx(tenantId, (tx) => tx.query(
    `INSERT INTO woo_category_map (tenant_id, category_id, woo_category_id) VALUES (current_setting('app.tenant_id')::uuid, $1, $2)
     ON CONFLICT (tenant_id, category_id) DO UPDATE SET woo_category_id = EXCLUDED.woo_category_id`, [cat.id, id]));
  return id;
}

export async function publishProduct(tenantId: string, productId: string) {
  await withJobLock(`woo.product:${productId}`, async () => {
    const setup = await tenantTx(tenantId, async (tx) => {
      const c = await clientFor(tx);
      if (!c) return null;
      return { ...c, snap: await snapshot(tx, productId, c.conn.onlineLocationId) };
    });
    if (!setup || !setup.snap) return;
    const { client, conn, snap } = setup;
    try {
      await push(client, tenantId, conn, snap);
      await noteResult(tenantId, null);
    } catch (e) {
      await noteResult(tenantId, e);
      if (e instanceof WooError && e.kind !== 'retry') {
        const msg = e.kind === 'auth' ? `WooCommerce refused the key: ${e.message}` : e.message;
        await setState(tenantId, productId, 'failed', msg);
        throw new PermanentJobError(msg);
      }
      throw e;
    }
  });
}

async function setState(tenantId: string, productId: string, state: string, error: string | null) {
  await tenantTx(tenantId, (tx) => tx.query('UPDATE products SET publish_state = $2, publish_error = $3 WHERE id = $1', [productId, state, error?.slice(0, 500) ?? null]));
}

async function saveProductMap(tenantId: string, productId: string, wooId: number, type: string) {
  await tenantTx(tenantId, (tx) => tx.query(
    `INSERT INTO woo_product_map (tenant_id, product_id, woo_product_id, woo_type, state, last_pushed_at)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, 'linked', now())
     ON CONFLICT (tenant_id, product_id) DO UPDATE SET woo_product_id = EXCLUDED.woo_product_id, woo_type = EXCLUDED.woo_type, state = 'linked', last_pushed_at = now()`,
    [productId, wooId, type]));
}

async function saveVariantMaps(tenantId: string, rows: { variantId: string; wooProductId: number; wooVariationId: number; stock: number | null }[]) {
  if (!rows.length) return;
  await tenantTx(tenantId, (tx) => tx.query(
    `INSERT INTO woo_variant_map (tenant_id, variant_id, woo_product_id, woo_variation_id, last_pushed_stock, last_pushed_at)
     SELECT current_setting('app.tenant_id')::uuid, u.v, u.p, u.w, u.s, now() FROM unnest($1::uuid[], $2::bigint[], $3::bigint[], $4::int[]) AS u(v, p, w, s)
     ON CONFLICT (tenant_id, variant_id) DO UPDATE SET woo_product_id = EXCLUDED.woo_product_id, woo_variation_id = EXCLUDED.woo_variation_id,
       last_pushed_stock = coalesce(EXCLUDED.last_pushed_stock, woo_variant_map.last_pushed_stock), last_pushed_at = now()`,
    [rows.map((r) => r.variantId), rows.map((r) => r.wooProductId), rows.map((r) => r.wooVariationId), rows.map((r) => r.stock)]));
}

/** Woo product that already carries these SKUs or our id: adopt it instead of creating a second one. */
async function findExisting(client: WooClient, snap: Snap): Promise<{ id: number; type: string; variations: Map<string, number> } | null> {
  const skus = snap.variants.map((v) => v.sku as string);
  const hits = skus.length
    ? await client.get<{ id: number; type: string; sku: string; parent_id: number }[]>('/products', { sku: skus.join(','), per_page: 100, status: 'any', _fields: 'id,type,sku,parent_id' })
    : [];
  const bySku = new Map(hits.map((h) => [h.sku.toLowerCase(), h]));
  if (snap.product.type === 'simple') {
    const h = bySku.get(skus[0].toLowerCase());
    if (!h) return null;
    if (h.type === 'variation') throw new WooError('invalid', `SKU ${skus[0]} is a variation of another WooCommerce product (#${h.parent_id}). Change one of the SKUs.`);
    return { id: h.id, type: h.type, variations: new Map() };
  }
  const parents = new Set(hits.filter((h) => h.type === 'variation').map((h) => h.parent_id));
  const simpleClash = hits.find((h) => h.type !== 'variation');
  if (simpleClash) throw new WooError('invalid', `SKU ${simpleClash.sku} is already a separate WooCommerce product (#${simpleClash.id}). Change one of the SKUs.`);
  if (parents.size > 1) throw new WooError('invalid', 'These SKUs belong to more than one WooCommerce product. Fix the SKUs in WooCommerce first.');
  let parentId = [...parents][0];
  if (!parentId) {
    const named = await client.get<{ id: number; type: string; meta_data: { key: string; value: unknown }[] }[]>('/products',
      { search: snap.product.name, status: 'any', per_page: 50, _fields: 'id,type,meta_data' });
    parentId = named.find((p) => p.meta_data?.some((m) => m.key === META_KEY && m.value === snap.product.id))?.id as number;
    if (!parentId) return null;
  }
  const variations = new Map<string, number>();
  for (const h of hits) if (h.type === 'variation' && h.parent_id === parentId) variations.set(h.sku.toLowerCase(), h.id);
  return { id: parentId, type: 'variable', variations };
}

async function push(client: WooClient, tenantId: string, conn: { weightUnit: string | null; dimensionUnit: string | null }, snap: Snap) {
  const p = snap.product;
  // Deleted in Woo: wait for the owner to choose (Publish clears this), don't quietly create it again on the next edit.
  if (snap.productMap?.state === 'deleted_in_woo') return;
  const mapped = snap.productMap?.state === 'linked' ? Number(snap.productMap.woo_product_id) : null;

  if (!isLive(p)) {
    if (mapped) {
      try { await client.put(`/products/${mapped}`, { status: 'draft' }); } catch (e) { if (!(e instanceof WooError && e.kind === 'not_found')) throw e; }
    }
    await setState(tenantId, p.id, 'not_published', null);
    return;
  }
  const live = snap.variants.filter(variantLive);
  if (!live.length) throw new WooError('invalid', 'The product has no active variants to sell');

  // Category (two levels), only when the ERP has one.
  let categories: { id: number }[] | undefined;
  if (snap.category) {
    const parentId = snap.category.parent ? await ensureCategory(client, tenantId, snap.category.parent, null) : null;
    categories = [{ id: await ensureCategory(client, tenantId, snap.category, parentId) }];
  }

  let wooId = mapped;
  let adopted: Awaited<ReturnType<typeof findExisting>> = null;
  if (!wooId) {
    adopted = await findExisting(client, snap);
    if (adopted) {
      if (adopted.type !== p.type) throw new WooError('invalid', `In WooCommerce this is a ${adopted.type} product, in the ERP it is ${p.type}. Make them the same type first.`);
      wooId = adopted.id;
      await saveProductMap(tenantId, p.id, wooId, p.type);
    }
  }

  const body: Record<string, unknown> = {
    name: p.name, type: p.type, status: 'publish',
    meta_data: [{ key: META_KEY, value: p.id }],
    ...(p.description ? { description: p.description } : {}),
    ...(categories ? { categories } : {}),
  };
  if (p.type === 'simple') {
    const v = live[0];
    Object.assign(body, {
      sku: v.sku, regular_price: price(v.price), sale_price: '', manage_stock: true, stock_quantity: snap.stock.get(v.id) ?? 0,
      ...shipping(v, conn.weightUnit, conn.dimensionUnit),
    });
  } else {
    body.attributes = await variableAttributes(client, wooId, live);
  }

  let saved: any;
  try {
    saved = wooId ? await client.put(`/products/${wooId}`, body) : await client.post('/products', body);
  } catch (e) {
    if (e instanceof WooError && e.kind === 'not_found' && wooId) {
      // Deleted in Woo since we last pushed: forget the old ids and create it again.
      await tenantTx(tenantId, async (tx) => {
        await tx.query('DELETE FROM woo_variant_map WHERE variant_id = ANY($1)', [snap.variants.map((v) => v.id)]);
        await tx.query('DELETE FROM woo_product_map WHERE product_id = $1', [p.id]);
        await tx.query('UPDATE product_images SET woo_media_id = NULL, woo_file_id = NULL WHERE product_id = $1', [p.id]);
      });
      throw new WooError('retry', 'The product was deleted in WooCommerce; it will be created again');
    }
    throw e;
  }
  wooId = saved.id as number;
  await saveProductMap(tenantId, p.id, wooId, p.type);

  if (p.type === 'simple') {
    await saveVariantMaps(tenantId, [{ variantId: live[0].id, wooProductId: wooId, wooVariationId: 0, stock: snap.stock.get(live[0].id) ?? 0 }]);
  } else {
    await pushVariations(client, tenantId, conn, snap, wooId, adopted?.variations ?? new Map());
  }

  const imageProblems = await pushImages(client, tenantId, snap, wooId);
  await setState(tenantId, p.id, 'synced', imageProblems);
}

/** Variation attributes from the ERP; other attributes the shop added in Woo (like "Fabric") are kept. */
async function variableAttributes(client: WooClient, wooId: number | null, live: Record<string, any>[]) {
  const ours = ATTRIBUTE_KEYS.map((k) => ({
    key: k, values: [...new Set(live.map((v) => v.attributes?.[k]).filter(Boolean) as string[])],
  })).filter((a) => a.values.length);
  const names = new Set(ours.map((a) => ATTR_LABEL[a.key].toLowerCase()));
  let keep: unknown[] = [];
  if (wooId) {
    const cur = await client.get<{ attributes: { id: number; name: string; variation: boolean }[] }>(`/products/${wooId}`, { _fields: 'attributes' });
    keep = (cur.attributes ?? []).filter((a) => !a.variation && !names.has(a.name.toLowerCase()));
  }
  return [...keep, ...ours.map((a, i) => ({ name: ATTR_LABEL[a.key], options: a.values, variation: true, visible: true, position: i }))];
}

async function pushVariations(client: WooClient, tenantId: string, conn: { weightUnit: string | null; dimensionUnit: string | null }, snap: Snap, wooId: number, adoptedBySku: Map<string, number>) {
  const create: Record<string, unknown>[] = [], update: Record<string, unknown>[] = [];
  const createdFor: string[] = [];
  const maps: { variantId: string; wooProductId: number; wooVariationId: number; stock: number | null }[] = [];
  for (const v of snap.variants) {
    const m = snap.variantMaps.get(v.id);
    const existing = m && Number(m.woo_product_id) === wooId ? Number(m.woo_variation_id) : adoptedBySku.get(String(v.sku).toLowerCase());
    if (!variantLive(v)) {
      if (existing) update.push({ id: existing, status: 'private' });
      continue;
    }
    const stock = snap.stock.get(v.id) ?? 0;
    const body = {
      sku: v.sku, regular_price: price(v.price), sale_price: '', status: 'publish', manage_stock: true, stock_quantity: stock,
      menu_order: v.position ?? 0,
      attributes: ATTRIBUTE_KEYS.filter((k) => v.attributes?.[k]).map((k) => ({ name: ATTR_LABEL[k], option: v.attributes[k] })),
      ...shipping(v, conn.weightUnit, conn.dimensionUnit),
    };
    if (existing) { update.push({ id: existing, ...body }); maps.push({ variantId: v.id, wooProductId: wooId, wooVariationId: existing, stock }); }
    else { create.push(body); createdFor.push(v.id); }
  }
  const errors: string[] = [];
  for (let i = 0; i < Math.max(create.length, update.length); i += 50) {
    const c = create.slice(i, i + 50), u = update.slice(i, i + 50);
    const res = await client.post(`/products/${wooId}/variations/batch`, { create: c, update: u }, 30_000);
    (res.create ?? []).forEach((r: any, j: number) => {
      const vid = createdFor[i + j];
      if (r.error) errors.push(`${(c[j] as { sku: string }).sku}: ${r.error.message}`);
      else maps.push({ variantId: vid, wooProductId: wooId, wooVariationId: r.id, stock: (c[j] as { stock_quantity: number }).stock_quantity });
    });
    (res.update ?? []).forEach((r: any) => { if (r.error) errors.push(`#${r.id}: ${r.error.message}`); });
  }
  await saveVariantMaps(tenantId, maps);
  if (errors.length) throw new WooError('invalid', `WooCommerce refused some variants: ${errors.join('; ').slice(0, 400)}`);
}

/** Gallery in ERP order (main image first). New files are sent as signed links, a few per call; Woo returns their media ids. */
async function pushImages(client: WooClient, tenantId: string, snap: Snap, wooId: number): Promise<string | null> {
  const gallery = snap.images.filter((i) => !i.variant_id);
  if (!gallery.length) return null;   // the ERP has no photos: leave whatever the shop shows
  const done = new Map<string, number>(gallery.filter((i) => i.woo_media_id && i.woo_file_id === i.file_id).map((i) => [i.id, Number(i.woo_media_id)]));
  const problems: string[] = [];
  const failed = new Set<string>();
  for (;;) {
    const todo = gallery.filter((i) => !done.has(i.id) && !failed.has(i.id)).slice(0, NEW_IMAGES_PER_CALL);
    const list = gallery.filter((i) => done.has(i.id) || todo.includes(i)).map((i) =>
      done.has(i.id) ? { id: done.get(i.id) } : { src: imageUrl(tenantId, i.file_id, i.content_type), alt: i.alt_text || snap.product.name });
    if (!todo.length) {
      // Nothing new; still put them in the ERP's order if anything was synced before.
      if (done.size && !failed.size) await client.put(`/products/${wooId}`, { images: list }, IMAGE_TIMEOUT_MS);
      break;
    }
    try {
      const res = await client.put(`/products/${wooId}`, { images: list }, IMAGE_TIMEOUT_MS);
      const ids = (res.images ?? []).map((x: { id: number }) => x.id);
      const sent = gallery.filter((i) => done.has(i.id) || todo.includes(i));
      sent.forEach((img, k) => { if (ids[k]) done.set(img.id, ids[k]); });
    } catch (e) {
      if (!(e instanceof WooError) || e.kind !== 'invalid') throw e;
      for (const i of todo) failed.add(i.id);
      problems.push(e.message);
    }
  }
  await tenantTx(tenantId, async (tx) => {
    for (const i of gallery) {
      if (done.has(i.id)) await tx.query("UPDATE product_images SET woo_media_id = $2, woo_file_id = file_id, sync_state = 'synced', last_error = NULL WHERE id = $1", [i.id, done.get(i.id)]);
      else if (failed.has(i.id)) await tx.query("UPDATE product_images SET sync_state = 'failed', last_error = $2 WHERE id = $1", [i.id, problems[0]?.slice(0, 500)]);
    }
  });
  return failed.size ? `${failed.size} image(s) could not be sent to WooCommerce: ${problems[0]}`.slice(0, 500) : null;
}
