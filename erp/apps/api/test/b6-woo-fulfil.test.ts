import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The fake shop runs on http://127.0.0.1, which only the dev flag allows.
vi.hoisted(() => {
  process.env.WOO_DEV_ALLOW_PRIVATE = 'true';
  process.env.WOO_WEBHOOK_BASE_URL = 'http://erp.test/api';
});

import { pool } from '../src/db.js';
import { PermanentJobError } from '../src/jobs/runner.js';
import { pushFulfilment } from '../src/modules/woocommerce/fulfilment.js';
import { api } from './b2-api.js';
import { makeTenant, owner } from './b2-helpers.js';
import { stockedItem } from './b5-helpers.js';
import { FakeWoo, RW } from './b4-fake-woo.js';
import { dispatchOrder, nextWooId, pickAndPack, readyOrder, skuOf, type T } from './b6-helpers.js';

const woo = await new FakeWoo().start();
afterAll(async () => { await woo.stop(); await owner.end(); await pool.end(); });

const shipmentOf = async (orderId: string) => (await owner.query('SELECT * FROM shipments WHERE order_id = $1', [orderId])).rows[0];
const jobsOf = async (shipmentId: string) =>
  (await owner.query("SELECT status FROM sync_jobs WHERE kind = 'woo.fulfilment' AND resource_id = $1 ORDER BY created_at", [shipmentId])).rows.map((r) => r.status);

describe('B6 telling WooCommerce about a dispatch', () => {
  let t: T;
  let sku: string;
  beforeAll(async () => {
    t = await makeTenant();
    const res = await api(t.cookie, 'PUT', '/v1/integrations/woocommerce', { siteUrl: woo.url, consumerKey: RW.key, consumerSecret: RW.secret });
    expect(res.status, res.text).toBe(200);
    sku = await skuOf(await stockedItem(t.cookie, { price: '300', stock: '30' }));
  });

  /** An order that exists in the fake shop and in the ERP, picked, packed and dispatched. */
  async function dispatched(body: Record<string, unknown> = { carrier: 'Delhivery', service: 'Surface', trackingNo: 'DLV777' }) {
    const wooId = nextWooId();
    woo.order({ id: wooId, line_items: [{ sku, quantity: 1, total: '300.00' }] });
    const o = await readyOrder(t, [[sku, 1, '300.00']], wooId);
    await pickAndPack(t.cookie, o.id);
    const d = await dispatchOrder(t.cookie, o.id, body);
    expect(d.status, d.text).toBe(200);
    expect(d.body.shipment.webUpdate).toBe('pending');
    return { ...o, shipment: await shipmentOf(o.id) };
  }

  it('posts the tracking note to the customer, then marks the order completed in the shop', async () => {
    const o = await dispatched();
    expect(await jobsOf(o.shipment.id)).toEqual(['pending']);
    await pushFulfilment(t.tenantId, o.shipment.id);
    expect(woo.notes.filter((n) => n.orderId === o.wooId)).toEqual([
      expect.objectContaining({ customer_note: true, note: 'Your order has been dispatched via Delhivery (Surface). Tracking number: DLV777' })]);
    expect(woo.orders.get(o.wooId).status).toBe('completed');
    expect(await shipmentOf(o.id)).toMatchObject({ woo_update_state: 'synced', woo_error: null });
    const calls = woo.calls.filter((c) => c.includes(`/orders/${o.wooId}`));
    expect(calls).toEqual([`POST /orders/${o.wooId}/notes`, `PUT /orders/${o.wooId}`]);
    await pushFulfilment(t.tenantId, o.shipment.id);   // a duplicate job does nothing
    expect(woo.calls.filter((c) => c.includes(`/orders/${o.wooId}`))).toHaveLength(2);
  });

  it('a shop that is down is retried without posting the note twice', async () => {
    const o = await dispatched({ carrier: 'Hand delivery' });
    woo.failWhen = (m, p) => (m === 'PUT' && p === `/orders/${o.wooId}` ? 503 : null);
    await expect(pushFulfilment(t.tenantId, o.shipment.id)).rejects.toThrow(/busy/);
    expect(await shipmentOf(o.id)).toMatchObject({ woo_update_state: 'pending', woo_error: expect.stringMatching(/will retry/) });
    woo.failWhen = null;
    await pushFulfilment(t.tenantId, o.shipment.id);
    expect(woo.notes.filter((n) => n.orderId === o.wooId).map((n) => n.note)).toEqual(['Your order has been dispatched via Hand delivery.']);
    expect(woo.orders.get(o.wooId).status).toBe('completed');
    expect((await shipmentOf(o.id)).woo_update_state).toBe('synced');
  });

  it('an order deleted in the shop fails for a person to see, who can retry it', async () => {
    const o = await dispatched();
    const saved = woo.orders.get(o.wooId);
    woo.orders.delete(o.wooId);
    await expect(pushFulfilment(t.tenantId, o.shipment.id)).rejects.toBeInstanceOf(PermanentJobError);
    expect(await shipmentOf(o.id)).toMatchObject({ woo_update_state: 'failed', woo_error: 'The order no longer exists in WooCommerce' });

    const q = await api(t.cookie, 'GET', '/v1/fulfilment/queue?stage=dispatched_pending_web');
    expect(q.body.items.find((i: any) => i.id === o.id)?.shipment).toMatchObject({ webUpdate: 'failed' });

    woo.orders.set(o.wooId, saved);
    const r = await api(t.cookie, 'POST', `/v1/orders/${o.id}/web-update/retry`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.shipment).toMatchObject({ webUpdate: 'pending', webError: null });
    await pushFulfilment(t.tenantId, o.shipment.id);
    expect((await api(t.cookie, 'GET', `/v1/orders/${o.id}`)).body.shipment.webUpdate).toBe('synced');
    expect((await api(t.cookie, 'POST', `/v1/orders/${o.id}/web-update/retry`)).status).toBe(409);
  });

  it('a pending update whose job gave up shows as failed', async () => {
    const o = await dispatched();
    await owner.query("UPDATE sync_jobs SET status = 'dead' WHERE kind = 'woo.fulfilment' AND resource_id = $1", [o.shipment.id]);
    expect((await api(t.cookie, 'GET', `/v1/orders/${o.id}`)).body.shipment.webUpdate).toBe('failed');
  });
});
