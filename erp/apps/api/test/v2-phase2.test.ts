import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/crypto.js';
import { phoneProblem } from '../src/lib/phone.js';
import { spread } from '../src/modules/pos/pricing.js';
import { api } from './b2-api.js';
import { makeTenant, makeUser, owner } from './b2-helpers.js';
import { adjust, key } from './b3-helpers.js';
import { gstin, invNo, onHandAt, sell, setupBilling, stockedItem } from './b5-helpers.js';

// GroPop v2 Phase 2: billing at the counter. Customer or Walk-in on every bill (D104), held bills (D105), discounts in ₹
// (D106), discount approval by PIN or from the Approvals page (D107), exchange against the old bill (D108).

type Tenant = Awaited<ReturnType<typeof makeTenant>>;
type User = Awaited<ReturnType<typeof makeUser>>;
const quote = (cookie: string, body: Record<string, unknown>) => api(cookie, 'POST', '/v1/pos/quote', body);
const sale = (cookie: string, body: Record<string, unknown>, total: string, payments?: unknown[]) =>
  api(cookie, 'POST', '/v1/pos/sales', { ...body, expectedTotal: total, payments: payments ?? [{ method: 'cash', amount: total }] }, key());
const audits = async (tenantId: string, action: string) =>
  (await owner.query('SELECT summary, actor_user_id AS actor_id FROM audit_events WHERE tenant_id = $1 AND action = $2 ORDER BY id', [tenantId, action])).rows;

describe('customer or Walk-in on every bill (D104)', () => {
  let T: Tenant;
  let v: string;
  beforeAll(async () => {
    T = await makeTenant();
    await setupBilling(T);
    await owner.query("UPDATE store_settings SET phone = '+91 98480 22338' WHERE tenant_id = $1", [T.tenantId]);
    v = await stockedItem(T.cookie, { price: '100', stock: '50' });
  });

  it('refuses made-up numbers and the shop’s own number for a customer', () => {
    for (const bad of ['9999999999', '0000000000', '1234567890', '9876543210', '0123456789', '5123456789', '+919999999999', '12345']) {
      expect(phoneProblem(bad), bad).not.toBeNull();
    }
    for (const good of ['9848012345', '+919848012345', '919848012345', '04023456789', '+447911123456']) expect(phoneProblem(good), good).toBeNull();
  });

  it('a bill needs a customer with a usable mobile number, or the cashier’s Walk-in mark', async () => {
    const lines = [{ variantId: v, qty: '1' }];
    // Quoting is fine without one: the cashier adds the customer before taking payment.
    expect((await quote(T.cookie, { lines })).status).toBe(200);
    const none = await sale(T.cookie, { lines }, '100.00');
    expect([none.status, none.body.code]).toEqual([400, 'CUSTOMER_REQUIRED']);

    for (const phone of ['9999999999', '9876543210', '9848022338']) {
      const c = await api(T.cookie, 'POST', '/v1/customers', { name: 'Ravi', phone });
      expect([c.status, phone]).toEqual([400, phone]);
    }
    const shop = await api(T.cookie, 'POST', '/v1/customers', { name: 'Ravi', phone: '9848022338' });
    expect(shop.body.fieldErrors.phone[0]).toMatch(/shop’s own number/);

    const noPhone = await api(T.cookie, 'POST', '/v1/customers', { name: 'Old customer' });
    expect(noPhone.status).toBe(201);
    const refused = await sale(T.cookie, { lines, customerId: noPhone.body.id }, '100.00');
    expect([refused.status, refused.body.code, refused.body.message]).toEqual([400, 'CUSTOMER_REQUIRED', 'Old customer has no usable mobile number. Add it, or choose Walk-in.']);

    const ravi = await api(T.cookie, 'POST', '/v1/customers', { name: 'Ravi', phone: '9848012345' });
    expect(ravi.status, ravi.text).toBe(201);
    const ok = await sale(T.cookie, { lines, customerId: ravi.body.id }, '100.00');
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body.invoice.buyer).toMatchObject({ name: 'Ravi', phone: '9848012345' });

    expect((await sale(T.cookie, { lines, customerId: ravi.body.id, walkIn: true }, '100.00')).body.fieldErrors.customerId).toEqual(['Choose a customer or Walk-in, not both']);
    const walk = await sale(T.cookie, { lines, walkIn: true }, '100.00');
    expect(walk.status, walk.text).toBe(201);
    expect(walk.body.invoice.buyer).toEqual({});
    const named = await sale(T.cookie, { lines, walkIn: true, walkInName: 'Lakshmi' }, '100.00');
    expect(named.body.invoice.buyer).toEqual({ name: 'Lakshmi' });
    const { rows: [o] } = await owner.query('SELECT customer_snapshot FROM sales_orders WHERE id = $1', [named.body.orderId]);
    expect(o.customer_snapshot).toEqual({ name: 'Lakshmi', walkIn: true });
  });

  it('the owner can turn the rule off in Billing & GST', async () => {
    const off = await api(T.cookie, 'PATCH', '/v1/billing/settings', { requireCustomer: false });
    expect([off.status, off.body.requireCustomer]).toEqual([200, false]);
    expect((await api(T.cookie, 'GET', '/v1/pos/context')).body.requireCustomer).toBe(false);
    expect((await sale(T.cookie, { lines: [{ variantId: v, qty: '1' }] }, '100.00')).status).toBe(201);
    await api(T.cookie, 'PATCH', '/v1/billing/settings', { requireCustomer: true });
  });
});

describe('held bills (D105)', () => {
  let T: Tenant;
  let cashier: User;
  let v: string;
  beforeAll(async () => {
    T = await makeTenant();
    await setupBilling(T);
    cashier = await makeUser(T.tenantId, 'cashier');
    v = await stockedItem(T.cookie, { price: '250', stock: '5' });
  });

  it('a held bill waits at its outlet; any cashier there picks it up once, priced again', async () => {
    const cart = { lines: [{ variantId: v, qty: '2' }], walkIn: true, walkInName: 'Anil', approvalId: '00000000-0000-4000-8000-000000000000' };
    const h = await api(T.cookie, 'POST', '/v1/pos/held', { cart, label: 'Card not working' });
    expect(h.status, h.text).toBe(201);
    expect(h.body).toMatchObject({ label: 'Card not working', itemCount: 1, total: '500.00', customer: 'Anil' });
    // Nothing is set aside: the stock is still free.
    expect((await quote(T.cookie, { lines: [{ variantId: v, qty: '5' }] })).body.shortages).toEqual([]);

    const list = await api(cashier.cookie, 'GET', '/v1/pos/held');
    expect(list.body.items).toEqual([expect.objectContaining({ id: h.body.id, heldBy: 'Owner', total: '500.00' })]);

    // The price changed while it waited: the till re-quotes it.
    await owner.query('UPDATE product_variants SET price = 260 WHERE id = $1', [v]);
    const back = await api(cashier.cookie, 'POST', `/v1/pos/held/${h.body.id}/resume`, {});
    expect(back.status, back.text).toBe(200);
    expect(back.body.cart).toEqual({ lines: [{ variantId: v, qty: '2' }], walkIn: true, walkInName: 'Anil', outletId: expect.any(String) });
    expect(back.body.cart.approvalId).toBeUndefined();
    expect((await quote(cashier.cookie, back.body.cart)).body.total).toBe('520.00');
    expect((await api(cashier.cookie, 'POST', `/v1/pos/held/${h.body.id}/resume`, {})).status).toBe(404);
    expect((await api(cashier.cookie, 'GET', '/v1/pos/held')).body.items).toEqual([]);

    const d = await api(T.cookie, 'POST', '/v1/pos/held', { cart: { lines: [{ variantId: v, qty: '1' }] } });
    expect((await api(cashier.cookie, 'DELETE', `/v1/pos/held/${d.body.id}`)).status).toBe(204);
    expect((await audits(T.tenantId, 'pos.bill_held'))).toHaveLength(2);
    expect((await audits(T.tenantId, 'pos.bill_resumed'))).toHaveLength(1);
    expect((await audits(T.tenantId, 'pos.held_bill_discarded'))).toHaveLength(1);
  });

  it('another outlet does not see it, and an outlet holds at most 50', async () => {
    await owner.query('UPDATE subscriptions SET extra_outlets = 1 WHERE tenant_id = $1', [T.tenantId]);
    const o2 = await api(T.cookie, 'POST', '/v1/outlets', { name: 'Second', address: '1 Road', stateCode: '27', invoicePrefix: 'SEC', creditNotePrefix: 'SECN' });
    expect(o2.status, o2.text).toBe(201);
    const h = await api(T.cookie, 'POST', '/v1/pos/held', { cart: { lines: [{ variantId: v, qty: '1' }] } });
    expect((await api(T.cookie, 'GET', `/v1/pos/held?outletId=${o2.body.outlet.id}`)).body.items).toEqual([]);
    expect((await api(T.cookie, 'POST', `/v1/pos/held/${h.body.id}/resume`, { outletId: o2.body.outlet.id })).status).toBe(404);

    await owner.query(
      `INSERT INTO pos_held_bills (tenant_id, outlet_id, cart, item_count, held_by) SELECT $1, main_outlet_id($1), '{}', 1, $2 FROM generate_series(1, 49)`,
      [T.tenantId, T.userId]);
    const full = await api(T.cookie, 'POST', '/v1/pos/held', { cart: { lines: [{ variantId: v, qty: '1' }] } });
    expect([full.status, full.body.code]).toEqual([409, 'TOO_MANY_HELD']);
  });
});

describe('discount in ₹ or % (D106)', () => {
  let T: Tenant;
  let cashier: User;
  let a: string, b: string;
  beforeAll(async () => {
    T = await makeTenant();
    await setupBilling(T, { patch: { cashierDiscountLimitPct: '10', discountReasonThresholdPct: '5', roundOff: false } });
    cashier = await makeUser(T.tenantId, 'cashier');
    a = await stockedItem(T.cookie, { price: '100', stock: '50' });
    b = await stockedItem(T.cookie, { price: '200', stock: '50' });
  });

  it('shares a ₹ bill discount over the lines to the paisa', () => {
    expect(spread(1000n, [10000n, 20000n])).toEqual([333n, 667n]);
    expect(spread(1n, [100n, 100n, 100n])).toEqual([1n, 0n, 0n]);
    expect(spread(30000n, [10000n, 20000n])).toEqual([10000n, 20000n]);
    expect(spread(500n, [0n, 10000n])).toEqual([0n, 500n]);
  });

  it('a line or the whole bill can take ₹ off instead of %', async () => {
    const line = await quote(T.cookie, { lines: [{ variantId: a, qty: '2', discountAmount: '15', discountReason: 'Shop-soiled' }, { variantId: b, qty: '1' }] });
    expect(line.status, line.text).toBe(200);
    expect(line.body.lines.map((l: any) => [l.discount, l.discountPct])).toEqual([['15.00', '7.5'], ['0.00', '0']]);
    expect(line.body.total).toBe('385.00');

    const bill = await quote(T.cookie, { lines: [{ variantId: a, qty: '1' }, { variantId: b, qty: '1' }], cartDiscountAmount: '10' });
    expect(bill.body.lines.map((l: any) => l.discount)).toEqual(['3.33', '6.67']);
    expect([bill.body.discountTotal, bill.body.total]).toEqual(['10.00', '290.00']);

    const both = await quote(T.cookie, { lines: [{ variantId: a, qty: '1', discountPct: '5', discountAmount: '5' }] });
    expect(both.body.fieldErrors['lines.0.discountAmount']).toEqual(['Give the discount in % or ₹, not both']);
    expect((await quote(T.cookie, { lines: [{ variantId: a, qty: '1' }], cartDiscountPct: '5', cartDiscountAmount: '5' })).body.fieldErrors.cartDiscountAmount).toBeTruthy();
    expect((await quote(T.cookie, { lines: [{ variantId: a, qty: '1', discountAmount: '101' }] })).body.fieldErrors['lines.0.discountAmount']).toEqual(['More than the item\'s ₹100.00']);
    expect((await quote(T.cookie, { lines: [{ variantId: a, qty: '1' }], cartDiscountAmount: '100.01' })).body.fieldErrors.cartDiscountAmount).toEqual(['More than the bill of ₹100.00']);
  });

  it('a ₹ discount counts against the same limit and reason rule as %', async () => {
    // ₹30 off ₹300 is exactly 10%: within the cashier's limit, but above the 5% reason threshold.
    const lines = [{ variantId: a, qty: '1' }, { variantId: b, qty: '1' }];
    const noReason = await quote(cashier.cookie, { lines, cartDiscountAmount: '30' });
    expect(noReason.body.fieldErrors['lines.0.discountReason']).toBeTruthy();
    const ok = await sell(cashier.cookie, lines, { cartDiscountAmount: '30', cartDiscountReason: 'Festival offer' });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body.total).toBe('270.00');
    const over = await quote(cashier.cookie, { lines, cartDiscountAmount: '31', cartDiscountReason: 'Festival offer' });
    expect([over.status, over.body.code]).toEqual([403, 'DISCOUNT_LIMIT']);
  });
});

describe('discount approval (D107)', () => {
  let T: Tenant;
  let cashier: User, cashier2: User, manager: User;
  let v: string;
  const lines = (pct = '20', qty = '1') => [{ variantId: v, qty, discountPct: pct }];

  beforeAll(async () => {
    T = await makeTenant();
    await setupBilling(T, { patch: { cashierDiscountLimitPct: '10', managerDiscountLimitPct: '25', discountReasonThresholdPct: '5' } });
    cashier = await makeUser(T.tenantId, 'cashier');
    cashier2 = await makeUser(T.tenantId, 'cashier');
    manager = await makeUser(T.tenantId, 'manager');
    await owner.query('UPDATE users SET password_hash = $2, name = $3 WHERE id = $1', [manager.userId, await hashPassword('manager password 123'), 'Meena']);
    v = await stockedItem(T.cookie, { price: '1000', stock: '50' });
  });

  const ask = (cookie: string, pct = '20', reason = 'Regular customer, bulk buy', qty = '1') =>
    api(cookie, 'POST', '/v1/pos/discount-requests', { cart: { lines: lines(pct, qty), walkIn: true }, reason });

  it('above the limit the cashier asks; a manager approves from the Approvals page; the approval is spent on one bill', async () => {
    const q = await quote(cashier.cookie, { lines: lines(), walkIn: true });
    expect([q.status, q.body.code]).toEqual([403, 'DISCOUNT_LIMIT']);
    expect((await ask(cashier.cookie, '8')).body.code).toBe('APPROVAL_NOT_NEEDED');

    const r = await ask(cashier.cookie);
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending', discountTotal: '200.00', maxPct: '20', reason: 'Regular customer, bulk buy' });
    expect(r.body.summary).toMatchObject({ limitPct: '10', total: '800.00', lines: [{ qty: '1', discount: '200.00', pct: '20' }] });

    // The manager sees it waiting; a cashier can't answer.
    expect((await api(manager.cookie, 'GET', '/v1/approvals/count')).body).toEqual({ waiting: 1, discounts: 1, expenses: 0 });
    expect((await api(manager.cookie, 'GET', '/v1/approvals')).body.waiting.map((x: any) => x.id)).toEqual([r.body.id]);
    expect((await api(cashier2.cookie, 'GET', '/v1/approvals')).status).toBe(403);
    expect((await api(cashier2.cookie, 'POST', `/v1/approvals/${r.body.id}`, { approve: true })).status).toBe(403);
    // Another cashier can't read it or use it.
    expect((await api(cashier2.cookie, 'GET', `/v1/pos/discount-requests/${r.body.id}`)).status).toBe(404);

    const yes = await api(manager.cookie, 'POST', `/v1/approvals/${r.body.id}`, { approve: true, note: 'OK this once' });
    expect(yes.status, yes.text).toBe(200);
    expect(yes.body).toMatchObject({ status: 'approved', decidedBy: 'Meena', decidedVia: 'remote', note: 'OK this once' });
    expect((await api(cashier.cookie, 'GET', `/v1/pos/discount-requests/${r.body.id}`)).body.status).toBe('approved');
    expect((await api(manager.cookie, 'POST', `/v1/approvals/${r.body.id}`, { approve: false })).body.code).toBe('ALREADY_ANSWERED');

    const other = await quote(cashier2.cookie, { lines: lines(), walkIn: true, approvalId: r.body.id });
    expect(other.body.message).toMatch(/not for this till/);
    const changed = await quote(cashier.cookie, { lines: lines('20', '2'), walkIn: true, approvalId: r.body.id });
    expect([changed.body.code, changed.body.message]).toEqual(['DISCOUNT_LIMIT', expect.stringMatching(/changed after it was approved/)]);

    const ok = await quote(cashier.cookie, { lines: lines(), walkIn: true, approvalId: r.body.id });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.approval).toEqual({ id: r.body.id, approvedBy: 'Meena' });
    const s = await sale(cashier.cookie, { lines: lines(), walkIn: true, approvalId: r.body.id }, ok.body.total);
    expect(s.status, s.text).toBe(201);
    // The bill carries the reason given to the approver; the audit log says who allowed it.
    expect(s.body.invoice.lines[0]).toMatchObject({ discount: '200.00' });
    const { rows: [line] } = await owner.query('SELECT discount_reason FROM sales_order_lines WHERE order_id = $1', [s.body.orderId]);
    expect(line.discount_reason).toBe('Regular customer, bulk buy');
    const [a] = await audits(T.tenantId, 'pos.discount_or_override');
    expect(a.summary).toMatchObject({ approvedBy: 'Meena', approvedVia: 'remote', request: r.body.id, limitPct: '10' });
    const { rows: [used] } = await owner.query('SELECT status, invoice_id FROM discount_requests WHERE id = $1', [r.body.id]);
    expect(used).toEqual({ status: 'used', invoice_id: s.body.invoiceId });

    const again = await sale(cashier.cookie, { lines: lines(), walkIn: true, approvalId: r.body.id }, ok.body.total);
    expect([again.body.code, again.body.message]).toEqual(['DISCOUNT_LIMIT', expect.stringMatching(/already used/)]);
  });

  it('at the till the approver types their own PIN; wrong PINs count and lock', async () => {
    // Setting a PIN needs the account password, and refuses easy ones.
    expect((await api(manager.cookie, 'PUT', '/v1/pos/pin', { pin: '4826', password: 'wrong' })).body.fieldErrors.password).toEqual(['Wrong password']);
    expect((await api(manager.cookie, 'PUT', '/v1/pos/pin', { pin: '1234', password: 'manager password 123' })).body.fieldErrors.pin).toBeTruthy();
    const set = await api(manager.cookie, 'PUT', '/v1/pos/pin', { pin: '4826', password: 'manager password 123' });
    expect(set.status, set.text).toBe(200);
    expect(set.body).toMatchObject({ set: true, locked: false });
    expect((await api(cashier.cookie, 'GET', '/v1/pos/pin')).status).toBe(403);
    const { rows: [k] } = await owner.query('SELECT pin_hash FROM pos_pins WHERE user_id = $1', [manager.userId]);
    expect(k.pin_hash).toMatch(/^\$argon2id\$/);

    const who = await api(cashier.cookie, 'GET', '/v1/pos/approvers');
    expect(who.body.items).toEqual([
      { id: T.userId, name: 'Owner', role: 'owner', hasPin: false },
      { id: manager.userId, name: 'Meena', role: 'manager', hasPin: true },
    ]);

    const r = await ask(cashier.cookie);
    const noPin = await api(cashier.cookie, 'POST', `/v1/pos/discount-requests/${r.body.id}/pin`, { approverId: T.userId, pin: '4826' });
    expect([noPin.status, noPin.body.code]).toEqual([409, 'PIN_NOT_SET']);
    const wrong = await api(cashier.cookie, 'POST', `/v1/pos/discount-requests/${r.body.id}/pin`, { approverId: manager.userId, pin: '1111' });
    expect([wrong.status, wrong.body.code, wrong.body.message]).toEqual([403, 'WRONG_PIN', 'Wrong PIN (4 tries left).']);
    expect((await owner.query('SELECT failed_count FROM pos_pins WHERE user_id = $1', [manager.userId])).rows[0].failed_count).toBe(1);
    const right = await api(cashier.cookie, 'POST', `/v1/pos/discount-requests/${r.body.id}/pin`, { approverId: manager.userId, pin: '4826' });
    expect(right.status, right.text).toBe(200);
    expect(right.body).toMatchObject({ status: 'approved', decidedBy: 'Meena', decidedVia: 'pin' });
    const [approved] = (await audits(T.tenantId, 'discount.approved')).slice(-1);
    expect(approved.actor_id).toBe(manager.userId);
    expect((await sell(cashier.cookie, lines(), { approvalId: r.body.id })).status).toBe(201);

    const r2 = await ask(cashier.cookie);
    for (let i = 0; i < 5; i++) await api(cashier.cookie, 'POST', `/v1/pos/discount-requests/${r2.body.id}/pin`, { approverId: manager.userId, pin: '9090' });
    const locked = await api(cashier.cookie, 'POST', `/v1/pos/discount-requests/${r2.body.id}/pin`, { approverId: manager.userId, pin: '4826' });
    expect([locked.status, locked.body.code]).toEqual([429, 'PIN_LOCKED']);
    expect(await audits(T.tenantId, 'pos.pin_locked')).toHaveLength(1);
    // A new PIN (with the password) unlocks it.
    expect((await api(manager.cookie, 'PUT', '/v1/pos/pin', { pin: '5917', password: 'manager password 123' })).body.locked).toBe(false);

    // Wrong tries keep counting after a lock (until a right one): the 15th in a row switches the PIN off until it is set again.
    const pin = (p: string) => api(cashier.cookie, 'POST', `/v1/pos/discount-requests/${r2.body.id}/pin`, { approverId: manager.userId, pin: p });
    const unlockClock = () => owner.query("UPDATE pos_pins SET locked_until = now() - interval '1 second' WHERE user_id = $1", [manager.userId]);
    await owner.query('UPDATE pos_pins SET failed_count = 9 WHERE user_id = $1', [manager.userId]);
    expect((await pin('9090')).body.message).toBe('Wrong PIN. Meena’s PIN is locked for 15 minutes.');
    await unlockClock();
    for (let i = 0; i < 3; i++) await pin('9090');
    expect((await pin('9090')).body.message).toBe('Wrong PIN (1 try left).');
    expect((await pin('9090')).body.message).toBe('Wrong PIN. Meena’s PIN is now switched off until they set it again.');
    const off = await pin('5917');
    expect([off.status, off.body.code]).toEqual([429, 'PIN_LOCKED']);
    expect(off.body.message).toMatch(/switched off after 15 wrong tries in a row/);
    expect((await api(manager.cookie, 'GET', '/v1/pos/pin')).body).toMatchObject({ set: true, locked: true, switchedOff: true });
    expect((await audits(T.tenantId, 'pos.pin_locked')).map((x) => x.summary.switchedOff)).toEqual([false, false, true]);
    expect((await api(manager.cookie, 'PUT', '/v1/pos/pin', { pin: '5917', password: 'manager password 123' })).body).toMatchObject({ locked: false, switchedOff: false });
  });

  it('an approver allows only up to their own limit, never their own request, and a "no" stays a no', async () => {
    const big = await ask(cashier.cookie, '30');
    const m = await api(manager.cookie, 'POST', `/v1/approvals/${big.body.id}`, { approve: true });
    expect([m.status, m.body.code]).toEqual([403, 'DISCOUNT_LIMIT']);
    expect(m.body.message).toMatch(/above Meena’s own limit of 25%/);
    expect((await api(T.cookie, 'POST', `/v1/approvals/${big.body.id}`, { approve: true })).body.status).toBe('approved');

    // A manager above their own limit asks the owner, and can't answer their own request.
    const mine = await api(manager.cookie, 'POST', '/v1/pos/discount-requests', { cart: { lines: lines('30'), walkIn: true }, reason: 'Damaged box' });
    expect(mine.status, mine.text).toBe(201);
    expect((await api(manager.cookie, 'POST', `/v1/approvals/${mine.body.id}`, { approve: true })).body.code).toBe('OWN_REQUEST');

    const no = await ask(cashier.cookie, '15');
    expect((await api(T.cookie, 'POST', `/v1/approvals/${no.body.id}`, { approve: false, note: 'Not today' })).body).toMatchObject({ status: 'rejected', note: 'Not today' });
    expect((await quote(cashier.cookie, { lines: lines('15'), walkIn: true, approvalId: no.body.id })).body.message).toMatch(/not approved/);

    // A newer request from the same till replaces a waiting one; the cashier can also cancel.
    const first = await ask(cashier.cookie, '12');
    const second = await ask(cashier.cookie, '13');
    expect((await api(cashier.cookie, 'GET', `/v1/pos/discount-requests/${first.body.id}`)).body.status).toBe('cancelled');
    expect((await api(cashier.cookie, 'POST', `/v1/pos/discount-requests/${second.body.id}/cancel`, {})).body.status).toBe('cancelled');
    expect((await api(T.cookie, 'POST', `/v1/approvals/${second.body.id}`, { approve: true })).body.code).toBe('ALREADY_ANSWERED');

    // An approval is good for 15 minutes.
    const late = await ask(cashier.cookie, '12');
    await api(T.cookie, 'POST', `/v1/approvals/${late.body.id}`, { approve: true });
    await owner.query("UPDATE discount_requests SET expires_at = now() - interval '1 minute' WHERE id = $1", [late.body.id]);
    expect((await quote(cashier.cookie, { lines: lines('12'), walkIn: true, approvalId: late.body.id })).body.message).toMatch(/expired/);
  });
});

describe('exchange against the old bill (D108)', () => {
  let T: Tenant;
  let cashier: User;
  let shirt: string, jeans: string, socks: string;
  let oldBill: any;
  beforeAll(async () => {
    T = await makeTenant();
    await setupBilling(T);
    cashier = await makeUser(T.tenantId, 'cashier');
    shirt = await stockedItem(T.cookie, { price: '1000', gstRate: '5', stock: '10' });
    jeans = await stockedItem(T.cookie, { price: '1500', gstRate: '5', stock: '10' });
    socks = await stockedItem(T.cookie, { price: '300', gstRate: '5', stock: '10' });
    oldBill = (await sell(T.cookie, [{ variantId: shirt, qty: '2' }])).body;
    expect(oldBill.invoiceNumber).toBe(invNo(1));
  });

  const back = (qty = '1') => [{ invoiceLineId: oldBill.invoice.lines[0].id, qty, condition: 'resellable' }];
  const exchange = (cookie: string, body: Record<string, unknown>, k = key()) => api(cookie, 'POST', '/v1/pos/exchanges', body, k);

  it('the old bill pays for a dearer new one; the customer pays the rest', async () => {
    const q = await api(cashier.cookie, 'POST', '/v1/pos/exchanges/quote', { invoiceId: oldBill.invoiceId, lines: back() });
    expect(q.status, q.text).toBe(200);
    expect(q.body).toMatchObject({ credit: '1000.00', invoice: { number: invNo(1), customerId: null }, lines: [{ qty: '1', credit: '1000.00' }] });

    const body = {
      walkIn: true, lines: [{ variantId: jeans, qty: '1' }], expectedTotal: '1500.00', payments: [{ method: 'upi', amount: '500', reference: 'UPI-1' }],
      exchange: { invoiceId: oldBill.invoiceId, reason: 'Size too small', lines: back(), expectedCredit: '1000.00' },
    };
    const k = key();
    const res = await exchange(cashier.cookie, body, k);
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ total: '1500.00', credit: '1000.00', due: '500.00', change: '0.00', invoiceNumber: invNo(2),
      exchange: { oldInvoice: invNo(1), credit: '1000.00', used: '1000.00', givenBack: null } });
    const cn = res.body.exchange.creditNoteNumber;
    expect(res.body.invoice.payments.map((p: any) => [p.method, p.amount, p.reference])).toEqual([['exchange', '1000.00', cn], ['upi', '500.00', 'UPI-1']]);
    // The shirt is back on the shop floor, the jeans are gone; the old bill shows its credit note and where the money went.
    expect([await onHandAt(shirt), await onHandAt(jeans)]).toEqual(['9', '9']);
    const old = await api(T.cookie, 'GET', `/v1/invoices/${oldBill.invoiceId}`);
    expect(old.body.creditNotes).toEqual([expect.objectContaining({ number: cn, total: '1000.00' })]);
    expect(old.body.payments.filter((p: any) => p.kind === 'refund').map((p: any) => [p.method, p.amount])).toEqual([['exchange', '1000.00']]);
    const { rows: [r] } = await owner.query('SELECT refund_method FROM customer_returns WHERE id = $1', [res.body.exchange.returnId]);
    expect(r.refund_method).toBe('exchange');

    // A retry is the same exchange, not a second one.
    const again = await exchange(cashier.cookie, body, k);
    expect(again.body.invoiceId).toBe(res.body.invoiceId);
    expect(await onHandAt(jeans)).toBe('9');
    // The till's takings: the exchange credit goes in and out, so only the UPI counts.
    const day = await api(cashier.cookie, 'GET', '/v1/pos/summary');
    expect(day.body.methods.find((m: any) => m.method === 'exchange')).toMatchObject({ received: '1000.00', refunded: '1000.00', net: '0.00' });
    expect(await audits(T.tenantId, 'pos.exchange')).toHaveLength(1);
  });

  it('a cheaper new bill: the rest is given back the way the cashier chooses; the credit and payments are checked', async () => {
    const base = { walkIn: true, lines: [{ variantId: socks, qty: '1' }], expectedTotal: '300.00', payments: [] as unknown[] };
    const ex = { invoiceId: oldBill.invoiceId, reason: 'Did not like it', lines: back(), expectedCredit: '1000.00' };
    expect((await exchange(cashier.cookie, { ...base, exchange: { ...ex, expectedCredit: '900.00' } })).body.code).toBe('PRICE_CHANGED');
    expect((await exchange(cashier.cookie, { ...base, exchange: ex })).body.fieldErrors.refundMethod).toEqual(['Choose how to give back ₹700.00']);
    expect((await exchange(cashier.cookie, { ...base, payments: [{ method: 'cash', amount: '10' }], exchange: ex, refundMethod: 'cash' })).body.code).toBe('PAYMENT_MISMATCH');
    expect((await exchange(cashier.cookie, { ...base, exchange: { ...ex, lines: back('2') }, refundMethod: 'cash' })).body.code).toBe('RETURN_EXCEEDS_SOLD');

    const res = await exchange(cashier.cookie, { ...base, exchange: ex, refundMethod: 'cash' });
    expect(res.status, res.text).toBe(201);
    expect(res.body.exchange).toMatchObject({ credit: '1000.00', used: '300.00', givenBack: { method: 'cash', amount: '700.00' } });
    const old = await api(T.cookie, 'GET', `/v1/invoices/${oldBill.invoiceId}`);
    expect(old.body.payments.filter((p: any) => p.kind === 'refund').map((p: any) => [p.method, p.amount])).toEqual([['exchange', '1000.00'], ['exchange', '300.00'], ['cash', '700.00']]);
    // Both shirts are now back: nothing more to exchange on the old bill.
    const none = await api(cashier.cookie, 'POST', '/v1/pos/exchanges/quote', { invoiceId: oldBill.invoiceId, lines: back() });
    expect(none.body.code).toBe('RETURN_EXCEEDS_SOLD');
  });

  it('refuses a bill from an outlet with another GSTIN', async () => {
    await owner.query('UPDATE subscriptions SET extra_outlets = 1 WHERE tenant_id = $1', [T.tenantId]);
    const o = await api(T.cookie, 'POST', '/v1/outlets', { name: 'Hyderabad', address: '1 Road', stateCode: '36', gstin: gstin('36'), invoicePrefix: 'HYD', creditNotePrefix: 'HYCN' });
    expect(o.status, o.text).toBe(201);
    const room = o.body.stockRooms.find((x: any) => x.type === 'shop_floor').id;
    expect((await adjust(T.cookie, room, 'correction', [{ variantId: socks, qtyDelta: '5' }], { note: 'stock' })).status).toBe(201);
    const hyd = await sell(T.cookie, [{ variantId: socks, qty: '1' }], { outletId: o.body.outlet.id });
    expect(hyd.status, hyd.text).toBe(201);
    const q = await api(T.cookie, 'POST', '/v1/pos/exchanges/quote', { invoiceId: hyd.body.invoiceId, lines: [{ invoiceLineId: hyd.body.invoice.lines[0].id, qty: '1', condition: 'resellable' }] });
    expect([q.status, q.body.code]).toEqual([409, 'EXCHANGE_OTHER_GSTIN']);
  });

  it('only "exchange" can pay with a credit note: the returns and sales routes refuse it', async () => {
    const s = await api(T.cookie, 'POST', '/v1/pos/sales', { walkIn: true, lines: [{ variantId: socks, qty: '1' }], expectedTotal: '300.00', payments: [{ method: 'exchange', amount: '300' }] }, key());
    expect(s.status).toBe(400);
    const r = await api(T.cookie, 'POST', '/v1/returns', { invoiceId: oldBill.invoiceId, reason: 'x x x', refundMethod: 'exchange', lines: back() }, key());
    expect(r.status).toBe(400);
    await expect(owner.query(
      `INSERT INTO payments (tenant_id, order_id, kind, method, amount, recorded_by) SELECT tenant_id, order_id, 'payment', 'exchange', 1, recorded_by FROM payments WHERE tenant_id = $1 LIMIT 1`,
      [T.tenantId])).rejects.toThrow(/payments_exchange_cn/);
  });
});
