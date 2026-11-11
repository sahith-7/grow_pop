import { beforeAll, describe, expect, it } from 'vitest';
import { tenantTx } from '../src/db.js';
import { api } from './b2-api.js';
import { makeTenant, makeUser, owner } from './b2-helpers.js';
import { adjust, key, locations } from './b3-helpers.js';
import { FY, gstin, sell, setupBilling, stockedItem } from './b5-helpers.js';
import { adminSession } from './b7-helpers.js';

// GroPop v2 Phase 1: outlets (D101). Several shops inside one store account, each with its own bill series, stock rooms,
// address and (in another state) GSTIN. One is included; more are switched on from the platform console.

type Tenant = Awaited<ReturnType<typeof makeTenant>>;
const fy = () => FY().slice(2);
const platform = (cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) => api(cookie, method, `/v1/platform${url}`, body);
const outlet = (T: Tenant, body: Record<string, unknown>) => api(T.cookie, 'POST', '/v1/outlets', { address: '4 Station Road', stateCode: '27', ...body });
const room = (detail: any, type: string) => detail.stockRooms.find((r: any) => r.type === type).id as string;

describe('outlets (D101)', () => {
  let T: Tenant;
  let admin: { cookie: string };
  let B: any;   // a second outlet in the same state, sharing the store's GSTIN
  let C: any;   // an outlet in Telangana, which needs its own GSTIN
  let v: string;

  beforeAll(async () => {
    T = await makeTenant();
    await setupBilling(T);   // Maharashtra, GSTIN 27…
    admin = await adminSession();
    v = await stockedItem(T.cookie, { price: '100', gstRate: '18', stock: '10' });
  });

  it('a store starts with its main outlet; another needs the console to allow it', async () => {
    const list = await api(T.cookie, 'GET', '/v1/outlets');
    expect(list.status, list.text).toBe(200);
    expect(list.body.items).toEqual([expect.objectContaining({ name: 'Main outlet', isMain: true, active: true, ready: true })]);
    expect(list.body.limit).toMatchObject({ included: 1, extra: 0, allowed: 1, open: 1 });
    expect(list.body.can).toEqual({ manage: true, staff: true });

    const full = await outlet(T, { name: 'KPHB', invoicePrefix: 'KPHB', creditNotePrefix: 'KPCN' });
    expect([full.status, full.body.code]).toEqual([403, 'PLAN_LIMIT']);
    expect(full.body.message).toMatch(/a month/);

    // The store can't raise its own limit: the runtime role has no write on subscriptions.
    await expect(tenantTx(T.tenantId, (tx) => tx.query('UPDATE subscriptions SET extra_outlets = 5'))).rejects.toThrow(/permission denied/);

    const set = await platform(admin.cookie, 'POST', `/tenants/${T.tenantId}/outlets`, { extraOutlets: 2, reason: 'Paid for 2 outlets, UTR 123' });
    expect(set.status, set.text).toBe(200);
    const store = await platform(admin.cookie, 'GET', `/tenants/${T.tenantId}`);
    expect(store.body.outlets).toMatchObject({ extraOutlets: 2, outlets: [{ name: 'Main outlet', main: true, active: true }] });
    expect((await owner.query("SELECT 1 FROM platform_audit WHERE tenant_id = $1 AND action = 'platform.outlets_changed'", [T.tenantId])).rows).toHaveLength(1);
  });

  it('creates an outlet with its own stock rooms and bill series', async () => {
    const res = await outlet(T, { name: 'KPHB Colony', invoicePrefix: 'kphb', creditNotePrefix: 'KPCN', phone: '9876543210' });
    expect(res.status, res.text).toBe(201);
    B = res.body;
    expect(B.outlet).toMatchObject({ name: 'KPHB Colony', isMain: false, invoicePrefix: 'KPHB', creditNotePrefix: 'KPCN' });
    expect(B.ready).toBe(true);
    expect(B.seller).toMatchObject({ address: '4 Station Road', gstin: gstin('27'), phone: '9876543210' });
    expect(B.nextNumbers).toEqual({ invoice: `KPHB/${fy()}/1`, creditNote: `KPCN/${fy()}/1` });
    expect(B.stockRooms.map((r: any) => [r.name, r.type, r.isSellable])).toEqual([
      ['KPHB Colony · Shop floor', 'shop_floor', true], ['KPHB Colony · Back room', 'back_room', true]]);
    expect(B.outlet.posLocationId).toBe(room(B, 'shop_floor'));
    const loc = await api(T.cookie, 'GET', '/v1/locations');
    expect(loc.body.items.filter((l: any) => l.outletId === B.outlet.id)).toHaveLength(2);
    expect((await owner.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'outlet.created'", [T.tenantId])).rows[0].n).toBe(1);
  });

  it('refuses a bill prefix another outlet uses, and a GSTIN of another state or business', async () => {
    const clash = await outlet(T, { name: 'Second', invoicePrefix: 'KPHB', creditNotePrefix: 'S2CN' });
    expect([clash.status, clash.body.fieldErrors?.invoicePrefix]).toEqual([400, ['KPHB Colony uses this prefix']]);
    const main = await outlet(T, { name: 'Second', invoicePrefix: 'INV', creditNotePrefix: 'S2CN' });
    expect(main.body.fieldErrors?.invoicePrefix?.[0]).toMatch(/main outlet/);
    const wrongState = await outlet(T, { name: 'Second', stateCode: '36', gstin: gstin('29'), invoicePrefix: 'S2', creditNotePrefix: 'S2CN' });
    expect(wrongState.body.fieldErrors?.gstin?.[0]).toMatch(/Karnataka/);
    const otherPan = await outlet(T, { name: 'Second', stateCode: '36', gstin: gstin('36', 'BBBPB1234C'), invoicePrefix: 'S2', creditNotePrefix: 'S2CN' });
    expect(otherPan.body.fieldErrors?.gstin?.[0]).toMatch(/different business/);
    const dupName = await outlet(T, { name: 'kphb colony', invoicePrefix: 'S2', creditNotePrefix: 'S2CN' });
    expect(dupName.body.fieldErrors?.name).toEqual(['Another outlet has this name']);
  });

  it('an outlet in another state can be added without its GSTIN, but can’t bill until it has one', async () => {
    const res = await outlet(T, { name: 'Hyderabad', stateCode: '36', invoicePrefix: 'HYD', creditNotePrefix: 'HYDCN', backRoom: false });
    expect(res.status, res.text).toBe(201);
    C = res.body;
    expect(C.ready).toBe(false);
    expect(C.problems.join(' ')).toMatch(/GSTIN/);
    expect(C.stockRooms).toHaveLength(1);
    const sale = await sell(T.cookie, [{ variantId: v, qty: '1' }], { outletId: C.outlet.id });
    expect([sale.status, sale.body.code]).toEqual([409, 'BILLING_NOT_SET_UP']);
    const fixed = await api(T.cookie, 'PATCH', `/v1/outlets/${C.outlet.id}`, { gstin: gstin('36') });
    expect(fixed.status, fixed.text).toBe(200);
    expect(fixed.body).toMatchObject({ ready: true, seller: { gstin: gstin('36'), stateName: 'Telangana' } });
  });

  it('the plan limit counts open outlets; the console can’t lower it below them', async () => {
    const more = await outlet(T, { name: 'Fourth', invoicePrefix: 'F4', creditNotePrefix: 'F4CN' });
    expect([more.status, more.body.code]).toEqual([403, 'PLAN_LIMIT']);
    const lower = await platform(admin.cookie, 'POST', `/tenants/${T.tenantId}/outlets`, { extraOutlets: 1, reason: 'Stopped paying' });
    expect([lower.status, lower.body.code]).toEqual([409, 'NOT_ALLOWED']);
  });

  it('a sale at an outlet uses its series, its stock room and its address and GSTIN', async () => {
    const shopB = room(B, 'shop_floor');
    expect((await adjust(T.cookie, shopB, 'correction', [{ variantId: v, qtyDelta: '5' }], { note: 'opening' })).status).toBe(201);
    const atB = await sell(T.cookie, [{ variantId: v, qty: '2' }], { outletId: B.outlet.id });
    expect(atB.status, atB.text).toBe(201);
    expect(atB.body.invoice).toMatchObject({ number: `KPHB/${fy()}/1`, seller: { address: '4 Station Road', gstin: gstin('27'), stateCode: '27' } });
    const atMain = await sell(T.cookie, [{ variantId: v, qty: '1' }]);
    expect(atMain.body.invoice.number).toBe(`INV/${fy()}/1`);
    expect(atMain.body.invoice.seller).toMatchObject({ address: '12 MG Road' });

    const { shop } = await locations(T.cookie);
    const onHand = async (loc: string) => (await owner.query('SELECT on_hand::text AS q FROM stock_balances WHERE variant_id = $1 AND location_id = $2', [v, loc])).rows[0].q;
    expect([await onHand(shop), await onHand(shopB)].map(Number)).toEqual([9, 3]);

    // Telangana outlet: its own GSTIN, intra-state tax for a walk-in buyer there.
    expect((await adjust(T.cookie, room(C, 'shop_floor'), 'correction', [{ variantId: v, qtyDelta: '2' }], { note: 'opening' })).status).toBe(201);
    const atC = await sell(T.cookie, [{ variantId: v, qty: '1' }], { outletId: C.outlet.id });
    expect(atC.status, atC.text).toBe(201);
    expect(atC.body.invoice).toMatchObject({ number: `HYD/${fy()}/1`, seller: { gstin: gstin('36'), stateCode: '36' }, placeOfSupply: { code: '36' }, supplyType: 'intra' });

    // Each counter's day summary covers its own outlet only.
    const sumB = await api(T.cookie, 'GET', `/v1/pos/summary?outletId=${B.outlet.id}`);
    expect(sumB.body).toMatchObject({ outlet: 'KPHB Colony', sales: 1, salesTotal: '200.00' });
    const sumMain = await api(T.cookie, 'GET', '/v1/pos/summary');
    expect(sumMain.body).toMatchObject({ outlet: 'Main outlet', sales: 1 });

    const detail = await api(T.cookie, 'GET', `/v1/outlets/${B.outlet.id}`);
    expect(detail.body.today).toMatchObject({ bills: 1, sales: '200.00' });
    expect(detail.body.nextNumbers.invoice).toBe(`KPHB/${fy()}/2`);
    const list = await api(T.cookie, 'GET', '/v1/outlets');
    expect(list.body.items.map((o: any) => [o.name, o.today.bills])).toEqual([['Main outlet', 1], ['KPHB Colony', 1], ['Hyderabad', 1]]);
  });

  it('a return is credited from the series of the outlet that made the bill, and restocks there', async () => {
    const sale = await sell(T.cookie, [{ variantId: v, qty: '1' }], { outletId: B.outlet.id });
    expect(sale.status, sale.text).toBe(201);
    const r = await api(T.cookie, 'POST', '/v1/returns', { invoiceId: sale.body.invoiceId, reason: 'Wrong size', refundMethod: 'cash',
      lines: [{ invoiceLineId: sale.body.invoice.lines[0].id, qty: '1', condition: 'resellable' }] }, key());
    expect(r.status, r.text).toBe(201);
    expect(r.body.creditNoteNumber).toBe(`KPCN/${fy()}/1`);
    expect(r.body.creditNote.seller).toMatchObject({ address: '4 Station Road' });
    const q = (await owner.query('SELECT on_hand::text AS q FROM stock_balances WHERE variant_id = $1 AND location_id = $2', [v, room(B, 'shop_floor')])).rows[0].q;
    expect(Number(q)).toBe(3);
  });

  it('moves stock between outlets that share a GSTIN, but not across GST registrations', async () => {
    const { back, shop } = await locations(T.cookie);
    expect((await adjust(T.cookie, back, 'correction', [{ variantId: v, qtyDelta: '4' }], { note: 'opening' })).status).toBe(201);
    const ok = await api(T.cookie, 'POST', '/v1/stock/transfers', { fromLocationId: back, toLocationId: room(B, 'back_room'), lines: [{ variantId: v, qty: '1' }] });
    expect(ok.status, ok.text).toBe(201);
    const across = await api(T.cookie, 'POST', '/v1/stock/transfers', { fromLocationId: shop, toLocationId: room(C, 'shop_floor'), lines: [{ variantId: v, qty: '1' }] });
    expect([across.status, across.body.code]).toEqual([409, 'TRANSFER_NEEDS_INVOICE']);
  });

  it('cashiers sell only at the outlets they are assigned to; owners and managers everywhere', async () => {
    const cashier = await makeUser(T.tenantId, 'cashier');
    const manager = await makeUser(T.tenantId, 'manager');
    // Not assigned anywhere: every open outlet, main first.
    expect((await api(cashier.cookie, 'GET', '/v1/pos/context')).body.outlets.map((o: any) => o.name)).toEqual(['Main outlet', 'KPHB Colony', 'Hyderabad']);
    const staff = await api(T.cookie, 'PUT', `/v1/outlets/${B.outlet.id}/staff`, { userIds: [cashier.userId, manager.userId] });
    expect(staff.status, staff.text).toBe(200);
    expect(staff.body.staff.filter((s: any) => s.assigned).map((s: any) => s.id)).toEqual([cashier.userId]);   // managers work everywhere
    const ctx = await api(cashier.cookie, 'GET', '/v1/pos/context');
    expect([ctx.body.outlet.name, ctx.body.outlets.length]).toEqual(['KPHB Colony', 1]);
    const there = await sell(cashier.cookie, [{ variantId: v, qty: '1' }]);
    expect(there.status, there.text).toBe(201);
    expect(there.body.invoice.number).toMatch(/^KPHB\//);
    const main = (await api(T.cookie, 'GET', '/v1/outlets')).body.items.find((o: any) => o.isMain).id;
    const elsewhere = await sell(cashier.cookie, [{ variantId: v, qty: '1' }], { outletId: main });
    expect([elsewhere.status, elsewhere.body.code]).toEqual([403, 'OUTLET_NOT_ALLOWED']);
    expect((await api(manager.cookie, 'GET', '/v1/pos/context')).body.outlets).toHaveLength(3);
    // Cashiers don't manage outlets.
    expect((await api(cashier.cookie, 'GET', '/v1/outlets')).status).toBe(403);
    expect((await api(manager.cookie, 'POST', '/v1/outlets', { name: 'X', address: '1 Road', stateCode: '27', invoicePrefix: 'X', creditNotePrefix: 'XCN' })).status).toBe(403);
    expect((await api(manager.cookie, 'GET', '/v1/outlets')).body.can).toEqual({ manage: false, staff: false });
  });

  it('closing an outlet stops its counter and frees a place in the plan; the main outlet stays open', async () => {
    const mainId = (await api(T.cookie, 'GET', '/v1/outlets')).body.items.find((o: any) => o.isMain).id;
    const closeMain = await api(T.cookie, 'PATCH', `/v1/outlets/${mainId}`, { active: false });
    expect([closeMain.status, closeMain.body.code]).toEqual([400, 'MAIN_OUTLET']);
    expect((await api(T.cookie, 'PATCH', `/v1/outlets/${mainId}`, { name: 'Ameerpet' })).body.outlet.name).toBe('Ameerpet');

    const closed = await api(T.cookie, 'PATCH', `/v1/outlets/${C.outlet.id}`, { active: false });
    expect(closed.status, closed.text).toBe(200);
    const sale = await sell(T.cookie, [{ variantId: v, qty: '1' }], { outletId: C.outlet.id });
    expect([sale.status, sale.body.code]).toEqual([403, 'OUTLET_NOT_ALLOWED']);
    expect((await platform(admin.cookie, 'POST', `/tenants/${T.tenantId}/outlets`, { extraOutlets: 1, reason: 'One outlet closed' })).status).toBe(200);
    const reopen = await api(T.cookie, 'PATCH', `/v1/outlets/${C.outlet.id}`, { active: true });
    expect([reopen.status, reopen.body.code]).toEqual([403, 'PLAN_LIMIT']);
  });

  it('another store sees none of this', async () => {
    const other = await makeTenant();
    expect((await api(other.cookie, 'GET', `/v1/outlets/${B.outlet.id}`)).status).toBe(404);
    expect((await api(other.cookie, 'PATCH', `/v1/outlets/${B.outlet.id}`, { name: 'Mine' })).status).toBe(404);
    expect((await api(other.cookie, 'PUT', `/v1/outlets/${B.outlet.id}/staff`, { userIds: [] })).status).toBe(404);
    expect((await sell(other.cookie, [{ variantId: v, qty: '1' }], { outletId: B.outlet.id })).status).toBeGreaterThanOrEqual(400);
    const list = await api(other.cookie, 'GET', '/v1/outlets');
    expect(list.body.items.map((o: any) => o.name)).toEqual(['Main outlet']);
  });
});

describe('search suggestions (D102)', () => {
  it('limits hits to the kinds asked for, and to what the role may open', async () => {
    const T = await makeTenant();
    await setupBilling(T);
    const v = await stockedItem(T.cookie, { price: '50', stock: '5' });
    await owner.query("UPDATE products SET name = 'Zari saree' WHERE id = (SELECT product_id FROM product_variants WHERE id = $1)", [v]);
    const c = await api(T.cookie, 'POST', '/v1/customers', { name: 'Zainab Khan', phone: '9876512345' });
    expect(c.status, c.text).toBe(201);
    const s = await api(T.cookie, 'POST', '/v1/suppliers', { name: 'Zenith Mills' });
    expect(s.status, s.text).toBe(201);
    const sale = await sell(T.cookie, [{ variantId: v, qty: '1' }], { customerId: c.body.id });
    expect(sale.status, sale.text).toBe(201);

    const all = await api(T.cookie, 'GET', '/v1/search?q=za');
    expect(all.body.items.map((h: any) => h.type).sort()).toEqual(['customer', 'invoice', 'product']);
    const cust = await api(T.cookie, 'GET', '/v1/search?q=za&kinds=customer');
    expect(cust.body.items).toEqual([expect.objectContaining({ type: 'customer', title: 'Zainab Khan', subtitle: '9876512345', href: `/contacts/customers/${c.body.id}` })]);
    expect((await api(T.cookie, 'GET', '/v1/search?q=98765&kinds=customer')).body.items).toHaveLength(1);
    const sup = await api(T.cookie, 'GET', '/v1/search?q=zen&kinds=supplier');
    expect(sup.body.items[0]).toMatchObject({ title: 'Zenith Mills', href: `/contacts/suppliers/${s.body.id}` });
    expect((await api(T.cookie, 'GET', `/v1/search?q=${encodeURIComponent(sale.body.invoice.number)}&kinds=invoice,return`)).body.items.map((h: any) => h.type)).toEqual(['invoice']);
    expect((await api(T.cookie, 'GET', '/v1/search?q=za&kinds=wrong')).status).toBe(400);
    expect((await api(T.cookie, 'GET', '/v1/search?q=z')).status).toBe(400);

    const cashier = await makeUser(T.tenantId, 'cashier');
    expect((await api(cashier.cookie, 'GET', '/v1/search?q=za&kinds=customer,supplier')).body.items).toEqual([]);
    expect((await api(cashier.cookie, 'GET', '/v1/search?q=za&kinds=product')).body.items).toHaveLength(1);
  });
});
