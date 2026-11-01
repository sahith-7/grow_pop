import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gs1CheckDigit } from '../src/lib/barcode.js';
import { api } from './b2-api.js';
import { getApp, makeTenant, makeUser, owner } from './b2-helpers.js';

const simple = (sku: string, extra: Record<string, unknown> = {}) => ({
  name: `Product ${sku}`, type: 'simple', status: 'active', variants: [{ sku, price: '100', ...extra }],
});
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

let A: Awaited<ReturnType<typeof makeTenant>>;
let B: Awaited<ReturnType<typeof makeTenant>>;
let cashierA: { cookie: string };

beforeAll(async () => {
  A = await makeTenant();
  B = await makeTenant();
  cashierA = await makeUser(A.tenantId, 'cashier');
});
afterAll(async () => { await (await getApp()).close(); await owner.end(); });

describe('products', () => {
  it('AC-03: duplicate SKU is rejected within a tenant (case-insensitive) and allowed in another tenant', async () => {
    expect((await api(A.cookie, 'POST', '/v1/products', simple('DUP-1'))).status).toBe(201);
    const dup = await api(A.cookie, 'POST', '/v1/products', simple('dup-1'));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('SKU_DUPLICATE');
    expect(dup.body.fieldErrors['variants.0.sku']).toBeDefined();
    expect((await api(B.cookie, 'POST', '/v1/products', simple('DUP-1'))).status).toBe(201);
  });

  it('rejects duplicate barcodes and bad check digits', async () => {
    const code = '890123456789' + gs1CheckDigit('890123456789');
    expect((await api(A.cookie, 'POST', '/v1/products', simple('BC-1', { barcode: code }))).status).toBe(201);
    expect((await api(A.cookie, 'POST', '/v1/products', simple('BC-2', { barcode: code }))).body.code).toBe('BARCODE_DUPLICATE');
    const bad = await api(A.cookie, 'POST', '/v1/products', simple('BC-3', { barcode: code.slice(0, 12) + ((Number(code[12]) + 1) % 10) }));
    expect(bad.status).toBe(400);
  });

  it('enforces price <= MRP and unknown fields are rejected', async () => {
    expect((await api(A.cookie, 'POST', '/v1/products', simple('MRP-1', { price: '700', mrp: '600' }))).status).toBe(400);
    expect((await api(A.cookie, 'POST', '/v1/products', { ...simple('X-1'), colour: 'red' })).status).toBe(400);
  });

  it('creates a variable product and checks attribute rules', async () => {
    const res = await api(A.cookie, 'POST', '/v1/products', {
      name: 'Tee', type: 'variable', variants: [
        { sku: 'TEE-S', price: '299', attributes: { size: 'S' } },
        { sku: 'TEE-M', price: '299', attributes: { size: 'M' } },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.variants).toHaveLength(2);
    const pid = res.body.id;
    expect((await api(A.cookie, 'POST', `/v1/products/${pid}/variants`, { sku: 'TEE-L', price: '299', attributes: { colour: 'Red' } })).status).toBe(400);
    expect((await api(A.cookie, 'POST', `/v1/products/${pid}/variants`, { sku: 'TEE-L', price: '299', attributes: { size: 'M' } })).body.code).toBe('VARIANT_DUPLICATE');
    expect((await api(A.cookie, 'POST', `/v1/products/${pid}/variants`, { sku: 'TEE-L', price: '299', attributes: { size: 'L' } })).status).toBe(201);
    const mixed = await api(A.cookie, 'POST', '/v1/products', {
      name: 'Bad', type: 'variable', variants: [{ sku: 'B1', price: '1', attributes: { size: 'S' } }, { sku: 'B2', price: '1', attributes: { colour: 'R' } }],
    });
    expect(mixed.status).toBe(400);
  });

  it('CAT-12: cost is hidden from roles without cost.view', async () => {
    const res = await api(A.cookie, 'POST', '/v1/products', simple('COST-1', { cost: '55.5' }));
    expect(res.body.variants[0].cost).toBe('55.50');
    const asCashier = await api(cashierA.cookie, 'GET', `/v1/products/${res.body.id}`);
    expect(asCashier.status).toBe(200);
    expect(asCashier.body.variants[0]).not.toHaveProperty('cost');
    expect((await api(cashierA.cookie, 'POST', '/v1/products', simple('COST-2'))).status).toBe(403);
  });

  it('another tenant gets 404, not 403, for an existing id', async () => {
    const res = await api(A.cookie, 'POST', '/v1/products', simple('ISO-1'));
    expect((await api(B.cookie, 'GET', `/v1/products/${res.body.id}`)).status).toBe(404);
    expect((await api(B.cookie, 'PATCH', `/v1/products/${res.body.id}`, { name: 'x' }, { 'if-match': '"1"' })).status).toBe(404);
  });

  it('PATCH needs If-Match, rejects stale versions and audits changes', async () => {
    const res = await api(A.cookie, 'POST', '/v1/products', simple('VER-1'));
    const id = res.body.id;
    expect(res.headers.etag).toBe('"1"');
    expect((await api(A.cookie, 'PATCH', `/v1/products/${id}`, { name: 'New' })).status).toBe(428);
    const ok = await api(A.cookie, 'PATCH', `/v1/products/${id}`, { name: 'New name', gstRate: '18' }, { 'if-match': '"1"' });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
    expect(ok.body.gstRate).toBe('18');
    expect((await api(A.cookie, 'PATCH', `/v1/products/${id}`, { name: 'Again' }, { 'if-match': '"1"' })).body.code).toBe('VERSION_CONFLICT');
    const audit = await owner.query("SELECT summary FROM audit_events WHERE entity_id = $1 AND action = 'product.update'", [id]);
    expect(audit.rows[0].summary.name).toEqual(['Product VER-1', 'New name']);
  });

  it('audits price changes on variants', async () => {
    const res = await api(A.cookie, 'POST', '/v1/products', simple('PRICE-1'));
    const v = res.body.variants[0];
    const up = await api(A.cookie, 'PATCH', `/v1/variants/${v.id}`, { price: '120' }, { 'if-match': `"${v.version}"` });
    expect(up.status).toBe(200);
    expect(up.body.price).toBe('120.00');
    const audit = await owner.query("SELECT summary FROM audit_events WHERE entity_id = $1 AND action = 'variant.update'", [res.body.id]);
    expect(audit.rows[0].summary.price).toEqual(['100.0000', '120']);
  });

  it('Idempotency-Key replays the first response and rejects a different body', async () => {
    const key = crypto.randomUUID();
    const a = await api(A.cookie, 'POST', '/v1/products', simple('IDEM-1'), { 'idempotency-key': key });
    const b = await api(A.cookie, 'POST', '/v1/products', simple('IDEM-1'), { 'idempotency-key': key });
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect((await api(A.cookie, 'POST', '/v1/products', simple('IDEM-2'), { 'idempotency-key': key })).status).toBe(422);
  });

  it('lists and searches by name, SKU and barcode with cursor pagination', async () => {
    const T = await makeTenant();
    for (const n of ['apple', 'banana', 'cherry']) await api(T.cookie, 'POST', '/v1/products', { ...simple(`S-${n}`), name: n });
    const p1 = await api(T.cookie, 'GET', '/v1/products?limit=2');
    expect(p1.body.items.map((i: any) => i.name)).toEqual(['apple', 'banana']);
    const p2 = await api(T.cookie, 'GET', `/v1/products?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((i: any) => i.name)).toEqual(['cherry']);
    expect(p2.body.nextCursor).toBeNull();
    expect((await api(T.cookie, 'GET', '/v1/products?q=ANA')).body.items).toHaveLength(1);
    expect((await api(T.cookie, 'GET', '/v1/products?q=s-cherry')).body.items[0].name).toBe('cherry');
    expect((await api(T.cookie, 'GET', '/v1/products?q=%25')).body.items).toHaveLength(0); // % is literal, not a wildcard
  });

  it('archive hides from list and lookup; restore brings it back as draft', async () => {
    const res = await api(A.cookie, 'POST', '/v1/products', simple('ARCH-1'));
    expect((await api(A.cookie, 'POST', `/v1/products/${res.body.id}/archive`)).body.status).toBe('archived');
    expect((await api(A.cookie, 'GET', '/v1/lookup?code=ARCH-1')).status).toBe(404);
    expect((await api(A.cookie, 'PATCH', `/v1/products/${res.body.id}`, { name: 'x' }, { 'if-match': '"2"' })).body.code).toBe('INVALID_STATE');
    expect((await api(A.cookie, 'POST', `/v1/products/${res.body.id}/restore`)).body.status).toBe('draft');
  });
});

describe('barcodes and lookup (AC-04)', () => {
  it('generates unique valid in-store EAN-13 codes and skips codes already in use', async () => {
    const T = await makeTenant();
    const taken = '200000000002' + gs1CheckDigit('200000000002');
    await api(T.cookie, 'POST', '/v1/products', simple('USED', { barcode: taken }));
    const { body } = await api(T.cookie, 'POST', '/v1/barcodes/generate', { count: 3 });
    expect(body.codes).toHaveLength(3);
    expect(body.codes).not.toContain(taken);
    for (const c of body.codes) {
      expect(c).toMatch(/^200\d{10}$/);
      expect(gs1CheckDigit(c.slice(0, 12))).toBe(Number(c[12]));
    }
    const again = await api(T.cookie, 'POST', '/v1/barcodes/generate', { count: 1 });
    expect(body.codes).not.toContain(again.body.codes[0]);
  });

  it('scan finds the right variant by barcode, then by SKU', async () => {
    const T = await makeTenant();
    const gen = await api(T.cookie, 'POST', '/v1/barcodes/generate', { count: 1 });
    const res = await api(T.cookie, 'POST', '/v1/products', {
      name: 'Jeans', type: 'variable', status: 'active', variants: [
        { sku: 'J-30', price: '999', attributes: { size: '30' }, barcode: gen.body.codes[0] },
        { sku: 'J-32', price: '999', attributes: { size: '32' } },
      ],
    });
    const byCode = await api(T.cookie, 'GET', `/v1/lookup?code=${gen.body.codes[0]}`);
    expect(byCode.body.matchedOn).toBe('barcode');
    expect(byCode.body.variant.sku).toBe('J-30');
    const bySku = await api(T.cookie, 'GET', '/v1/lookup?code=j-32');
    expect(bySku.body.matchedOn).toBe('sku');
    expect(bySku.body.productId).toBe(res.body.id);
    expect((await api(B.cookie, 'GET', `/v1/lookup?code=${gen.body.codes[0]}`)).status).toBe(404);
  });

  it('builds label rows with barcode or SKU fallback', async () => {
    const res = await api(A.cookie, 'POST', '/v1/products', simple('LBL-1', { mrp: '120' }));
    const { body } = await api(A.cookie, 'POST', '/v1/labels', { items: [{ variantId: res.body.variants[0].id, copies: 3 }] });
    expect(body.labels[0]).toMatchObject({ code: 'LBL-1', codeSource: 'sku', copies: 3, price: '100.00', mrp: '120.00' });
  });
});

describe('categories, brands, images', () => {
  it('categories are two levels deep with unique names per parent', async () => {
    const T = await makeTenant();
    const top = await api(T.cookie, 'POST', '/v1/categories', { name: 'Apparel' });
    const child = await api(T.cookie, 'POST', '/v1/categories', { name: 'Shirts', parentId: top.body.id });
    expect(child.status).toBe(201);
    expect((await api(T.cookie, 'POST', '/v1/categories', { name: 'Deep', parentId: child.body.id })).status).toBe(400);
    expect((await api(T.cookie, 'POST', '/v1/categories', { name: 'apparel' })).body.code).toBe('NAME_DUPLICATE');
    expect((await api(T.cookie, 'POST', '/v1/brands', { name: 'Acme' })).status).toBe(201);
  });

  it('uploads an image, refuses mismatched content, and keeps exactly one primary', async () => {
    const res = await api(A.cookie, 'POST', '/v1/products', simple('IMG-1'));
    const pid = res.body.id;
    const fake = await api(A.cookie, 'POST', '/v1/files?kind=product_image', Buffer.from('<svg></svg>'), { 'content-type': 'image/png' });
    expect(fake.status).toBe(415);
    const svg = await api(A.cookie, 'POST', '/v1/files?kind=product_image', Buffer.from('<svg></svg>'), { 'content-type': 'image/svg+xml' });
    expect(svg.status).toBe(415);
    const f1 = await api(A.cookie, 'POST', '/v1/files?kind=product_image', PNG, { 'content-type': 'image/png' });
    const f2 = await api(A.cookie, 'POST', '/v1/files?kind=product_image', PNG, { 'content-type': 'image/png' });
    expect(f1.status).toBe(201);
    const i1 = await api(A.cookie, 'POST', `/v1/products/${pid}/images`, { fileId: f1.body.fileId });
    const i2 = await api(A.cookie, 'POST', `/v1/products/${pid}/images`, { fileId: f2.body.fileId });
    expect(i1.body.isPrimary).toBe(true);
    expect(i2.body.isPrimary).toBe(false);
    const order = await api(A.cookie, 'PUT', `/v1/products/${pid}/images/order`, { imageIds: [i2.body.id, i1.body.id], primaryImageId: i2.body.id });
    expect(order.body.items.map((i: any) => [i.id, i.isPrimary])).toEqual([[i2.body.id, true], [i1.body.id, false]]);
    expect((await api(A.cookie, 'DELETE', `/v1/products/${pid}/images/${i2.body.id}`)).status).toBe(204);
    const after = await api(A.cookie, 'GET', `/v1/products/${pid}`);
    expect(after.body.images).toHaveLength(1);
    expect(after.body.images[0].isPrimary).toBe(true);
    const img = await api(A.cookie, 'GET', after.body.images[0].url.replace('/api', ''));
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect((await api(B.cookie, 'GET', after.body.images[0].url.replace('/api', ''))).status).toBe(404);
    // Another tenant's file cannot be attached
    const pB = await api(B.cookie, 'POST', '/v1/products', simple('IMG-B'));
    expect((await api(B.cookie, 'POST', `/v1/products/${pB.body.id}/images`, { fileId: f1.body.fileId })).status).toBe(400);
  });
});
