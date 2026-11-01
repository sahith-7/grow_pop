import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// B4 needs these before any module reads them. The fake shop runs on http://127.0.0.1, which only the dev flag allows.
vi.hoisted(() => {
  process.env.WOO_DEV_ALLOW_PRIVATE = 'true';
  process.env.WOO_WEBHOOK_BASE_URL = 'http://erp.test/api';
});

import { pool, tenantTx } from '../src/db.js';
import { hookName, shopLockKey } from '../src/modules/woocommerce/connection.js';
import { processWebhook } from '../src/modules/woocommerce/inbound.js';
import { sweepOnce } from '../src/modules/woocommerce/jobs.js';
import { runMatch } from '../src/modules/woocommerce/match.js';
import { publishProduct } from '../src/modules/woocommerce/publish.js';
import { reconcile } from '../src/modules/woocommerce/reconcile.js';
import { pushStock } from '../src/modules/woocommerce/stock.js';
import { api } from './b2-api.js';
import { makeTenant, makeUser, owner } from './b2-helpers.js';
import { adjust, key, locations, makeItem } from './b3-helpers.js';
import { FakeWoo, RO, RW } from './b4-fake-woo.js';

const woo = await new FakeWoo().start();
afterAll(() => woo.stop());

/** Run every queued woo job for this tenant once, the way the worker would (sweep, then claim). */
async function drain(tenantId: string) {
  await sweepOnce();
  for (let i = 0; i < 20; i++) {
    const { rows } = await owner.query(
      "UPDATE sync_jobs SET status = 'running', attempts = attempts + 1 WHERE id = (SELECT id FROM sync_jobs WHERE tenant_id = $1 AND status = 'pending' AND kind LIKE 'woo.%' ORDER BY priority, created_at LIMIT 1) RETURNING id, kind, resource_id",
      [tenantId]);
    const j = rows[0];
    if (!j) { await sweepOnce(); if (!(await owner.query("SELECT 1 FROM sync_jobs WHERE tenant_id = $1 AND status = 'pending' AND kind LIKE 'woo.%'", [tenantId])).rowCount) return; continue; }
    try {
      if (j.kind === 'woo.inbound') await processWebhook(tenantId, j.resource_id);
      if (j.kind === 'woo.product') await publishProduct(tenantId, j.resource_id);
      if (j.kind === 'woo.stock') await pushStock(tenantId);
      if (j.kind === 'woo.reconcile') await reconcile(tenantId);
      if (j.kind === 'woo.match') await runMatch(tenantId);
      await owner.query("UPDATE sync_jobs SET status = 'done', done_at = now() WHERE id = $1", [j.id]);
    } catch (e) {
      await owner.query("UPDATE sync_jobs SET status = 'failed', last_error = $2 WHERE id = $1", [j.id, String((e as Error).message)]);
    }
  }
}

const connectBody = { siteUrl: woo.url, consumerKey: RW.key, consumerSecret: RW.secret };
const available = async (cookie: string, variantId: string, locationId: string) => {
  const r = await api(cookie, 'GET', `/v1/stock/balances?locationId=${locationId}&limit=100`);
  return r.body.items.find((b: any) => b.variantId === variantId)?.available ?? '0';
};

describe('B4 connection', () => {
  let t: Awaited<ReturnType<typeof makeTenant>>;
  beforeAll(async () => { t = await makeTenant(); });

  it('tests a key without saving it, and names the problem', async () => {
    const ok = await api(t.cookie, 'POST', '/v1/integrations/woocommerce/test', connectBody);
    expect(ok.body).toMatchObject({ ok: true, wooVersion: '11.1.2', currency: 'INR' });
    const ro = await api(t.cookie, 'POST', '/v1/integrations/woocommerce/test', { ...connectBody, consumerKey: RO.key, consumerSecret: RO.secret });
    expect(ro.body).toMatchObject({ ok: false, problem: 'permissions' });
    const bad = await api(t.cookie, 'POST', '/v1/integrations/woocommerce/test', { ...connectBody, consumerSecret: `cs_${'e'.repeat(40)}` });
    expect(bad.body).toMatchObject({ ok: false, problem: 'unauthorized' });
    const shape = await api(t.cookie, 'POST', '/v1/integrations/woocommerce/test', { ...connectBody, consumerKey: 'nope' });
    expect(shape.status).toBe(400);
    expect((await owner.query('SELECT 1 FROM woo_connections WHERE tenant_id = $1', [t.tenantId])).rowCount).toBe(0);
  });

  it('only the owner connects; manager sees status; cashier sees nothing', async () => {
    const mgr = await makeUser(t.tenantId, 'manager');
    const cashier = await makeUser(t.tenantId, 'cashier');
    expect((await api(mgr.cookie, 'PUT', '/v1/integrations/woocommerce', connectBody)).status).toBe(403);
    expect((await api(mgr.cookie, 'GET', '/v1/integrations/woocommerce')).status).toBe(200);
    expect((await api(cashier.cookie, 'GET', '/v1/integrations/woocommerce')).status).toBe(403);
  });

  it('connects: secrets sealed, webhooks created, nothing secret returned', async () => {
    const res = await api(t.cookie, 'PUT', '/v1/integrations/woocommerce', connectBody);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ status: 'connected', keyHint: 'ck_…aaaa', webhooksHealthy: true });
    expect(res.text).not.toContain(RW.secret);
    expect(res.text).not.toContain(RW.key);
    const { rows: [c] } = await owner.query('SELECT key_enc, secret_enc, webhook_secret_enc FROM woo_connections WHERE tenant_id = $1', [t.tenantId]);
    for (const b of [c.key_enc, c.secret_enc]) {
      expect(b.toString('latin1')).not.toContain('ck_');
      expect(b.toString('latin1')).not.toContain('cs_');
    }
    const ours = [...woo.hooks.values()].filter((h) => h.delivery_url.startsWith('http://erp.test/api/v1/webhooks/woocommerce/'));
    expect(ours.map((h) => h.topic).sort()).toEqual(['order.created', 'order.deleted', 'order.restored', 'order.updated', 'product.deleted']);
    expect(new Set(ours.map((h) => h.delivery_url)).size).toBe(1);
    const audit = await owner.query("SELECT summary FROM audit_events WHERE tenant_id = $1 AND action = 'woo.connected'", [t.tenantId]);
    expect(JSON.stringify(audit.rows)).not.toContain(RW.secret);
  });

  it('connecting and the 15-minute check-up take turns on the shop', async () => {
    const c = await pool.connect();
    try {
      await c.query('SELECT pg_advisory_lock(hashtextextended($1, 42))', [shopLockKey(t.tenantId)]);
      await expect(reconcile(t.tenantId)).rejects.toThrow(/another worker/);
      const pending = api(t.cookie, 'PUT', '/v1/integrations/woocommerce', connectBody);
      await new Promise((r) => setTimeout(r, 400));
      await c.query('SELECT pg_advisory_unlock(hashtextextended($1, 42))', [shopLockKey(t.tenantId)]);
      expect((await pending).status).toBe(200);
    } finally { c.release(); }
    expect([...woo.hooks.values()].filter((h) => h.name === hookName(h.topic, t.tenantId))).toHaveLength(5);
  });

  it('a second store (or a staging copy of the ERP) on the same shop leaves the first store\'s webhooks alone', async () => {
    const before = [...woo.hooks.values()].filter((h) => h.name === hookName(h.topic, t.tenantId));
    expect(before).toHaveLength(5);
    const other = await makeTenant();
    expect((await api(other.cookie, 'PUT', '/v1/integrations/woocommerce', connectBody)).status).toBe(200);
    for (const h of before) expect(woo.hooks.has(h.id)).toBe(true);
    expect((await api(other.cookie, 'DELETE', '/v1/integrations/woocommerce')).status).toBe(204);
    for (const h of before) expect(woo.hooks.has(h.id)).toBe(true);
  });

  it('a ciphertext moved to another tenant does not decrypt', async () => {
    const other = await makeTenant();
    const { rows: [c] } = await owner.query('SELECT * FROM woo_connections WHERE tenant_id = $1', [t.tenantId]);
    const { rows: [loc] } = await owner.query("SELECT id FROM locations WHERE tenant_id = $1 LIMIT 1", [other.tenantId]);
    const locId = loc?.id ?? (await locations(other.cookie)).shop;
    await owner.query(
      `INSERT INTO woo_connections (tenant_id, site_url, key_hint, key_enc, secret_enc, webhook_secret_enc, status, online_location_id, connected_by)
       VALUES ($1, $2, 'x', $3, $4, $5, 'connected', $6, $7)`, [other.tenantId, c.site_url, c.key_enc, c.secret_enc, c.webhook_secret_enc, locId, other.userId]);
    const r = await api(other.cookie, 'POST', '/v1/sync/reconcile');
    expect(r.status).toBe(202);
    await expect(reconcile(other.tenantId)).rejects.toThrow(/unable to authenticate/i);
  });
});

describe('B4 publish, orders, stock', () => {
  let t: Awaited<ReturnType<typeof makeTenant>>;
  let shop: string;
  const v: Record<string, string> = {};
  let kurtaWoo: number;

  beforeAll(async () => {
    t = await makeTenant();
    woo.ownHook = (h) => h.name === hookName(h.topic, t.tenantId);
    shop = (await locations(t.cookie)).shop;
    // The shop already sells a kurta with two of the ERP's SKUs, and a mug the ERP does not have.
    const parent = woo.addProduct({ type: 'variable', name: 'Kurta', attributes: [{ id: 0, name: 'Fabric', options: ['Cotton'], variation: false }] });
    kurtaWoo = parent.id;
    woo.addProduct({ type: 'variation', parent_id: parent.id, sku: 'T4-KUR-S', regular_price: '499', stock_quantity: 5 });
    woo.addProduct({ type: 'variation', parent_id: parent.id, sku: 'T4-KUR-M', regular_price: '499', stock_quantity: 5 });
    woo.addProduct({ sku: 'T4-MUG', name: 'Mug', regular_price: '199' });

    const kurta = await api(t.cookie, 'POST', '/v1/products', { name: 'Cotton Kurta', type: 'variable', status: 'active',
      variants: ['S', 'M', 'L'].map((s) => ({ sku: `T4-KUR-${s}`, price: '599', attributes: { size: s }, weightG: 350 })) });
    expect(kurta.status, kurta.text).toBe(201);
    for (const x of kurta.body.variants) v[x.sku] = x.id;
    v['T4-BOT'] = await makeItem(t.cookie, 'T4-BOT', {}, 'NOS');
    await api(t.cookie, 'PATCH', `/v1/products/${(await owner.query('SELECT product_id FROM product_variants WHERE id = $1', [v['T4-BOT']])).rows[0].product_id}`,
      { publishToWeb: true }, { 'if-match': '"1"' });
    expect((await adjust(t.cookie, shop, 'opening', [{ variantId: v['T4-KUR-S'], qtyDelta: '10' }, { variantId: v['T4-KUR-M'], qtyDelta: '4' }, { variantId: v['T4-BOT'], qtyDelta: '7' }], {}, ) as any).status).toBe(201);
    expect((await api(t.cookie, 'PUT', '/v1/integrations/woocommerce', connectBody)).status).toBe(200);
  });

  it('matches by SKU and pushes nothing until confirmed', async () => {
    await drain(t.tenantId);
    const m = await api(t.cookie, 'GET', '/v1/integrations/woocommerce/match');
    expect(m.body.state).toBe('ready');
    expect(m.body.summary).toMatchObject({ matched: 2, erpOnly: 2 });
    expect(m.body.wooOnly.map((w: any) => w.sku)).toContain('T4-MUG');
    expect(woo.calls.filter((c) => c.startsWith('PUT /products') || c.includes('variations/batch'))).toEqual([]);
    expect([...woo.products.values()].find((p) => p.sku === 'T4-KUR-S')!.regular_price).toBe('499');
  });

  it('after confirm: adopts the existing Woo product (no duplicate), creates the rest, ERP owns price and stock', async () => {
    expect((await api(t.cookie, 'POST', '/v1/integrations/woocommerce/match/confirm')).status).toBe(200);
    await drain(t.tenantId);
    const kurtas = [...woo.products.values()].filter((p) => p.type === 'variable');
    expect(kurtas).toHaveLength(1);
    expect(kurtas[0]).toMatchObject({ id: kurtaWoo, name: 'Cotton Kurta', status: 'publish' });
    expect((kurtas[0].attributes as any[]).map((a) => a.name)).toEqual(['Fabric', 'Size']);
    const vars = Object.fromEntries([...woo.products.values()].filter((p) => p.parent_id === kurtaWoo).map((p) => [p.sku, p]));
    expect(Object.keys(vars).sort()).toEqual(['T4-KUR-L', 'T4-KUR-M', 'T4-KUR-S']);
    expect(vars['T4-KUR-S']).toMatchObject({ regular_price: '599.00', stock_quantity: 10 });
    expect(vars['T4-KUR-M'].stock_quantity).toBe(4);
    expect((vars['T4-KUR-S'] as any).weight).toBe('0.35');
    expect([...woo.products.values()].find((p) => p.sku === 'T4-BOT')).toMatchObject({ type: 'simple', stock_quantity: 7 });
    const states = await owner.query('SELECT publish_state, publish_error FROM products WHERE tenant_id = $1 AND publish_to_web', [t.tenantId]);
    expect(states.rows.every((r) => r.publish_state === 'synced')).toBe(true);
  });

  it('comparing again after confirming keeps product sync on', async () => {
    expect((await api(t.cookie, 'POST', '/v1/integrations/woocommerce/match')).status).toBe(202);
    await drain(t.tenantId);
    const m = await api(t.cookie, 'GET', '/v1/integrations/woocommerce/match');
    expect(m.body.state).toBe('confirmed');
    expect(m.body.summary.matched).toBeGreaterThanOrEqual(3);
  });

  it('a lost mapping (crash after Woo created it) adopts instead of duplicating', async () => {
    await owner.query('DELETE FROM woo_variant_map WHERE tenant_id = $1', [t.tenantId]);
    await owner.query('DELETE FROM woo_product_map WHERE tenant_id = $1', [t.tenantId]);
    const { rows } = await owner.query('SELECT id FROM products WHERE tenant_id = $1 AND publish_to_web', [t.tenantId]);
    for (const r of rows) await publishProduct(t.tenantId, r.id);
    expect([...woo.products.values()].filter((p) => p.sku === 'T4-BOT')).toHaveLength(1);
    expect([...woo.products.values()].filter((p) => p.parent_id === kurtaWoo)).toHaveLength(3);
  });

  it('a stock change reaches Woo through the outbox', async () => {
    await adjust(t.cookie, shop, 'correction', [{ variantId: v['T4-KUR-M'], qtyDelta: '2' }]);
    await drain(t.tenantId);
    expect([...woo.products.values()].find((p) => p.sku === 'T4-KUR-M')!.stock_quantity).toBe(6);
  });

  let orderId: string;
  const kurS = () => [...woo.products.values()].find((p) => p.sku === 'T4-KUR-S')!;

  it('a paid web order reserves stock; a replay changes nothing', async () => {
    const o = woo.order({ id: 9001, status: 'processing', line_items: [{ product_id: kurtaWoo, variation_id: kurS().id, sku: 'T4-KUR-S', quantity: 3 }] });
    const r = await woo.deliver('order.created', o);
    expect(r.statusCode).toBe(200);
    expect((await woo.deliver('order.created', o)).statusCode).toBe(200);           // Woo retry / replay
    expect((await owner.query("SELECT count(*)::int AS n FROM webhook_events WHERE tenant_id = $1 AND topic = 'order.created'", [t.tenantId])).rows[0].n).toBe(1);
    await drain(t.tenantId);
    const list = await api(t.cookie, 'GET', '/v1/orders?channel=woocommerce');
    const ord = list.body.items.find((x: any) => x.externalId === '9001');
    expect(ord).toMatchObject({ status: 'ready_to_pick', paymentState: 'awaiting', customerName: 'Asha' });
    orderId = ord.id;
    expect(await available(t.cookie, v['T4-KUR-S'], shop)).toBe('7');
    expect(kurS().stock_quantity).toBe(7);
  });

  it('an older payload arriving late is ignored', async () => {
    const stale = { ...woo.orders.get(9001), status: 'cancelled', date_modified_gmt: '2020-01-01T00:00:00' };
    await woo.deliver('order.updated', stale);
    await drain(t.tenantId);
    expect((await api(t.cookie, 'GET', `/v1/orders/${orderId}`)).body.status).toBe('ready_to_pick');
    expect((await owner.query("SELECT status FROM webhook_events WHERE tenant_id = $1 AND topic = 'order.updated' ORDER BY received_at DESC LIMIT 1", [t.tenantId])).rows[0].status).toBe('ignored_stale');
  });

  it('a forged webhook is refused and audited', async () => {
    const r = await woo.deliver('order.updated', { id: 9001, status: 'cancelled' }, { signature: 'AAAA' });
    expect(r.statusCode).toBe(401);
    expect((await owner.query("SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'woo.webhook_rejected'", [t.tenantId])).rowCount).toBeGreaterThan(0);
    const app = (await import('./b2-helpers.js')).getApp;
    const unknown = await (await app()).inject({ method: 'POST', url: `/v1/webhooks/woocommerce/${'x'.repeat(43)}`, payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(unknown.statusCode).toBe(404);
  });

  it('not enough stock: the order waits as a stock exception, then reserves once stock arrives', async () => {
    const bot = [...woo.products.values()].find((p) => p.sku === 'T4-BOT')!;
    const o = woo.order({ id: 9002, status: 'processing', line_items: [{ product_id: bot.id, sku: 'T4-BOT', quantity: 20 }] });
    await woo.deliver('order.created', o);
    await drain(t.tenantId);
    const list = await api(t.cookie, 'GET', '/v1/orders?status=attention');
    const ex = list.body.items.find((x: any) => x.externalId === '9002');
    expect(ex.status).toBe('stock_exception');
    expect(ex.exceptionReason).toContain('T4-BOT needs 20, 7 available');
    expect(await available(t.cookie, v['T4-BOT'], shop)).toBe('7');
    await adjust(t.cookie, shop, 'correction', [{ variantId: v['T4-BOT'], qtyDelta: '13' }]);
    const r = await api(t.cookie, 'POST', `/v1/orders/${ex.id}/retry-reservation`);
    expect(r.body.status).toBe('ready_to_pick');
    expect(await available(t.cookie, v['T4-BOT'], shop)).toBe('0');
  });

  it('an unknown SKU waits until a person maps the line', async () => {
    const o = woo.order({ id: 9003, status: 'on-hold', line_items: [{ product_id: 5555, sku: 'NOT-IN-ERP', quantity: 1 }] });
    await woo.deliver('order.created', o);
    await drain(t.tenantId);
    const { rows: [so] } = await owner.query("SELECT id, status, exception_reason FROM sales_orders WHERE tenant_id = $1 AND external_id = '9003'", [t.tenantId]);
    expect(so.status).toBe('stock_exception');
    const d = await api(t.cookie, 'GET', `/v1/orders/${so.id}`);
    const m = await api(t.cookie, 'POST', `/v1/orders/${so.id}/map-line`, { lineId: d.body.lines[0].id, variantId: v['T4-KUR-M'] });
    expect(m.body.status).toBe('on_hold');
    expect(m.body.lines[0].reservation).toBe('active');
  });

  it('completed in Woo deducts stock exactly once; cancelled releases', async () => {
    await woo.deliver('order.updated', woo.order({ id: 9001, status: 'completed', line_items: woo.orders.get(9001).line_items }));
    await drain(t.tenantId);
    await woo.deliver('order.updated', woo.order({ id: 9001, status: 'completed', line_items: woo.orders.get(9001).line_items }));
    await drain(t.tenantId);
    const mv = await api(t.cookie, 'GET', `/v1/stock/movements?variantId=${v['T4-KUR-S']}`);
    const dispatch = mv.body.items.filter((x: any) => x.movementType === 'dispatch');
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]).toMatchObject({ qtyDelta: '-3', balanceAfter: '7', source: { type: 'sales_order', number: '9001' }, actor: { id: null, name: 'WooCommerce' } });
    expect((await api(t.cookie, 'GET', `/v1/orders/${orderId}`)).body.status).toBe('completed');

    await woo.deliver('order.updated', woo.order({ id: 9003, status: 'cancelled', line_items: woo.orders.get(9003).line_items }));
    await drain(t.tenantId);
    const { rows: [so] } = await owner.query("SELECT status FROM sales_orders WHERE tenant_id = $1 AND external_id = '9003'", [t.tenantId]);
    expect(so.status).toBe('cancelled');
    expect((await owner.query('SELECT * FROM v_reservation_reconciliation')).rows).toEqual([]);
    expect((await api(t.cookie, 'GET', '/v1/stock/reconciliation')).body.mismatches).toEqual([]);
  });

  it('reconcile repairs stock edited in Woo and re-enables a disabled webhook', async () => {
    kurS().stock_quantity = 99;
    const hook = [...woo.hooks.values()].find((h) => h.topic === 'order.updated' && woo.ownHook(h))!;
    hook.status = 'disabled';
    expect((await api(t.cookie, 'POST', '/v1/sync/reconcile')).status).toBe(202);
    await drain(t.tenantId);
    expect(kurS().stock_quantity).toBe(7);
    expect(hook.status).toBe('active');
    const s = await api(t.cookie, 'GET', '/v1/integrations/woocommerce');
    expect(s.body).toMatchObject({ status: 'connected', webhooksHealthy: true });
  });

  it('Woo down: the job is retried, not lost', async () => {
    await adjust(t.cookie, shop, 'correction', [{ variantId: v['T4-KUR-S'], qtyDelta: '1' }]);
    await sweepOnce();
    woo.failNext = 503;
    await expect(pushStock(t.tenantId)).rejects.toThrow(/busy/i);
    expect((await owner.query("SELECT count(*)::int AS n FROM woo_outbox WHERE tenant_id = $1 AND kind = 'stock'", [t.tenantId])).rows[0].n).toBeGreaterThan(0);
    await pushStock(t.tenantId);
    expect(kurS().stock_quantity).toBe(8);
  });

  it('disconnect removes our webhooks and wipes the secrets', async () => {
    const r = await api(t.cookie, 'DELETE', '/v1/integrations/woocommerce');
    expect(r.status).toBe(204);
    const { rows: [c] } = await owner.query('SELECT status, key_enc, secret_enc, webhook_secret_enc, endpoint_token_hash FROM woo_connections WHERE tenant_id = $1', [t.tenantId]);
    expect(c).toMatchObject({ status: 'disconnected', key_enc: null, secret_enc: null, webhook_secret_enc: null, endpoint_token_hash: null });
    expect([...woo.hooks.values()].filter((h) => woo.ownHook(h))).toEqual([]);
    expect(woo.hooks.size).toBeGreaterThan(0);   // other stores' webhooks stay
    expect((await owner.query('SELECT count(*)::int AS n FROM woo_variant_map WHERE tenant_id = $1', [t.tenantId])).rows[0].n).toBeGreaterThan(0);
  });
});

describe('B4 tenant isolation and grants', () => {
  it('every B4 table has RLS on; all but the two the cross-tenant lookups read also force it (D74)', async () => {
    const { rows } = await owner.query(
      `SELECT relname FROM pg_class WHERE relname = ANY($1) AND (NOT relrowsecurity OR NOT relforcerowsecurity)`,
      [['woo_product_map', 'woo_variant_map', 'woo_category_map', 'webhook_events', 'customers', 'sales_orders', 'sales_order_lines', 'sales_order_events', 'stock_reservations']]);
    expect(rows).toEqual([]);
    const { rows: lookups } = await owner.query(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('woo_connections', 'woo_outbox') ORDER BY 1");
    expect(lookups.map((r) => [r.relname, r.relrowsecurity, r.relforcerowsecurity])).toEqual([['woo_connections', true, false], ['woo_outbox', true, false]]);
  });

  it('another tenant sees none of it', async () => {
    const a = await makeTenant();
    await tenantTx(a.tenantId, async (tx) => {
      for (const table of ['woo_connections', 'sales_orders', 'sales_order_lines', 'stock_reservations', 'webhook_events', 'customers'])
        expect((await tx.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    });
  });

  it('the order timeline is append-only for the app role', async () => {
    const c = await pool.connect();
    try {
      await expect(c.query('UPDATE sales_order_events SET message = message')).rejects.toThrow(/permission denied/);
      await expect(c.query('DELETE FROM sales_orders')).rejects.toThrow(/permission denied/);
      await expect(c.query('DELETE FROM woo_connections')).rejects.toThrow(/permission denied/);
    } finally { c.release(); }
  });
});
