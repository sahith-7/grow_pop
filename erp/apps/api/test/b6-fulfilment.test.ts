import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { api } from './b2-api.js';
import { makeTenant, makeUser, owner } from './b2-helpers.js';
import { key } from './b3-helpers.js';
import { onHandAt, setupBilling, stockedItem } from './b5-helpers.js';
import { applyOrder, dispatchOrder, ledgerRows, pickAndPack, readyOrder, skuOf, wooOrder, type T } from './b6-helpers.js';

afterAll(async () => { await owner.end(); await pool.end(); });

const order = async (t: T, id: string) => (await api(t.cookie, 'GET', `/v1/orders/${id}`)).body;
const events = async (id: string) => (await owner.query('SELECT kind, message FROM sales_order_events WHERE order_id = $1 ORDER BY id', [id])).rows;

describe('B6 pick, pack and dispatch', () => {
  let t: T;
  let v: string, sku: string, barcode: string;
  beforeAll(async () => {
    t = await makeTenant();
    await setupBilling(t);
    v = await stockedItem(t.cookie, { price: '500', gstRate: '5', stock: '20' });
    sku = await skuOf(v);
    barcode = `29${Date.now()}`.slice(0, 13);
    await owner.query('UPDATE product_variants SET barcode = $2 WHERE id = $1', [v, barcode]);
  });

  it('walks one order from ready to dispatched: scan checks, exact pack, stock out once, invoice issued', async () => {
    const o = await readyOrder(t, [[sku, 3, '1500.00']]);
    const q = await api(t.cookie, 'GET', '/v1/fulfilment/queue?stage=ready_to_pick');
    expect(q.status, q.text).toBe(200);
    expect(q.body.items.map((i: any) => i.id)).toContain(o.id);
    expect(q.body.counts.ready_to_pick).toBeGreaterThanOrEqual(1);

    const list = await api(t.cookie, 'POST', '/v1/pick-lists', { orderIds: [o.id] });
    expect(list.status, list.text).toBe(201);
    expect(list.body).toMatchObject({ number: expect.stringMatching(/^PK-/), status: 'open', lines: [{ sku, qtyRequired: '3', qtyPicked: '0' }] });
    expect((await order(t, o.id)).status).toBe('picking');

    // Wrong item, unknown code, too many: refused and nothing changes.
    const other = await stockedItem(t.cookie, { price: '10', stock: '5' });
    const wrong = await api(t.cookie, 'POST', `/v1/pick-lists/${list.body.id}/scan`, { code: await skuOf(other) });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ code: 'PICK_MISMATCH', message: expect.stringMatching(/Wrong item/) });
    expect((await api(t.cookie, 'POST', `/v1/pick-lists/${list.body.id}/scan`, { code: 'NOPE-123' })).body.code).toBe('PICK_MISMATCH');

    const first = await api(t.cookie, 'POST', `/v1/pick-lists/${list.body.id}/scan`, { code: barcode });
    expect(first.status, first.text).toBe(200);
    expect(first.body).toMatchObject({ status: 'picking', scanned: { sku, into: [{ qty: '1' }] }, progress: { picked: '1', required: '3' } });
    const over = await api(t.cookie, 'POST', `/v1/pick-lists/${list.body.id}/scan`, { code: sku.toLowerCase(), qty: '3' });
    expect(over.body).toMatchObject({ code: 'PICK_MISMATCH', message: expect.stringMatching(/Only 2 more/) });

    // Packing before everything is picked is refused.
    const lines = (await order(t, o.id)).lines.map((l: any) => ({ lineId: l.id, qty: l.qty }));
    expect((await api(t.cookie, 'POST', `/v1/orders/${o.id}/pack`, { lines })).body.code).toBe('NOT_PICKED');
    const rest = await api(t.cookie, 'POST', `/v1/pick-lists/${list.body.id}/scan`, { code: sku, qty: '2' });
    expect(rest.body).toMatchObject({ status: 'picked', progress: { picked: '3', required: '3' } });
    expect((await api(t.cookie, 'POST', `/v1/pick-lists/${list.body.id}/scan`, { code: sku })).body.message).toMatch(/already picked/);

    const short = await api(t.cookie, 'POST', `/v1/orders/${o.id}/pack`, { lines: [{ ...lines[0], qty: '2' }] });
    expect(short.status).toBe(400);
    expect(short.body.fieldErrors['lines.0.qty'][0]).toMatch(/substitutions are off/);
    const packed = await api(t.cookie, 'POST', `/v1/orders/${o.id}/pack`, { lines });
    expect(packed.status, packed.text).toBe(200);
    expect(packed.body).toMatchObject({ status: 'packed', packedAt: expect.any(String) });

    const before = await onHandAt(v);
    expect((await api(t.cookie, 'POST', `/v1/orders/${o.id}/dispatch`, { carrier: 'Delhivery' })).status).toBe(400);   // no Idempotency-Key
    expect((await dispatchOrder(t.cookie, o.id, { carrier: '' })).status).toBe(400);
    expect((await dispatchOrder(t.cookie, o.id, { carrier: 'X', shippedAt: new Date(Date.now() + 86_400_000).toISOString() })).body.fieldErrors.shippedAt).toBeTruthy();
    const k = key();
    const d = await dispatchOrder(t.cookie, o.id, { carrier: 'Delhivery', service: 'Surface', trackingNo: 'DLV123' }, k);
    expect(d.status, d.text).toBe(200);
    expect(d.body).toMatchObject({
      status: 'dispatched', invoiceState: 'issued', documents: [{ type: 'invoice' }], pickList: null,
      shipment: { carrier: 'Delhivery', service: 'Surface', trackingNo: 'DLV123', webUpdate: 'not_needed' },   // no shop connected in this test
    });
    expect(Number(before) - Number(await onHandAt(v))).toBe(3);
    expect(await ledgerRows(o.id)).toBe(1);

    // Same request again (a retry after a timeout) replays; a second dispatch is refused. Stock leaves once.
    const replay = await dispatchOrder(t.cookie, o.id, { carrier: 'Delhivery', service: 'Surface', trackingNo: 'DLV123' }, k);
    expect(replay.status).toBe(200);
    expect((await dispatchOrder(t.cookie, o.id)).body.code).toBe('ALREADY_DISPATCHED');
    expect(await ledgerRows(o.id)).toBe(1);
    expect((await owner.query("SELECT count(*)::int AS n FROM invoices WHERE order_id = $1", [o.id])).rows[0].n).toBe(1);
    expect((await owner.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'order.dispatched' AND entity_id = $1", [o.id])).rows[0].n).toBe(1);
    expect((await api(t.cookie, 'GET', `/v1/pick-lists/${list.body.id}`)).body.status).toBe('cancelled');   // nothing live left on it
  });

  it('a batch pick list fills the oldest order first and lists each line with its bag', async () => {
    const a = await readyOrder(t, [[sku, 1, '500.00']]);
    const b = await readyOrder(t, [[sku, 2, '1000.00']]);
    const list = await api(t.cookie, 'POST', '/v1/pick-lists', { orderIds: [b.id, a.id] });
    expect(list.status, list.text).toBe(201);
    expect(list.body.orders).toHaveLength(2);
    const s = await api(t.cookie, 'POST', `/v1/pick-lists/${list.body.id}/scan`, { code: sku, qty: '2' });
    const placedFirst = (await owner.query('SELECT id FROM sales_orders WHERE id = ANY($1) ORDER BY placed_at, id LIMIT 1', [[a.id, b.id]])).rows[0].id;
    expect(s.body.scanned.into[0].orderNumber).toBe((await order(t, placedFirst)).number);
    expect((await api(t.cookie, 'GET', '/v1/pick-lists?open=true')).body.items.map((l: any) => l.id)).toContain(list.body.id);
    // An order can be on one live list only.
    expect((await api(t.cookie, 'POST', '/v1/pick-lists', { orderIds: [a.id] })).status).toBe(409);
    const cancel = await api(t.cookie, 'POST', `/v1/pick-lists/${list.body.id}/cancel`, { reason: 'wrong batch' });
    expect(cancel.status, cancel.text).toBe(200);
    expect(cancel.body.status).toBe('cancelled');
    expect((await order(t, a.id)).status).toBe('ready_to_pick');
    expect((await order(t, b.id)).status).toBe('ready_to_pick');
  });

  it('only ready orders go on a pick list; dispatch needs packing', async () => {
    const r = await applyOrder(t, wooOrder({ id: 990_001 + Math.floor(Math.random() * 1000), status: 'on-hold', lines: [[sku, 1, '500.00']] }));
    expect((await api(t.cookie, 'POST', '/v1/pick-lists', { orderIds: [r.orderId] })).body.code).toBe('INVALID_STATE');
    const o = await readyOrder(t, [[sku, 1, '500.00']]);
    expect((await dispatchOrder(t.cookie, o.id)).body.code).toBe('INVALID_STATE');
    expect((await api(t.cookie, 'POST', `/v1/orders/${o.id}/pack`, { lines: [] })).status).toBe(400);
  });

  it('taking an order off picking keeps its stock held and lets it be picked again', async () => {
    const o = await readyOrder(t, [[sku, 1, '500.00']]);
    await pickAndPack(t.cookie, o.id);
    const back = await api(t.cookie, 'POST', `/v1/orders/${o.id}/unpick`, { reason: 'Box damaged' });
    expect(back.status, back.text).toBe(200);
    expect(back.body).toMatchObject({ status: 'ready_to_pick', packedAt: null, pickList: null });
    expect((await owner.query("SELECT count(*)::int AS n FROM stock_reservations WHERE order_id = $1 AND state = 'active'", [o.id])).rows[0].n).toBe(1);
    await pickAndPack(t.cookie, o.id);
    expect((await dispatchOrder(t.cookie, o.id)).status).toBe(200);
  });
});

describe('B6 while WooCommerce changes the order', () => {
  let t: T;
  let sku: string;
  beforeAll(async () => {
    t = await makeTenant();
    await setupBilling(t);
    sku = await skuOf(await stockedItem(t.cookie, { price: '200', gstRate: '5', stock: '50' }));
  });

  it('cancelled in the shop during picking: off the list, stock released, staff told to put items back', async () => {
    const o = await readyOrder(t, [[sku, 2, '400.00']]);
    const list = await api(t.cookie, 'POST', '/v1/pick-lists', { orderIds: [o.id] });
    await api(t.cookie, 'POST', `/v1/pick-lists/${list.body.id}/scan`, { code: sku });
    await applyOrder(t, wooOrder({ id: o.wooId, status: 'cancelled', lines: [[sku, 2, '400.00']], modified: '2026-10-20T06:00:00' }));
    expect((await order(t, o.id)).status).toBe('cancelled');
    expect((await api(t.cookie, 'GET', `/v1/pick-lists/${list.body.id}`)).body).toMatchObject({ status: 'cancelled', orders: [{ removed: true }] });
    expect((await owner.query("SELECT count(*)::int AS n FROM stock_reservations WHERE order_id = $1 AND state = 'active'", [o.id])).rows[0].n).toBe(0);
    expect(await events(o.id)).toContainEqual({ kind: 'fulfilment_stopped', message: expect.stringMatching(/put the picked items back/) });
    expect((await api(t.cookie, 'POST', `/v1/pick-lists/${list.body.id}/scan`, { code: sku })).status).toBe(409);
  });

  it('the shop re-sending "processing" keeps the picking and packed stages', async () => {
    const o = await readyOrder(t, [[sku, 1, '200.00']]);
    await api(t.cookie, 'POST', '/v1/pick-lists', { orderIds: [o.id] });
    await applyOrder(t, wooOrder({ id: o.wooId, status: 'processing', lines: [[sku, 1, '200.00']], modified: '2026-10-20T06:00:00' }));
    expect((await order(t, o.id)).status).toBe('picking');
  });

  it('quantity changed in the shop during picking: re-reserved and back to ready', async () => {
    const o = await readyOrder(t, [[sku, 1, '200.00']]);
    await pickAndPack(t.cookie, o.id);
    await applyOrder(t, wooOrder({ id: o.wooId, status: 'processing', lines: [[sku, 3, '600.00']], modified: '2026-10-20T06:00:00' }));
    expect(await order(t, o.id)).toMatchObject({ status: 'ready_to_pick', packedAt: null, pickList: null });
    expect(await events(o.id)).toContainEqual({ kind: 'fulfilment_stopped', message: expect.stringMatching(/Changed in WooCommerce/) });
  });

  it('completed in the shop before the ERP dispatched: stock leaves once, invoice issued, off the list', async () => {
    const o = await readyOrder(t, [[sku, 1, '200.00']]);
    await pickAndPack(t.cookie, o.id);
    await applyOrder(t, wooOrder({ id: o.wooId, status: 'completed', lines: [[sku, 1, '200.00']], modified: '2026-10-20T06:00:00' }));
    expect(await order(t, o.id)).toMatchObject({ status: 'completed', invoiceState: 'issued', pickList: null });
    expect(await ledgerRows(o.id)).toBe(1);
    expect((await dispatchOrder(t.cookie, o.id)).body.code).toBe('INVALID_STATE');
  });

  it('after an ERP dispatch, the shop’s "processing" echo keeps it dispatched and its "completed" finishes it', async () => {
    const o = await readyOrder(t, [[sku, 1, '200.00']]);
    await pickAndPack(t.cookie, o.id);
    expect((await dispatchOrder(t.cookie, o.id)).status).toBe(200);
    await applyOrder(t, wooOrder({ id: o.wooId, status: 'processing', lines: [[sku, 1, '200.00']], modified: '2026-10-20T06:00:00' }));
    expect((await order(t, o.id)).status).toBe('dispatched');
    await applyOrder(t, wooOrder({ id: o.wooId, status: 'completed', lines: [[sku, 1, '200.00']], modified: '2026-10-20T07:00:00' }));
    expect((await order(t, o.id)).status).toBe('completed');
    expect(await ledgerRows(o.id)).toBe(1);
    expect((await owner.query('SELECT count(*)::int AS n FROM invoices WHERE order_id = $1', [o.id])).rows[0].n).toBe(1);
  });
});

describe('B6 fulfilment permissions and tenancy', () => {
  it('fulfilment staff do the work; cashier and inventory roles cannot; another store sees nothing', async () => {
    const t = await makeTenant();
    const sku = await skuOf(await stockedItem(t.cookie, { price: '100', stock: '10' }));
    const o = await readyOrder(t, [[sku, 1, '100.00']]);
    for (const role of ['cashier', 'inventory'] as const) {
      const u = await makeUser(t.tenantId, role);
      expect((await api(u.cookie, 'GET', '/v1/fulfilment/queue')).status).toBe(403);
      expect((await api(u.cookie, 'POST', '/v1/pick-lists', { orderIds: [o.id] })).status).toBe(403);
    }
    const staff = await makeUser(t.tenantId, 'fulfillment');
    const listId = await pickAndPack(staff.cookie, o.id);
    const other = await makeTenant();
    expect((await api(other.cookie, 'GET', `/v1/pick-lists/${listId}`)).status).toBe(404);
    expect((await dispatchOrder(other.cookie, o.id)).status).toBe(404);
    expect((await api(other.cookie, 'GET', '/v1/fulfilment/queue?stage=packed')).body.items).toEqual([]);
    const d = await dispatchOrder(staff.cookie, o.id, { carrier: 'Hand delivery' });
    expect(d.status, d.text).toBe(200);
    expect(d.body).toMatchObject({ status: 'dispatched', shipment: { carrier: 'Hand delivery', trackingNo: null }, invoiceState: 'pending' });   // billing not set up
  });
});
