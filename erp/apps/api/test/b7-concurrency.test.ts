import { describe, expect, it } from 'vitest';
import { api } from './b2-api.js';
import { makeTenant, owner } from './b2-helpers.js';
import { onHandAt, sell, setupBilling, stockedItem } from './b5-helpers.js';
import { applyOrder, dispatchOrder, ledgerRows, nextWooId, pickAndPack, readyOrder, skuOf, wooOrder } from './b6-helpers.js';

// Races the roadmap names for B7b: no double reservation, deduction or invoice number. Invoice numbering under
// simultaneous sales is in b5-pos; ledger vs balance under parallel decrements is in b3-stock.

const statuses = (rs: { status: number }[]) => rs.map((r) => r.status).sort();

describe('B7 concurrency', () => {
  it('two tills selling the last unit at the same moment: one sale, one refusal, stock 0', async () => {
    const t = await makeTenant();
    await setupBilling(t);
    const v = await stockedItem(t.cookie, { price: '50', stock: '1' });
    const rs = await Promise.all([sell(t.cookie, [{ variantId: v, qty: '1' }]), sell(t.cookie, [{ variantId: v, qty: '1' }])]);
    expect(statuses(rs)).toEqual([201, 409]);
    expect(Number(await onHandAt(v))).toBe(0);
    expect((await owner.query('SELECT count(*)::int AS n FROM invoices WHERE tenant_id = $1', [t.tenantId])).rows[0].n).toBe(1);
  });

  it('a web order and a till racing for the last unit: never both', async () => {
    const t = await makeTenant();
    await setupBilling(t);
    const v = await stockedItem(t.cookie, { price: '50', stock: '1' });
    const sku = await skuOf(v);
    const [web, till] = await Promise.all([
      applyOrder(t, wooOrder({ id: nextWooId(), status: 'processing', lines: [[sku, 1, '50.00']] })).then((r) => r.orderId as string),
      sell(t.cookie, [{ variantId: v, qty: '1' }]),
    ]);
    const order = (await owner.query('SELECT status FROM sales_orders WHERE id = $1', [web])).rows[0].status;
    const held = order === 'ready_to_pick';
    expect(held ? till.status : 201).toBe(held ? 409 : 201);
    if (!held) expect(order).toBe('stock_exception');
    expect(Number(await onHandAt(v))).toBe(held ? 1 : 0);
  });

  it('two people dispatching the same order at once (different requests): stock leaves once, one invoice', async () => {
    const t = await makeTenant();
    await setupBilling(t);
    const v = await stockedItem(t.cookie, { price: '50', stock: '3' });
    const o = await readyOrder(t, [[await skuOf(v), 2, '100.00']]);
    await pickAndPack(t.cookie, o.id);
    const rs = await Promise.all([dispatchOrder(t.cookie, o.id), dispatchOrder(t.cookie, o.id), dispatchOrder(t.cookie, o.id)]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.every((r) => r.status === 200 || r.status === 409), JSON.stringify(rs.map((r) => r.text))).toBe(true);
    expect(await ledgerRows(o.id)).toBe(1);
    expect((await owner.query('SELECT count(*)::int AS n FROM shipments WHERE order_id = $1', [o.id])).rows[0].n).toBe(1);
    expect((await owner.query('SELECT count(*)::int AS n FROM invoices WHERE order_id = $1', [o.id])).rows[0].n).toBe(1);
    expect(Number(await onHandAt(v))).toBe(1);
  });

  it('the same order put on two pick lists at once: only one list gets it', async () => {
    const t = await makeTenant();
    const v = await stockedItem(t.cookie, { price: '50', stock: '3' });
    const o = await readyOrder(t, [[await skuOf(v), 1, '50.00']]);
    const rs = await Promise.all([1, 2, 3].map(() => api(t.cookie, 'POST', '/v1/pick-lists', { orderIds: [o.id] })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await owner.query("SELECT count(*)::int AS n FROM pick_list_lines WHERE order_id = $1 AND state = 'active'", [o.id])).rows[0].n).toBe(1);
  });

  it('two payments recorded for one store at once extend its paid period twice, never lose one', async () => {
    const { adminSession } = await import('./b7-helpers.js');
    const s = await adminSession();
    const t = await makeTenant();
    const pay = (ref: string) => api(s.cookie, 'POST', `/v1/platform/tenants/${t.tenantId}/payments`,
      { amountPaise: 99900, method: 'upi', reference: ref, paidOn: '2026-10-20', planId: 'starter', months: 1 });
    const rs = await Promise.all([pay(`C1-${Date.now()}`), pay(`C2-${Date.now()}`)]);
    expect(statuses(rs)).toEqual([201, 201]);
    const { rows: [sub] } = await owner.query('SELECT paid_until FROM subscriptions WHERE tenant_id = $1', [t.tenantId]);
    expect(new Date(sub.paid_until).getTime()).toBeGreaterThan(Date.now() + 58 * 86_400_000);
  });
});
