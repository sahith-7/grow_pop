import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { gs1CheckDigit } from '../src/lib/barcode.js';
import { api } from './b2-api.js';
import { makeTenant, makeUser, owner } from './b2-helpers.js';
import { key, locations, onHand } from './b3-helpers.js';
import { sell, setupBilling, stockedItem } from './b5-helpers.js';

// GroPop v2 batch 1: the New product form's rules (D88), deleting categories and brands (D89), the dashboard Overview
// (D90) and the top-bar search (D91).

type Tenant = Awaited<ReturnType<typeof makeTenant>>;
const category = async (t: Tenant, name = `Cat ${randomUUID().slice(0, 6)}`, parentId?: string) => {
  const r = await api(t.cookie, 'POST', '/v1/categories', { name, ...(parentId ? { parentId } : {}) });
  expect(r.status, r.text).toBe(201);
  return r.body.id as string;
};
const product = (t: Tenant, body: Record<string, unknown>, headers: Record<string, string> = key()) =>
  api(t.cookie, 'POST', '/v1/products', { name: `P ${randomUUID().slice(0, 6)}`, type: 'simple', status: 'active', ...body }, headers);
const sku = () => `V2-${randomUUID().slice(0, 8)}`;

describe('v2 new product rules (D88)', () => {
  let T: Tenant;
  let cat: string;
  beforeAll(async () => { T = await makeTenant(); cat = await category(T); });

  it('needs a category', async () => {
    const r = await product(T, { categoryId: null, variants: [{ sku: sku(), price: '10' }] });
    expect(r.status).toBe(400);
    expect(r.body.fieldErrors.categoryId).toBeTruthy();
  });

  it('gives every new variant a barcode that continues the store’s own series, skipping manufacturer codes', async () => {
    const first = await product(T, { categoryId: cat, variants: [{ sku: sku(), price: '10', barcode: 'AC1203' }] });
    expect(first.status, first.text).toBe(201);
    // A scanned manufacturer EAN-13 (not in the 2xx in-store range) is not the store's series.
    const body = '890123456789';
    const ean = body + gs1CheckDigit(body);
    expect((await product(T, { categoryId: cat, variants: [{ sku: sku(), price: '10', barcode: ean }] })).status).toBe(201);
    const auto = await product(T, { categoryId: cat, variants: [{ sku: sku(), price: '10' }] });
    expect(auto.body.variants[0].barcode).toBe('AC1204');
    const next = await api(T.cookie, 'POST', '/v1/barcodes/next', { count: 2 });
    expect(next.body.codes).toEqual(['AC1205', 'AC1206']);
    // Suggestions are not reserved; a taken code is skipped.
    await product(T, { categoryId: cat, variants: [{ sku: sku(), price: '10', barcode: 'AC1206' }] });
    expect((await api(T.cookie, 'POST', '/v1/barcodes/next', { count: 1 })).body.codes).toEqual(['AC1207']);
    // Leading zeros are kept.
    await product(T, { categoryId: cat, variants: [{ sku: sku(), price: '10', barcode: 'GP-0099' }] });
    expect((await api(T.cookie, 'POST', '/v1/barcodes/next', { count: 1 })).body.codes).toEqual(['GP-0100']);
  });

  it('a store with no codes of its own starts the in-store EAN-13 series', async () => {
    const U = await makeTenant();
    const c = await category(U);
    const r = await product(U, { categoryId: c, variants: [{ sku: sku(), price: '10' }] });
    expect(r.body.variants[0].barcode).toMatch(/^2\d{12}$/);
  });

  it('posts opening stock with the product, in one go, and shows it in the product ledger', async () => {
    const { shop } = await locations(T.cookie);
    const r = await product(T, {
      categoryId: cat, type: 'variable', openingLocationId: shop, variants: [
        { sku: sku(), price: '500', cost: '300', attributes: { size: 'M' }, openingQty: '7', reorderLevel: '2', netWeight: '250', netWeightUnit: 'g' },
        { sku: sku(), price: '500', attributes: { size: 'L' }, openingQty: '0' },
      ] });
    expect(r.status, r.text).toBe(201);
    const [m, l] = r.body.variants;
    expect(m).toMatchObject({ netWeight: '250', netWeightUnit: 'g', reorderLevel: '2', cost: '300.00' });
    expect((await onHand(T.cookie, m.id, shop)).onHand).toBe('7');
    expect((await onHand(T.cookie, l.id, shop)).onHand).toBe('0');
    const ledger = await api(T.cookie, 'GET', `/v1/stock/movements?productId=${r.body.id}`);
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]).toMatchObject({ movementType: 'opening', qtyDelta: '7' });
  });

  it('opening stock needs a location and the right to adjust stock; nothing is saved when it fails', async () => {
    const s = sku();
    const r = await product(T, { categoryId: cat, variants: [{ sku: s, price: '10', openingQty: '3' }] });
    expect(r.status).toBe(400);
    expect(r.body.fieldErrors.openingLocationId).toBeTruthy();
    const { shop } = await locations(T.cookie);
    const fractional = await product(T, { categoryId: cat, openingLocationId: shop, variants: [{ sku: s, price: '10', openingQty: '1.5' }] });
    expect(fractional.status).toBe(400);
    expect(fractional.body.fieldErrors['variants.0.openingQty']).toBeTruthy();
    expect((await api(T.cookie, 'GET', `/v1/lookup?code=${s}`)).status).toBe(404);   // rolled back with the stock
  });

  it('net weight and its unit go together', async () => {
    const r = await product(T, { categoryId: cat, variants: [{ sku: sku(), price: '10', netWeight: '1' }] });
    expect(r.status).toBe(400);
    expect(r.body.fieldErrors['variants.0.netWeightUnit']).toBeTruthy();
  });

  it('filters products by stock status', async () => {
    const U = await makeTenant();
    const c = await category(U);
    const { shop } = await locations(U.cookie);
    await product(U, { name: 'Has stock', categoryId: c, openingLocationId: shop, variants: [{ sku: sku(), price: '10', openingQty: '5', reorderLevel: '10' }] });
    await product(U, { name: 'Empty', categoryId: c, variants: [{ sku: sku(), price: '10', openingQty: '0' }] });
    const names = async (stock: string) => (await api(U.cookie, 'GET', `/v1/products?stock=${stock}`)).body.items.map((p: { name: string }) => p.name);
    expect(await names('in_stock')).toEqual(['Has stock']);
    expect(await names('out_of_stock')).toEqual(['Empty']);
    expect(await names('low')).toEqual(['Has stock']);
    const all = (await api(U.cookie, 'GET', '/v1/products')).body.items;
    expect(all.find((p: { name: string }) => p.name === 'Has stock').stock).toEqual({ free: '5', low: true });
  });
});

describe('v2 deleting categories and brands (D89)', () => {
  it('deletes only what nothing uses, and logs it', async () => {
    const T = await makeTenant();
    const free = await category(T, 'Unused');
    const parent = await category(T, 'Parent');
    await category(T, 'Child', parent);
    const used = await category(T, 'Used');
    const brand = (await api(T.cookie, 'POST', '/v1/brands', { name: 'Acme' })).body.id;
    const r = await product(T, { categoryId: used, brandId: brand, variants: [{ sku: sku(), price: '10' }] });
    await api(T.cookie, 'POST', `/v1/products/${r.body.id}/archive`);   // archived products still count

    expect((await api(T.cookie, 'DELETE', `/v1/categories/${free}`)).status).toBe(204);
    const inUse = await api(T.cookie, 'DELETE', `/v1/categories/${used}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.code).toBe('IN_USE');
    expect((await api(T.cookie, 'DELETE', `/v1/categories/${parent}`)).body.code).toBe('IN_USE');
    expect((await api(T.cookie, 'DELETE', `/v1/brands/${brand}`)).body.code).toBe('IN_USE');
    const unusedBrand = (await api(T.cookie, 'POST', '/v1/brands', { name: 'Gone' })).body.id;
    expect((await api(T.cookie, 'DELETE', `/v1/brands/${unusedBrand}`)).status).toBe(204);

    const names = (await api(T.cookie, 'GET', '/v1/categories?includeArchived=true')).body.items.map((c: { name: string }) => c.name);
    expect(names).not.toContain('Unused');
    const { rows } = await owner.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND action IN ('category.delete', 'brand.delete')", [T.tenantId]);
    expect(rows.map((x) => x.action).sort()).toEqual(['brand.delete', 'category.delete']);
  });

  it('cashiers cannot delete, and another store cannot touch them', async () => {
    const T = await makeTenant();
    const U = await makeTenant();
    const c = await category(T);
    const cashier = await makeUser(T.tenantId, 'cashier');
    expect((await api(cashier.cookie, 'DELETE', `/v1/categories/${c}`)).status).toBe(403);
    expect((await api(U.cookie, 'DELETE', `/v1/categories/${c}`)).status).toBe(404);
  });
});

describe('v2 dashboard overview (D90) and search (D91)', () => {
  let T: Tenant;
  beforeAll(async () => {
    T = await makeTenant();
    await setupBilling(T);
    const v = await stockedItem(T.cookie, { price: '1180', gstRate: '18', stock: '5' });
    await owner.query('UPDATE product_variants SET cost = 500 WHERE id = $1', [v]);
    expect((await sell(T.cookie, [{ variantId: v, qty: '2' }])).status).toBe(201);
  });

  it('counts this month’s sales for the owner, with stock and margin', async () => {
    const r = await api(T.cookie, 'GET', '/v1/dashboard/overview');
    expect(r.status, r.text).toBe(200);
    const tile = (k: string) => r.body.tiles.find((x: { key: string }) => x.key === k)?.value;
    expect(tile('sales')).toBe('2360.00');
    expect(tile('invoices')).toBe('1');
    expect(tile('soldQty')).toBe('2');
    expect(tile('margin')).toBe('1000.00');   // taxable 2000 − cost 2 × 500
    expect(tile('stockQty')).toBe('3');
    expect(r.body.paymentModes).toEqual([{ method: 'cash', amount: '2360.00' }]);
    expect(r.body.trend.at(-1)).toMatchObject({ day: r.body.today, sales: '2360.00' });
    expect(r.body.from.slice(8)).toBe('01');
  });

  it('filters by channel and location, and leaves out what a role may not see', async () => {
    const web = await api(T.cookie, 'GET', '/v1/dashboard/overview?channel=woocommerce');
    expect(web.body.tiles.find((x: { key: string }) => x.key === 'sales').value).toBe('0.00');
    const { back } = await locations(T.cookie);
    const elsewhere = await api(T.cookie, 'GET', `/v1/dashboard/overview?locationId=${back}`);
    expect(elsewhere.body.tiles.find((x: { key: string }) => x.key === 'sales').value).toBe('0.00');
    const cashier = await makeUser(T.tenantId, 'cashier');
    const c = await api(cashier.cookie, 'GET', '/v1/dashboard/overview');
    const keys = c.body.tiles.map((x: { key: string }) => x.key);
    expect(keys).toContain('sales');
    expect(keys).not.toContain('margin');
    expect(keys).not.toContain('stockValue');
    expect(keys).not.toContain('bills');
    expect((await api(T.cookie, 'GET', '/v1/dashboard/overview?from=2026-02-01&to=2026-01-01')).status).toBe(400);
  });

  it('another store sees none of it', async () => {
    const U = await makeTenant();
    const r = await api(U.cookie, 'GET', '/v1/dashboard/overview');
    expect(r.body.tiles.find((x: { key: string }) => x.key === 'sales').value).toBe('0.00');
  });

  it('search finds products and invoices in this store only', async () => {
    const c = await category(T);
    await product(T, { name: 'Zebra stripe kurta', categoryId: c, variants: [{ sku: sku(), price: '10' }] });
    const r = await api(T.cookie, 'GET', '/v1/search?q=zebra');
    expect(r.body.items).toEqual([expect.objectContaining({ kind: 'Product', title: 'Zebra stripe kurta' })]);
    const inv = await api(T.cookie, 'GET', '/v1/search?q=INV');
    expect(inv.body.items.some((x: { kind: string }) => x.kind === 'Invoice')).toBe(true);
    const U = await makeTenant();
    expect((await api(U.cookie, 'GET', '/v1/search?q=zebra')).body.items).toEqual([]);
  });
});
