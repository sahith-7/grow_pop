import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './b2-api.js';
import { makeTenant, makeUser } from './b2-helpers.js';
import { adjust, key, locations } from './b3-helpers.js';
import { sell, setupBilling, stockedItem } from './b5-helpers.js';
import { adminSession } from './b7-helpers.js';

// GroPop v2: the owner's outlet switcher (D115). One outlet, or all, is "in view" through the gp_outlet cookie; every
// back-office read that belongs to an outlet follows it. Staff tied to outlets see only theirs, whatever the cookie says.

type Tenant = Awaited<ReturnType<typeof makeTenant>>;
const at = (cookie: string, outletId: string | null) => (outletId ? `${cookie}; gp_outlet=${outletId}` : cookie);

describe('the outlet in view (D115)', () => {
  let T: Tenant;
  let main: string;
  let B: { id: string; shop: string; back: string };
  let mainShop: string;
  let v: string;
  const bills: Record<string, string> = {};

  beforeAll(async () => {
    T = await makeTenant();
    await setupBilling(T);
    const admin = await adminSession();
    expect((await api(admin.cookie, 'POST', `/v1/platform/tenants/${T.tenantId}/outlets`, { extraOutlets: 1, reason: 'Switcher test' })).status).toBe(200);
    const made = await api(T.cookie, 'POST', '/v1/outlets', { name: 'KPHB Colony', address: '4 Station Road', stateCode: '27', invoicePrefix: 'KPHB', creditNotePrefix: 'KPCN' });
    expect(made.status, made.text).toBe(201);
    const room = (type: string) => made.body.stockRooms.find((r: any) => r.type === type).id as string;
    B = { id: made.body.outlet.id, shop: room('shop_floor'), back: room('back_room') };
    main = (await api(T.cookie, 'GET', '/v1/outlets')).body.items.find((o: any) => o.isMain).id;
    mainShop = (await locations(T.cookie)).shop;
    v = await stockedItem(T.cookie, { price: '100', gstRate: '18', stock: '10' });   // 10 at the main shop floor
    const moved = await api(T.cookie, 'POST', '/v1/stock/transfers', { fromLocationId: mainShop, toLocationId: B.shop, lines: [{ variantId: v, qty: '4' }] }, key());
    expect(moved.status, moved.text).toBe(201);
    const a = await sell(T.cookie, [{ variantId: v, qty: '1' }], { outletId: main });
    const b = await sell(T.cookie, [{ variantId: v, qty: '2' }], { outletId: B.id });
    expect([a.status, b.status], a.text + b.text).toEqual([201, 201]);
    bills.main = a.body.invoice.number; bills.B = b.body.invoice.number;
  });

  it('the account says which outlets there are and which is in view; a bad cookie means all', async () => {
    const me = await api(T.cookie, 'GET', '/v1/auth/me');
    expect(me.body.outlets).toEqual({ all: true, current: null, items: [
      { id: main, name: 'Main outlet', isMain: true, active: true }, { id: B.id, name: 'KPHB Colony', isMain: false, active: true }] });
    expect((await api(at(T.cookie, B.id), 'GET', '/v1/auth/me')).body.outlets.current).toBe(B.id);
    expect((await api(at(T.cookie, 'not-an-id'), 'GET', '/v1/auth/me')).body.outlets.current).toBeNull();
    // Another store's outlet is just unknown here.
    const other = await makeTenant();
    const theirMain = (await api(other.cookie, 'GET', '/v1/auth/me')).body.outlets.items[0].id;
    expect((await api(at(T.cookie, theirMain), 'GET', '/v1/auth/me')).body.outlets.current).toBeNull();
    const leak = await api(at(T.cookie, theirMain), 'GET', '/v1/invoices?type=invoice');
    expect(leak.body.items.map((i: any) => i.number).sort()).toEqual([bills.B, bills.main].sort());
  });

  it('bills, returns, orders and the dashboard follow the outlet', async () => {
    const numbers = async (outlet: string | null) => (await api(at(T.cookie, outlet), 'GET', '/v1/invoices?type=invoice')).body.items.map((i: any) => i.number);
    expect((await numbers(null)).sort()).toEqual([bills.B, bills.main].sort());
    expect(await numbers(B.id)).toEqual([bills.B]);
    expect(await numbers(main)).toEqual([bills.main]);
    expect(bills.B).toMatch(/^KPHB\//);

    const orders = await api(at(T.cookie, B.id), 'GET', '/v1/orders');
    expect(orders.body.items).toHaveLength(1);

    const inv = (await api(T.cookie, 'GET', '/v1/invoices?type=invoice')).body.items.find((i: any) => i.number === bills.B);
    const doc = (await api(T.cookie, 'GET', `/v1/invoices/${inv.id}`)).body;
    const ret = await api(T.cookie, 'POST', '/v1/returns', { invoiceId: inv.id, reason: 'Wrong size', refundMethod: 'none',
      lines: [{ invoiceLineId: doc.lines[0].id, qty: '1', condition: 'resellable' }] }, key());
    expect(ret.status, ret.text).toBe(201);
    expect((await api(at(T.cookie, B.id), 'GET', '/v1/returns')).body.items).toHaveLength(1);
    expect((await api(at(T.cookie, main), 'GET', '/v1/returns')).body.items).toHaveLength(0);

    const tiles = async (outlet: string | null) => (await api(at(T.cookie, outlet), 'GET', '/v1/dashboard')).body;
    expect((await tiles(B.id))).toMatchObject({ outletId: B.id, outletName: 'KPHB Colony', sales: { invoicesToday: 1 } });
    expect((await tiles(main)).sales.invoicesToday).toBe(1);
    expect((await tiles(null))).toMatchObject({ outletId: null, sales: { invoicesToday: 2 } });

    const ov = async (outlet: string | null, qs = '') => api(at(T.cookie, outlet), 'GET', `/v1/dashboard/overview${qs}`);
    const tile = (r: any, k: string) => r.body.tiles.find((t: any) => t.key === k)?.value;
    expect(tile(await ov(B.id), 'invoices')).toBe('1');
    expect(tile(await ov(null), 'invoices')).toBe('2');
    expect(tile(await ov(B.id), 'stockQty')).toBe('3');           // 4 moved in, 2 sold, 1 back
    expect((await ov(B.id)).body.locations.map((l: any) => l.id).sort()).toEqual([B.shop, B.back].sort());
    const wrongRoom = await ov(B.id, `?locationId=${mainShop}`);
    expect([wrongRoom.status, wrongRoom.body.fieldErrors?.locationId]).toEqual([400, ["This stock room isn't at KPHB Colony"]]);
  });

  it('stock, movements, products and reports follow the outlet', async () => {
    const row = async (outlet: string | null) => (await api(at(T.cookie, outlet), 'GET', '/v1/stock/balances?limit=100')).body.items.find((r: any) => r.variantId === v);
    expect((await row(null)).onHand).toBe('8');
    expect((await row(B.id)).onHand).toBe('3');
    expect((await row(main)).onHand).toBe('5');

    const moves = (await api(at(T.cookie, B.id), 'GET', `/v1/stock/movements?variantId=${v}`)).body.items;
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m: any) => [B.shop, B.back].includes(m.locationId))).toBe(true);

    const product = async (outlet: string | null) => (await api(at(T.cookie, outlet), 'GET', '/v1/products?limit=100')).body.items.find((p: any) => p.skus.length && p.stock);
    expect((await product(B.id)).stock.free).toBe('3');
    expect((await product(null)).stock.free).toBe('8');

    const sales = await api(at(T.cookie, B.id), 'GET', '/v1/reports/sales');
    expect(sales.status, sales.text).toBe(200);
    expect(sales.body).toMatchObject({ outletId: B.id, outletName: 'KPHB Colony', totals: { invoices: 1, credit_notes: 1 } });
    expect((await api(T.cookie, 'GET', '/v1/reports/sales')).body.totals).toMatchObject({ invoices: 2, credit_notes: 1 });
    const inv = await api(at(T.cookie, main), 'GET', '/v1/reports/inventory-summary');
    expect(inv.body.rows.find((r: any) => r.on_hand !== '0')?.on_hand).toBe('5');
    const csv = await api(at(T.cookie, B.id), 'GET', '/v1/reports/inventory-summary?format=csv');
    expect(csv.headers['content-disposition']).toMatch(/inventory-summary_kphb-colony_\d{4}-\d{2}-\d{2}\.csv/);
    const wrongRoom = await api(at(T.cookie, B.id), 'GET', `/v1/reports/stock-movements?locationId=${mainShop}`);
    expect(wrongRoom.status).toBe(400);
  });

  it('cash pages follow the outlet unless they name one', async () => {
    const tills = async (outlet: string | null) => (await api(at(T.cookie, outlet), 'GET', '/v1/tills')).body.items.map((t: any) => t.outletId);
    expect(new Set(await tills(null))).toEqual(new Set([main, B.id]));
    expect(await tills(B.id)).toEqual([B.id]);
    expect((await api(at(T.cookie, B.id), 'GET', `/v1/tills?outletId=${main}`)).body.items.map((t: any) => t.outletId)).toEqual([main]);
    const book = await api(at(T.cookie, B.id), 'GET', '/v1/cash-book');
    expect(book.status, book.text).toBe(200);
  });

  it('staff tied to an outlet see only it, whatever the cookie says, and post stock only there', async () => {
    const clerk = await makeUser(T.tenantId, 'inventory');
    const free = await makeUser(T.tenantId, 'inventory');
    const tied = await api(T.cookie, 'PUT', `/v1/outlets/${B.id}/staff`, { userIds: [clerk.userId] });
    expect(tied.status, tied.text).toBe(200);
    // The outlet page redraws from this answer, so it carries what the page reads (it crashed without `can`).
    expect([tied.body.can, tied.body.states?.length > 30, tied.body.staff.find((s: any) => s.id === clerk.userId)?.assigned]).toEqual([{ manage: true, staff: true }, true, true]);

    const me = (await api(clerk.cookie, 'GET', '/v1/auth/me')).body.outlets;
    expect(me).toEqual({ all: false, current: B.id, items: [{ id: B.id, name: 'KPHB Colony', isMain: false, active: true }] });
    expect((await api(at(clerk.cookie, main), 'GET', '/v1/auth/me')).body.outlets.current).toBe(B.id);
    const stock = async (cookie: string) => (await api(cookie, 'GET', '/v1/stock/balances?limit=100')).body.items.find((r: any) => r.variantId === v).onHand;
    expect(await stock(clerk.cookie)).toBe('3');
    expect(await stock(at(clerk.cookie, main))).toBe('3');
    expect(await stock(free.cookie)).toBe('8');   // assigned nowhere: works everywhere

    const there = await adjust(clerk.cookie, mainShop, 'correction', [{ variantId: v, qtyDelta: '1' }], { note: 'wrong shop' });
    expect([there.status, there.body.fieldErrors?.locationId]).toEqual([400, ['This stock room is at an outlet you are not assigned to']]);
    const here = await adjust(clerk.cookie, B.back, 'correction', [{ variantId: v, qtyDelta: '1' }], { note: 'found one' });
    expect(here.status, here.text).toBe(201);
    // Stock may go from their outlet to another, not the other way.
    const out = await api(clerk.cookie, 'POST', '/v1/stock/transfers', { fromLocationId: B.back, toLocationId: mainShop, lines: [{ variantId: v, qty: '1' }] }, key());
    expect(out.status, out.text).toBe(201);
    const back = await api(clerk.cookie, 'POST', '/v1/stock/transfers', { fromLocationId: mainShop, toLocationId: B.back, lines: [{ variantId: v, qty: '1' }] }, key());
    expect([back.status, back.body.fieldErrors?.fromLocationId?.[0]]).toEqual([400, 'This stock room is at an outlet you are not assigned to']);
    const count = await api(clerk.cookie, 'POST', '/v1/stocktakes', { locationId: mainShop, categoryIds: [], blind: false });
    expect(count.status).toBe(400);
  });

  it('signing out forgets the outlet in view, so the next person starts at all outlets', async () => {
    const u = await makeUser(T.tenantId, 'manager');
    const out = await api(at(u.cookie, B.id), 'POST', '/v1/auth/logout');
    expect(out.status).toBe(200);
    const set = ([] as string[]).concat((out.headers['set-cookie'] as string | string[]) ?? []);
    expect(set.some((c) => /^gp_outlet=;/.test(c))).toBe(true);
  });
});
