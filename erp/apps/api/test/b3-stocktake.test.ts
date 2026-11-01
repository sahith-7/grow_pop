import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api } from './b2-api.js';
import { getApp, makeTenant, makeUser, owner } from './b2-helpers.js';
import { adjust, key, locations, makeItem, onHand } from './b3-helpers.js';

let A: Awaited<ReturnType<typeof makeTenant>>;
let loc: Awaited<ReturnType<typeof locations>>;
let counter: { cookie: string };
let manager: { cookie: string };

beforeAll(async () => {
  A = await makeTenant();
  loc = await locations(A.cookie);
  counter = await makeUser(A.tenantId, 'inventory');
  manager = await makeUser(A.tenantId, 'manager');
});
afterAll(async () => { await (await getApp()).close(); await owner.end(); });

const line = (st: any, variantId: string) => st.lines.find((l: any) => l.variantId === variantId);

describe('stocktake (INV-05, AC-06)', () => {
  it('blind count by staff, approval by a manager, variance posted as a traceable movement; prior ledger intact', async () => {
    const a = await makeItem(A.cookie), b = await makeItem(A.cookie), c = await makeItem(A.cookie);
    await adjust(A.cookie, loc.back, 'opening', [{ variantId: a, qtyDelta: '10' }, { variantId: b, qtyDelta: '5' }, { variantId: c, qtyDelta: '8' }]);
    const before = await api(A.cookie, 'GET', '/v1/stock/movements?locationId=' + loc.back);

    const st = await api(counter.cookie, 'POST', '/v1/stocktakes', { locationId: loc.back });
    expect(st.status, st.text).toBe(201);
    expect(st.body.number).toMatch(/^ST-\d{5}$/);
    expect(st.body.canSeeExpected).toBe(false);
    expect(line(st.body, a)).not.toHaveProperty('expectedQty');
    expect((await api(counter.cookie, 'POST', '/v1/stocktakes', { locationId: loc.back })).body.code).toBe('STOCKTAKE_OPEN');

    // Scans add; a typed count sets. c is never counted.
    for (let i = 0; i < 9; i++) await api(counter.cookie, 'PUT', `/v1/stocktakes/${st.body.id}/counts`, { counts: [{ variantId: a, addQty: '1' }] });
    const saved = await api(counter.cookie, 'PUT', `/v1/stocktakes/${st.body.id}/counts`, { counts: [{ variantId: b, countedQty: '5' }] });
    expect(saved.body.progress.counted).toBe(2);
    expect((await api(counter.cookie, 'POST', `/v1/stocktakes/${st.body.id}/submit`)).body.status).toBe('review');
    expect((await api(counter.cookie, 'POST', `/v1/stocktakes/${st.body.id}/post`)).status).toBe(403);   // counter cannot approve own count

    const review = await api(manager.cookie, 'GET', `/v1/stocktakes/${st.body.id}`);
    expect(line(review.body, a)).toMatchObject({ expectedQty: '10', countedQty: '9', variance: '-1' });
    expect(line(review.body, b)).toMatchObject({ variance: '0' });
    expect(line(review.body, c).countedQty).toBeNull();

    const posted = await api(manager.cookie, 'POST', `/v1/stocktakes/${st.body.id}/post`, undefined, key());
    expect(posted.status, posted.text).toBe(200);
    expect(posted.body.status).toBe('posted');
    expect((await onHand(A.cookie, a, loc.back)).onHand).toBe('9');
    expect((await onHand(A.cookie, b, loc.back)).onHand).toBe('5');
    expect((await onHand(A.cookie, c, loc.back)).onHand).toBe('8');   // uncounted lines are left alone

    const moves = await api(A.cookie, 'GET', `/v1/stock/movements?sourceId=${st.body.id}`);
    expect(moves.body.items).toHaveLength(1);
    expect(moves.body.items[0]).toMatchObject({ movementType: 'stocktake', qtyDelta: '-1', balanceBefore: '10', balanceAfter: '9', source: { number: st.body.number } });
    const after = await api(A.cookie, 'GET', '/v1/stock/movements?locationId=' + loc.back);
    expect(after.body.items.slice(1)).toEqual(before.body.items);   // earlier rows unchanged
    expect((await api(manager.cookie, 'POST', `/v1/stocktakes/${st.body.id}/post`)).body.code).toBe('INVALID_STATE');
  });

  it('sales during the count are not variances: moves before an item is counted count, moves after it do not', async () => {
    const early = await makeItem(A.cookie), late = await makeItem(A.cookie);
    await adjust(A.cookie, loc.shop, 'opening', [{ variantId: early, qtyDelta: '10' }, { variantId: late, qtyDelta: '10' }]);
    const st = (await api(A.cookie, 'POST', '/v1/stocktakes', { locationId: loc.shop, blind: false })).body;
    // 2 of "early" sell before anyone counts it; the shelf then really holds 8.
    await adjust(A.cookie, loc.shop, 'correction', [{ variantId: early, qtyDelta: '-2' }]);
    await api(A.cookie, 'PUT', `/v1/stocktakes/${st.id}/counts`, { counts: [{ variantId: early, countedQty: '8' }, { variantId: late, countedQty: '10' }] });
    // 3 of "late" sell after it was counted.
    await adjust(A.cookie, loc.shop, 'correction', [{ variantId: late, qtyDelta: '-3' }]);
    await api(A.cookie, 'POST', `/v1/stocktakes/${st.id}/submit`);
    const review = (await api(A.cookie, 'GET', `/v1/stocktakes/${st.id}`)).body;
    expect(line(review, early)).toMatchObject({ expectedQty: '10', movedDuringCount: '-2', variance: '0' });
    expect(line(review, late)).toMatchObject({ expectedQty: '10', movedDuringCount: '0', variance: '0' });
    await api(A.cookie, 'POST', `/v1/stocktakes/${st.id}/post`);
    expect((await onHand(A.cookie, early, loc.shop)).onHand).toBe('8');
    expect((await onHand(A.cookie, late, loc.shop)).onHand).toBe('7');
  });

  it('cancel has no stock effect and frees the location; counting stops after submit', async () => {
    const v = await makeItem(A.cookie);
    await adjust(A.cookie, loc.shop, 'opening', [{ variantId: v, qtyDelta: '4' }]);
    const st = (await api(A.cookie, 'POST', '/v1/stocktakes', { locationId: loc.shop })).body;
    await api(A.cookie, 'PUT', `/v1/stocktakes/${st.id}/counts`, { counts: [{ variantId: v, countedQty: '1' }] });
    await api(A.cookie, 'POST', `/v1/stocktakes/${st.id}/submit`);
    expect((await api(A.cookie, 'PUT', `/v1/stocktakes/${st.id}/counts`, { counts: [{ variantId: v, countedQty: '2' }] })).body.code).toBe('INVALID_STATE');
    expect((await api(A.cookie, 'POST', `/v1/stocktakes/${st.id}/reopen`)).body.status).toBe('counting');
    expect((await api(counter.cookie, 'POST', `/v1/stocktakes/${st.id}/cancel`)).status).toBe(403);
    expect((await api(A.cookie, 'POST', `/v1/stocktakes/${st.id}/cancel`)).body.status).toBe('cancelled');
    expect((await onHand(A.cookie, v, loc.shop)).onHand).toBe('4');
    expect((await api(A.cookie, 'POST', '/v1/stocktakes', { locationId: loc.shop })).status).toBe(201);
  });

  it('rejects counts for items outside the stocktake and fractions of whole-unit items', async () => {
    const st = (await api(A.cookie, 'POST', '/v1/stocktakes', { locationId: loc.back })).body;
    const outsider = await makeItem(A.cookie);   // created after the snapshot
    const inside = st.lines[0].variantId;
    const r1 = await api(A.cookie, 'PUT', `/v1/stocktakes/${st.id}/counts`, { counts: [{ variantId: outsider, countedQty: '1' }] });
    expect(r1.body.fieldErrors['counts.0.variantId']).toBeDefined();
    const r2 = await api(A.cookie, 'PUT', `/v1/stocktakes/${st.id}/counts`, { counts: [{ variantId: inside, countedQty: '1.5' }] });
    expect(r2.status).toBe(400);
    expect((await api(A.cookie, 'GET', '/v1/stocktakes?status=counting')).body.items.map((s: any) => s.id)).toContain(st.id);
  });
});
