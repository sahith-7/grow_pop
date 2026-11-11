import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { api } from './b2-api.js';
import { makeTenant, makeUser, owner } from './b2-helpers.js';
import { key, locations } from './b3-helpers.js';
import { FY, gstin, invNo, onHandAt, sell, setupBilling, stockedItem } from './b5-helpers.js';

afterAll(async () => { await owner.end(); await pool.end(); });

type T = Awaited<ReturnType<typeof makeTenant>>;

describe('B5 POS: before billing is set up', () => {
  it('refuses to sell and says what is missing', async () => {
    const t = await makeTenant();
    const v = await stockedItem(t.cookie, { price: '100' });
    const ctx = await api(t.cookie, 'GET', '/v1/pos/context');
    expect(ctx.body.ready).toBe(false);
    expect(ctx.body.problems.join(' ')).toMatch(/GST registration/);
    const q = await api(t.cookie, 'POST', '/v1/pos/quote', { lines: [{ variantId: v, qty: '1' }] });
    expect([q.status, q.body.code]).toEqual([409, 'BILLING_NOT_SET_UP']);
    // Registered without a GSTIN in Settings is still not ready.
    await setupBilling(t, { gstin: null });
    expect((await api(t.cookie, 'GET', '/v1/pos/context')).body.problems.join(' ')).toMatch(/Add your GSTIN/);
  });
});

describe('B5 POS sale (regular GST seller, prices include GST)', () => {
  let t: T;
  let shirt: string, rice: string;
  beforeAll(async () => {
    t = await makeTenant();
    await setupBilling(t);
    shirt = await stockedItem(t.cookie, { price: '1180', gstRate: '18', mrp: '1300' });
    rice = await stockedItem(t.cookie, { price: '105', gstRate: '5', hsn: '1006' });
  });

  it('prices the cart on the server, then posts stock, invoice and payment in one go', async () => {
    const q = await api(t.cookie, 'POST', '/v1/pos/quote', { lines: [{ variantId: shirt, qty: '1' }, { variantId: rice, qty: '2' }] });
    expect(q.status, q.text).toBe(200);
    expect(q.body).toMatchObject({
      docKind: 'tax_invoice', subtotal: '1390.00', taxableTotal: '1200.00', taxBreakdown: { cgst: '95.00', sgst: '95.00', igst: '0.00' }, roundOff: '0.00', total: '1390.00',
    });
    expect(q.body.lines[0]).toMatchObject({ taxableValue: '1000.00', tax: '180.00', gstRate: '18', available: '10' });

    const res = await api(t.cookie, 'POST', '/v1/pos/sales', {
      walkIn: true, lines: [{ variantId: shirt, qty: '1' }, { variantId: rice, qty: '2' }], expectedTotal: '1390.00',
      payments: [{ method: 'upi', amount: '390', reference: 'UPI-77' }, { method: 'cash', amount: '1500' }],
    }, key());
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ invoiceNumber: invNo(1), orderNumber: invNo(1), total: '1390.00', change: '500.00' });
    const inv = res.body.invoice;
    expect(inv).toMatchObject({
      title: 'Tax Invoice', financialYear: FY(), placeOfSupply: { code: '27', name: 'Maharashtra' }, supplyType: 'intra', stateTaxLabel: 'SGST',
      taxableTotal: '1200.00', cgst: '95.00', sgst: '95.00', igst: '0.00', total: '1390.00', totalInWords: 'Rupees One Thousand Three Hundred Ninety Only',
    });
    expect(inv.seller).toMatchObject({ gstin: gstin('27'), address: '12 MG Road', stateCode: '27' });
    expect(inv.lines.map((l: any) => [l.hsnCode, l.uqc, l.qty, l.taxableValue, l.cgst, l.sgst])).toEqual([['6109', 'NOS', '1', '1000.00', '90.00', '90.00'], ['1006', 'NOS', '2', '200.00', '5.00', '5.00']]);
    expect(inv.payments.map((p: any) => [p.method, p.amount, p.tendered])).toEqual([['upi', '390.00', null], ['cash', '1000.00', '1500.00']]);
    expect([await onHandAt(shirt), await onHandAt(rice)]).toEqual(['9', '8']);
    const { rows } = await owner.query("SELECT movement_type, qty_delta::text FROM stock_ledger WHERE source_type = 'sales_order' AND source_id = $1 ORDER BY seq", [res.body.orderId]);
    expect(rows).toEqual([{ movement_type: 'sale', qty_delta: '-1.000' }, { movement_type: 'sale', qty_delta: '-2.000' }]);
    // The sale shows in orders as a POS order.
    const o = await api(t.cookie, 'GET', `/v1/orders/${res.body.orderId}`);
    expect(o.body).toMatchObject({ channel: 'pos', status: 'completed', paymentState: 'paid', documents: [{ type: 'invoice', number: invNo(1) }] });
  });

  it('a retried request returns the same sale; the same key with another body is refused', async () => {
    const body = { walkIn: true, lines: [{ variantId: rice, qty: '1' }], expectedTotal: '105.00', payments: [{ method: 'cash', amount: '105' }] };
    const k = key();
    const a = await api(t.cookie, 'POST', '/v1/pos/sales', body, k);
    const b = await api(t.cookie, 'POST', '/v1/pos/sales', body, k);
    expect(a.status, a.text).toBe(201);
    expect(b.body.invoiceId).toBe(a.body.invoiceId);
    expect(await onHandAt(rice)).toBe('7');
    expect((await api(t.cookie, 'POST', '/v1/pos/sales', { ...body, lines: [{ variantId: rice, qty: '2' }] }, k)).status).toBe(422);
    expect((await api(t.cookie, 'POST', '/v1/pos/sales', body)).status).toBe(400);   // no key at all
  });

  it('refuses when the total changed since the cashier saw it, or payments do not cover it', async () => {
    const lines = [{ variantId: rice, qty: '1' }];
    expect((await api(t.cookie, 'POST', '/v1/pos/sales', { walkIn: true, lines, expectedTotal: '100.00', payments: [{ method: 'cash', amount: '105' }] }, key())).body.code).toBe('PRICE_CHANGED');
    expect((await api(t.cookie, 'POST', '/v1/pos/sales', { walkIn: true, lines, expectedTotal: '105.00', payments: [{ method: 'card', amount: '110' }] }, key())).body.code).toBe('PAYMENT_MISMATCH');
    const short = await api(t.cookie, 'POST', '/v1/pos/sales', { walkIn: true, lines, expectedTotal: '105.00', payments: [{ method: 'cash', amount: '100' }] }, key());
    expect([short.body.code, short.body.message]).toEqual(['PAYMENT_MISMATCH', '₹5.00 still to pay']);
  });

  it('cannot sell stock that is not there or is held for web orders, and the invoice number is not used up', async () => {
    const before = (await api(t.cookie, 'GET', '/v1/billing/series')).body.items.find((s: any) => s.docType === 'invoice').nextNumber;
    // Hold 7 of the 9 shirts for a web order (as B4's reservations do).
    const { shop } = await locations(t.cookie);
    await owner.query("UPDATE stock_balances SET reserved = 7 WHERE variant_id = $1 AND location_id = $2", [shirt, shop]);
    const q = await api(t.cookie, 'POST', '/v1/pos/quote', { lines: [{ variantId: shirt, qty: '3' }] });
    expect(q.body.shortages).toEqual([{ variantId: shirt, sku: expect.any(String), available: '2' }]);
    const res = await sell(t.cookie, [{ variantId: shirt, qty: '3' }]);
    expect([res.status, res.body.code]).toEqual([409, 'INSUFFICIENT_STOCK']);
    await owner.query("UPDATE stock_balances SET reserved = 0 WHERE variant_id = $1 AND location_id = $2", [shirt, shop]);
    const after = (await api(t.cookie, 'GET', '/v1/billing/series')).body.items.find((s: any) => s.docType === 'invoice').nextNumber;
    expect(after).toBe(before);
  });

  it('numbers invoices consecutively with no gaps, even for sales at the same moment', async () => {
    const first = (await api(t.cookie, 'GET', '/v1/billing/series')).body.items.find((s: any) => s.docType === 'invoice').nextNumber;
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => sell(t.cookie, [{ variantId: rice, qty: '1' }])));
    for (const r of results) expect(r.status, r.text).toBe(201);
    expect(results.map((r) => r.body.invoiceNumber).sort()).toEqual([0, 1, 2, 3, 4].map((i) => invNo(first + i)).sort());
  });

  it('rounds the bill to the rupee and shows the round-off', async () => {
    const odd = await stockedItem(t.cookie, { price: '99.50', gstRate: '18' });
    const res = await sell(t.cookie, [{ variantId: odd, qty: '1' }]);
    expect(res.body.invoice).toMatchObject({ roundOff: '0.50', total: '100.00' });
  });

  it('a counter sale to a buyer registered in another state is still CGST + SGST (place of supply is the shop)', async () => {
    const c = await api(t.cookie, 'POST', '/v1/customers', { name: 'Acme Traders', phone: '9800000001', gstin: gstin('29', 'AABCA1234Z'), address: '5 Brigade Rd, Bengaluru' });
    expect(c.status, c.text).toBe(201);
    expect(c.body.stateCode).toBe('29');
    const res = await sell(t.cookie, [{ variantId: shirt, qty: '1' }], { customerId: c.body.id });
    expect(res.status, res.text).toBe(201);
    expect(res.body.invoice).toMatchObject({ supplyType: 'intra', placeOfSupply: { code: '27' }, cgst: '90.00', igst: '0.00', buyer: { gstin: gstin('29', 'AABCA1234Z'), name: 'Acme Traders' } });
  });

  it('a B2B invoice needs HSN codes; a bad GSTIN is refused', async () => {
    const noHsn = await stockedItem(t.cookie, { price: '50', hsn: null });
    const c = await api(t.cookie, 'POST', '/v1/customers', { name: 'Beta Ltd', gstin: gstin('27', 'AABCB1234Z') });
    const res = await sell(t.cookie, [{ variantId: noHsn, qty: '1' }], { customerId: c.body.id });
    expect(res.status).toBe(400);
    expect(Object.values(res.body.fieldErrors).flat().join()).toMatch(/needs an HSN code/);
    const bad = await api(t.cookie, 'POST', '/v1/customers', { name: 'Typo', gstin: '27AAPFU0939F1ZA' });
    expect(bad.body.fieldErrors.gstin[0]).toMatch(/check digit/);
    // Without a GSTIN (B2C) the same item sells.
    expect((await sell(t.cookie, [{ variantId: noHsn, qty: '1' }])).status).toBe(201);
  });

  it('a bill of ₹50,000 or more to an unregistered buyer needs their name, address and state', async () => {
    const tv = await stockedItem(t.cookie, { price: '55000', gstRate: '18' });
    const res = await sell(t.cookie, [{ variantId: tv, qty: '1' }]);
    expect([res.status, res.body.code]).toEqual([400, 'CUSTOMER_DETAILS_REQUIRED']);
    const c = await api(t.cookie, 'POST', '/v1/customers', { name: 'R. Kumar', phone: '9800000002', address: '9 FC Road, Pune', stateCode: '27' });
    expect((await sell(t.cookie, [{ variantId: tv, qty: '1' }], { customerId: c.body.id })).status).toBe(201);
  });

  it('refuses items without a GST rate, and archived or draft items', async () => {
    const noRate = await stockedItem(t.cookie, { price: '10', gstRate: null });
    const res = await api(t.cookie, 'POST', '/v1/pos/quote', { lines: [{ variantId: noRate, qty: '1' }] });
    expect(res.body.fieldErrors['lines.0.variantId'][0]).toMatch(/Set a GST rate/);
  });

  it('mixes taxable and exempt goods on one Tax Invoice-cum-Bill of Supply', async () => {
    const milk = await stockedItem(t.cookie, { price: '30', gstRate: '0', hsn: '0401' });
    const res = await sell(t.cookie, [{ variantId: milk, qty: '1' }, { variantId: rice, qty: '1' }]);
    expect(res.body.invoice).toMatchObject({ docKind: 'invoice_cum_bos', title: 'Tax Invoice-cum-Bill of Supply' });
    const onlyMilk = await sell(t.cookie, [{ variantId: milk, qty: '2' }]);
    expect(onlyMilk.body.invoice).toMatchObject({ docKind: 'bill_of_supply', cgst: '0.00', total: '60.00' });
  });

  it('the owner can set the series before the year’s first invoice, never after', async () => {
    const t2 = await makeTenant();
    await setupBilling(t2);
    const mgr = await makeUser(t2.tenantId, 'manager');
    expect((await api(mgr.cookie, 'POST', '/v1/billing/series', { docType: 'invoice', financialYear: FY(), prefix: 'SHOP-', startAt: 501 })).status).toBe(403);
    const long = await api(t2.cookie, 'POST', '/v1/billing/series', { docType: 'invoice', financialYear: FY(), prefix: 'ABCDEFGHIJKL', startAt: 123456 });
    expect(long.status).toBe(400);
    const set = await api(t2.cookie, 'POST', '/v1/billing/series', { docType: 'invoice', financialYear: FY(), prefix: 'SHOP-', startAt: 501 });
    expect(set.status, set.text).toBe(200);
    const v = await stockedItem(t2.cookie, { price: '10' });
    expect((await sell(t2.cookie, [{ variantId: v, qty: '1' }])).body.invoiceNumber).toBe('SHOP-501');
    expect((await sell(t2.cookie, [{ variantId: v, qty: '1' }])).body.invoiceNumber).toBe('SHOP-502');
    const again = await api(t2.cookie, 'POST', '/v1/billing/series', { docType: 'invoice', financialYear: FY(), prefix: 'X-', startAt: 1 });
    expect([again.status, again.body.code]).toEqual([409, 'SERIES_IN_USE']);
  });
});

describe('B5 POS discounts and price changes', () => {
  let t: T;
  let v: string;
  let cashier: { cookie: string }, manager: { cookie: string }, inventory: { cookie: string };
  beforeAll(async () => {
    t = await makeTenant();
    await setupBilling(t, { patch: { cashierDiscountLimitPct: '10', managerDiscountLimitPct: '50', discountReasonThresholdPct: '5' } });
    v = await stockedItem(t.cookie, { price: '1000', gstRate: '18', mrp: '1200', stock: '50' });
    cashier = await makeUser(t.tenantId, 'cashier');
    manager = await makeUser(t.tenantId, 'manager');
    inventory = await makeUser(t.tenantId, 'inventory');
  });

  it('a cashier gives a small discount freely, needs a reason above the threshold, and is stopped at their limit', async () => {
    const small = await sell(cashier.cookie, [{ variantId: v, qty: '1', discountPct: '5' }]);
    expect(small.status, small.text).toBe(201);
    expect(small.body.invoice.lines[0]).toMatchObject({ gross: '1000.00', discount: '50.00', taxableValue: '805.08' });
    const noReason = await api(cashier.cookie, 'POST', '/v1/pos/quote', { lines: [{ variantId: v, qty: '1', discountPct: '8' }] });
    expect(noReason.body.fieldErrors['lines.0.discountReason'][0]).toMatch(/reason/);
    const ok = await sell(cashier.cookie, [{ variantId: v, qty: '1', discountPct: '8', discountReason: 'Shop-soiled' }]);
    expect(ok.status).toBe(201);
    // Line 8% then cart 5% = 12.6% combined: over the cashier's 10%.
    const over = await api(cashier.cookie, 'POST', '/v1/pos/quote', { lines: [{ variantId: v, qty: '1', discountPct: '8' }], cartDiscountPct: '5', cartDiscountReason: 'Regular' });
    expect([over.status, over.body.code]).toEqual([403, 'DISCOUNT_LIMIT']);
    expect((await sell(manager.cookie, [{ variantId: v, qty: '1', discountPct: '8' }], { cartDiscountPct: '5', cartDiscountReason: 'Regular' })).status).toBe(201);
    const { rows } = await owner.query("SELECT summary FROM audit_events WHERE tenant_id = $1 AND action = 'pos.discount_or_override' ORDER BY id", [t.tenantId]);
    expect(rows.map((r) => r.summary.lines[0].reason)).toEqual(['Shop-soiled', 'Regular']);
  });

  it('only owner and manager change prices, never above MRP', async () => {
    expect((await api(cashier.cookie, 'POST', '/v1/pos/quote', { lines: [{ variantId: v, qty: '1', unitPriceOverride: '900' }] })).status).toBe(403);
    const above = await api(manager.cookie, 'POST', '/v1/pos/quote', { lines: [{ variantId: v, qty: '1', unitPriceOverride: '1250' }] });
    expect(above.body.fieldErrors['lines.0.unitPriceOverride'][0]).toMatch(/MRP/);
    const ok = await sell(manager.cookie, [{ variantId: v, qty: '1', unitPriceOverride: '900' }]);
    expect(ok.body.invoice.lines[0]).toMatchObject({ unitPrice: '900.00', lineTotal: '900.00' });
    // The same price as the catalogue is not an override.
    expect((await api(cashier.cookie, 'POST', '/v1/pos/quote', { lines: [{ variantId: v, qty: '1', unitPriceOverride: '1000.00' }] })).status).toBe(200);
  });

  it('the inventory role cannot use the POS', async () => {
    expect((await api(inventory.cookie, 'GET', '/v1/pos/context')).status).toBe(403);
    expect((await api(inventory.cookie, 'POST', '/v1/pos/quote', { lines: [{ variantId: v, qty: '1' }] })).status).toBe(403);
  });
});

describe('B5 other GST set-ups', () => {
  it('prices before GST: tax is added on top', async () => {
    const t = await makeTenant();
    await setupBilling(t, { patch: { pricesIncludeTax: false } });
    const v = await stockedItem(t.cookie, { price: '100', gstRate: '18' });
    const res = await sell(t.cookie, [{ variantId: v, qty: '1' }]);
    expect(res.body.invoice).toMatchObject({ taxableTotal: '100.00', cgst: '9.00', sgst: '9.00', total: '118.00', pricesIncludeTax: false });
  });

  it('composition seller: Bill of Supply with no tax and the required declaration data', async () => {
    const t = await makeTenant();
    await setupBilling(t, { scheme: 'composition' });
    const v = await stockedItem(t.cookie, { price: '100', gstRate: '18' });
    const res = await sell(t.cookie, [{ variantId: v, qty: '2' }]);
    expect(res.body.invoice).toMatchObject({ docKind: 'bill_of_supply', gstScheme: 'composition', taxableTotal: '200.00', cgst: '0.00', total: '200.00' });
  });

  it('seller not registered: a plain Bill, no GSTIN, no tax; needs the state chosen', async () => {
    const t = await makeTenant();
    const s = await setupBilling(t, { scheme: 'unregistered' });
    expect(s.problems.join(' ')).toMatch(/Choose your state/);
    await api(t.cookie, 'PATCH', '/v1/billing/settings', { stateCode: '33' });
    const v = await stockedItem(t.cookie, { price: '100', gstRate: '18' });
    const res = await sell(t.cookie, [{ variantId: v, qty: '1' }]);
    expect(res.body.invoice).toMatchObject({ docKind: 'bill', title: 'Bill', total: '100.00', seller: { gstin: null, stateCode: '33' } });
  });

  it('a seller in a union territory without a legislature charges UTGST', async () => {
    const t = await makeTenant();
    await setupBilling(t, { gstin: gstin('04') });
    const v = await stockedItem(t.cookie, { price: '118', gstRate: '18' });
    const res = await sell(t.cookie, [{ variantId: v, qty: '1' }]);
    expect(res.body.invoice).toMatchObject({ stateTaxLabel: 'UTGST', placeOfSupply: { code: '04', name: 'Chandigarh' }, sgst: '9.00' });
  });

  it('only the owner changes billing settings, and changes are audited', async () => {
    const t = await makeTenant();
    await setupBilling(t);
    const mgr = await makeUser(t.tenantId, 'manager');
    expect((await api(mgr.cookie, 'GET', '/v1/billing/settings')).status).toBe(200);
    expect((await api(mgr.cookie, 'PATCH', '/v1/billing/settings', { roundOff: false })).status).toBe(403);
    expect((await api(t.cookie, 'PATCH', '/v1/billing/settings', { roundOff: false })).status).toBe(200);
    const { rows } = await owner.query("SELECT summary FROM audit_events WHERE tenant_id = $1 AND action = 'billing.settings_changed' ORDER BY id DESC LIMIT 1", [t.tenantId]);
    expect(rows[0].summary).toEqual({ roundOff: { from: true, to: false } });
  });
});

describe('B5 counter reads: lookup, customers, takings', () => {
  it('lookup finds by exact SKU first and shows free stock; customers are found by phone and edited; takings net off refunds', async () => {
    const t = await makeTenant();
    await setupBilling(t);
    const v = await stockedItem(t.cookie, { price: '200', gstRate: '5', stock: '7' });
    const { rows: [{ sku }] } = await owner.query('SELECT sku FROM product_variants WHERE id = $1', [v]);
    const look = await api(t.cookie, 'GET', `/v1/pos/lookup?q=${encodeURIComponent(sku)}`);
    expect(look.status, look.text).toBe(200);
    expect(look.body.items[0]).toMatchObject({ variantId: v, exact: true, available: '7', price: '200.00', gstRate: '5' });
    expect(look.body.items[0]).not.toHaveProperty('cost');

    const c = await api(t.cookie, 'POST', '/v1/customers', { name: 'Meena', phone: '9811111111' });
    expect(c.status, c.text).toBe(201);
    const found = await api(t.cookie, 'GET', '/v1/customers?q=98111');
    expect(found.body.items.map((x: any) => x.id)).toEqual([c.body.id]);
    expect((await api(t.cookie, 'GET', '/v1/customers')).status).toBe(200);
    const patched = await api(t.cookie, 'PATCH', `/v1/customers/${c.body.id}`, { address: '1 MG Road', stateCode: '27' });
    expect(patched.body).toMatchObject({ address: '1 MG Road', stateName: 'Maharashtra' });

    const sale = await sell(t.cookie, [{ variantId: v, qty: '2' }], {}, [{ method: 'cash', amount: '500' }]);
    expect(sale.status, sale.text).toBe(201);
    await api(t.cookie, 'POST', '/v1/returns', { invoiceId: sale.body.invoiceId, reason: 'One back', refundMethod: 'cash', lines: [{ invoiceLineId: sale.body.invoice.lines[0].id, qty: '1', condition: 'resellable' }] }, key());
    const s = await api(t.cookie, 'GET', '/v1/pos/summary');
    expect(s.status, s.text).toBe(200);
    expect(s.body).toMatchObject({ sales: 1, salesTotal: '400.00', methods: [{ method: 'cash', received: '400.00', refunded: '200.00', net: '200.00', payments: 1 }] });
    expect((await api(t.cookie, 'GET', '/v1/pos/summary?date=2000-01-01')).body).toMatchObject({ sales: 0, methods: [] });
    const rl = await api(t.cookie, 'GET', `/v1/returns?q=${encodeURIComponent(sale.body.invoiceNumber)}`);
    expect(rl.body.items).toHaveLength(1);
  });
});
