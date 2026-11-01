import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, tenantTx } from '../src/db.js';
import { applyWooOrder, type WooOrder } from '../src/modules/sales/woo-orders.js';
import { api } from './b2-api.js';
import { makeTenant, makeUser, owner } from './b2-helpers.js';
import { key, locations } from './b3-helpers.js';
import { setupBilling, stockedItem } from './b5-helpers.js';

afterAll(async () => { await owner.end(); await pool.end(); });

type T = Awaited<ReturnType<typeof makeTenant>>;
let seq = 7000;

/** A WooCommerce order as its REST API / webhook sends it (the fields B4 reads). */
function wooOrder(o: { id: number; status: string; sku: string; qty: number; lineTotal: string; lineTax?: string; shipping?: string; total: string; state?: string; country?: string; modified?: string }): WooOrder {
  return {
    id: o.id, number: String(o.id), status: o.status, currency: 'INR', customer_id: 0,
    date_created_gmt: '2026-10-20T05:00:00', date_modified_gmt: o.modified ?? '2026-10-20T05:00:00', date_paid_gmt: '2026-10-20T05:00:00',
    payment_method: 'razorpay', total: o.total, total_tax: o.lineTax ?? '0', shipping_total: o.shipping ?? '0', discount_total: '0',
    billing: { first_name: 'Asha', last_name: 'Rao', email: 'asha@example.com', phone: '9876543210', address_1: '4 Church St', city: 'Bengaluru', state: o.state ?? 'KA', postcode: '560001', country: o.country ?? 'IN' },
    shipping: { first_name: 'Asha', last_name: 'Rao', address_1: '4 Church St', city: 'Bengaluru', state: o.state ?? 'KA', postcode: '560001', country: o.country ?? 'IN' },
    line_items: [{ id: 1, product_id: 1, variation_id: 0, sku: o.sku, name: 'Kurta', quantity: o.qty, price: Number(o.lineTotal) / o.qty, total: o.lineTotal, total_tax: o.lineTax ?? '0' }],
  };
}

async function apply(t: T, order: WooOrder) {
  const { shop } = await locations(t.cookie);
  return tenantTx(t.tenantId, (tx) => applyWooOrder(tx, shop, order));
}

const skuOf = async (variantId: string) => (await owner.query('SELECT sku FROM product_variants WHERE id = $1', [variantId])).rows[0].sku as string;

describe('B5 invoices for web orders', () => {
  let t: T;
  let v: string, sku: string;
  beforeAll(async () => {
    t = await makeTenant();
    await setupBilling(t);                         // seller in Maharashtra (27)
    v = await stockedItem(t.cookie, { price: '1180', gstRate: '18', hsn: '6211', stock: '20' });
    sku = await skuOf(v);
  });

  it('completing a web order to another state issues an IGST invoice for exactly what the customer paid, shipping included', async () => {
    const id = ++seq;
    await apply(t, wooOrder({ id, status: 'processing', sku, qty: 2, lineTotal: '2360.00', shipping: '118.00', total: '2478.00' }));
    const r = await apply(t, wooOrder({ id, status: 'completed', sku, qty: 2, lineTotal: '2360.00', shipping: '118.00', total: '2478.00', modified: '2026-10-20T06:00:00' }));
    const order = (await api(t.cookie, 'GET', `/v1/orders/${r.orderId}`)).body;
    expect(order).toMatchObject({ status: 'completed', invoiceState: 'issued', documents: [{ type: 'invoice' }] });
    const inv = (await api(t.cookie, 'GET', `/v1/invoices/${order.documents[0].id}`)).body;
    expect(inv).toMatchObject({
      supplyType: 'inter', placeOfSupply: { code: '29', name: 'Karnataka' }, taxableTotal: '2100.00', igst: '378.00', cgst: '0.00', roundOff: '0.00', total: '2478.00',
      buyer: { name: 'Asha Rao', stateCode: '29' }, issuedBy: null,
    });
    expect(inv.lines.map((l: any) => [l.kind, l.description, l.qty, l.taxableValue, l.igst, l.gstRate, l.hsnCode])).toEqual([
      ['item', 'Kurta', '2', '2000.00', '360.00', '18', '6211'], ['shipping', 'Shipping and handling', '1', '100.00', '18.00', '18', '6211']]);
  });

  it('delivery in the shop’s own state is CGST + SGST; a replayed completion issues nothing new', async () => {
    const id = ++seq;
    const body = { id, sku, qty: 1, lineTotal: '1180.00', total: '1180.00', state: 'MH' };
    await apply(t, wooOrder({ ...body, status: 'processing' }));
    await apply(t, wooOrder({ ...body, status: 'completed', modified: '2026-10-20T06:00:00' }));
    await apply(t, wooOrder({ ...body, status: 'completed', modified: '2026-10-20T07:00:00' }));
    const { rows } = await owner.query(
      `SELECT i.supply_type, i.cgst::text, i.sgst::text FROM invoices i JOIN sales_orders o ON o.id = i.order_id WHERE o.tenant_id = $1 AND o.external_id = $2`, [t.tenantId, String(id)]);
    expect(rows).toEqual([{ supply_type: 'intra', cgst: '90.00', sgst: '90.00' }]);
  });

  it('an address the ERP cannot place waits for a person, who picks the state and issues it', async () => {
    const id = ++seq;
    const body = { id, sku, qty: 1, lineTotal: '1180.00', total: '1180.00', state: 'Somewhere' };
    await apply(t, wooOrder({ ...body, status: 'processing' }));
    const r = await apply(t, wooOrder({ ...body, status: 'completed', modified: '2026-10-20T06:00:00' }));
    const before = (await api(t.cookie, 'GET', `/v1/orders/${r.orderId}`)).body;
    expect(before).toMatchObject({ status: 'completed', invoiceState: 'pending', invoiceNote: expect.stringMatching(/not a GST state/), documents: [] });
    const cashier = await makeUser(t.tenantId, 'cashier');
    expect((await api(cashier.cookie, 'POST', `/v1/orders/${r.orderId}/invoice`, {})).status).toBe(403);
    const fulfil = await makeUser(t.tenantId, 'fulfillment');
    expect((await api(fulfil.cookie, 'POST', `/v1/orders/${r.orderId}/invoice`, {})).status).toBe(403);
    const res = await api(t.cookie, 'POST', `/v1/orders/${r.orderId}/invoice`, { placeOfSupply: '33' });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ invoiceState: 'issued', documents: [{ type: 'invoice' }] });
    expect((await api(t.cookie, 'POST', `/v1/orders/${r.orderId}/invoice`, {})).status).toBe(409);   // stays one invoice
  });

  it('a web order returned after delivery gets a credit note like a counter sale', async () => {
    const id = ++seq;
    const body = { id, sku, qty: 1, lineTotal: '1180.00', total: '1180.00', state: 'KA' };
    await apply(t, wooOrder({ ...body, status: 'processing' }));
    const r = await apply(t, wooOrder({ ...body, status: 'completed', modified: '2026-10-20T06:00:00' }));
    const order = (await api(t.cookie, 'GET', `/v1/orders/${r.orderId}`)).body;
    const inv = (await api(t.cookie, 'GET', `/v1/invoices/${order.documents[0].id}`)).body;
    const res = await api(t.cookie, 'POST', '/v1/returns', { invoiceId: inv.id, reason: 'Courier return', refundMethod: 'original', lines: [{ invoiceLineId: inv.lines[0].id, qty: '1', condition: 'resellable' }] }, key());
    expect(res.status, res.text).toBe(201);
    expect(res.body.creditNote).toMatchObject({ igst: '180.00', total: '1180.00' });
  });
});

describe('B5 web-order invoices: settings', () => {
  it('when billing is not set up, completion still takes the stock and the invoice waits', async () => {
    const t = await makeTenant();
    const v = await stockedItem(t.cookie, { price: '100', gstRate: '5', stock: '5' });
    const sku = await skuOf(v);
    const id = ++seq;
    await apply(t, wooOrder({ id, status: 'processing', sku, qty: 1, lineTotal: '100.00', total: '100.00' }));
    const r = await apply(t, wooOrder({ id, status: 'completed', sku, qty: 1, lineTotal: '100.00', total: '100.00', modified: '2026-10-20T06:00:00' }));
    const o = (await api(t.cookie, 'GET', `/v1/orders/${r.orderId}`)).body;
    expect(o).toMatchObject({ status: 'completed', invoiceState: 'pending', invoiceNote: expect.stringMatching(/GST registration/) });
    expect((await owner.query("SELECT count(*)::int AS n FROM stock_ledger WHERE source_id = $1 AND movement_type = 'dispatch'", [r.orderId])).rows[0].n).toBe(1);
    await setupBilling(t);
    const res = await api(t.cookie, 'POST', `/v1/orders/${r.orderId}/invoice`, {});
    expect(res.body.invoiceState).toBe('issued');
  });

  it('a store whose WooCommerce plugin makes the invoices can turn ERP web invoices off', async () => {
    const t = await makeTenant();
    await setupBilling(t, { patch: { invoiceWebOrders: false } });
    const v = await stockedItem(t.cookie, { price: '100', gstRate: '5', stock: '5' });
    const sku = await skuOf(v);
    const id = ++seq;
    await apply(t, wooOrder({ id, status: 'processing', sku, qty: 1, lineTotal: '100.00', total: '100.00' }));
    const r = await apply(t, wooOrder({ id, status: 'completed', sku, qty: 1, lineTotal: '100.00', total: '100.00', modified: '2026-10-20T06:00:00' }));
    expect((await api(t.cookie, 'GET', `/v1/orders/${r.orderId}`)).body).toMatchObject({ invoiceState: 'not_needed', documents: [] });
  });
});
