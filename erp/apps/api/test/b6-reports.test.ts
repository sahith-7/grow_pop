import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { localDate } from '../src/lib/gst.js';
import { api } from './b2-api.js';
import { makeTenant, makeUser, owner } from './b2-helpers.js';
import { key, locations } from './b3-helpers.js';
import { setupBilling, sell, stockedItem } from './b5-helpers.js';
import { readyOrder, skuOf, type T } from './b6-helpers.js';

afterAll(async () => { await owner.end(); await pool.end(); });

const today = () => localDate(new Date(), 'Asia/Kolkata');
const report = (cookie: string, name: string, q = '') => api(cookie, 'GET', `/v1/reports/${name}${q ? `?${q}` : ''}`);

describe('B6 reports', () => {
  let t: T;
  let costed: string, costedSku: string;
  beforeAll(async () => {
    t = await makeTenant();
    await setupBilling(t);
    costed = await stockedItem(t.cookie, { price: '100', stock: '10' });
    costedSku = await skuOf(costed);
    await owner.query("UPDATE product_variants SET cost = 50, reorder_level = 15 WHERE id = $1", [costed]);
    await owner.query(`UPDATE products SET name = '=HYPERLINK("http://evil")' WHERE id = (SELECT product_id FROM product_variants WHERE id = $1)`, [costed]);
    // A counter sale of 2 × ₹1,180 at 18%, one of them returned.
    const v = await stockedItem(t.cookie, { price: '1180', gstRate: '18', stock: '5' });
    const sale = await sell(t.cookie, [{ variantId: v, qty: '2' }]);
    expect(sale.status, sale.text).toBe(201);
    const r = await api(t.cookie, 'POST', '/v1/returns', { invoiceId: sale.body.invoice.id, reason: 'Wrong size', refundMethod: 'cash',
      lines: [{ invoiceLineId: sale.body.invoice.lines[0].id, qty: '1', condition: 'resellable' }] }, key());
    expect(r.status, r.text).toBe(201);
  });

  it('lists the reports a role may open', async () => {
    const all = await api(t.cookie, 'GET', '/v1/reports');
    expect(all.body.items.map((r: any) => r.key)).toEqual(['inventory-summary', 'low-stock', 'stock-movements', 'stocktake-variance', 'purchasing', 'sales', 'sync-health']);
    expect(all.body.can).toEqual({ export: true, cost: true });
    const inv = await makeUser(t.tenantId, 'inventory');
    const mine = await api(inv.cookie, 'GET', '/v1/reports');
    expect(mine.body.items.map((r: any) => r.key)).not.toContain('sales');
    expect(mine.body.items.map((r: any) => r.key)).not.toContain('sync-health');
    expect(mine.body.can.export).toBe(false);
    expect((await report(inv.cookie, 'sales')).status).toBe(403);
    expect((await report(inv.cookie, 'inventory-summary', 'format=csv')).status).toBe(403);
    expect((await report(inv.cookie, 'inventory-summary')).status).toBe(200);
    for (const role of ['cashier', 'fulfillment'] as const) {
      const u = await makeUser(t.tenantId, role);
      expect((await report(u.cookie, 'inventory-summary')).status, role).toBe(403);
    }
  });

  it('inventory summary: value is on hand × cost, totals cover every row', async () => {
    const r = await report(t.cookie, 'inventory-summary');
    expect(r.status, r.text).toBe(200);
    expect(r.body.columns.map((c: any) => c.key)).toContain('value');
    const row = r.body.rows.find((x: any) => x.sku === costedSku);
    expect(row).toMatchObject({ on_hand: '10', available: '10', unit_cost: '50.00', value: '500.00' });
    const sum = r.body.rows.reduce((a: number, x: any) => a + Number(x.value ?? 0), 0);
    expect(r.body).toMatchObject({ rowCount: r.body.rows.length, truncated: false, totals: { value: sum.toFixed(2) } });
  });

  it('low stock shows what is short and what is on order', async () => {
    const r = await report(t.cookie, 'low-stock');
    expect(r.body.rows).toEqual([expect.objectContaining({ sku: costedSku, available: '10', reorder_level: '15', short_by: '5', on_order: '0' })]);
  });

  it('sales: invoiced less credited per day and channel', async () => {
    const r = await report(t.cookie, 'sales');
    expect(r.status, r.text).toBe(200);
    expect(r.body.rows).toEqual([{ day: today(), channel: 'Counter', invoices: 1, credit_notes: 1, invoiced: '2360.00', credited: '1180.00',
      net_sales: '1180.00', net_taxable: '1000.00', net_tax: '180.00' }]);
    expect(r.body.totals).toMatchObject({ invoices: 1, net_sales: '1180.00' });
    expect(r.body.from).toBe(localDate(new Date(Date.now() - 29 * 86_400_000), 'Asia/Kolkata'));
    expect((await report(t.cookie, 'sales', 'from=2020-01-01&to=2020-01-31')).body.rows).toEqual([]);
  });

  it('stock movements carry the ledger, newest first, filtered by location', async () => {
    const { back } = await locations(t.cookie);
    const r = await report(t.cookie, 'stock-movements');
    expect(r.body.rows[0]).toMatchObject({ movement: 'return in', qty: '1' });
    expect(r.body.rows.length).toBeGreaterThanOrEqual(4);
    expect((await report(t.cookie, 'stock-movements', `locationId=${back}`)).body.rows).toEqual([]);
  });

  it('CSV: every row, spreadsheet formulas neutralised, the export audited', async () => {
    const r = await report(t.cookie, 'inventory-summary', 'format=csv');
    expect(r.status, r.text).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toBe(`attachment; filename="inventory-summary_${today()}.csv"`);
    const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('SKU,Product,Category,On hand,Reserved,Available,Damaged / quarantined,Average cost,Stock value');
    expect(lines.find((l) => l.startsWith(costedSku))).toBe(`${costedSku},"'=HYPERLINK(""http://evil"")",General,10,0,10,0,50.00,500.00`);
    const { rows } = await owner.query("SELECT summary FROM audit_events WHERE tenant_id = $1 AND action = 'report.exported'", [t.tenantId]);
    expect(rows).toEqual([{ summary: expect.objectContaining({ report: 'inventory-summary', costColumns: true }) }]);
  });

  it('checks its filters', async () => {
    expect((await report(t.cookie, 'sales', 'from=2026-02-01&to=2026-01-01')).body.fieldErrors.from).toBeTruthy();
    expect((await report(t.cookie, 'sales', 'from=2024-01-01&to=2026-01-01')).body.fieldErrors.from[0]).toMatch(/366/);
    expect((await report(t.cookie, 'sales', 'from=2026-13-45')).status).toBe(400);
    expect((await report(t.cookie, 'nope')).status).toBe(404);
    expect((await report(t.cookie, 'sales', 'x=1')).status).toBe(400);
    const other = await makeTenant();
    const { shop } = await locations(other.cookie);
    expect((await report(t.cookie, 'inventory-summary', `locationId=${shop}`)).body.fieldErrors.locationId).toBeTruthy();
  });

  it('another store sees none of these rows', async () => {
    const other = await makeTenant();
    expect((await report(other.cookie, 'sales')).body.rows).toEqual([]);
    expect((await report(other.cookie, 'low-stock')).body.rows).toEqual([]);
    expect((await report(other.cookie, 'stock-movements')).body.rows).toEqual([]);
  });
});

describe('B6 dashboard', () => {
  it('shows each role only the tiles it may see', async () => {
    const t = await makeTenant();
    await setupBilling(t);
    const v = await stockedItem(t.cookie, { price: '1180', gstRate: '18', stock: '5' });
    expect((await sell(t.cookie, [{ variantId: v, qty: '1' }])).status).toBe(201);
    await readyOrder(t, [[await skuOf(v), 1, '1180.00']]);

    const own = await api(t.cookie, 'GET', '/v1/dashboard');
    expect(own.status, own.text).toBe(200);
    expect(own.body).toMatchObject({
      today: today(),
      sales: { today: '1180.00', yesterday: '0.00', invoicesToday: 1 },
      stock: { itemCount: 1, lowStockCount: 0, value: '0.00' },
      attention: { ordersNeedingAttention: 0, readyToPick: 1, beingPicked: 0, dispatchUpdatesStuck: 0, failedSyncJobs: 0, stocktakesInReview: 0 },
      bestSellers: [{ qty: '1' }],
    });
    expect(own.body.recentSales).toHaveLength(2);

    const cashier = await makeUser(t.tenantId, 'cashier');
    const c = (await api(cashier.cookie, 'GET', '/v1/dashboard')).body;
    expect(c.sales).toBeTruthy();
    expect(c.stock).toBeUndefined();
    expect(c.attention).toEqual({ ordersNeedingAttention: 0, readyToPick: 1, beingPicked: 0 });

    const staff = await makeUser(t.tenantId, 'fulfillment');
    const f = (await api(staff.cookie, 'GET', '/v1/dashboard')).body;
    expect(f.sales).toBeUndefined();
    expect(f.stock).toEqual({ itemCount: 1, lowStockCount: 0 });   // stock.read, but no cost.view: no value
    expect(f.attention).toMatchObject({ readyToPick: 1, dispatchUpdatesStuck: 0 });
    expect(f.attention.failedSyncJobs).toBeUndefined();
  });
});
