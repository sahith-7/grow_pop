import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { registeredRoutes } from '../src/lib/saas.js';
import { api } from './b2-api.js';
import { getApp, makeTenant, owner } from './b2-helpers.js';
import { locations } from './b3-helpers.js';
import { sell, setupBilling, stockedItem } from './b5-helpers.js';
import { pickAndPack, readyOrder, skuOf } from './b6-helpers.js';

// AC-01: every API route, called by store B's owner with store A's ids, finds nothing and changes nothing.
// The route list comes from the running app, so a new route with an id in its path fails this test until it is mapped
// below to the table its id belongs to. Platform routes (no store) and webhooks (token, tested in B4) are separate.

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

/** Path segment before `:id` → the table that id comes from. */
const TABLE_BY_SEGMENT: Record<string, string> = {
  files: 'files', categories: 'categories', brands: 'brands', products: 'products', variants: 'product_variants',
  imports: 'import_jobs', locations: 'locations', movements: 'stock_ledger', stocktakes: 'stocktakes', suppliers: 'suppliers',
  'purchase-orders': 'purchase_orders', 'goods-receipts': 'goods_receipts', orders: 'sales_orders', jobs: 'sync_jobs',
  customers: 'customers', invoices: 'invoices', 'pick-lists': 'pick_lists', exports: 'data_exports',
  users: 'users',   // Phase 1's PATCH /v1/users/:id
};
const TABLE_BY_PARAM: Record<string, string> = { imageId: 'product_images', lineId: 'pick_list_lines' };
const LITERAL_PARAM: Record<string, string> = { action: 'submit', report: 'inventory-summary' };
/** Refused before the id is looked up, for a reason that is store B's own (it has no shop connected). */
const PRECHECK = new Set(['NOT_CONNECTED POST /v1/products/:id/publish']);
const SKIP = (url: string) => url.startsWith('/health') || url.startsWith('/v1/platform') || url.startsWith('/v1/webhooks') || url.startsWith('/v1/auth');

let A: { tenantId: string; cookie: string };
let B: { tenantId: string; cookie: string };
const ids: Record<string, string> = {};
const markers: string[] = [];

async function tenantTables() {
  const { rows } = await owner.query(
    `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`);
  return rows.map((r) => r.table_name as string);
}

/** One fingerprint per table of everything store A has, to prove nothing changed. */
async function fingerprint(tenantId: string) {
  const out: Record<string, string> = {};
  for (const t of await tenantTables()) {
    const { rows: [r] } = await owner.query(`SELECT count(*) || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS f FROM "${t}" x WHERE tenant_id = $1`, [tenantId]);
    out[t] = r.f;
  }
  return out;
}

beforeAll(async () => {
  A = await makeTenant();
  B = await makeTenant();
  const tag = `ISO${randomUUID().slice(0, 6)}`;
  markers.push(tag);
  await setupBilling(A);
  const v = await stockedItem(A.cookie, { price: '100', stock: '20' });
  const sku = await skuOf(v);
  const productId = (await owner.query('SELECT product_id FROM product_variants WHERE id = $1', [v])).rows[0].product_id;
  await owner.query('UPDATE products SET name = $2 WHERE id = $1', [productId, `${tag} product`]);
  expect((await api(A.cookie, 'POST', '/v1/categories', { name: `${tag} category` })).status).toBe(201);
  expect((await api(A.cookie, 'POST', '/v1/brands', { name: `${tag} brand` })).status).toBe(201);
  const f = await api(A.cookie, 'POST', '/v1/files?kind=product_image', PNG, { 'content-type': 'image/png' });
  expect((await api(A.cookie, 'POST', `/v1/products/${productId}/images`, { fileId: f.body.fileId })).status).toBe(201);
  const csv = await api(A.cookie, 'POST', '/v1/files?kind=import&name=p.csv', Buffer.from('product_name,sku,price\nPen,PEN-ISO,10\n'), { 'content-type': 'text/csv' });
  expect((await api(A.cookie, 'POST', '/v1/imports', { fileId: csv.body.fileId })).status).toBeLessThan(300);
  const loc = await locations(A.cookie);
  const s = await api(A.cookie, 'POST', '/v1/suppliers', { name: `${tag} supplier` });
  expect(s.status, s.text).toBe(201);
  expect((await api(A.cookie, 'POST', '/v1/purchase-orders', { supplierId: s.body.id, lines: [{ variantId: v, orderedQty: '2', unitCost: '10' }] })).status).toBe(201);
  const g = await api(A.cookie, 'POST', '/v1/goods-receipts', { supplierId: s.body.id, lines: [{ variantId: v, locationId: loc.shop, receivedQty: '5', acceptedQty: '5', unitCost: '10' }] });
  expect(g.status, g.text).toBe(201);
  expect((await api(A.cookie, 'POST', '/v1/stocktakes', { locationId: loc.back })).status).toBe(201);
  expect((await sell(A.cookie, [{ variantId: v, qty: '1' }])).status).toBe(201);
  const o = await readyOrder(A, [[sku, 1, '100.00']]);
  await pickAndPack(A.cookie, o.id);
  const c = await api(A.cookie, 'POST', '/v1/customers', { name: `${tag} customer`, phone: `98${String(Date.now()).slice(-8)}` });
  expect(c.status, c.text).toBe(201);
  expect((await api(A.cookie, 'POST', '/v1/account/exports')).status).toBe(202);
  await owner.query("INSERT INTO sync_jobs (tenant_id, kind, resource_id, status, last_error) VALUES ($1, 'woo.product', $2, 'dead', 'x')", [A.tenantId, productId]);

  for (const table of new Set([...Object.values(TABLE_BY_SEGMENT), ...Object.values(TABLE_BY_PARAM)])) {
    const { rows: [r] } = await owner.query(`SELECT id::text FROM "${table}" WHERE tenant_id = $1 LIMIT 1`, [A.tenantId]);
    expect(r, `seed store A with a row in ${table}`).toBeTruthy();
    ids[table] = r.id;
  }
});

describe('AC-01 tenant isolation sweep', () => {
  it('every route with an id: store B gets 400/404 for store A ids, and store A is untouched', async () => {
    await getApp();
    const before = await fingerprint(A.tenantId);
    const routes = registeredRoutes.filter((r) => r.method !== 'HEAD' && !SKIP(r.url) && r.url.includes(':'));
    expect(routes.length).toBeGreaterThan(40);
    const problems: string[] = [];
    for (const r of routes) {
      const segs = r.url.split('/');
      const url = segs.map((s, i) => {
        if (!s.startsWith(':')) return s;
        const p = s.slice(1).replace(/\.csv$/, '');
        if (LITERAL_PARAM[p]) return LITERAL_PARAM[p];
        const table = TABLE_BY_PARAM[p] ?? TABLE_BY_SEGMENT[segs[i - 1]];
        if (!table) { problems.push(`unmapped: ${r.method} ${r.url} (${p})`); return 'x'; }
        return ids[table];
      }).join('/');
      const res = await api(B.cookie, r.method as any, url, r.method === 'GET' || r.method === 'DELETE' ? undefined : {}, { 'idempotency-key': randomUUID(), 'if-match': '"1"' });
      const literalOnly = !segs.some((s) => s.startsWith(':') && !LITERAL_PARAM[s.slice(1)]);
      if (literalOnly) {
        if (res.status >= 500) problems.push(`${res.status}: ${r.method} ${r.url}`);
      } else if (![400, 404].includes(res.status) && !PRECHECK.has(`${res.body?.code} ${r.method} ${r.url}`)) problems.push(`${res.status}: ${r.method} ${r.url} ${res.text.slice(0, 120)}`);
      for (const m of [...markers, ...Object.values(ids)]) if (res.text.includes(m)) problems.push(`leak of ${m}: ${r.method} ${r.url}`);
    }
    expect(problems).toEqual([]);
    expect(await fingerprint(A.tenantId)).toEqual(before);
  });

  it('every list and report route: store B never sees store A', async () => {
    const routes = registeredRoutes.filter((r) => r.method === 'GET' && !SKIP(r.url) && !r.url.includes(':'));
    const leaks: string[] = [];
    for (const r of routes) {
      const res = await api(B.cookie, 'GET', r.url);
      if (res.status >= 500) leaks.push(`${res.status}: ${r.url}`);
      for (const m of [...markers, ...Object.values(ids), A.tenantId]) if (res.text.includes(m)) leaks.push(`${m} in ${r.url}`);
    }
    for (const rep of ['inventory-summary', 'low-stock', 'stock-movements', 'purchasing', 'sales', 'sync-health']) {
      const res = await api(B.cookie, 'GET', `/v1/reports/${rep}?format=csv`);
      for (const m of [...markers, A.tenantId]) if (res.text.includes(m)) leaks.push(`${m} in ${rep} CSV`);
    }
    expect(leaks).toEqual([]);
  });
});
