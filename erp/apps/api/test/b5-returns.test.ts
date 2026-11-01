import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, tenantTx } from '../src/db.js';
import { api } from './b2-api.js';
import { makeTenant, makeUser, owner } from './b2-helpers.js';
import { key } from './b3-helpers.js';
import { onHandAt, sell, setupBilling, stockedItem } from './b5-helpers.js';

afterAll(async () => { await owner.end(); await pool.end(); });

type T = Awaited<ReturnType<typeof makeTenant>>;
const ret = (cookie: string, body: Record<string, unknown>) => api(cookie, 'POST', '/v1/returns', body, key());

describe('B5 customer returns and credit notes', () => {
  let t: T;
  let v: string, w: string;
  beforeAll(async () => {
    t = await makeTenant();
    await setupBilling(t);
    v = await stockedItem(t.cookie, { price: '33.33', gstRate: '5', stock: '20' });
    w = await stockedItem(t.cookie, { price: '1180', gstRate: '18', stock: '5' });
  });

  it('returns part of a line: credit note in proportion to the invoice, stock back by condition, refund recorded', async () => {
    const sale = await sell(t.cookie, [{ variantId: v, qty: '3' }, { variantId: w, qty: '2' }]);
    expect(sale.status, sale.text).toBe(201);
    const inv = sale.body.invoice;
    expect(inv).toMatchObject({ taxableTotal: '2095.23', total: '2460.00', roundOff: '0.01' });
    const [lv, lw] = inv.lines;
    const r = await ret(t.cookie, { invoiceId: inv.id, reason: 'Wrong size', refundMethod: 'cash', lines: [
      { invoiceLineId: lv.id, qty: '1', condition: 'resellable' }, { invoiceLineId: lw.id, qty: '1', condition: 'damaged' }] });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ number: 'RET-00001', creditNoteNumber: expect.stringMatching(/^CN\/\d\d-\d\d\/1$/), refundAmount: '1213.00', restockedLines: 1 });
    expect(r.body.creditNote).toMatchObject({ title: 'Credit Note', originalInvoice: { id: inv.id, number: inv.number }, taxableTotal: '1031.74', cgst: '90.79', sgst: '90.79' });
    expect(r.body.creditNote.lines.map((l: any) => [l.qty, l.taxableValue, l.cgst, l.lineTotal])).toEqual([['1', '31.74', '0.79', '33.32'], ['1', '1000.00', '90.00', '1180.00']]);
    expect([await onHandAt(v), await onHandAt(w), await onHandAt(w, 'non_sellable')]).toEqual(['18', '3', '1']);
    const detail = await api(t.cookie, 'GET', `/v1/invoices/${inv.id}`);
    expect(detail.body.lines.map((l: any) => l.returnableQty)).toEqual(['2', '1']);
    expect(detail.body.payments.filter((p: any) => p.kind === 'refund')).toEqual([expect.objectContaining({ method: 'cash', amount: '1213.00' })]);
    const order = await api(t.cookie, 'GET', `/v1/orders/${sale.body.orderId}`);
    expect(order.body.paymentState).toBe('partially_refunded');
  });

  it('never credits more than was sold', async () => {
    const sale = await sell(t.cookie, [{ variantId: v, qty: '2' }]);
    const line = sale.body.invoice.lines[0];
    const r = await ret(t.cookie, { invoiceId: sale.body.invoiceId, reason: 'Changed mind', refundMethod: 'cash', lines: [{ invoiceLineId: line.id, qty: '3', condition: 'resellable' }] });
    expect([r.status, r.body.code]).toEqual([409, 'RETURN_EXCEEDS_SOLD']);
    expect((await ret(t.cookie, { invoiceId: sale.body.invoiceId, reason: 'x', refundMethod: 'cash', lines: [{ invoiceLineId: line.id, qty: '1', condition: 'resellable' }] })).status).toBe(400);
  });

  it('returned in parts, the credit notes add up to the invoice to the paisa (round-offs cancel out)', async () => {
    const sale = await sell(t.cookie, [{ variantId: v, qty: '3' }]);   // 99.99 → rounds to 100.00
    const inv = sale.body.invoice;
    expect([inv.total, inv.roundOff]).toEqual(['100.00', '0.01']);
    const totals: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await ret(t.cookie, { invoiceId: inv.id, reason: 'Returned one', refundMethod: 'upi', lines: [{ invoiceLineId: inv.lines[0].id, qty: '1', condition: 'resellable' }] });
      expect(r.status, r.text).toBe(201);
      totals.push(r.body.refundAmount);
    }
    expect(totals).toEqual(['33.00', '33.00', '34.00']);
    const sum = totals.reduce((a, x) => a + Math.round(Number(x) * 100), 0);
    expect(sum).toBe(10000);
    const { rows } = await owner.query(
      'SELECT sum(taxable_total)::text AS taxable, sum(cgst)::text AS cgst FROM credit_notes WHERE invoice_id = $1', [inv.id]);
    expect(rows[0]).toEqual({ taxable: inv.taxableTotal, cgst: inv.cgst });
    expect((await api(t.cookie, 'GET', `/v1/orders/${sale.body.orderId}`)).body).toMatchObject({ status: 'refunded', paymentState: 'refunded' });
  });

  it('a cashier can take a return; the inventory role cannot', async () => {
    const cashier = await makeUser(t.tenantId, 'cashier');
    const inventory = await makeUser(t.tenantId, 'inventory');
    const sale = await sell(t.cookie, [{ variantId: v, qty: '1' }]);
    const body = { invoiceId: sale.body.invoiceId, reason: 'Faulty', refundMethod: 'cash', lines: [{ invoiceLineId: sale.body.invoice.lines[0].id, qty: '1', condition: 'damaged' }] };
    expect((await ret(inventory.cookie, body)).status).toBe(403);
    expect((await ret(cashier.cookie, body)).status).toBe(201);
    expect((await api(cashier.cookie, 'GET', '/v1/returns')).body.items.length).toBeGreaterThan(0);
  });

  it('a retried return posts once', async () => {
    const sale = await sell(t.cookie, [{ variantId: v, qty: '2' }]);
    const body = { invoiceId: sale.body.invoiceId, reason: 'Wrong item', refundMethod: 'cash', lines: [{ invoiceLineId: sale.body.invoice.lines[0].id, qty: '1', condition: 'resellable' }] };
    const k = key();
    const a = await api(t.cookie, 'POST', '/v1/returns', body, k);
    const b = await api(t.cookie, 'POST', '/v1/returns', body, k);
    expect(b.body.creditNoteId).toBe(a.body.creditNoteId);
    expect((await owner.query('SELECT count(*)::int AS n FROM credit_notes WHERE invoice_id = $1', [sale.body.invoiceId])).rows[0].n).toBe(1);
  });
});

describe('B5 voiding an invoice', () => {
  let t: T;
  let v: string;
  beforeAll(async () => {
    t = await makeTenant();
    await setupBilling(t);
    v = await stockedItem(t.cookie, { price: '500', gstRate: '18', stock: '10' });
  });

  it('only the owner voids; it credits what is left, keeps the original, and blocks further returns', async () => {
    const mgr = await makeUser(t.tenantId, 'manager');
    const sale = await sell(t.cookie, [{ variantId: v, qty: '3' }]);
    const id = sale.body.invoiceId;
    await ret(t.cookie, { invoiceId: id, reason: 'One back', refundMethod: 'cash', lines: [{ invoiceLineId: sale.body.invoice.lines[0].id, qty: '1', condition: 'resellable' }] });
    expect((await api(mgr.cookie, 'POST', `/v1/invoices/${id}/void`, { reason: 'Billed twice', restock: true, refundMethod: 'cash' }, key())).status).toBe(403);
    const res = await api(t.cookie, 'POST', `/v1/invoices/${id}/void`, { reason: 'Billed twice', restock: true, refundMethod: 'cash' }, key());
    expect(res.status, res.text).toBe(200);
    expect(res.body.creditNote).toMatchObject({ kind: 'void', lines: [expect.objectContaining({ qty: '2' })] });
    expect(await onHandAt(v)).toBe('10');
    const inv = await api(t.cookie, 'GET', `/v1/invoices/${id}`);
    expect(inv.body).toMatchObject({ voided: true, total: '1500.00', creditNotes: [expect.objectContaining({ kind: 'return' }), expect.objectContaining({ kind: 'void' })] });
    const again = await api(t.cookie, 'POST', `/v1/invoices/${id}/void`, { reason: 'Again', restock: false, refundMethod: 'none' }, key());
    expect(again.body.code).toBe('INVOICE_VOIDED');
    const audit = await owner.query("SELECT summary FROM audit_events WHERE tenant_id = $1 AND action = 'invoice.voided'", [t.tenantId]);
    expect(audit.rows[0].summary).toMatchObject({ reason: 'Billed twice', total: '1000.00' });
  });

  it('void without restocking moves no stock', async () => {
    const sale = await sell(t.cookie, [{ variantId: v, qty: '1' }]);
    const before = await onHandAt(v);
    const res = await api(t.cookie, 'POST', `/v1/invoices/${sale.body.invoiceId}/void`, { reason: 'Goods never collected? no: wrong customer', restock: false, refundMethod: 'none' }, key());
    expect(res.status, res.text).toBe(200);
    expect(await onHandAt(v)).toBe(before);
  });
});

describe('B5 tax documents cannot be changed', () => {
  it('the app role cannot update or delete invoices, credit notes or payments, even in its own store', async () => {
    const t = await makeTenant();
    await setupBilling(t);
    const v = await stockedItem(t.cookie, { price: '10', gstRate: '5' });
    const sale = await sell(t.cookie, [{ variantId: v, qty: '1' }]);
    for (const sql of [
      'UPDATE invoices SET total = 0 WHERE id = $1', 'DELETE FROM invoices WHERE id = $1', 'UPDATE invoice_lines SET qty = 5 WHERE invoice_id = $1',
      'DELETE FROM payments WHERE order_id = (SELECT order_id FROM invoices WHERE id = $1)',
    ]) {
      await expect(tenantTx(t.tenantId, (tx) => tx.query(sql, [sale.body.invoiceId])), sql).rejects.toThrow(/permission denied/);
    }
  });

  it('another store’s invoice is not found', async () => {
    const a = await makeTenant(), b = await makeTenant();
    await setupBilling(a);
    const v = await stockedItem(a.cookie, { price: '10', gstRate: '5' });
    const sale = await sell(a.cookie, [{ variantId: v, qty: '1' }]);
    expect((await api(b.cookie, 'GET', `/v1/invoices/${sale.body.invoiceId}`)).status).toBe(404);
    const r = await ret(b.cookie, { invoiceId: sale.body.invoiceId, reason: 'Steal', refundMethod: 'cash', lines: [{ invoiceLineId: sale.body.invoice.lines[0].id, qty: '1', condition: 'resellable' }] });
    expect(r.status).toBe(404);
  });
});

describe('B5 invoice and credit note lists', () => {
  it('lists invoices and credit notes, newest first, with search, dates and paging', async () => {
    const t = await makeTenant();
    await setupBilling(t);
    const v = await stockedItem(t.cookie, { price: '100', gstRate: '5', stock: '10' });
    const a = await sell(t.cookie, [{ variantId: v, qty: '1' }]);
    const b = await sell(t.cookie, [{ variantId: v, qty: '2' }]);
    await ret(t.cookie, { invoiceId: a.body.invoiceId, reason: 'Faulty', refundMethod: 'cash', lines: [{ invoiceLineId: a.body.invoice.lines[0].id, qty: '1', condition: 'damaged' }] });

    const all = await api(t.cookie, 'GET', '/v1/invoices');
    expect(all.status, all.text).toBe(200);
    expect(all.body.items.map((i: any) => [i.number, i.credited])).toEqual([[b.body.invoiceNumber, '0.00'], [a.body.invoiceNumber, '100.00']]);
    const page1 = await api(t.cookie, 'GET', '/v1/invoices?limit=1');
    const page2 = await api(t.cookie, 'GET', `/v1/invoices?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
    expect([page1.body.items[0].id, page2.body.items[0].id, page2.body.nextCursor]).toEqual([b.body.invoiceId, a.body.invoiceId, null]);
    expect((await api(t.cookie, 'GET', `/v1/invoices?q=${encodeURIComponent(a.body.invoiceNumber)}`)).body.items.map((i: any) => i.id)).toContain(a.body.invoiceId);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    expect((await api(t.cookie, 'GET', `/v1/invoices?from=${today}&to=${today}`)).body.items).toHaveLength(2);
    expect((await api(t.cookie, 'GET', '/v1/invoices?to=2000-01-01')).body.items).toHaveLength(0);
    const cns = await api(t.cookie, 'GET', '/v1/invoices?type=credit_note');
    expect(cns.body.items).toEqual([expect.objectContaining({ type: 'credit_note', invoice: { id: a.body.invoiceId, number: a.body.invoiceNumber }, total: '100.00' })]);
  });
});
