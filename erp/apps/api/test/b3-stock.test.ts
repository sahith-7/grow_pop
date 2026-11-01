import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, tenantTx } from '../src/db.js';
import { api } from './b2-api.js';
import { getApp, makeTenant, makeUser, owner } from './b2-helpers.js';
import { adjust, key, locations, makeItem, onHand } from './b3-helpers.js';

let A: Awaited<ReturnType<typeof makeTenant>>;
let B: Awaited<ReturnType<typeof makeTenant>>;
let locA: Awaited<ReturnType<typeof locations>>;
let manager: { cookie: string };
let inventory: { cookie: string };
let cashier: { cookie: string };
let fulfilment: { cookie: string };

beforeAll(async () => {
  A = await makeTenant();
  B = await makeTenant();
  locA = await locations(A.cookie);
  manager = await makeUser(A.tenantId, 'manager');
  inventory = await makeUser(A.tenantId, 'inventory');
  cashier = await makeUser(A.tenantId, 'cashier');
  fulfilment = await makeUser(A.tenantId, 'fulfillment');
});
afterAll(async () => { await (await getApp()).close(); await owner.end(); });

describe('locations', () => {
  it('a new store gets Shop floor and Back room, both sellable', async () => {
    expect(locA.all.map((l) => l.name)).toEqual(['Shop floor', 'Back room']);
    expect(locA.all.every((l: any) => l.isSellable && l.active)).toBe(true);
  });

  it('only the owner manages locations; a quarantine location is never sellable', async () => {
    expect((await api(manager.cookie, 'POST', '/v1/locations', { name: 'Godown', type: 'back_room' })).status).toBe(403);
    const q = await api(A.cookie, 'POST', '/v1/locations', { name: 'Damaged bin', type: 'quarantine', isSellable: true });
    expect(q.status).toBe(201);
    expect(q.body.isSellable).toBe(false);
    expect((await api(A.cookie, 'POST', '/v1/locations', { name: 'damaged BIN', type: 'back_room' })).body.code).toBe('NAME_DUPLICATE');
  });

  it('a location holding stock cannot be deactivated', async () => {
    const loc = (await api(A.cookie, 'POST', '/v1/locations', { name: 'Counter 2', type: 'shop_floor' })).body;
    const v = await makeItem(A.cookie);
    expect((await adjust(A.cookie, loc.id, 'opening', [{ variantId: v, qtyDelta: '3' }])).status).toBe(201);
    expect((await api(A.cookie, 'PATCH', `/v1/locations/${loc.id}`, { active: false })).body.code).toBe('LOCATION_HAS_STOCK');
  });
});

describe('adjustments and write-offs (INV-04, INV-08, AC-16)', () => {
  it('opening stock posts a ledger row with before/after, actor and reason, and an audit event', async () => {
    const v = await makeItem(A.cookie);
    const res = await adjust(inventory.cookie, locA.shop, 'opening', [{ variantId: v, qtyDelta: '10', unitCost: '42.5' }]);
    expect(res.status, res.text).toBe(201);
    expect(res.body.number).toMatch(/^ADJ-\d{5}$/);
    const [m] = res.body.movements;
    expect(m).toMatchObject({ movementType: 'opening', qtyDelta: '10', balanceBefore: '0', balanceAfter: '10', reasonCode: 'opening', bucket: 'sellable' });
    expect(m.actor.id).toBeTruthy();
    expect((await onHand(A.cookie, v, locA.shop)).onHand).toBe('10');
    const variant = await tenantTx(A.tenantId, (t) => t.query('SELECT cost FROM product_variants WHERE id = $1', [v]));
    expect(variant.rows[0].cost).toBe('42.5000');
    const a = await tenantTx(A.tenantId, (t) => t.query("SELECT summary FROM audit_events WHERE action = 'stock.adjusted' AND entity_id = $1", [res.body.id]));
    expect(a.rows[0].summary.lines[0]).toMatchObject({ before: '0', after: '10', delta: '10' });
  });

  it('blocks negative sellable stock by default; only the owner can override, with a note, and it is audited', async () => {
    const v = await makeItem(A.cookie);
    await adjust(A.cookie, locA.shop, 'opening', [{ variantId: v, qtyDelta: '2' }]);
    const over = await adjust(manager.cookie, locA.shop, 'correction', [{ variantId: v, qtyDelta: '-3' }]);
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('INSUFFICIENT_STOCK');
    expect(over.body.fieldErrors['lines.0.qtyDelta']).toEqual(['Only 2 available']);
    expect((await adjust(manager.cookie, locA.shop, 'correction', [{ variantId: v, qtyDelta: '-3' }], { overrideNegative: true, note: 'sold before entry' })).status).toBe(403);
    expect((await adjust(A.cookie, locA.shop, 'correction', [{ variantId: v, qtyDelta: '-3' }], { overrideNegative: true })).status).toBe(400);
    const ok = await adjust(A.cookie, locA.shop, 'correction', [{ variantId: v, qtyDelta: '-3' }], { overrideNegative: true, note: 'sold before entry' });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body.movements[0].balanceAfter).toBe('-1');
    const a = await tenantTx(A.tenantId, (t) => t.query("SELECT 1 FROM audit_events WHERE action = 'stock.negative_override' AND entity_id = $1", [ok.body.id]));
    expect(a.rowCount).toBe(1);
  });

  it('write-offs need stock.writeoff (inventory staff cannot) and must remove stock', async () => {
    const v = await makeItem(A.cookie);
    await adjust(A.cookie, locA.shop, 'opening', [{ variantId: v, qtyDelta: '5' }]);
    expect((await adjust(inventory.cookie, locA.shop, 'damage', [{ variantId: v, qtyDelta: '-1' }])).status).toBe(403);
    expect((await adjust(manager.cookie, locA.shop, 'damage', [{ variantId: v, qtyDelta: '1' }])).status).toBe(400);
    const w = await adjust(manager.cookie, locA.shop, 'expiry', [{ variantId: v, qtyDelta: '-1' }]);
    expect(w.status).toBe(201);
    expect(w.body.movements[0].movementType).toBe('writeoff');
  });

  it('whole-unit items reject fractions; kg items accept them', async () => {
    const pcs = await makeItem(A.cookie);
    const kg = await makeItem(A.cookie, undefined, {}, 'KGS');
    expect((await adjust(A.cookie, locA.shop, 'opening', [{ variantId: pcs, qtyDelta: '1.5' }])).status).toBe(400);
    const r = await adjust(A.cookie, locA.shop, 'opening', [{ variantId: kg, qtyDelta: '1.255' }]);
    expect(r.status).toBe(201);
    await adjust(A.cookie, locA.shop, 'correction', [{ variantId: kg, qtyDelta: '-0.005' }]);
    expect((await onHand(A.cookie, kg, locA.shop)).onHand).toBe('1.25');
  });

  it('cashiers have no stock access; fulfilment can read stock but not cost or adjust', async () => {
    expect((await api(cashier.cookie, 'GET', '/v1/stock/balances')).status).toBe(403);
    expect((await api(cashier.cookie, 'GET', '/v1/stock/movements')).status).toBe(403);
    const v = await makeItem(A.cookie, undefined, { cost: '50' });
    await adjust(A.cookie, locA.shop, 'opening', [{ variantId: v, qtyDelta: '4' }]);
    const list = await api(fulfilment.cookie, 'GET', '/v1/stock/balances?limit=100');
    expect(list.status).toBe(200);
    const row = list.body.items.find((r: any) => r.variantId === v);
    expect(row.onHand).toBe('4');
    expect(row).not.toHaveProperty('value');
    expect(row).not.toHaveProperty('cost');
    const mine = await api(A.cookie, 'GET', '/v1/stock/balances?limit=100');
    expect(mine.body.items.find((r: any) => r.variantId === v).value).toBe('200.00');
    expect((await adjust(fulfilment.cookie, locA.shop, 'correction', [{ variantId: v, qtyDelta: '1' }])).status).toBe(403);
  });

  it('a double-clicked post with the same Idempotency-Key posts once', async () => {
    const v = await makeItem(A.cookie);
    const headers = key();
    const body = { locationId: locA.shop, reasonCode: 'opening', lines: [{ variantId: v, qtyDelta: '7' }] };
    const [r1, r2] = await Promise.all([api(A.cookie, 'POST', '/v1/stock/adjustments', body, headers), api(A.cookie, 'POST', '/v1/stock/adjustments', body, headers)]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r1.body.id).toBe(r2.body.id);
    expect((await onHand(A.cookie, v, locA.shop)).onHand).toBe('7');
  });
});

describe('transfers and reversals (INV-06, INV-09)', () => {
  it('moves stock between locations in one transaction and keeps the total', async () => {
    const v = await makeItem(A.cookie);
    await adjust(A.cookie, locA.back, 'opening', [{ variantId: v, qtyDelta: '10' }]);
    const t = await api(inventory.cookie, 'POST', '/v1/stock/transfers', { fromLocationId: locA.back, toLocationId: locA.shop, lines: [{ variantId: v, qty: '4' }] });
    expect(t.status, t.text).toBe(201);
    expect(t.body.movements.map((m: any) => [m.movementType, m.qtyDelta])).toEqual([['transfer_out', '-4'], ['transfer_in', '4']]);
    expect((await onHand(A.cookie, v, locA.back)).onHand).toBe('6');
    expect((await onHand(A.cookie, v, locA.shop)).onHand).toBe('4');
    expect((await onHand(A.cookie, v)).onHand).toBe('10');
    const tooMuch = await api(inventory.cookie, 'POST', '/v1/stock/transfers', { fromLocationId: locA.back, toLocationId: locA.shop, lines: [{ variantId: v, qty: '7' }] });
    expect(tooMuch.body.code).toBe('INSUFFICIENT_STOCK');
    expect((await onHand(A.cookie, v)).onHand).toBe('10');
  });

  it('reverses a whole document once, with linked rows, and keeps the original rows', async () => {
    const v = await makeItem(A.cookie);
    await adjust(A.cookie, locA.back, 'opening', [{ variantId: v, qtyDelta: '10' }]);
    const t = await api(A.cookie, 'POST', '/v1/stock/transfers', { fromLocationId: locA.back, toLocationId: locA.shop, lines: [{ variantId: v, qty: '3' }] });
    const r = await api(A.cookie, 'POST', `/v1/stock/movements/${t.body.movements[0].id}/reverse`, { note: 'wrong shelf' });
    expect(r.status, r.text).toBe(201);
    expect(r.body.movements.every((m: any) => m.movementType === 'reversal' && m.reversalOfId)).toBe(true);
    expect((await onHand(A.cookie, v, locA.back)).onHand).toBe('10');
    expect((await onHand(A.cookie, v, locA.shop)).onHand).toBe('0');
    expect((await api(A.cookie, 'POST', `/v1/stock/movements/${t.body.movements[1].id}/reverse`, { note: 'again' })).body.code).toBe('ALREADY_REVERSED');
    const hist = await api(A.cookie, 'GET', `/v1/stock/movements?sourceId=${t.body.id}`);
    expect(hist.body.items).toHaveLength(4);
    expect(hist.body.items.filter((m: any) => m.reversedById)).toHaveLength(2);
  });
});

describe('ledger integrity (INV-03, INV-10)', () => {
  it('concurrent sales-like decrements never take stock below zero, and balances always equal the ledger', async () => {
    const v = await makeItem(A.cookie);
    await adjust(A.cookie, locA.shop, 'opening', [{ variantId: v, qtyDelta: '5' }]);
    const results = await Promise.all(Array.from({ length: 12 }, () => adjust(A.cookie, locA.shop, 'correction', [{ variantId: v, qtyDelta: '-1' }])));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    expect((await onHand(A.cookie, v, locA.shop)).onHand).toBe('0');
    expect((await api(A.cookie, 'GET', '/v1/stock/reconciliation')).body.mismatches).toEqual([]);
  });

  it('opposite-order multi-line documents do not deadlock', async () => {
    const v1 = await makeItem(A.cookie), v2 = await makeItem(A.cookie);
    await adjust(A.cookie, locA.shop, 'opening', [{ variantId: v1, qtyDelta: '50' }, { variantId: v2, qtyDelta: '50' }]);
    const runs = Array.from({ length: 10 }, (_, i) => adjust(A.cookie, locA.shop, 'correction',
      i % 2 ? [{ variantId: v1, qtyDelta: '-1' }, { variantId: v2, qtyDelta: '-1' }] : [{ variantId: v2, qtyDelta: '-1' }, { variantId: v1, qtyDelta: '-1' }]));
    expect((await Promise.all(runs)).every((r) => r.status === 201)).toBe(true);
    expect((await onHand(A.cookie, v1, locA.shop)).onHand).toBe('40');
  });

  it('the runtime role cannot change or delete ledger rows', async () => {
    await expect(tenantTx(A.tenantId, (t) => t.query('UPDATE stock_ledger SET qty_delta = 1'))).rejects.toThrow(/permission denied/);
    await expect(tenantTx(A.tenantId, (t) => t.query('DELETE FROM stock_ledger'))).rejects.toThrow(/permission denied/);
    await expect(tenantTx(A.tenantId, (t) => t.query('DELETE FROM stock_balances'))).rejects.toThrow(/permission denied/);
  });
});

describe('tenant isolation (AC-01)', () => {
  it("another store's location or product cannot be used, and its stock is invisible", async () => {
    const vA = await makeItem(A.cookie);
    await adjust(A.cookie, locA.shop, 'opening', [{ variantId: vA, qtyDelta: '9' }]);
    const locB = await locations(B.cookie);
    expect((await adjust(B.cookie, locA.shop, 'opening', [{ variantId: vA, qtyDelta: '1' }])).status).toBe(400);
    expect((await adjust(B.cookie, locB.shop, 'opening', [{ variantId: vA, qtyDelta: '1' }])).status).toBe(400);
    expect((await api(B.cookie, 'GET', '/v1/stock/balances?limit=100')).body.items.find((r: any) => r.variantId === vA)).toBeUndefined();
    expect((await api(B.cookie, 'GET', `/v1/stock/movements?variantId=${vA}`)).body.items).toEqual([]);
    expect((await pool.query('SELECT count(*)::int AS n FROM stock_ledger')).rows[0].n).toBe(0);
  });
});

describe('opening stock CSV', () => {
  const upload = async (cookie: string, csv: string) =>
    (await api(cookie, 'POST', '/v1/files?kind=import&name=opening.csv', Buffer.from(csv), { 'content-type': 'text/csv' })).body.fileId as string;

  it('previews, refuses files with any error, and posts one opening adjustment per location', async () => {
    const s1 = `OP-${Date.now()}-A`, s2 = `OP-${Date.now()}-B`;
    await makeItem(A.cookie, s1);
    await makeItem(A.cookie, s2);
    const bad = await upload(A.cookie, `SKU,Qty,Location,Unit Cost\n${s1},5,Shop floor,10\n${s2},x,,\nNOPE,1,,\n`);
    const preview = await api(A.cookie, 'POST', '/v1/stock/opening-import', { fileId: bad, locationId: locA.shop, commit: true });
    expect(preview.status, preview.text).toBe(201);
    expect(preview.body.posted).toEqual([]);
    expect(preview.body.errors.map((e: any) => [e.row, e.column])).toEqual([[3, 'qty'], [4, 'sku']]);

    const good = await upload(A.cookie, `sku,qty,location,unit_cost\n${s1},5,Shop floor,10\n${s2},"1,200",back room,₹20\n`);
    const dry = await api(A.cookie, 'POST', '/v1/stock/opening-import', { fileId: good, locationId: locA.shop });
    expect(dry.body).toMatchObject({ validRows: 2, errorCount: 0, posted: [] });
    const done = await api(A.cookie, 'POST', '/v1/stock/opening-import', { fileId: good, locationId: locA.shop, commit: true }, key());
    expect(done.body.posted).toHaveLength(2);
    const again = await api(A.cookie, 'POST', '/v1/stock/opening-import', { fileId: good, locationId: locA.shop, commit: true }, key());
    expect(again.body.posted).toEqual([]);
    expect(again.body.errors[0].message).toMatch(/already has stock history/);
  });

  it('cashiers cannot import opening stock', async () => {
    expect((await api(cashier.cookie, 'POST', '/v1/stock/opening-import', { fileId: '00000000-0000-4000-8000-000000000000', locationId: locA.shop })).status).toBe(403);
  });
});
