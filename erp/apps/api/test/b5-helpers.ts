import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { financialYear, localDate } from '../src/lib/gst.js';
import { api } from './b2-api.js';
import { owner } from './b2-helpers.js';
import { adjust, key, locations } from './b3-helpers.js';

const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A GSTIN with a correct check digit: state code + PAN-like part + entity number + Z + check. */
export function gstin(state: string, pan = 'AAPFU0939F', entity = '1') {
  const body = `${state}${pan}${entity}Z`;
  let sum = 0;
  for (let i = 0; i < 14; i++) { const p = B36.indexOf(body[i]) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + (p % 36); }
  return body + B36[(36 - (sum % 36)) % 36];
}

export const FY = () => financialYear(localDate(new Date(), 'Asia/Kolkata'));
export const invNo = (n: number, base = 'INV') => `${base}/${FY().slice(2)}/${n}`;

/**
 * Billing set up for a store: GSTIN and address go where Phase 1 keeps them (store_settings; written directly here, as
 * Phase 1's settings form would), the registration type through B5's own route.
 */
/** Billing ready to sell. Registers are off unless a test turns them on (v2 phase 3 tests do). */
export async function setupBilling(t: { tenantId: string; cookie: string }, o: { scheme?: 'regular' | 'composition' | 'unregistered'; gstin?: string | null; stateCode?: string; patch?: Record<string, unknown> } = {}) {
  const scheme = o.scheme ?? 'regular';
  const g = o.gstin === undefined ? (scheme === 'unregistered' ? null : gstin('27')) : o.gstin;
  await owner.query(
    `INSERT INTO store_settings (tenant_id, address, city, state, postal_code, gstin) VALUES ($1, '12 MG Road', 'Pune', 'Maharashtra', '411001', $2)
     ON CONFLICT (tenant_id) DO UPDATE SET address = EXCLUDED.address, city = EXCLUDED.city, state = EXCLUDED.state, postal_code = EXCLUDED.postal_code, gstin = EXCLUDED.gstin`,
    [t.tenantId, g]);
  const res = await api(t.cookie, 'PATCH', '/v1/billing/settings', { gstScheme: scheme, requireRegister: false, ...(o.stateCode ? { stateCode: o.stateCode } : {}), ...(o.patch ?? {}) });
  expect(res.status, res.text).toBe(200);
  return res.body;
}

/** An active product at a GST rate with stock on the shop floor. Returns its variant id. */
export async function stockedItem(cookie: string, o: { price: string; gstRate?: string | null; hsn?: string | null; mrp?: string; stock?: string; unitCode?: string } ) {
  const sku = `B5-${randomUUID().slice(0, 8)}`;
  const res = await api(cookie, 'POST', '/v1/products', {
    name: `Item ${sku}`, type: 'simple', status: 'active', unitCode: o.unitCode ?? 'NOS',
    gstRate: o.gstRate === undefined ? '18' : o.gstRate, hsnCode: o.hsn === undefined ? '6109' : o.hsn,
    variants: [{ sku, price: o.price, ...(o.mrp ? { mrp: o.mrp } : {}) }],
  });
  expect(res.status, res.text).toBe(201);
  const id = res.body.variants[0].id as string;
  if (o.stock !== '0') {
    const { shop } = await locations(cookie);
    const a = await adjust(cookie, shop, 'correction', [{ variantId: id, qtyDelta: o.stock ?? '10' }], { note: 'B5 test stock' });
    expect(a.status, a.text).toBe(201);
  }
  return id;
}

type Line = { variantId: string; qty: string; discountPct?: string; discountAmount?: string; discountReason?: string; unitPriceOverride?: string };

/**
 * Quote, then sell for exactly the quoted total (cash, unless payments are given). Without a customer the bill is marked
 * Walk-in, as the cashier would (v2 phase 2: every counter bill names its customer or is Walk-in).
 */
export async function sell(cookie: string, lines: Line[], extra: Record<string, unknown> = {}, payments?: { method: string; amount: string; reference?: string }[]) {
  if (!extra.customerId && extra.walkIn === undefined) extra = { ...extra, walkIn: true };
  const { tillId: _till, ...cart } = extra;   // the till is for the sale (v2 phase 3), not the quote
  const q = await api(cookie, 'POST', '/v1/pos/quote', { lines, ...cart });
  if (q.status !== 200) return q;
  return api(cookie, 'POST', '/v1/pos/sales', { lines, ...extra, expectedTotal: q.body.total, payments: payments ?? [{ method: 'cash', amount: q.body.total }] }, key());
}

export async function onHandAt(variantId: string, bucket: 'on_hand' | 'non_sellable' = 'on_hand') {
  const { rows } = await owner.query(`SELECT coalesce(sum(${bucket}), 0)::text AS q FROM stock_balances WHERE variant_id = $1`, [variantId]);
  return rows[0].q.replace(/\.?0+$/, '') || '0';
}
