import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/crypto.js';
import { testOutbox } from '../src/lib/notify.js';
import { sendRegisterMail } from '../src/modules/cash/mail-job.js';
import { api } from './b2-api.js';
import { makeTenant, makeUser, owner } from './b2-helpers.js';
import { key } from './b3-helpers.js';
import { sell, setupBilling, stockedItem } from './b5-helpers.js';

// GroPop v2 Phase 3: cash control. Payment methods (D109), tills and registers with the drawer's expected cash, the cash
// book (D110), till expenses with limits and approval (D111), closing with the owner's summary (D112), and the return and
// exchange rules promised in Phase 2 (D113).

type Tenant = Awaited<ReturnType<typeof makeTenant>>;
type User = Awaited<ReturnType<typeof makeUser>>;
const audits = async (tenantId: string, action: string) =>
  (await owner.query('SELECT summary FROM audit_events WHERE tenant_id = $1 AND action = $2 ORDER BY id', [tenantId, action])).rows.map((r) => r.summary);
const named = async (u: User, name: string, password?: string) =>
  owner.query('UPDATE users SET name = $2, password_hash = coalesce($3, password_hash) WHERE id = $1', [u.userId, name, password ? await hashPassword(password) : null]);
const move = (u: { cookie: string }, sessionId: string, body: Record<string, unknown>) => api(u.cookie, 'POST', `/v1/registers/${sessionId}/movements`, body);
const detail = async (u: { cookie: string }, sessionId: string) => (await api(u.cookie, 'GET', `/v1/registers/${sessionId}`)).body;
const giveBack = (cookie: string, bill: any, refundMethod: string, lineIdx = [0], extra: Record<string, unknown> = {}) =>
  api(cookie, 'POST', '/v1/returns', {
    invoiceId: bill.invoiceId, reason: 'Customer changed mind', refundMethod,
    lines: lineIdx.map((i) => ({ invoiceLineId: bill.invoice.lines[i].id, qty: '1', condition: 'resellable' })), ...extra,
  }, key());

describe('payment methods (D109)', () => {
  let T: Tenant;
  let cashier: User;
  let v: string;
  const lines = () => [{ variantId: v, qty: '1' }];
  beforeAll(async () => {
    T = await makeTenant();
    await setupBilling(T);
    cashier = await makeUser(T.tenantId, 'cashier');
    v = await stockedItem(T.cookie, { price: '100', stock: '50' });
  });

  it('every store starts with Cash, UPI, Card and Other; the owner adds their own; a sale names the one used', async () => {
    const r = await api(T.cookie, 'GET', '/v1/payment-methods');
    expect(r.status, r.text).toBe(200);
    expect(r.body.items.map((m: any) => [m.name, m.kind, m.builtin, m.active])).toEqual([
      ['Cash', 'cash', true, true], ['UPI', 'upi', true, true], ['Card', 'card', true, true], ['Other', 'other', true, true]]);
    expect((await api(cashier.cookie, 'GET', '/v1/payment-methods')).status).toBe(403);
    expect((await api(cashier.cookie, 'POST', '/v1/payment-methods', { name: 'Mine', kind: 'upi' })).status).toBe(403);

    const p = await api(T.cookie, 'POST', '/v1/payment-methods', { name: 'Paytm machine 2', kind: 'upi' });
    expect(p.status, p.text).toBe(201);
    expect(p.body).toMatchObject({ name: 'Paytm machine 2', kind: 'upi', builtin: false, active: true, position: 4, offAt: [] });
    expect((await api(T.cookie, 'POST', '/v1/payment-methods', { name: 'paytm MACHINE 2', kind: 'card' })).body.code).toBe('NAME_DUPLICATE');
    expect((await api(T.cookie, 'POST', '/v1/payment-methods', { name: 'Second drawer', kind: 'cash' })).status).toBe(400);
    expect(await audits(T.tenantId, 'payment_method.created')).toEqual([{ name: 'Paytm machine 2', kind: 'upi' }]);

    const s = await sell(cashier.cookie, lines(), {}, [{ method: 'upi', methodId: p.body.id, amount: '100.00', reference: 'PTM-1' } as any]);
    expect(s.status, s.text).toBe(201);
    const { rows: [o] } = await owner.query('SELECT payment_method FROM sales_orders WHERE id = $1', [s.body.orderId]);
    expect(o.payment_method).toBe('Paytm machine 2');
    const { rows: [y] } = await owner.query('SELECT method, method_id FROM payments WHERE order_id = $1', [s.body.orderId]);
    expect(y).toEqual({ method: 'upi', method_id: p.body.id });

    // A till that sends only the kind (an older screen) gets that kind's built-in method.
    const c = await sell(cashier.cookie, lines());
    const { rows: [cy] } = await owner.query('SELECT m.name FROM payments y JOIN payment_methods m ON m.id = y.method_id WHERE y.order_id = $1', [c.body.orderId]);
    expect(cy.name).toBe('Cash');
    const wrongKind = await sell(cashier.cookie, lines(), {}, [{ method: 'card', methodId: p.body.id, amount: '100.00' } as any]);
    expect([wrongKind.status, wrongKind.body.fieldErrors?.['payments.0.method']]).toEqual([400, ['Paytm machine 2 takes UPI']]);
  });

  it('a method switched off for the store, or at one outlet, leaves the counter and is refused', async () => {
    const all = (await api(T.cookie, 'GET', '/v1/payment-methods')).body;
    const by = (n: string) => all.items.find((m: any) => m.name === n);
    const main = all.outlets[0].id;
    const off = await api(T.cookie, 'PATCH', `/v1/payment-methods/${by('Card').id}`, { offAt: [main] });
    expect([off.status, off.body.offAt, off.body.active]).toEqual([200, [main], true]);
    const ctx = await api(cashier.cookie, 'GET', '/v1/pos/context');
    expect(ctx.body.paymentMethods.map((m: any) => m.name)).toEqual(['Cash', 'UPI', 'Other', 'Paytm machine 2']);
    const atOutlet = await sell(cashier.cookie, lines(), {}, [{ method: 'card', amount: '100.00' }]);
    expect([atOutlet.status, atOutlet.body.code, atOutlet.body.message]).toEqual([409, 'METHOD_OFF', 'Card is switched off at this outlet. Take the payment another way.']);

    await api(T.cookie, 'PATCH', `/v1/payment-methods/${by('Card').id}`, { offAt: [], active: false });
    expect((await sell(cashier.cookie, lines(), {}, [{ method: 'card', amount: '100.00' }])).body.message).toBe('Card is switched off. Take the payment another way.');
    expect((await api(T.cookie, 'PATCH', `/v1/payment-methods/${by('Card').id}`, { offAt: ['00000000-0000-4000-8000-000000000000'] })).body.fieldErrors.offAt).toEqual(['Unknown outlet']);

    // At least one stays on, or the counter can't take money at all.
    for (const n of ['UPI', 'Other', 'Paytm machine 2']) expect((await api(T.cookie, 'PATCH', `/v1/payment-methods/${by(n).id}`, { active: false })).status).toBe(200);
    const last = await api(T.cookie, 'PATCH', `/v1/payment-methods/${by('Cash').id}`, { active: false });
    expect([last.status, last.body.code]).toEqual([409, 'LAST_METHOD']);
    const renamed = await api(T.cookie, 'PATCH', `/v1/payment-methods/${by('Cash').id}`, { name: 'Cash drawer' });
    expect(renamed.body).toMatchObject({ name: 'Cash drawer', kind: 'cash', active: true });
    expect((await api(cashier.cookie, 'GET', '/v1/pos/context')).body.paymentMethods).toEqual([{ id: by('Cash').id, kind: 'cash', name: 'Cash drawer' }]);
    expect((await audits(T.tenantId, 'payment_method.updated')).at(-1)).toEqual({ method: 'Cash', name: 'Cash drawer' });
  });
});

describe('registers: opening, the drawer, closing, the owner’s summary (D110, D112)', () => {
  let T: Tenant;
  let ravi: User, sita: User, meena: User;
  let v: string;
  let tillId: string, sessionId: string;
  const lines = () => [{ variantId: v, qty: '1' }];
  beforeAll(async () => {
    T = await makeTenant();
    await setupBilling(T, { patch: { requireRegister: true } });
    ravi = await makeUser(T.tenantId, 'cashier');
    sita = await makeUser(T.tenantId, 'cashier');
    meena = await makeUser(T.tenantId, 'manager');
    await named(ravi, 'Ravi');
    await named(sita, 'Sita');
    await named(meena, 'Meena');
    v = await stockedItem(T.cookie, { price: '250', stock: '50' });
  });

  it('a new store requires a register; the counter can’t bill until the drawer is counted', async () => {
    const fresh = await makeTenant();
    expect((await api(fresh.cookie, 'GET', '/v1/billing/settings')).body).toMatchObject({ requireRegister: true, expenseLimitEach: '500.00', expenseLimitDay: '1000.00', returnDays: null, returnMoneyBack: true });

    const none = await sell(ravi.cookie, lines());
    expect([none.status, none.body.code, none.body.message]).toEqual([409, 'REGISTER_CLOSED', 'Open the register before billing: count the cash in the drawer first.']);
    const ctx = (await api(ravi.cookie, 'GET', '/v1/pos/context')).body;
    expect(ctx).toMatchObject({ requireRegister: true, canManageCash: false, expenseLimits: { each: '500.00', day: '1000.00' } });
    expect(ctx.tills).toEqual([expect.objectContaining({ name: 'Counter 1', open: null, lastKept: null })]);
    tillId = ctx.tills[0].id;
    expect((await sell(ravi.cookie, lines(), { tillId })).body.message).toBe('The register at Counter 1 is closed. Open it with the cash count first.');

    const wrongSum = await api(ravi.cookie, 'POST', '/v1/registers', { tillId, openingCash: '700', counts: { 500: 1, 100: 2, 10: 5 } });
    expect(wrongSum.body.fieldErrors.openingCash).toEqual(['The notes and coins add up to ₹750.00']);
    const open = await api(ravi.cookie, 'POST', '/v1/registers', { tillId, counts: { 500: 1, 100: 2, 10: 5 } });
    expect(open.status, open.text).toBe(201);
    expect(open.body).toMatchObject({ status: 'open', openingCash: '750.00', expectedOpening: null, openedBy: 'Ravi', mine: true, canManage: false, totals: { expected: '750.00', bills: 0 } });
    sessionId = open.body.id;
    const twice = await api(sita.cookie, 'POST', '/v1/registers', { tillId, openingCash: '750' });
    expect([twice.status, twice.body.code, twice.body.message]).toEqual([409, 'REGISTER_OPEN', 'Counter 1 is already open (opened by Ravi). Use it, or close it first.']);
    expect((await api(sita.cookie, 'GET', '/v1/tills')).body.items[0].open).toMatchObject({ id: sessionId, openedBy: 'Ravi', mine: false });
  });

  it('every payment, refund and drawer movement lands in the register; expected cash follows them', async () => {
    const s1 = await sell(ravi.cookie, lines(), { tillId }, [{ method: 'cash', amount: '500' }]);
    expect(s1.status, s1.text).toBe(201);
    expect(s1.body).toMatchObject({ change: '250.00', sessionId });
    // A second cashier bills from the same drawer.
    expect((await sell(sita.cookie, lines(), { tillId }, [{ method: 'upi', amount: '250.00' }])).status).toBe(201);

    const add = await move(ravi, sessionId, { kind: 'cash_in', amount: '200', category: 'Float added', reason: 'Change for the day' });
    expect([add.status, add.body.status]).toEqual([201, 'posted']);
    const cashierOut = await move(ravi, sessionId, { kind: 'cash_out', amount: '100', category: 'Bank deposit', reason: 'Deposit' });
    expect([cashierOut.status, cashierOut.body.message]).toEqual([403, 'Only the owner or a manager can take cash out of the drawer.']);
    expect((await move(ravi, sessionId, { kind: 'expense', amount: '50', category: 'Holiday', reason: 'Trip' })).body.fieldErrors.category).toEqual(['Pick one from the list']);
    const tea = await move(ravi, sessionId, { kind: 'expense', amount: '60', category: 'Tea and snacks', reason: 'Tea for staff' });
    expect(tea.body).toMatchObject({ status: 'posted', needsApproval: null, amount: '60.00', recordedBy: 'Ravi' });
    expect((await move(meena, sessionId, { kind: 'cash_out', amount: '300', category: 'Bank deposit', reason: 'Afternoon deposit' })).body.status).toBe('posted');
    const tooMuch = await move(meena, sessionId, { kind: 'cash_out', amount: '5000', category: 'Owner took', reason: 'Rent' });
    expect([tooMuch.status, tooMuch.body.code, tooMuch.body.message]).toEqual([409, 'NOT_ENOUGH_CASH', 'The drawer should hold ₹840.00: it can\'t pay out ₹5,000.00.']);

    // 750 opening + 250 cash sale + 200 added − 60 tea − 300 deposit
    let d = await detail(ravi, sessionId);
    expect(d.totals).toMatchObject({ bills: 2, sales: '500.00', opening: '750.00', cashSales: '250.00', cashRefunds: '0.00', cashIn: '200.00', cashOut: '300.00', expenses: '60.00', expected: '840.00' });
    expect(d.totals.methods).toEqual([
      { name: 'Cash', kind: 'cash', received: '250.00', refunded: '0.00', payments: 1 },
      { name: 'UPI', kind: 'upi', received: '250.00', refunded: '0.00', payments: 1 }]);
    expect(d.movements.map((m: any) => [m.kind, m.amount, m.status])).toEqual([['cash_in', '200.00', 'posted'], ['expense', '60.00', 'posted'], ['cash_out', '300.00', 'posted']]);

    // Cash given back from the back office comes out of the only register open at the outlet.
    const ret = await giveBack(T.cookie, s1.body, 'cash');
    expect(ret.status, ret.text).toBe(201);
    const { rows: [y] } = await owner.query('SELECT session_id, method_id IS NOT NULL AS has_method FROM payments WHERE return_id = $1', [ret.body.id]);
    expect(y).toEqual({ session_id: sessionId, has_method: true });
    // "Back the way it was paid" on a counter bill paid in cash is cash: the drawer knows it left.
    const s3 = await sell(ravi.cookie, lines(), { tillId });
    const orig = await giveBack(T.cookie, s3.body, 'original');
    expect([orig.status, orig.body.refundMethod]).toEqual([201, 'cash']);
    d = await detail(ravi, sessionId);
    expect(d.totals).toMatchObject({ bills: 3, cashSales: '500.00', cashRefunds: '500.00', expected: '590.00' });
  });

  it('closing: count, say why it is short, keep a float; the owner gets it in the app and by e-mail', async () => {
    const close = (u: User, body: Record<string, unknown>) => api(u.cookie, 'POST', `/v1/registers/${sessionId}/close`, body);
    const notMine = await close(sita, { countedCash: '590', keptCash: '500' });
    expect([notMine.status, notMine.body.message]).toEqual([403, 'Ravi opened this register. They, the owner or a manager can close it.']);
    expect((await close(ravi, { counts: { 500: 1 }, keptCash: '500' })).body.fieldErrors.note).toEqual(['The drawer is short by ₹90.00. Say why.']);
    expect((await close(ravi, { countedCash: '500', keptCash: '600', note: 'Gave change wrongly' })).body.fieldErrors.keptCash).toEqual(['Only ₹500.00 was counted']);
    testOutbox.length = 0;
    const ok = await close(ravi, { counts: { 500: 1 }, keptCash: '500', note: 'Gave change wrongly' });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ status: 'closed', countedCash: '500.00', expectedCash: '590.00', difference: '-90.00', keptCash: '500.00', closeNote: 'Gave change wrongly', closedBy: 'Ravi' });
    expect(ok.body.totals).toMatchObject({ counted: '500.00', difference: '-90.00', kept: '500.00', takenOut: '0.00', closedBy: 'Ravi', till: 'Counter 1' });
    expect((await sell(ravi.cookie, lines(), { tillId })).body.code).toBe('REGISTER_CLOSED');
    expect((await close(ravi, { countedCash: '500', keptCash: '500' })).body.code).toBe('REGISTER_CLOSED');
    expect((await move(ravi, sessionId, { kind: 'cash_in', amount: '1', category: 'Other', reason: 'Late' })).body.code).toBe('REGISTER_CLOSED');

    // The bell: owners only.
    const n = await api(T.cookie, 'GET', '/v1/notifications');
    expect(n.body.unread).toBe(1);
    expect(n.body.items[0]).toMatchObject({ kind: 'register_closed', title: expect.stringMatching(/^Counter 1 closed at .+: short$/), link: `/cash/registers/${sessionId}`, read: false });
    expect(n.body.items[0].body).toMatch(/^3 bills, sales ₹750\.00\. Cash expected ₹590\.00, counted ₹500\.00 \(cash short by ₹90\.00\)\. Expenses ₹60\.00\. Closed by Ravi at /);
    expect((await api(ravi.cookie, 'GET', '/v1/notifications')).body).toEqual({ unread: 0, items: [] });
    expect((await api(meena.cookie, 'GET', '/v1/notifications/count')).body).toEqual({ unread: 0 });
    expect((await api(T.cookie, 'GET', '/v1/notifications/count')).body).toEqual({ unread: 1 });
    expect((await api(ravi.cookie, 'POST', '/v1/notifications/read', { ids: [n.body.items[0].id] })).body).toEqual({ unread: 0 });
    expect((await api(T.cookie, 'GET', '/v1/notifications/count')).body).toEqual({ unread: 1 });
    expect((await api(T.cookie, 'POST', '/v1/notifications/read', {})).body).toEqual({ unread: 0 });

    // The e-mail is queued with the closing and sent by the worker.
    const { rows: [job] } = await owner.query('SELECT kind, status FROM sync_jobs WHERE tenant_id = $1 AND resource_id = $2', [T.tenantId, sessionId]);
    expect(job).toEqual({ kind: 'mail.register', status: 'pending' });
    await sendRegisterMail({ tenantId: T.tenantId, resourceId: sessionId });
    const { rows: [me] } = await owner.query("SELECT email FROM users WHERE tenant_id = $1 AND role = 'owner'", [T.tenantId]);
    const mail = testOutbox.find((m) => m.to.includes(me.email))!;
    expect(mail.subject).toMatch(/: Counter 1 closed \(short ₹90\.00\)$/);
    for (const line of ['Bills: 3, sales ₹750.00', 'Cash at opening:   ₹750.00', 'Should be in drawer: ₹590.00', 'Counted:           ₹500.00',
      'SHORT by ₹90.00: "Gave change wrongly"', 'Left in the drawer: ₹500.00; taken out: ₹0.00', `/cash/registers/${sessionId}`]) expect(mail.text).toContain(line);
    expect(testOutbox.filter((m) => m.to.includes(me.email))).toHaveLength(1);
    expect((await audits(T.tenantId, 'register.closed'))[0]).toMatchObject({ expected: '590.00', counted: '500.00', difference: '-90.00', kept: '500.00', note: 'Gave change wrongly' });
  });

  it('handover: the next opening is checked against what the last closing left', async () => {
    const ctx = (await api(sita.cookie, 'GET', '/v1/pos/context')).body;
    expect(ctx.tills[0]).toMatchObject({ lastKept: '500.00', open: null });
    const differs = await api(sita.cookie, 'POST', '/v1/registers', { tillId, openingCash: '450' });
    expect(differs.body.fieldErrors.note).toEqual(['The last closing left ₹500.00 in the drawer, and you counted ₹450.00. Say why.']);
    const ok = await api(sita.cookie, 'POST', '/v1/registers', { tillId, openingCash: '450', note: 'Owner took 50 for milk' });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body).toMatchObject({ openingCash: '450.00', expectedOpening: '500.00', openingNote: 'Owner took 50 for milk', openedBy: 'Sita' });
    expect((await audits(T.tenantId, 'register.opened')).at(-1)).toMatchObject({ openingCash: '450.00', lastLeft: '500.00', note: 'Owner took 50 for milk' });
  });

  it('the cash book and the register list: owners and managers, for all their outlets or one', async () => {
    const book = await api(meena.cookie, 'GET', '/v1/cash-book');
    expect(book.status, book.text).toBe(200);
    expect(book.body.registers.map((r: any) => [r.status, r.openedBy, r.opening, r.expected, r.counted])).toEqual([
      ['closed', 'Ravi', '750.00', '590.00', '500.00'], ['open', 'Sita', '450.00', '450.00', null]]);
    expect(book.body.totals).toMatchObject({ opening: '1200.00', cashSales: '500.00', cashRefunds: '500.00', cashIn: '200.00', cashOut: '300.00', expenses: '60.00', expected: '1040.00', counted: '500.00', difference: '-90.00' });
    expect(book.body.movements).toHaveLength(3);
    const yesterday = await api(meena.cookie, 'GET', '/v1/cash-book?date=2020-01-01');
    expect([yesterday.body.registers, yesterday.body.movements]).toEqual([[], []]);
    expect((await api(ravi.cookie, 'GET', '/v1/cash-book')).status).toBe(403);
    expect((await api(meena.cookie, 'GET', '/v1/cash-book?outletId=00000000-0000-4000-8000-000000000000')).body.code).toBe('OUTLET_NOT_ALLOWED');

    const list = await api(T.cookie, 'GET', '/v1/registers');
    expect(list.body.items.map((r: any) => [r.status, r.till, r.bills, r.difference])).toEqual([['open', 'Counter 1', 0, null], ['closed', 'Counter 1', 3, '-90.00']]);
    expect((await api(ravi.cookie, 'GET', '/v1/registers')).status).toBe(403);
  });

  it('tills: owners and managers add them per outlet; a till with an open register can’t be switched off', async () => {
    const outletId = (await api(T.cookie, 'GET', '/v1/pos/context')).body.outlet.id;
    expect((await api(ravi.cookie, 'POST', '/v1/tills', { outletId, name: 'Counter 2' })).status).toBe(403);
    const t2 = await api(meena.cookie, 'POST', '/v1/tills', { outletId, name: 'Counter 2' });
    expect(t2.status, t2.text).toBe(201);
    expect((await api(meena.cookie, 'POST', '/v1/tills', { outletId, name: 'counter 2' })).body.code).toBe('NAME_DUPLICATE');
    expect((await api(meena.cookie, 'PATCH', `/v1/tills/${tillId}`, { active: false })).body.code).toBe('REGISTER_OPEN');
    expect((await api(meena.cookie, 'PATCH', `/v1/tills/${t2.body.id}`, { active: false })).status).toBe(200);
    expect((await api(ravi.cookie, 'GET', '/v1/pos/context')).body.tills.map((t: any) => t.name)).toEqual(['Counter 1']);
    expect((await api(ravi.cookie, 'POST', '/v1/registers', { tillId: t2.body.id, openingCash: '0' })).body.fieldErrors.tillId).toEqual(['Till not found or switched off']);
  });

  it('a cashier at another outlet can’t use this outlet’s registers', async () => {
    await owner.query('UPDATE subscriptions SET extra_outlets = 1 WHERE tenant_id = $1', [T.tenantId]);
    const ol = await api(T.cookie, 'POST', '/v1/outlets', { name: 'Branch', address: '2 Road', stateCode: '27', invoicePrefix: 'BRI', creditNotePrefix: 'BRC' });
    expect(ol.status, ol.text).toBe(201);
    const far = await makeUser(T.tenantId, 'cashier');
    expect((await api(T.cookie, 'PUT', `/v1/outlets/${ol.body.outlet.id}/staff`, { userIds: [far.userId] })).status).toBe(200);
    const tills = (await api(far.cookie, 'GET', '/v1/tills')).body.items;
    expect(tills.map((t: any) => [t.outlet, t.name])).toEqual([['Branch', 'Counter 1']]);
    expect((await api(far.cookie, 'POST', '/v1/registers', { tillId, openingCash: '0' })).body.code).toBe('OUTLET_NOT_ALLOWED');
    const open = (await api(T.cookie, 'GET', '/v1/tills')).body.items.find((t: any) => t.id === tillId).open;
    expect((await api(far.cookie, 'GET', `/v1/registers/${open.id}`)).body.code).toBe('OUTLET_NOT_ALLOWED');
    expect((await move(far, open.id, { kind: 'cash_in', amount: '1', category: 'Other', reason: 'Nope' })).body.code).toBe('OUTLET_NOT_ALLOWED');
    // A sale at the branch can't use the main counter's till.
    const s = await api(far.cookie, 'POST', '/v1/pos/sales', { lines: lines(), walkIn: true, tillId, expectedTotal: '250.00', payments: [{ method: 'cash', amount: '250' }] }, key());
    expect([s.status, s.body.fieldErrors?.tillId]).toEqual([400, ['This till is at another outlet']]);
  });
});

describe('till expenses above the limit (D111)', () => {
  let T: Tenant;
  let ravi: User, sita: User, meena: User;
  let sessionId: string;
  const pin = (u: User, id: string, approverId: string, p: string) => api(u.cookie, 'POST', `/v1/cash-movements/${id}/pin`, { approverId, pin: p });
  beforeAll(async () => {
    T = await makeTenant();
    await setupBilling(T, { patch: { requireRegister: true, expenseLimitEach: '500', expenseLimitDay: '1000' } });
    ravi = await makeUser(T.tenantId, 'cashier');
    sita = await makeUser(T.tenantId, 'cashier');
    meena = await makeUser(T.tenantId, 'manager');
    await named(ravi, 'Ravi');
    await named(meena, 'Meena', 'manager password 123');
    expect((await api(meena.cookie, 'PUT', '/v1/pos/pin', { pin: '4826', password: 'manager password 123' })).status).toBe(200);
    const tillId = (await api(ravi.cookie, 'GET', '/v1/tills')).body.items[0].id;
    sessionId = (await api(ravi.cookie, 'POST', '/v1/registers', { tillId, openingCash: '2000' })).body.id;
  });

  it('above the limit for one expense it waits; the manager approves with their PIN on the cashier’s screen', async () => {
    const e = await move(ravi, sessionId, { kind: 'expense', amount: '800', category: 'Repairs', reason: 'Fan repair' });
    expect(e.status, e.text).toBe(201);
    expect(e.body).toMatchObject({ status: 'pending', needsApproval: '₹800.00 is above your limit of ₹500.00 for one expense' });
    expect((await detail(ravi, sessionId)).totals).toMatchObject({ expenses: '0.00', pendingExpenses: '800.00', expected: '2000.00' });

    expect((await api(meena.cookie, 'GET', '/v1/cash-movements/waiting')).body.items.map((x: any) => [x.id, x.recordedBy])).toEqual([[e.body.id, 'Ravi']]);
    expect((await api(meena.cookie, 'GET', '/v1/approvals/count')).body).toEqual({ waiting: 1, discounts: 0, expenses: 1 });
    expect((await api(ravi.cookie, 'GET', '/v1/cash-movements/waiting')).status).toBe(403);
    expect((await api(sita.cookie, 'GET', `/v1/cash-movements/${e.body.id}`)).status).toBe(404);
    expect((await pin(sita, e.body.id, meena.userId, '4826')).status).toBe(404);
    expect((await pin(ravi, e.body.id, ravi.userId, '4826')).body.fieldErrors.approverId).toEqual(['Pick an owner or manager']);

    const wrong = await pin(ravi, e.body.id, meena.userId, '1111');
    expect([wrong.status, wrong.body.code]).toEqual([403, 'WRONG_PIN']);
    expect((await owner.query('SELECT failed_count FROM pos_pins WHERE user_id = $1', [meena.userId])).rows[0].failed_count).toBe(1);
    const right = await pin(ravi, e.body.id, meena.userId, '4826');
    expect(right.status, right.text).toBe(200);
    expect(right.body).toMatchObject({ status: 'posted', decidedBy: 'Meena', decidedVia: 'pin' });
    expect((await detail(ravi, sessionId)).totals).toMatchObject({ expenses: '800.00', pendingExpenses: '0.00', expected: '1200.00' });
    expect((await pin(ravi, e.body.id, meena.userId, '4826')).body.code).toBe('ALREADY_ANSWERED');
    expect((await audits(T.tenantId, 'cash.expense_approved'))[0]).toMatchObject({ amount: '800.00', category: 'Repairs', via: 'pin' });
  });

  it('above the daily limit; answered from the Approvals page, cancelled, or lapsing at closing', async () => {
    // Ravi has spent ₹800 today, so ₹300 more is over the ₹1,000 a day.
    const a = await move(ravi, sessionId, { kind: 'expense', amount: '300', category: 'Transport', reason: 'Auto to the wholesaler' });
    expect(a.body).toMatchObject({ status: 'pending', needsApproval: 'With this, your expenses today would be ₹1,100.00, above your daily limit of ₹1,000.00' });
    expect((await api(ravi.cookie, 'POST', `/v1/cash-movements/${a.body.id}/decide`, { approve: true })).status).toBe(403);
    const no = await api(meena.cookie, 'POST', `/v1/cash-movements/${a.body.id}/decide`, { approve: false, note: 'Use the petty cash book' });
    expect(no.body).toMatchObject({ status: 'rejected', decidedBy: 'Meena', decidedVia: 'remote', note: 'Use the petty cash book' });
    expect((await api(ravi.cookie, 'GET', `/v1/cash-movements/${a.body.id}`)).body.status).toBe('rejected');

    const b = await move(ravi, sessionId, { kind: 'expense', amount: '300', category: 'Transport', reason: 'Auto again' });
    expect((await api(sita.cookie, 'POST', `/v1/cash-movements/${b.body.id}/cancel`)).status).toBe(404);
    expect((await api(ravi.cookie, 'POST', `/v1/cash-movements/${b.body.id}/cancel`)).body.status).toBe('cancelled');
    expect((await api(meena.cookie, 'POST', `/v1/cash-movements/${b.body.id}/decide`, { approve: true })).body.code).toBe('ALREADY_ANSWERED');

    // An owner's or manager's own expense doesn't wait; it is still checked against the drawer.
    expect((await move(meena, sessionId, { kind: 'expense', amount: '900', category: 'Repairs', reason: 'Shutter motor' })).body).toMatchObject({ status: 'posted', needsApproval: null });
    const c = await move(ravi, sessionId, { kind: 'expense', amount: '300', category: 'Cleaning', reason: 'Cleaner’s pay' });
    expect(c.body.status).toBe('pending');
    // Approved, it takes the last ₹300 in the drawer; the next can't be paid.
    expect((await api(meena.cookie, 'POST', `/v1/cash-movements/${c.body.id}/decide`, { approve: true })).status).toBe(200);
    const d = await move(ravi, sessionId, { kind: 'expense', amount: '600', category: 'Cleaning', reason: 'Deep clean' });
    expect((await api(meena.cookie, 'POST', `/v1/cash-movements/${d.body.id}/decide`, { approve: true })).body.code).toBe('NOT_ENOUGH_CASH');

    // Closing: what still waits is not paid.
    const closed = await api(meena.cookie, 'POST', `/v1/registers/${sessionId}/close`, { countedCash: '0', keptCash: '0' });
    expect(closed.status, closed.text).toBe(200);
    expect(closed.body).toMatchObject({ expectedCash: '0.00', difference: '0.00', closedBy: expect.any(String) });
    expect(closed.body.totals.lapsedExpenses).toBe(1);
    expect((await api(ravi.cookie, 'GET', `/v1/cash-movements/${d.body.id}`)).body).toMatchObject({ status: 'cancelled', note: 'Register closed before it was answered' });
    expect((await api(meena.cookie, 'GET', '/v1/approvals/count')).body.expenses).toBe(0);
  });
});

describe('return and exchange rules (D113)', () => {
  let T: Tenant;
  let ravi: User, meena: User;
  let shirt: string, brief: string;
  beforeAll(async () => {
    T = await makeTenant();
    await setupBilling(T);
    ravi = await makeUser(T.tenantId, 'cashier');
    meena = await makeUser(T.tenantId, 'manager');
    shirt = await stockedItem(T.cookie, { price: '1000', gstRate: '5', stock: '20' });
    brief = await stockedItem(T.cookie, { price: '300', gstRate: '5', stock: '20' });
  });

  it('a category marked “no returns” covers its sub-categories; the owner can still take items back', async () => {
    const inner = await api(T.cookie, 'POST', '/v1/categories', { name: 'Innerwear', noReturns: true });
    expect([inner.status, inner.body.noReturns]).toEqual([201, true]);
    const briefs = await api(T.cookie, 'POST', '/v1/categories', { name: 'Briefs', parentId: inner.body.id });
    expect(briefs.body.noReturns).toBe(false);
    expect((await api(T.cookie, 'POST', '/v1/brands', { name: 'X', noReturns: true })).status).toBe(400);
    await owner.query('UPDATE products SET category_id = $2 WHERE id = (SELECT product_id FROM product_variants WHERE id = $1)', [brief, briefs.body.id]);

    const bill = (await sell(ravi.cookie, [{ variantId: brief, qty: '2' }, { variantId: shirt, qty: '2' }])).body;
    const both = await giveBack(ravi.cookie, bill, 'cash', [0, 1]);
    expect([both.status, both.body.code, both.body.message]).toEqual([409, 'RETURN_CATEGORY', 'Innerwear items can\'t be returned at this store. The owner can still take them back.']);
    expect(both.body.fieldErrors).toEqual({ 'lines.0.invoiceLineId': ['Innerwear items can\'t be returned'] });
    expect((await giveBack(ravi.cookie, bill, 'cash', [1])).status).toBe(201);
    const q = await api(ravi.cookie, 'POST', '/v1/pos/exchanges/quote', { invoiceId: bill.invoiceId, lines: [{ invoiceLineId: bill.invoice.lines[0].id, qty: '1', condition: 'resellable' }] });
    expect(q.body.code).toBe('RETURN_CATEGORY');
    expect((await giveBack(T.cookie, bill, 'cash', [0])).status).toBe(201);
    // Switched back off: returns as before.
    expect((await api(T.cookie, 'PATCH', `/v1/categories/${inner.body.id}`, { name: 'Innerwear', noReturns: false })).body.noReturns).toBe(false);
    expect((await giveBack(ravi.cookie, bill, 'cash', [0])).status).toBe(201);
  });

  it('only within so many days of the bill', async () => {
    expect((await api(T.cookie, 'PATCH', '/v1/billing/settings', { returnDays: 7 })).body.returnDays).toBe(7);
    const bill = (await sell(ravi.cookie, [{ variantId: shirt, qty: '3' }])).body;
    expect((await giveBack(meena.cookie, bill, 'cash')).status).toBe(201);
    await owner.query("UPDATE invoices SET issued_at = now() - interval '9 days' WHERE id = $1", [bill.invoiceId]);
    const late = await giveBack(meena.cookie, bill, 'cash');
    expect([late.status, late.body.code, late.body.message]).toEqual([409, 'RETURN_WINDOW', `Bill ${bill.invoiceNumber} is 9 days old. This store takes items back within 7 days of the bill. The owner can still take it back.`]);
    expect((await api(ravi.cookie, 'POST', '/v1/pos/exchanges/quote', { invoiceId: bill.invoiceId, lines: [{ invoiceLineId: bill.invoice.lines[0].id, qty: '1', condition: 'resellable' }] })).body.code).toBe('RETURN_WINDOW');
    expect((await giveBack(T.cookie, bill, 'cash')).status).toBe(201);
    expect((await api(T.cookie, 'PATCH', '/v1/billing/settings', { returnDays: 0 })).status).toBe(400);
    await api(T.cookie, 'PATCH', '/v1/billing/settings', { returnDays: null });
  });

  it('exchange only: no money back, and an exchange must use the whole credit, except by the owner', async () => {
    expect((await api(T.cookie, 'PATCH', '/v1/billing/settings', { returnMoneyBack: false })).body.returnMoneyBack).toBe(false);
    expect((await api(ravi.cookie, 'GET', '/v1/pos/context')).body.returnRules).toEqual({ days: null, moneyBack: false, bindsMe: true });
    const bill = (await sell(ravi.cookie, [{ variantId: shirt, qty: '3' }])).body;
    const cash = await giveBack(ravi.cookie, bill, 'cash');
    expect([cash.status, cash.body.code, cash.body.message]).toEqual([409, 'EXCHANGE_ONLY', 'This store gives exchanges, not money back. Exchange it at the counter, or ask the owner.']);

    const ex = (newItem: string, refundMethod?: string) => api(ravi.cookie, 'POST', '/v1/pos/exchanges', {
      walkIn: true, lines: [{ variantId: newItem, qty: '1' }], expectedTotal: newItem === brief ? '300.00' : '1000.00', payments: [],
      exchange: { invoiceId: bill.invoiceId, reason: 'Wrong size', lines: [{ invoiceLineId: bill.invoice.lines[0].id, qty: '1', condition: 'resellable' }], expectedCredit: '1000.00' },
      ...(refundMethod ? { refundMethod } : {}),
    }, key());
    const cheaper = await ex(brief, 'cash');
    expect([cheaper.status, cheaper.body.code, cheaper.body.message]).toEqual([409, 'EXCHANGE_ONLY', 'This store gives exchanges, not money back: ₹700.00 of the credit is unused. Add items worth that much, or ask the owner.']);
    expect((await ex(shirt)).status).toBe(201);
    expect((await giveBack(T.cookie, bill, 'cash')).status).toBe(201);
    expect((await api(T.cookie, 'GET', '/v1/pos/context')).body.returnRules.bindsMe).toBe(false);
    await api(T.cookie, 'PATCH', '/v1/billing/settings', { returnMoneyBack: true });
  });

  it('“back the way it was paid” on a bill paid two ways needs the method chosen', async () => {
    const bill = (await sell(ravi.cookie, [{ variantId: shirt, qty: '1' }], {}, [{ method: 'upi', amount: '400' }, { method: 'cash', amount: '600' }])).body;
    const r = await giveBack(T.cookie, bill, 'original');
    expect(r.body.fieldErrors.refundMethod).toEqual(['This bill was paid more than one way: choose how the money goes back']);
    expect((await giveBack(T.cookie, bill, 'upi')).status).toBe(201);
  });
});
