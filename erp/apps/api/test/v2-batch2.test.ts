import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './b2-api.js';
import { makeTenant, makeUser, owner } from './b2-helpers.js';
import { key, locations, makeItem } from './b3-helpers.js';
import { sell, setupBilling, stockedItem } from './b5-helpers.js';

// GroPop v2 batch 2: Contacts (D96), bulk price updates (D97), labels (D98), bill formats (D99), the export dialog (D100).

type Tenant = Awaited<ReturnType<typeof makeTenant>>;

describe('contacts (D96)', () => {
  let T: Tenant;
  let custId: string;
  let supplierId: string;
  beforeAll(async () => {
    T = await makeTenant();
    await setupBilling(T);
    const c = await api(T.cookie, 'POST', '/v1/customers', { name: 'Asha Rao', phone: '9876500001', email: 'asha@example.com' });
    expect(c.status, c.text).toBe(201);
    custId = c.body.id;
    await api(T.cookie, 'POST', '/v1/customers', { name: 'Bala K', phone: '9876500002' });
    const s = await api(T.cookie, 'POST', '/v1/suppliers', { name: `Zen Traders ${randomUUID().slice(0, 4)}`, phone: '9876500099' });
    expect(s.status, s.text).toBe(201);
    supplierId = s.body.id;
  });

  it('lists customers with what each bought, returned and when last', async () => {
    const v = await stockedItem(T.cookie, { price: '100', gstRate: '0', hsn: null });
    const a = await sell(T.cookie, [{ variantId: v, qty: '2' }], { customerId: custId });
    expect(a.status, a.text).toBe(201);
    const b = await sell(T.cookie, [{ variantId: v, qty: '1' }], { customerId: custId });
    expect(b.status, b.text).toBe(201);
    // Void the second bill: it still shows in history, and its amount counts as returned.
    const vd = await api(T.cookie, 'POST', `/v1/invoices/${b.body.invoice.id}/void`, { reason: 'Wrong item', restock: true, refundMethod: 'cash' }, key());
    expect(vd.status, vd.text).toBe(200);

    const list = await api(T.cookie, 'GET', '/v1/contacts?type=customer');
    expect(list.status, list.text).toBe(200);
    const asha = list.body.items.find((x: any) => x.id === custId);
    expect(asha).toMatchObject({ type: 'customer', name: 'Asha Rao', phone: '9876500001', stats: { orders: 2, spent: '300.00', returned: '100.00', net: '200.00' } });
    expect(asha.stats.lastAt).toBeTruthy();
    expect(list.body.items.find((x: any) => x.name === 'Bala K').stats).toMatchObject({ orders: 0, spent: '0.00', lastAt: null });

    const found = await api(T.cookie, 'GET', '/v1/contacts?type=customer&q=00002');
    expect(found.body.items.map((x: any) => x.name)).toEqual(['Bala K']);

    const one = await api(T.cookie, 'GET', `/v1/contacts/customers/${custId}`);
    expect(one.status, one.text).toBe(200);
    expect(one.body.can.edit).toBe(true);
    expect(one.body.history.items).toHaveLength(2);
    expect(one.body.history.items[0]).toMatchObject({ number: b.body.order?.number ?? expect.any(String), total: '100.00', voided: true, credited: '100.00' });
    expect(one.body.history.items[1]).toMatchObject({ total: '200.00', voided: false, invoice: { number: expect.any(String) } });
  });

  it('pages through a long history', async () => {
    const page1 = await api(T.cookie, 'GET', `/v1/contacts/customers/${custId}/history?limit=1`);
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await api(T.cookie, 'GET', `/v1/contacts/customers/${custId}/history?limit=1&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
  });

  it('lists suppliers with receipts, value received and open purchase orders', async () => {
    const { back } = await locations(T.cookie);
    const v = await makeItem(T.cookie);
    const po = await api(T.cookie, 'POST', '/v1/purchase-orders', { supplierId, lines: [{ variantId: v, orderedQty: '10', unitCost: '40' }] }, key());
    expect(po.status, po.text).toBe(201);
    await api(T.cookie, 'POST', `/v1/purchase-orders/${po.body.id}/submit`);
    const g = await api(T.cookie, 'POST', '/v1/goods-receipts', {
      purchaseOrderId: po.body.id, supplierId, supplierInvoiceNo: 'ZT-501',
      lines: [{ poLineId: po.body.lines[0].id, variantId: v, locationId: back, receivedQty: '5', acceptedQty: '5' }],
    }, key());
    expect(g.status, g.text).toBe(201);

    const list = await api(T.cookie, 'GET', '/v1/contacts?type=supplier');
    expect(list.body.items.find((x: any) => x.id === supplierId).stats).toMatchObject({ receipts: 1, purchased: '200.00', openPurchaseOrders: 1, returns: 0 });
    const one = await api(T.cookie, 'GET', `/v1/contacts/suppliers/${supplierId}`);
    expect(one.body.history.items[0]).toMatchObject({ kind: 'receipt', number: g.body.number, reference: 'ZT-501', purchaseOrder: po.body.number, qty: '5', value: '200.00' });
  });

  it('is for owners and managers; another store’s contact is not found; CSV export is audited', async () => {
    const manager = await makeUser(T.tenantId, 'manager');
    const cashier = await makeUser(T.tenantId, 'cashier');
    expect((await api(manager.cookie, 'GET', '/v1/contacts?type=customer')).status).toBe(200);
    expect((await api(cashier.cookie, 'GET', '/v1/contacts?type=customer')).status).toBe(403);
    expect((await api(cashier.cookie, 'GET', '/v1/customers?q=Asha')).status).toBe(200); // the till still finds a customer
    const U = await makeTenant();
    expect((await api(U.cookie, 'GET', `/v1/contacts/customers/${custId}`)).status).toBe(404);
    expect((await api(U.cookie, 'GET', `/v1/contacts/suppliers/${supplierId}/history`)).status).toBe(404);
    expect((await api(T.cookie, 'GET', '/v1/contacts?type=everyone')).status).toBe(400);

    const csv = await api(T.cookie, 'GET', '/v1/exports/contacts.csv?type=customer');
    expect(csv.status).toBe(200);
    expect(csv.text.split('\r\n')[0]).toBe('﻿name,phone,email,gstin,state,address,orders,spent,returned,last_purchase');
    expect(csv.text).toContain('Asha Rao,9876500001,asha@example.com');
    const { rows } = await owner.query("SELECT summary FROM audit_events WHERE tenant_id = $1 AND action = 'export.contacts'", [T.tenantId]);
    expect(rows[0].summary).toMatchObject({ type: 'customer', rows: 2 });
  });
});

describe('bulk price updates (D97)', () => {
  let T: Tenant;
  let cat: string;
  let other: string;
  const item = async (o: { price: string; mrp?: string; cost?: string; categoryId?: string }) => {
    const sku = `BP-${randomUUID().slice(0, 8)}`;
    const r = await api(T.cookie, 'POST', '/v1/products', {
      name: `Biscuit ${sku}`, type: 'simple', status: 'active', categoryId: o.categoryId ?? cat,
      variants: [{ sku, price: o.price, ...(o.mrp ? { mrp: o.mrp } : {}), ...(o.cost ? { cost: o.cost } : {}) }],
    }, key());
    expect(r.status, r.text).toBe(201);
    return { id: r.body.variants[0].id as string, sku, productId: r.body.id as string };
  };
  const variant = async (productId: string) => (await api(T.cookie, 'GET', `/v1/products/${productId}`)).body.variants[0];
  const applyRows = (rows: any[], source = 'rule', description = 'Test run') => api(T.cookie, 'POST', '/v1/price-updates', {
    source, description, lines: rows.filter((r) => !r.problem).map((r) => ({ variantId: r.variantId, version: r.version, price: r.next.price, mrp: r.next.mrp, cost: r.next.cost })),
  }, key());

  beforeAll(async () => {
    T = await makeTenant();
    cat = (await api(T.cookie, 'POST', '/v1/categories', { name: `Biscuits ${randomUUID().slice(0, 4)}` })).body.id;
    other = (await api(T.cookie, 'POST', '/v1/categories', { name: `Soaps ${randomUUID().slice(0, 4)}` })).body.id;
  });

  it('previews a rule exactly, flags prices above MRP, and changes only what was shown', async () => {
    const a = await item({ price: '10', mrp: '12', cost: '7' });
    const b = await item({ price: '99.99', mrp: '100' });
    const c = await item({ price: '20' });
    const soap = await item({ price: '30', categoryId: other });
    const p = await api(T.cookie, 'POST', '/v1/price-updates/preview', { filter: { categoryId: cat }, field: 'price', method: 'increase_pct', value: '12.5', rounding: 'none' });
    expect(p.status, p.text).toBe(200);
    expect(p.body.matched).toBe(3);
    const row = (id: string) => p.body.rows.find((r: any) => r.variantId === id);
    expect(row(a.id)).toMatchObject({ current: { price: '10.00', mrp: '12.00', cost: '7.00' }, next: { price: '11.25' }, problem: null });
    expect(row(b.id).problem).toMatch(/above the MRP ₹100.00/);
    expect(row(c.id).next.price).toBe('22.50');
    expect(row(soap.id)).toBeUndefined();

    const done = await applyRows(p.body.rows);
    expect(done.status, done.text).toBe(201);
    expect(done.body.variantCount).toBe(2);
    expect((await variant(a.productId)).price).toBe('11.25');
    expect((await variant(b.productId)).price).toBe('99.99');   // flagged row was left out
    expect((await variant(soap.productId)).price).toBe('30.00');

    // Undo puts back what this run changed.
    const u = await api(T.cookie, 'POST', `/v1/price-updates/${done.body.id}/undo`);
    expect(u.status, u.text).toBe(200);
    expect(u.body).toMatchObject({ restored: 2, kept: 0 });
    expect((await variant(a.productId)).price).toBe('10.00');
    expect((await api(T.cookie, 'POST', `/v1/price-updates/${done.body.id}/undo`)).body.code).toBe('ALREADY_UNDONE');
  });

  it('rounds, works the price out from MRP or cost, and refuses a stale preview', async () => {
    const a = await item({ price: '80', mrp: '123', cost: '61' });
    const fromMrp = await api(T.cookie, 'POST', '/v1/price-updates/preview', { filter: { productIds: [a.productId] }, field: 'price', method: 'mrp_less_pct', value: '10', rounding: '1' });
    expect(fromMrp.body.rows[0].next.price).toBe('111.00');   // 110.70 -> ₹111
    const fromCost = await api(T.cookie, 'POST', '/v1/price-updates/preview', { filter: { productIds: [a.productId] }, field: 'price', method: 'cost_plus_pct', value: '30', rounding: '5' });
    expect(fromCost.body.rows).toHaveLength(0);               // 79.30 -> ₹80, the same as now
    expect(fromCost.body.unchanged).toBe(1);
    expect((await api(T.cookie, 'POST', '/v1/price-updates/preview', { field: 'mrp', method: 'cost_plus_pct', value: '10' })).status).toBe(400);

    // Someone edits the item between preview and apply: the run is refused as a whole.
    const v = await variant(a.productId);
    const edit = await api(T.cookie, 'PATCH', `/v1/variants/${a.id}`, { price: '85' }, { 'if-match': `"${v.version}"` });
    expect(edit.status, edit.text).toBe(200);
    const stale = await applyRows(fromMrp.body.rows);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE');
    expect((await variant(a.productId)).price).toBe('85.00');
  });

  it('a spreadsheet run: download, edit, upload, check, apply; undo keeps later changes', async () => {
    const a = await item({ price: '50', mrp: '60', cost: '40' });
    const b = await item({ price: '70', mrp: '75' });
    const sheet = await api(T.cookie, 'GET', `/v1/exports/prices.csv?categoryId=${cat}`);
    expect(sheet.status).toBe(200);
    expect(sheet.text.split('\r\n')[0]).toBe('﻿sku,barcode,product,variant,price,mrp,cost');
    expect(sheet.text).toContain(`${a.sku},`);

    const csv = ['sku,product,price,mrp,cost', `${a.sku},x,"₹1,055.50",1100,`, `${b.sku},x,80,,`, `NOPE-1,x,5,,`, `${a.sku},x,1,,`, `${b.sku.toLowerCase()}x,x,abc,,`].join('\n');
    const p = await api(T.cookie, 'POST', '/v1/price-updates/preview-sheet', { csv });
    expect(p.status, p.text).toBe(200);
    expect(p.body.errors.map((e: any) => [e.row, e.message])).toEqual([[4, 'No item has this SKU'], [5, 'This SKU is in the sheet twice'], [6, 'No item has this SKU']]);
    const ra = p.body.rows.find((r: any) => r.variantId === a.id);
    expect(ra).toMatchObject({ next: { price: '1055.50', mrp: '1100.00', cost: '40.00' }, problem: null });
    expect(p.body.rows.find((r: any) => r.variantId === b.id).problem).toMatch(/above the MRP ₹75.00/);

    const done = await applyRows(p.body.rows, 'sheet', 'Diwali prices');
    expect(done.status, done.text).toBe(201);
    expect(done.body.variantCount).toBe(1);
    expect(await variant(a.productId)).toMatchObject({ price: '1055.50', mrp: '1100.00' });

    const list = await api(T.cookie, 'GET', '/v1/price-updates');
    expect(list.body.items[0]).toMatchObject({ id: done.body.id, source: 'sheet', description: 'Diwali prices', variantCount: 1, createdBy: 'Owner', undoneAt: null });
    const one = await api(T.cookie, 'GET', `/v1/price-updates/${done.body.id}`);
    expect(one.body.lines[0]).toMatchObject({ sku: a.sku, old: { price: '50.00', mrp: '60.00' }, new: { price: '1055.50' }, stillCurrent: true });

    // A later hand edit wins over undo.
    const v = await variant(a.productId);
    await api(T.cookie, 'PATCH', `/v1/variants/${a.id}`, { price: '999' }, { 'if-match': `"${v.version}"` });
    const u = await api(T.cookie, 'POST', `/v1/price-updates/${done.body.id}/undo`);
    expect(u.body).toMatchObject({ restored: 0, kept: 1, keptSkus: [a.sku] });
    expect((await variant(a.productId)).price).toBe('999.00');
    expect((await api(T.cookie, 'GET', '/v1/price-updates')).body.items[0]).toMatchObject({ undoneBy: 'Owner', undoneCount: 0 });
  });

  it('is for owners and managers; history cannot be rewritten; another store sees nothing', async () => {
    const cashier = await makeUser(T.tenantId, 'cashier');
    const inventory = await makeUser(T.tenantId, 'inventory');
    const manager = await makeUser(T.tenantId, 'manager');
    expect((await api(cashier.cookie, 'GET', '/v1/price-updates')).status).toBe(403);
    expect((await api(inventory.cookie, 'POST', '/v1/price-updates/preview', { field: 'price', method: 'set', value: '1' })).status).toBe(403);
    expect((await api(manager.cookie, 'GET', '/v1/price-updates')).status).toBe(200);
    const run = (await api(T.cookie, 'GET', '/v1/price-updates')).body.items[0];
    const U = await makeTenant();
    expect((await api(U.cookie, 'GET', `/v1/price-updates/${run.id}`)).status).toBe(404);
    expect((await api(U.cookie, 'POST', `/v1/price-updates/${run.id}/undo`)).status).toBe(404);
    // The app's database role may add runs but never edit or delete their lines.
    const { DATABASE_URL } = process.env;
    const pg = await import('pg');
    const rt = new pg.default.Client({ connectionString: DATABASE_URL });
    await rt.connect();
    try {
      await rt.query("SELECT set_config('app.tenant_id', $1, false)", [T.tenantId]);
      await expect(rt.query('UPDATE price_update_lines SET new_price = 0')).rejects.toThrow(/permission denied/);
      await expect(rt.query('DELETE FROM price_updates')).rejects.toThrow(/permission denied/);
    } finally { await rt.end(); }
    // Missing idempotency key and empty runs are refused.
    expect((await api(T.cookie, 'POST', '/v1/price-updates', { source: 'rule', description: 'x', lines: [] })).status).toBe(400);
  });
});

describe('export dialog (D100)', () => {
  it('exports chosen products and columns; with no options it is the import-ready file', async () => {
    const T = await makeTenant();
    const catA = (await api(T.cookie, 'POST', '/v1/categories', { name: 'Atta' })).body.id;
    const mk = async (name: string, categoryId: string | null, extra: Record<string, unknown> = {}) => {
      const r = await api(T.cookie, 'POST', '/v1/products', { name, type: 'simple', status: 'active', categoryId, variants: [{ sku: `EX-${randomUUID().slice(0, 6)}`, price: '40', cost: '30', ...extra }] }, key());
      expect(r.status, r.text).toBe(201);
      return r.body;
    };
    const a = await mk('Atta 1kg', catA, { netWeight: '1', netWeightUnit: 'kg' });
    const other = (await api(T.cookie, 'POST', '/v1/categories', { name: 'Oil' })).body.id;
    const b = await mk('Oil 1l', other);

    const full = await api(T.cookie, 'GET', '/v1/exports/products.csv');
    expect(full.text.split('\r\n')[0]).toMatch(/^﻿product_name,sku,price,mrp,cost,barcode,category,brand,unit,hsn_code,gst_rate,/);
    expect(full.text).toContain('Oil 1l');

    const some = await api(T.cookie, 'GET', `/v1/exports/products.csv?categoryId=${catA}&columns=price,stock_on_hand,net_weight`);
    expect(some.status, some.text).toBe(200);
    const lines = some.text.trimEnd().split('\r\n');
    expect(lines[0]).toBe('﻿product_name,sku,price,stock_on_hand,net_weight');
    expect(lines.slice(1)).toEqual([`Atta 1kg,${a.variants[0].sku},40.00,0,1 kg`]);

    const picked = await api(T.cookie, 'GET', `/v1/exports/products.csv?productIds=${b.id}&columns=cost`);
    expect(picked.text.trim().split('\r\n').slice(1)).toEqual([`Oil 1l,${b.variants[0].sku},30.00`]);
    expect((await api(T.cookie, 'GET', '/v1/exports/products.csv?columns=price,secret')).status).toBe(400);
    expect((await api(T.cookie, 'GET', '/v1/exports/products.csv?productIds=nope')).status).toBe(400);
  });
});

describe('labels (D98)', () => {
  it('prints for ticked products and for a goods receipt, one label per unit received', async () => {
    const T = await makeTenant();
    const brand = (await api(T.cookie, 'POST', '/v1/brands', { name: 'Aashirvaad' })).body.id;
    const p = await api(T.cookie, 'POST', '/v1/products', { name: 'Atta', type: 'variable', status: 'active', brandId: brand, variants: [
      { sku: `L-${randomUUID().slice(0, 6)}`, price: '60', mrp: '65', attributes: { size: '1kg' }, netWeight: '1', netWeightUnit: 'kg' },
      { sku: `L-${randomUUID().slice(0, 6)}`, price: '280', attributes: { size: '5kg' } },
    ] }, key());
    expect(p.status, p.text).toBe(201);
    const r = await api(T.cookie, 'POST', '/v1/labels', { productIds: [p.body.id] });
    expect(r.status, r.text).toBe(200);
    expect(r.body.labels).toHaveLength(2);
    expect(r.body.labels[0]).toMatchObject({ productName: 'Atta', variant: '1kg', brand: 'Aashirvaad', netWeight: '1 kg', price: '60.00', mrp: '65.00', copies: 1 });
    expect(r.body.settings).toMatchObject({ layout: 'roll-50x25', design: 'standard', custom: [] });

    const s = await api(T.cookie, 'POST', '/v1/suppliers', { name: 'Mill' });
    const { back } = await locations(T.cookie);
    const g = await api(T.cookie, 'POST', '/v1/goods-receipts', { supplierId: s.body.id, lines: [
      { variantId: p.body.variants[0].id, locationId: back, receivedQty: '12', acceptedQty: '10', unitCost: '50' },
    ] }, key());
    expect(g.status, g.text).toBe(201);
    const fromGrn = await api(T.cookie, 'POST', '/v1/labels', { receiptId: g.body.id });
    expect(fromGrn.body.labels.map((l: any) => [l.variantId, l.copies])).toEqual([[p.body.variants[0].id, 10]]);
    expect((await api(T.cookie, 'POST', '/v1/labels', { receiptId: randomUUID() })).status).toBe(404);
    expect((await api(T.cookie, 'POST', '/v1/labels', { productIds: [p.body.id], receiptId: g.body.id })).status).toBe(400);
  });

  it('saves the label defaults and custom sizes, and refuses sizes that do not fit the paper', async () => {
    const T = await makeTenant();
    const body = {
      layout: 'custom-2up', design: 'mrp',
      show: { store: true, name: true, variant: true, sku: false, price: true, mrp: true, netWeight: true, codeText: true },
      custom: [{ id: 'custom-2up', name: 'Shop roll', paper: 'roll', widthMm: 50, heightMm: 38, columns: 2, gapXMm: 2, gapYMm: 0, marginTopMm: 0, marginLeftMm: 0 }],
    };
    const put = await api(T.cookie, 'PUT', '/v1/label-settings', body);
    expect(put.status, put.text).toBe(200);
    expect((await api(T.cookie, 'GET', '/v1/label-settings')).body).toEqual(body);
    const tooWide = { ...body, custom: [{ ...body.custom[0], columns: 3 }] };
    const bad = await api(T.cookie, 'PUT', '/v1/label-settings', tooWide);
    expect(bad.status).toBe(400);
    expect(bad.body.fieldErrors.custom[0]).toMatch(/154.0 mm wide; the paper is 120 mm/);
    const cashier = await makeUser(T.tenantId, 'cashier');
    expect((await api(cashier.cookie, 'PUT', '/v1/label-settings', body)).status).toBe(403);
    expect((await api(cashier.cookie, 'GET', '/v1/label-settings')).status).toBe(200);
    expect((await api((await makeTenant()).cookie, 'GET', '/v1/label-settings')).body.layout).toBe('roll-50x25');
  });
});

describe('bill formats (D99)', () => {
  it('the owner picks the bill format; the POS and invoice pages are told which one', async () => {
    const T = await makeTenant();
    await setupBilling(T);
    expect((await api(T.cookie, 'GET', '/v1/billing/settings')).body.billFormat).toBe('80mm');
    const r = await api(T.cookie, 'PATCH', '/v1/billing/settings', { billFormat: 'a5' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.billFormat).toBe('a5');
    expect((await api(T.cookie, 'PATCH', '/v1/billing/settings', { billFormat: '76mm' })).status).toBe(400);
    expect((await api(T.cookie, 'GET', '/v1/pos/context')).body.billFormat).toBe('a5');
    const v = await stockedItem(T.cookie, { price: '50' });
    const sale = await sell(T.cookie, [{ variantId: v, qty: '1' }]);
    expect(sale.status, sale.text).toBe(201);
    expect((await api(T.cookie, 'GET', `/v1/invoices/${sale.body.invoice.id}`)).body.billFormat).toBe('a5');
    const manager = await makeUser(T.tenantId, 'manager');
    expect((await api(manager.cookie, 'PATCH', '/v1/billing/settings', { billFormat: '57mm' })).status).toBe(403);
    const { rows } = await owner.query("SELECT summary FROM audit_events WHERE tenant_id = $1 AND action = 'billing.settings_changed' ORDER BY created_at DESC LIMIT 1", [T.tenantId]);
    expect(rows[0].summary).toEqual({ billFormat: { from: '80mm', to: 'a5' } });
  });
});
