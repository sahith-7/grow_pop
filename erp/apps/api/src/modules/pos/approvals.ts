import { z } from 'zod';
import type { Tx } from '../../db.js';
import { hashPassword, verifyPassword } from '../../lib/crypto.js';
import { fmtMoney } from '../../lib/decimal.js';
import { rateBp, rupees } from '../../lib/gst.js';
import { appError, audit } from '../../lib/phase1.js';
import { can, type Role } from '../../lib/permissions.js';
import { qtyText } from '../../lib/quantity.js';
import { loadProfile } from '../billing/profile.js';
import { waitingExpenses } from '../cash/registers.js';
import { cartInput, limitOf, priceCart, type Seat } from './pricing.js';
import { tillProfile } from './service.js';

// Discount approval (v2, D107). A cashier gives a discount above their limit only with an owner's or manager's yes:
//  - at the till: the approver picks their name and types their own PIN on the cashier's screen, or
//  - from anywhere: the request waits on the Approvals page; the till checks every few seconds until it is answered.
// An approval covers that exact cart (items, quantities, prices, discounts) for 15 minutes and one bill. An approver can
// allow up to their own limit (a manager's is set in Billing & GST; the owner's is 100%). Nobody approves their own request.

const MINUTES_TO_ANSWER = 30;
const MINUTES_TO_USE = 15;
const PIN_TRIES = 5;          // wrong tries in a row before a 15-minute lock
const PIN_LOCK_MINUTES = 15;
const PIN_TRIES_OFF = 15;     // wrong tries in a row before the PIN stops working until its owner sets it again

export const requestInput = z.object({ cart: cartInput, reason: z.string().trim().min(3, 'Say why, in a few words').max(200) }).strict();
export const pinInput = z.object({ approverId: z.string().uuid(), pin: z.string().regex(/^\d{4,6}$/, '4 to 6 digits') }).strict();
export const decideInput = z.object({ approve: z.boolean(), note: z.string().trim().max(200).optional() }).strict();
export const setPinInput = z.object({ pin: z.string().regex(/^\d{4,6}$/, 'Use 4 to 6 digits'), password: z.string().min(1, 'Enter your password').max(200) }).strict();

const statusOf = (r: Record<string, any>) => (r.status === 'pending' && !r.answerable ? 'expired' : r.status === 'approved' && !r.live ? 'expired' : r.status as string);

const out = (r: Record<string, any>) => ({
  id: r.id as string, status: statusOf(r), outlet: r.outlet_name as string, requestedBy: r.requested_by_name as string,
  requestedAt: r.created_at as Date, reason: r.reason as string, discountTotal: fmtMoney(r.discount_total), maxPct: String(Number(r.max_pct)),
  summary: r.summary as Record<string, unknown>, decidedBy: (r.decided_by_name as string | null) ?? null, decidedVia: r.decided_via as string | null,
  decidedAt: r.decided_at as Date | null, note: r.decision_note as string | null, expiresAt: r.expires_at as Date,
});

const SELECT = `SELECT r.*, o.name AS outlet_name, q.name AS requested_by_name, d.name AS decided_by_name,
                       r.expires_at > now() AS live, r.created_at > now() - interval '${MINUTES_TO_ANSWER} minutes' AS answerable
                  FROM discount_requests r JOIN outlets o ON o.id = r.outlet_id JOIN users q ON q.id = r.requested_by
                  LEFT JOIN users d ON d.id = r.decided_by`;

async function one(tx: Tx, id: string, lock = false) {
  const { rows: [r] } = await tx.query(`${SELECT} WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`, [id]);
  if (!r) throw appError(404, 'NOT_FOUND', 'Discount request not found');
  return r;
}

/** Ask for a discount above this person's limit. A newer request from the same person at the same till replaces theirs. */
export async function requestDiscount(tx: Tx, seat: Seat, input: z.infer<typeof requestInput>) {
  if (!seat.canDiscount) throw appError(403, 'FORBIDDEN', 'You are not allowed to give discounts');
  const p = await tillProfile(tx, seat, input.cart.outletId);
  const priced = await priceCart(tx, p, seat, { ...input.cart, approvalId: undefined }, { requesting: { reason: input.reason } });
  if (!priced.overLimit.length) throw appError(400, 'APPROVAL_NOT_NEEDED', `This discount is within your limit of ${priced.limitPct}%: no approval needed.`);
  const maxPct = priced.overLimit.reduce((m, o) => (Number(o.pct) > m ? Number(o.pct) : m), 0);
  const summary = {
    limitPct: priced.limitPct, customer: priced.buyer.name ?? null,
    lines: priced.lines.map((l) => ({ sku: l.sku, name: l.description, qty: qtyText(l.qty), price: fmtMoney(l.unitPrice), gross: rupees(l.gross), discount: rupees(l.discount), pct: l.discountPctApplied })),
    subtotal: rupees(priced.totals.gross), discountTotal: rupees(priced.totals.discount), total: rupees(priced.totals.total),
  };
  await tx.query(`UPDATE discount_requests SET status = 'cancelled' WHERE requested_by = $1 AND outlet_id = $2 AND status = 'pending'`, [seat.userId, p.outlet.id]);
  const { rows: [r] } = await tx.query(
    `INSERT INTO discount_requests (tenant_id, outlet_id, requested_by, cart_hash, summary, discount_total, max_pct, reason, expires_at)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, now() + interval '${MINUTES_TO_ANSWER} minutes') RETURNING id`,
    [p.outlet.id, seat.userId, priced.hash, JSON.stringify(summary), rupees(priced.totals.discount), maxPct.toFixed(2), input.reason]);
  await audit(tx, { actorId: seat.userId, action: 'discount.requested', entityType: 'discount_request', entityId: r.id,
    summary: { outlet: p.outlet.name, discountTotal: summary.discountTotal, maxPct: String(maxPct), limitPct: priced.limitPct, reason: input.reason } });
  return out(await one(tx, r.id));
}

/** The till checks on its own request; approvers can read any. */
export async function readRequest(tx: Tx, seat: Seat, id: string) {
  const r = await one(tx, id);
  if (r.requested_by !== seat.userId && !can(seat.role, 'pos.discount_approve')) throw appError(404, 'NOT_FOUND', 'Discount request not found');
  return out(r);
}

export async function cancelRequest(tx: Tx, seat: Seat, id: string) {
  const r = await one(tx, id, true);
  if (r.requested_by !== seat.userId) throw appError(404, 'NOT_FOUND', 'Discount request not found');
  if (r.status === 'pending' || r.status === 'approved') await tx.query(`UPDATE discount_requests SET status = 'cancelled' WHERE id = $1`, [id]);
  return out(await one(tx, id));
}

/** The approver's limit must cover the request; a pending request must still be answerable. */
async function decide(tx: Tx, r: Record<string, any>, approver: { id: string; name: string; role: Role }, approve: boolean, via: 'pin' | 'remote', note?: string) {
  if (r.requested_by === approver.id) throw appError(403, 'OWN_REQUEST', 'You can’t approve your own discount.');
  if (r.status !== 'pending') throw appError(409, 'ALREADY_ANSWERED', r.status === 'cancelled' ? 'The cashier cancelled this request.' : `This request was already ${r.status === 'used' ? 'used' : r.status}.`);
  if (!r.answerable) throw appError(409, 'REQUEST_EXPIRED', 'This request is too old. The cashier can ask again.');
  if (approve) {
    const p = await loadProfile(tx, r.outlet_id);
    const limit = limitOf(approver.role, p);
    if (rateBp(String(Number(r.max_pct))) > rateBp(limit)) {
      throw appError(403, 'DISCOUNT_LIMIT', `${Number(r.max_pct)}% is above ${approver.name}’s own limit of ${limit}%. Ask the owner.`);
    }
  }
  await tx.query(
    `UPDATE discount_requests SET status = $2, decided_by = $3, decided_via = $4, decided_at = now(), decision_note = $5,
       expires_at = CASE WHEN $2 = 'approved' THEN now() + interval '${MINUTES_TO_USE} minutes' ELSE expires_at END WHERE id = $1`,
    [r.id, approve ? 'approved' : 'rejected', approver.id, via, note || null]);
  await audit(tx, {
    actorId: approver.id, action: approve ? 'discount.approved' : 'discount.rejected', entityType: 'discount_request', entityId: r.id,
    summary: { via, requestedBy: r.requested_by_name, outlet: r.outlet_name, discountTotal: fmtMoney(r.discount_total), maxPct: String(Number(r.max_pct)), note: note || null },
  });
}

/** From the Approvals page: the signed-in owner or manager answers. */
export async function decideRemote(tx: Tx, seat: Seat, id: string, input: z.infer<typeof decideInput>) {
  const r = await one(tx, id, true);
  const { rows: [me] } = await tx.query('SELECT name FROM users WHERE id = $1', [seat.userId]);
  await decide(tx, r, { id: seat.userId, name: me.name, role: seat.role }, input.approve, 'remote', input.note);
  return out(await one(tx, id));
}

export type PinProblem = { status: number; code: string; message: string };

/**
 * An owner's or manager's PIN typed on a cashier's screen (discounts, D107; till expenses, D111). Wrong tries are
 * counted even though the request fails, so the caller commits its transaction and only then reports the problem.
 * Wrong tries count until a right one: every 5th locks the PIN for 15 minutes, the 15th switches it off until its owner
 * sets it again (with their password). So someone guessing gets at most 15 tries at a 4-digit PIN.
 */
export async function checkPin(tx: Tx, seat: Seat, input: z.infer<typeof pinInput>, about: Record<string, unknown>):
  Promise<{ problem: PinProblem } | { approver: { id: string; name: string; role: Role } }> {
  const { rows: [u] } = await tx.query('SELECT id, name, role, status FROM users WHERE id = $1', [input.approverId]);
  if (!u || u.status !== 'active' || u.id === seat.userId || !can(u.role, 'pos.discount_approve')) {
    throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { approverId: ['Pick an owner or manager'] });
  }
  const { rows: [k] } = await tx.query(`SELECT pin_hash, failed_count, locked_until > now() AS locked, locked_until = 'infinity' AS off FROM pos_pins WHERE user_id = $1 FOR UPDATE`, [u.id]);
  const a = { ...u, pin_hash: k?.pin_hash as string | undefined, failed_count: (k?.failed_count as number) ?? 0, locked: !!k?.locked, off: !!k?.off };
  if (!a.pin_hash) return { problem: { status: 409, code: 'PIN_NOT_SET', message: `${a.name} has not set a PIN. They can set one on Password & sign-in, or approve from the Approvals page.` } };
  if (a.off) return { problem: { status: 429, code: 'PIN_LOCKED', message: `${a.name}’s PIN was switched off after ${PIN_TRIES_OFF} wrong tries in a row. They can set it again on Password & sign-in, or approve from the Approvals page.` } };
  if (a.locked) return { problem: { status: 429, code: 'PIN_LOCKED', message: `Too many wrong PINs for ${a.name}. Try again in ${PIN_LOCK_MINUTES} minutes, or approve from the Approvals page.` } };
  if (!(await verifyPassword(a.pin_hash, input.pin))) {
    const tries = a.failed_count + 1;
    const off = tries >= PIN_TRIES_OFF;
    const lock = !off && tries % PIN_TRIES === 0;
    await tx.query(
      `UPDATE pos_pins SET failed_count = $2,
         locked_until = CASE WHEN $3 THEN 'infinity'::timestamptz WHEN $4 THEN now() + interval '${PIN_LOCK_MINUTES} minutes' ELSE locked_until END WHERE user_id = $1`, [a.id, tries, off, lock]);
    if (off || lock) await audit(tx, { actorId: seat.userId, action: 'pos.pin_locked', entityType: 'user', entityId: a.id, summary: { approver: a.name, ...about, wrongTries: tries, switchedOff: off } });
    const left = PIN_TRIES - (tries % PIN_TRIES);
    return { problem: { status: 403, code: 'WRONG_PIN', message: off ? `Wrong PIN. ${a.name}’s PIN is now switched off until they set it again.`
      : lock ? `Wrong PIN. ${a.name}’s PIN is locked for ${PIN_LOCK_MINUTES} minutes.` : `Wrong PIN (${left} ${left === 1 ? 'try' : 'tries'} left).` } };
  }
  await tx.query('UPDATE pos_pins SET failed_count = 0, locked_until = NULL WHERE user_id = $1', [a.id]);
  return { approver: { id: a.id as string, name: a.name as string, role: a.role as Role } };
}

/** A discount approved at the till with the approver's PIN (D107). */
export async function approveWithPin(tx: Tx, seat: Seat, id: string, input: z.infer<typeof pinInput>): Promise<{ problem?: PinProblem; request?: ReturnType<typeof out> }> {
  const r = await one(tx, id, true);
  if (r.requested_by !== seat.userId) throw appError(404, 'NOT_FOUND', 'Discount request not found');
  const pin = await checkPin(tx, seat, input, { request: id });
  if ('problem' in pin) return pin;
  await decide(tx, r, pin.approver, true, 'pin');
  return { request: out(await one(tx, id)) };
}

/** Owners and managers who can approve at this outlet's till, and whether each has a PIN. Names only. */
export async function approvers(tx: Tx, seat: Seat) {
  const { rows } = await tx.query(
    `SELECT u.id, u.name, u.role, k.user_id IS NOT NULL AS has_pin FROM users u LEFT JOIN pos_pins k ON k.user_id = u.id
      WHERE u.status = 'active' AND u.id <> $1 ORDER BY u.role = 'owner' DESC, lower(u.name)`, [seat.userId]);
  return { items: rows.filter((r) => can(r.role, 'pos.discount_approve')).map((r) => ({ id: r.id as string, name: r.name as string, role: r.role as string, hasPin: r.has_pin as boolean })) };
}

/** The Approvals page: what is waiting, then what was answered in the last 2 days. */
export async function listRequests(tx: Tx, seat: Seat) {
  const { rows: waiting } = await tx.query(
    `${SELECT} WHERE r.status = 'pending' AND r.created_at > now() - interval '${MINUTES_TO_ANSWER} minutes' AND r.requested_by <> $1 ORDER BY r.created_at`, [seat.userId]);
  const { rows: recent } = await tx.query(
    `${SELECT} WHERE (r.status <> 'pending' OR r.created_at <= now() - interval '${MINUTES_TO_ANSWER} minutes') AND r.created_at > now() - interval '2 days'
      ORDER BY r.created_at DESC LIMIT 50`);
  return { waiting: waiting.map(out), recent: recent.map(out) };
}

export async function waitingCount(tx: Tx, seat: Seat) {
  const { rows: [r] } = await tx.query(
    `SELECT count(*)::int AS n FROM discount_requests WHERE status = 'pending' AND created_at > now() - interval '${MINUTES_TO_ANSWER} minutes' AND requested_by <> $1`, [seat.userId]);
  // Till expenses above the limit wait for the owner or a manager too (D111).
  const expenses = can(seat.role, 'cash.manage') ? (await waitingExpenses(tx, seat)).length : 0;
  return { waiting: (r.n as number) + expenses, discounts: r.n as number, expenses };
}

// ------------------------------------------------------------------ the approver's own PIN

/** 1111, 1234, 4321 and the like are the first guesses anyone makes. */
const easyPin = (pin: string) => /^(\d)\1+$/.test(pin) || '01234567890123456789'.includes(pin) || '98765432109876543210'.includes(pin);

export async function pinStatus(tx: Tx, userId: string) {
  const { rows: [k] } = await tx.query(`SELECT updated_at, locked_until > now() AS locked, locked_until = 'infinity' AS off FROM pos_pins WHERE user_id = $1`, [userId]);
  return { set: !!k, updatedAt: (k?.updated_at as Date) ?? null, locked: !!k?.locked, switchedOff: !!k?.off };
}

/** Set or change one's own PIN; the account password proves it is them (a PIN is worth a discount). */
export async function setPin(tx: Tx, userId: string, input: z.infer<typeof setPinInput>) {
  if (easyPin(input.pin)) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { pin: ['Too easy to guess. Avoid repeated or running digits.'] });
  const { rows: [u] } = await tx.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!u?.password_hash || !(await verifyPassword(u.password_hash, input.password))) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { password: ['Wrong password'] });
  await tx.query(
    `INSERT INTO pos_pins (tenant_id, user_id, pin_hash) VALUES (current_setting('app.tenant_id')::uuid, $1, $2)
     ON CONFLICT (user_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, failed_count = 0, locked_until = NULL, updated_at = now()`, [userId, await hashPassword(input.pin)]);
  await audit(tx, { actorId: userId, action: 'pos.pin_set', entityType: 'user', entityId: userId });
  return pinStatus(tx, userId);
}

export async function removePin(tx: Tx, userId: string) {
  const { rowCount } = await tx.query('DELETE FROM pos_pins WHERE user_id = $1', [userId]);
  if (rowCount) await audit(tx, { actorId: userId, action: 'pos.pin_removed', entityType: 'user', entityId: userId });
  return pinStatus(tx, userId);
}
