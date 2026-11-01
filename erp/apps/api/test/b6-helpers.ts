import { expect } from 'vitest';
import { tenantTx } from '../src/db.js';
import { applyWooOrder, type WooOrder } from '../src/modules/sales/woo-orders.js';
import { api } from './b2-api.js';
import { owner } from './b2-helpers.js';
import { key, locations } from './b3-helpers.js';

export type T = { tenantId: string; cookie: string };
let seq = 60_000 + Math.floor(Math.random() * 10_000) * 10;
export const nextWooId = () => ++seq;

/** A WooCommerce order as its REST API / webhook sends it (the fields B4 reads). Lines: [sku, qty, line total]. */
export function wooOrder(o: { id: number; status: string; lines: [string, number, string][]; modified?: string; state?: string }): WooOrder {
  const total = o.lines.reduce((a, l) => a + Number(l[2]), 0).toFixed(2);
  return {
    id: o.id, number: String(o.id), status: o.status, currency: 'INR', customer_id: 0,
    date_created_gmt: '2026-10-20T05:00:00', date_modified_gmt: o.modified ?? '2026-10-20T05:00:00', date_paid_gmt: '2026-10-20T05:00:00',
    payment_method: 'razorpay', total, total_tax: '0', shipping_total: '0', discount_total: '0',
    billing: { first_name: 'Asha', last_name: 'Rao', phone: '9876543210', address_1: '4 Church St', city: 'Pune', state: o.state ?? 'MH', postcode: '411001', country: 'IN' },
    shipping: { first_name: 'Asha', last_name: 'Rao', address_1: '4 Church St', city: 'Pune', state: o.state ?? 'MH', postcode: '411001', country: 'IN' },
    line_items: o.lines.map(([sku, qty, lineTotal], i) => ({ id: i + 1, product_id: 1, variation_id: 0, sku, name: `Item ${sku}`, quantity: qty, price: Number(lineTotal) / qty, total: lineTotal, total_tax: '0' })),
  };
}

/** Apply an order the way a webhook would (B4's applyWooOrder), shipping from the shop floor. */
export async function applyOrder(t: T, order: WooOrder) {
  const { shop } = await locations(t.cookie);
  return tenantTx(t.tenantId, (tx) => applyWooOrder(tx, shop, order));
}

/** A paid ("processing") web order, ready to pick. Returns its ERP id. */
export async function readyOrder(t: T, lines: [string, number, string][], id = nextWooId()) {
  const r = await applyOrder(t, wooOrder({ id, status: 'processing', lines }));
  const o = (await api(t.cookie, 'GET', `/v1/orders/${r.orderId}`)).body;
  expect(o.status, JSON.stringify(o)).toBe('ready_to_pick');
  return { id: r.orderId as string, wooId: id };
}

export const skuOf = async (variantId: string) => (await owner.query('SELECT sku FROM product_variants WHERE id = $1', [variantId])).rows[0].sku as string;

/** Pick list → scan every line → pack exactly. Leaves the order packed. */
export async function pickAndPack(cookie: string, orderId: string) {
  const list = await api(cookie, 'POST', '/v1/pick-lists', { orderIds: [orderId] });
  expect(list.status, list.text).toBe(201);
  for (const l of list.body.lines) {
    const r = await api(cookie, 'PATCH', `/v1/pick-lists/${list.body.id}/lines/${l.id}`, { qtyPicked: l.qtyRequired });
    expect(r.status, r.text).toBe(200);
  }
  const o = (await api(cookie, 'GET', `/v1/orders/${orderId}`)).body;
  const packed = await api(cookie, 'POST', `/v1/orders/${orderId}/pack`, { lines: o.lines.map((l: any) => ({ lineId: l.id, qty: l.qty })) });
  expect(packed.status, packed.text).toBe(200);
  return list.body.id as string;
}

export const dispatchOrder = (cookie: string, orderId: string, body: Record<string, unknown> = { carrier: 'Delhivery', trackingNo: 'DLV123456' }, k = key()) =>
  api(cookie, 'POST', `/v1/orders/${orderId}/dispatch`, body, k);

export const ledgerRows = async (orderId: string) =>
  (await owner.query("SELECT count(*)::int AS n FROM stock_ledger WHERE source_id = $1 AND movement_type = 'dispatch'", [orderId])).rows[0].n as number;
