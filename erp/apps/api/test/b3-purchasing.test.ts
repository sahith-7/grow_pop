import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantTx } from '../src/db.js';
import { api } from './b2-api.js';
import { getApp, makeTenant, makeUser, owner } from './b2-helpers.js';
import { adjust, key, locations, makeItem, onHand } from './b3-helpers.js';

let A: Awaited<ReturnType<typeof makeTenant>>;
let B: Awaited<ReturnType<typeof makeTenant>>;
let loc: Awaited<ReturnType<typeof locations>>;
let inventory: { cookie: string };
let cashier: { cookie: string };
let supplierId: string;

beforeAll(async () => {
  A = await makeTenant();
  B = await makeTenant();
  loc = await locations(A.cookie);
  inventory = await makeUser(A.tenantId, 'inventory');
  cashier = await makeUser(A.tenantId, 'cashier');
  const s = await api(A.cookie, 'POST', '/v1/suppliers', { name: `Acme Traders ${randomUUID().slice(0, 4)}`, gstin: '27aapfu0939f1zv', phone: '9876543210' });
  expect(s.status, s.text).toBe(201);
  supplierId = s.body.id;
});
afterAll(async () => { await (await getApp()).close(); await owner.end(); });

const newPo = async (lines: { variantId: string; orderedQty: string; unitCost: string }[]) => {
  const po = await api(A.cookie, 'POST', '/v1/purchase-orders', { supplierId, expectedDate: '2026-11-01', lines });
  expect(po.status, po.text).toBe(201);
  return po.body;
};

describe('suppliers', () => {
  it('normalises GSTIN, takes the state code from it, rejects duplicates and bad GSTINs', async () => {
    const s = (await api(A.cookie, 'GET', `/v1/suppliers/${supplierId}`)).body;
    expect(s).toMatchObject({ gstin: '27AAPFU0939F1ZV', stateCode: '27', archived: false });
    expect((await api(A.cookie, 'POST', '/v1/suppliers', { name: s.name.toUpperCase() })).body.code).toBe('NAME_DUPLICATE');
    expect((await api(A.cookie, 'POST', '/v1/suppliers', { name: 'Bad GST', gstin: '12345' })).status).toBe(400);
    expect((await api(inventory.cookie, 'POST', '/v1/suppliers', { name: 'Not allowed' })).status).toBe(403);
    expect((await api(inventory.cookie, 'GET', '/v1/suppliers')).status).toBe(200);   // receivers pick suppliers
    expect((await api(cashier.cookie, 'GET', '/v1/suppliers')).status).toBe(403);
    expect((await api(B.cookie, 'GET', `/v1/suppliers/${supplierId}`)).status).toBe(404);
  });
});

describe('purchase orders (PUR-01/02)', () => {
  it('edits a draft with If-Match, then locks it after submit', async () => {
    const v1 = await makeItem(A.cookie), v2 = await makeItem(A.cookie);
    const po = await newPo([{ variantId: v1, orderedQty: '10', unitCost: '50' }]);
    expect(po).toMatchObject({ status: 'draft', total: '500.00' });
    expect(po.number).toMatch(/^PO-\d{5}$/);
    const body = { supplierId, lines: [{ variantId: v1, orderedQty: '12', unitCost: '50' }, { variantId: v2, orderedQty: '3', unitCost: '10.5' }] };
    expect((await api(A.cookie, 'PATCH', `/v1/purchase-orders/${po.id}`, body)).status).toBe(428);
    expect((await api(A.cookie, 'PATCH', `/v1/purchase-orders/${po.id}`, body, { 'if-match': '"99"' })).status).toBe(412);
    const ed = await api(A.cookie, 'PATCH', `/v1/purchase-orders/${po.id}`, body, { 'if-match': `"${po.version}"` });
    expect(ed.status, ed.text).toBe(200);
    expect(ed.body.total).toBe('631.50');
    expect((await api(A.cookie, 'POST', `/v1/purchase-orders/${po.id}/submit`)).body.status).toBe('submitted');
    expect((await api(A.cookie, 'PATCH', `/v1/purchase-orders/${po.id}`, body, { 'if-match': `"${ed.body.version + 1}"` })).body.code).toBe('INVALID_STATE');
    // The database refuses too, not only the service.
    await expect(tenantTx(A.tenantId, (t) => t.query('DELETE FROM purchase_order_lines WHERE po_id = $1', [po.id]))).rejects.toThrow(/draft/);
    expect((await api(A.cookie, 'POST', `/v1/purchase-orders/${po.id}/close`)).body.code).toBe('INVALID_STATE');
    expect((await api(A.cookie, 'POST', `/v1/purchase-orders/${po.id}/cancel`)).body.status).toBe('cancelled');
  });

  it('rejects the same item twice and fractions of whole-unit items', async () => {
    const v = await makeItem(A.cookie);
    const r = await api(A.cookie, 'POST', '/v1/purchase-orders', { supplierId, lines: [{ variantId: v, orderedQty: '1', unitCost: '1' }, { variantId: v, orderedQty: '2', unitCost: '1' }] });
    expect(r.body.fieldErrors['lines.1.variantId']).toBeDefined();
    expect((await api(A.cookie, 'POST', '/v1/purchase-orders', { supplierId, lines: [{ variantId: v, orderedQty: '0.5', unitCost: '1' }] })).status).toBe(400);
  });
});

describe('goods receipts (PUR-03/04, AC-05)', () => {
  it('AC-05: receive 8 of 10 -> sellable +8, outstanding 2; damaged goes to non-sellable; the rest closes the PO', async () => {
    const v = await makeItem(A.cookie);
    const po = await newPo([{ variantId: v, orderedQty: '10', unitCost: '40' }]);
    await api(A.cookie, 'POST', `/v1/purchase-orders/${po.id}/submit`);
    const lineId = po.lines[0].id;

    const g1 = await api(inventory.cookie, 'POST', '/v1/goods-receipts', {
      purchaseOrderId: po.id, supplierId, supplierInvoiceNo: 'INV-77',
      lines: [{ poLineId: lineId, variantId: v, locationId: loc.back, receivedQty: '9', acceptedQty: '8' }],
    }, key());
    expect(g1.status, g1.text).toBe(201);
    expect(g1.body.number).toMatch(/^GRN-\d{5}$/);
    expect((await onHand(A.cookie, v, loc.back)).onHand).toBe('8');
    expect((await onHand(A.cookie, v, loc.back)).nonSellable).toBe('1');
    expect((await onHand(A.cookie, v, loc.back)).available).toBe('8');
    let cur = (await api(A.cookie, 'GET', `/v1/purchase-orders/${po.id}`)).body;
    expect(cur.status).toBe('partial');
    expect(cur.lines[0]).toMatchObject({ orderedQty: '10', receivedQty: '9', acceptedQty: '8', outstandingQty: '2' });
    expect(cur.receipts.map((r: any) => r.number)).toEqual([g1.body.number]);

    const over = await api(inventory.cookie, 'POST', '/v1/goods-receipts', {
      purchaseOrderId: po.id, supplierId, lines: [{ poLineId: lineId, variantId: v, locationId: loc.back, receivedQty: '3', acceptedQty: '3' }],
    });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('OVER_RECEIPT');
    // Extras go on a line not tied to the PO.
    const g2 = await api(inventory.cookie, 'POST', '/v1/goods-receipts', {
      purchaseOrderId: po.id, supplierId,
      lines: [{ poLineId: lineId, variantId: v, locationId: loc.back, receivedQty: '2', acceptedQty: '2' },
              { variantId: v, locationId: loc.shop, receivedQty: '1', acceptedQty: '1', unitCost: '40' }],
    });
    expect(g2.status, g2.text).toBe(201);
    cur = (await api(A.cookie, 'GET', `/v1/purchase-orders/${po.id}`)).body;
    expect(cur.status).toBe('closed');
    expect(cur.lines[0].outstandingQty).toBe('0');
    expect((await onHand(A.cookie, v)).onHand).toBe('11');
    expect((await api(inventory.cookie, 'POST', '/v1/goods-receipts', { purchaseOrderId: po.id, supplierId, lines: [{ poLineId: lineId, variantId: v, locationId: loc.back, receivedQty: '1', acceptedQty: '1' }] })).body.code).toBe('INVALID_STATE');
    const detail = (await api(A.cookie, 'GET', `/v1/goods-receipts/${g1.body.id}`)).body;
    expect(detail.lines[0]).toMatchObject({ receivedQty: '9', acceptedQty: '8', damagedQty: '1', unitCost: '40.00' });
  });

  it('updates cost as a weighted average of stock on hand and what was received', async () => {
    const v = await makeItem(A.cookie, undefined, { cost: '10' });
    await adjust(A.cookie, loc.shop, 'opening', [{ variantId: v, qtyDelta: '10' }]);
    const g = await api(A.cookie, 'POST', '/v1/goods-receipts', { supplierId, lines: [{ variantId: v, locationId: loc.shop, receivedQty: '30', acceptedQty: '30', unitCost: '14' }] });
    expect(g.status, g.text).toBe(201);
    const cost = await tenantTx(A.tenantId, (t) => t.query('SELECT cost FROM product_variants WHERE id = $1', [v]));
    expect(cost.rows[0].cost).toBe('13.0000');   // (10 × 10 + 30 × 14) / 40
  });

  it('refuses a PO from another supplier, a draft PO, and another tenant\'s PO', async () => {
    const v = await makeItem(A.cookie);
    const draft = await newPo([{ variantId: v, orderedQty: '1', unitCost: '1' }]);
    const line = { poLineId: draft.lines[0].id, variantId: v, locationId: loc.shop, receivedQty: '1', acceptedQty: '1' };
    expect((await api(A.cookie, 'POST', '/v1/goods-receipts', { purchaseOrderId: draft.id, supplierId, lines: [line] })).body.code).toBe('INVALID_STATE');
    const other = (await api(A.cookie, 'POST', '/v1/suppliers', { name: `Other ${randomUUID().slice(0, 4)}` })).body;
    await api(A.cookie, 'POST', `/v1/purchase-orders/${draft.id}/submit`);
    expect((await api(A.cookie, 'POST', '/v1/goods-receipts', { purchaseOrderId: draft.id, supplierId: other.id, lines: [line] })).status).toBe(400);
    expect((await api(B.cookie, 'GET', `/v1/purchase-orders/${draft.id}`)).status).toBe(404);
    expect((await api(cashier.cookie, 'GET', '/v1/purchase-orders')).status).toBe(403);
  });
});

describe('supplier returns (PUR-05)', () => {
  it('returns damaged stock to the supplier through a traceable movement', async () => {
    const v = await makeItem(A.cookie);
    const g = await api(A.cookie, 'POST', '/v1/goods-receipts', { supplierId, lines: [{ variantId: v, locationId: loc.back, receivedQty: '5', acceptedQty: '3', unitCost: '9' }] });
    const r = await api(A.cookie, 'POST', '/v1/supplier-returns', { supplierId, receiptId: g.body.id, reason: 'Torn packaging',
      lines: [{ variantId: v, locationId: loc.back, bucket: 'non_sellable', qty: '2' }] }, key());
    expect(r.status, r.text).toBe(201);
    expect(r.body.number).toMatch(/^SR-\d{5}$/);
    expect(r.body.movements[0]).toMatchObject({ movementType: 'supplier_return', bucket: 'non_sellable', qtyDelta: '-2', balanceAfter: '0' });
    expect((await onHand(A.cookie, v, loc.back)).onHand).toBe('3');
    const tooMany = await api(A.cookie, 'POST', '/v1/supplier-returns', { supplierId, reason: 'More', lines: [{ variantId: v, locationId: loc.back, bucket: 'sellable', qty: '4' }] });
    expect(tooMany.body.code).toBe('INSUFFICIENT_STOCK');
    expect((await api(inventory.cookie, 'POST', '/v1/supplier-returns', { supplierId, reason: 'x y z', lines: [{ variantId: v, locationId: loc.back, bucket: 'sellable', qty: '1' }] })).status).toBe(403);
  });
});
