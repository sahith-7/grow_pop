import { z } from 'zod';
import type { Tx } from '../../db.js';
import { enqueue } from '../../jobs/queue.js';
import { fmtMoney } from '../../lib/decimal.js';
import { inr, localDate, paise, rupees } from '../../lib/gst.js';
import { appError, audit } from '../../lib/phase1.js';
import { can, type Role } from '../../lib/permissions.js';
import { loadProfile } from '../billing/profile.js';
import { allowedOutlets, resolveOutlet } from '../outlets/service.js';
import { notifyOwners } from './notifications.js';

// Cash control (v2, D110–D112). Each outlet has tills; a register session is one drawer from the opening count to the
// closing count. Every counter payment and refund made at a till is tagged with its open session, and so is every drawer
// movement (cash added, cash taken out, till expenses). What should be in the drawer at any moment is:
//   opening cash + cash taken − cash given back + cash added − cash taken out − expenses paid.
// Closing compares that with the notes and coins counted; any difference needs a reason, and the owner gets a summary.

export interface Actor { userId: string; role: Role }

const rupee = z.string().trim().regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter an amount like 500 or 499.50');
/** Notes and coins by face value, as counted. ₹20 and ₹10 notes and coins count together. */
export const DENOMINATIONS = ['500', '200', '100', '50', '20', '10', '5', '2', '1'] as const;
export const countsInput = z.object({
  ...Object.fromEntries(DENOMINATIONS.map((d) => [d, z.number().int().min(0).max(100_000).optional()])) as Record<(typeof DENOMINATIONS)[number], z.ZodOptional<z.ZodNumber>>,
  /** Anything else (paise, a damaged note kept aside), as an amount. */
  other: rupee.optional(),
}).strict();
type Counts = z.infer<typeof countsInput>;
const countTotal = (c: Counts) => DENOMINATIONS.reduce<bigint>((a, d) => a + BigInt(c[d] ?? 0) * BigInt(d) * 100n, 0n) + (c.other ? paise(c.other) : 0n);

const note = (min: number, max: number) => z.string().trim().min(min, 'Say why, in a few words').max(max);
export const tillInput = z.object({ outletId: z.string().uuid(), name: z.string().trim().min(1, 'Give it a name').max(40) }).strict();
export const tillPatch = z.object({ name: z.string().trim().min(1).max(40), active: z.boolean() }).partial().strict();
export const openInput = z.object({ tillId: z.string().uuid(), openingCash: rupee.optional(), counts: countsInput.optional(), note: note(3, 200).optional() }).strict();
export const closeInput = z.object({ countedCash: rupee.optional(), counts: countsInput.optional(), keptCash: rupee, note: note(3, 300).optional() }).strict();

export const CATEGORIES = {
  expense: ['Tea and snacks', 'Transport', 'Repairs', 'Cleaning', 'Stationery', 'Staff advance', 'Other'],
  cash_in: ['Float added', 'Owner added', 'Other'],
  cash_out: ['Bank deposit', 'Owner took', 'Other'],
} as const;
export const movementInput = z.object({
  kind: z.enum(['cash_in', 'cash_out', 'expense']),
  amount: rupee,
  category: z.string().trim().min(1).max(40),
  reason: note(3, 200),
}).strict();
export const decideMovementInput = z.object({ approve: z.boolean(), note: z.string().trim().max(200).optional() }).strict();

const MAX_TILLS = 20;
const bad = (field: string, msg: string) => appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { [field]: [msg] });

// ------------------------------------------------------------------ tills

/** Every outlet has at least one till, "Counter 1", made the first time it is needed. */
export async function ensureTill(tx: Tx, outletId: string) {
  await tx.query(
    `INSERT INTO tills (tenant_id, outlet_id, name) SELECT current_setting('app.tenant_id')::uuid, $1, 'Counter 1'
      WHERE NOT EXISTS (SELECT 1 FROM tills WHERE outlet_id = $1) ON CONFLICT DO NOTHING`, [outletId]);
}

/** Tills at the outlets this person works at (or one of them), each with its open register if any. */
export async function listTills(tx: Tx, actor: Actor, outletId?: string) {
  const outlets = (await allowedOutlets(tx, actor.userId, actor.role)).filter((o) => !outletId || o.id === outletId);
  for (const o of outlets) await ensureTill(tx, o.id);
  const { rows } = await tx.query(
    `SELECT t.id, t.name, t.active, t.outlet_id, o.name AS outlet_name, s.id AS session_id, s.opened_at, s.opened_by, u.name AS opened_by_name,
            (SELECT p.kept_cash FROM register_sessions p WHERE p.till_id = t.id AND p.status = 'closed' ORDER BY p.closed_at DESC LIMIT 1) AS last_kept
       FROM tills t JOIN outlets o ON o.id = t.outlet_id
       LEFT JOIN register_sessions s ON s.till_id = t.id AND s.status = 'open' LEFT JOIN users u ON u.id = s.opened_by
      WHERE t.outlet_id = ANY($1::uuid[]) ORDER BY o.is_main DESC, o.created_at, t.created_at`, [outlets.map((o) => o.id)]);
  return rows.map((r) => ({
    id: r.id as string, name: r.name as string, active: r.active as boolean, outletId: r.outlet_id as string, outlet: r.outlet_name as string,
    lastKept: fmtMoney(r.last_kept),
    open: r.session_id ? { id: r.session_id as string, openedAt: r.opened_at as Date, openedBy: r.opened_by_name as string, mine: r.opened_by === actor.userId } : null,
  }));
}

export async function createTill(tx: Tx, actor: Actor, input: z.infer<typeof tillInput>) {
  await resolveOutlet(tx, actor.userId, actor.role, input.outletId);
  await ensureTill(tx, input.outletId);
  const { rows: [n] } = await tx.query('SELECT count(*)::int AS n FROM tills WHERE outlet_id = $1', [input.outletId]);
  if (n.n >= MAX_TILLS) throw appError(409, 'TILL_LIMIT', `An outlet can have up to ${MAX_TILLS} tills.`);
  const { rows: [t] } = await tx.query(
    `INSERT INTO tills (tenant_id, outlet_id, name) VALUES (current_setting('app.tenant_id')::uuid, $1, $2)
     ON CONFLICT DO NOTHING RETURNING id`, [input.outletId, input.name]);
  if (!t) throw appError(409, 'NAME_DUPLICATE', 'This outlet already has a till with this name', { name: ['Already used'] });
  await audit(tx, { actorId: actor.userId, action: 'till.created', entityType: 'till', entityId: t.id, summary: { name: input.name } });
  return { id: t.id as string };
}

export async function patchTill(tx: Tx, actor: Actor, id: string, patch: z.infer<typeof tillPatch>) {
  const { rows: [t] } = await tx.query('SELECT * FROM tills WHERE id = $1 FOR UPDATE', [id]);
  if (!t) throw appError(404, 'NOT_FOUND', 'Till not found');
  await resolveOutlet(tx, actor.userId, actor.role, t.outlet_id);
  if (patch.active === false) {
    const { rows: [s] } = await tx.query("SELECT 1 FROM register_sessions WHERE till_id = $1 AND status = 'open'", [id]);
    if (s) throw appError(409, 'REGISTER_OPEN', 'Close this till’s register before switching the till off.');
  }
  try {
    await tx.query('UPDATE tills SET name = coalesce($2, name), active = coalesce($3, active) WHERE id = $1', [id, patch.name ?? null, patch.active ?? null]);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw appError(409, 'NAME_DUPLICATE', 'This outlet already has a till with this name', { name: ['Already used'] });
    throw e;
  }
  await audit(tx, { actorId: actor.userId, action: 'till.updated', entityType: 'till', entityId: id, summary: { name: t.name, ...patch } });
  return { id };
}

// ------------------------------------------------------------------ the drawer's numbers

async function totals(tx: Tx, sessionId: string, opening: bigint) {
  const { rows: pays } = await tx.query(
    `SELECT CASE WHEN y.method = 'exchange' THEN 'Exchange credit' ELSE coalesce(m.name, initcap(y.method)) END AS name, y.method, y.kind,
            count(*)::int AS n, sum(y.amount) AS amount
       FROM payments y LEFT JOIN payment_methods m ON m.id = y.method_id WHERE y.session_id = $1 GROUP BY 1, 2, 3 ORDER BY 1`, [sessionId]);
  const { rows: moves } = await tx.query(
    'SELECT kind, status, count(*)::int AS n, sum(amount) AS amount FROM cash_movements WHERE session_id = $1 GROUP BY kind, status', [sessionId]);
  const { rows: [bills] } = await tx.query('SELECT count(*)::int AS n, coalesce(sum(total), 0) AS total FROM sales_orders WHERE session_id = $1', [sessionId]);
  const sumPays = (method: string, kind: string) => pays.filter((p) => p.method === method && p.kind === kind).reduce<bigint>((a, p) => a + paise(p.amount), 0n);
  const sumMoves = (kind: string, status = 'posted') => moves.filter((m) => m.kind === kind && m.status === status).reduce<bigint>((a, m) => a + paise(m.amount), 0n);
  const cashSales = sumPays('cash', 'payment');
  const cashRefunds = sumPays('cash', 'refund');
  const cashIn = sumMoves('cash_in');
  const cashOut = sumMoves('cash_out');
  const expenses = sumMoves('expense');
  const expected = opening + cashSales - cashRefunds + cashIn - cashOut - expenses;
  const byMethod = new Map<string, { name: string; kind: string; received: bigint; refunded: bigint; count: number }>();
  for (const p of pays) {
    const e = byMethod.get(p.name) ?? { name: p.name, kind: p.method, received: 0n, refunded: 0n, count: 0 };
    if (p.kind === 'payment') { e.received += paise(p.amount); e.count += p.n; } else e.refunded += paise(p.amount);
    byMethod.set(p.name, e);
  }
  return {
    expected,
    out: {
      bills: bills.n as number, sales: fmtMoney(bills.total)!,
      opening: rupees(opening), cashSales: rupees(cashSales), cashRefunds: rupees(cashRefunds), cashIn: rupees(cashIn), cashOut: rupees(cashOut),
      expenses: rupees(expenses), pendingExpenses: rupees(sumMoves('expense', 'pending')), expected: rupees(expected),
      methods: [...byMethod.values()].map((m) => ({ name: m.name, kind: m.kind, received: rupees(m.received), refunded: rupees(m.refunded), payments: m.count })),
    },
  };
}

const SESSION = `SELECT s.*, t.name AS till_name, o.name AS outlet_name, ou.name AS opened_by_name, cu.name AS closed_by_name
                   FROM register_sessions s JOIN tills t ON t.id = s.till_id JOIN outlets o ON o.id = s.outlet_id
                   JOIN users ou ON ou.id = s.opened_by LEFT JOIN users cu ON cu.id = s.closed_by`;

const MOVEMENT = `SELECT m.*, ru.name AS recorded_by_name, du.name AS decided_by_name, t.name AS till_name, o.name AS outlet_name
                    FROM cash_movements m JOIN register_sessions s ON s.id = m.session_id JOIN tills t ON t.id = s.till_id
                    JOIN outlets o ON o.id = m.outlet_id JOIN users ru ON ru.id = m.recorded_by LEFT JOIN users du ON du.id = m.decided_by`;

const movementOut = (r: Record<string, any>) => ({
  id: r.id as string, sessionId: r.session_id as string, kind: r.kind as string, category: r.category as string, amount: fmtMoney(r.amount)!,
  reason: r.reason as string, status: r.status as string, recordedBy: r.recorded_by_name as string, recordedAt: r.created_at as Date,
  decidedBy: (r.decided_by_name as string | null) ?? null, decidedVia: r.decided_via as string | null, note: r.decision_note as string | null,
  till: r.till_name as string, outlet: r.outlet_name as string,
});

async function sessionRow(tx: Tx, id: string, lock = false) {
  if (lock) await tx.query('SELECT 1 FROM register_sessions WHERE id = $1 FOR UPDATE', [id]);
  const { rows: [s] } = await tx.query(`${SESSION} WHERE s.id = $1`, [id]);
  if (!s) throw appError(404, 'NOT_FOUND', 'Register not found');
  return s;
}

/** A register is shared by everyone who works at its outlet (the drawer is): a cashier can hand over to the next. */
const mayUse = (tx: Tx, actor: Actor, s: Record<string, any>) => resolveOutlet(tx, actor.userId, actor.role, s.outlet_id);

export async function sessionDetail(tx: Tx, actor: Actor, id: string) {
  const s = await sessionRow(tx, id);
  await mayUse(tx, actor, s);
  const live = s.status === 'open' ? (await totals(tx, id, paise(s.opening_cash))).out : null;
  const { rows: moves } = await tx.query(`${MOVEMENT} WHERE m.session_id = $1 ORDER BY m.created_at`, [id]);
  return {
    id: s.id as string, status: s.status as string, till: { id: s.till_id as string, name: s.till_name as string }, outlet: { id: s.outlet_id as string, name: s.outlet_name as string },
    openedBy: s.opened_by_name as string, openedAt: s.opened_at as Date, openingCash: fmtMoney(s.opening_cash)!, openingCounts: s.opening_counts,
    expectedOpening: fmtMoney(s.expected_opening), openingNote: s.opening_note as string | null,
    closedBy: (s.closed_by_name as string | null) ?? null, closedAt: s.closed_at as Date | null, countedCash: fmtMoney(s.counted_cash),
    closingCounts: s.closing_counts, expectedCash: fmtMoney(s.expected_cash), difference: fmtMoney(s.difference), keptCash: fmtMoney(s.kept_cash),
    closeNote: s.close_note as string | null,
    totals: live ?? s.summary, mine: s.opened_by === actor.userId, canManage: can(actor.role, 'cash.manage'),
    movements: moves.map(movementOut),
  };
}

// ------------------------------------------------------------------ opening and closing

export async function openRegister(tx: Tx, actor: Actor, input: z.infer<typeof openInput>) {
  const { rows: [t] } = await tx.query('SELECT * FROM tills WHERE id = $1 FOR UPDATE', [input.tillId]);
  if (!t || !t.active) throw bad('tillId', 'Till not found or switched off');
  await resolveOutlet(tx, actor.userId, actor.role, t.outlet_id);
  const { rows: [already] } = await tx.query(`${SESSION} WHERE s.till_id = $1 AND s.status = 'open'`, [t.id]);
  if (already) throw appError(409, 'REGISTER_OPEN', `${t.name} is already open (opened by ${already.opened_by_name}). Use it, or close it first.`);
  if (!input.counts && input.openingCash === undefined) throw bad('openingCash', 'Count the cash in the drawer');
  const counted = input.counts ? countTotal(input.counts) : paise(input.openingCash!);
  if (input.counts && input.openingCash !== undefined && paise(input.openingCash) !== counted) throw bad('openingCash', `The notes and coins add up to ₹${inr(counted)}`);

  // Handover: the last closing at this till left some cash in the drawer. If today's count differs, say why.
  const { rows: [prev] } = await tx.query("SELECT id, kept_cash FROM register_sessions WHERE till_id = $1 AND status = 'closed' ORDER BY closed_at DESC LIMIT 1", [t.id]);
  const expectedOpening = prev ? paise(prev.kept_cash) : null;
  if (expectedOpening !== null && expectedOpening !== counted && !input.note) {
    throw bad('note', `The last closing left ₹${inr(expectedOpening)} in the drawer, and you counted ₹${inr(counted)}. Say why.`);
  }
  const { rows: [s] } = await tx.query(
    `INSERT INTO register_sessions (tenant_id, outlet_id, till_id, opened_by, opening_cash, opening_counts, expected_opening, opening_note, previous_id)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [t.outlet_id, t.id, actor.userId, rupees(counted), input.counts ? JSON.stringify(input.counts) : null,
      expectedOpening === null ? null : rupees(expectedOpening), input.note ?? null, prev?.id ?? null]);
  await audit(tx, {
    actorId: actor.userId, action: 'register.opened', entityType: 'register', entityId: s.id,
    summary: { till: t.name, openingCash: rupees(counted), ...(expectedOpening !== null && expectedOpening !== counted ? { lastLeft: rupees(expectedOpening), note: input.note } : {}) },
  });
  return sessionDetail(tx, actor, s.id);
}

export async function closeRegister(tx: Tx, actor: Actor, id: string, input: z.infer<typeof closeInput>) {
  const s = await sessionRow(tx, id, true);
  await resolveOutlet(tx, actor.userId, actor.role, s.outlet_id);
  if (s.status !== 'open') throw appError(409, 'REGISTER_CLOSED', `This register was closed by ${s.closed_by_name}.`);
  if (s.opened_by !== actor.userId && !can(actor.role, 'cash.manage')) {
    throw appError(403, 'FORBIDDEN', `${s.opened_by_name} opened this register. They, the owner or a manager can close it.`);
  }
  if (!input.counts && input.countedCash === undefined) throw bad('countedCash', 'Count the cash in the drawer');
  const counted = input.counts ? countTotal(input.counts) : paise(input.countedCash!);
  if (input.counts && input.countedCash !== undefined && paise(input.countedCash) !== counted) throw bad('countedCash', `The notes and coins add up to ₹${inr(counted)}`);
  const kept = paise(input.keptCash);
  if (kept > counted) throw bad('keptCash', `Only ₹${inr(counted)} was counted`);

  // An expense still waiting for approval is not paid: it lapses with the register.
  const { rowCount: lapsed } = await tx.query(
    "UPDATE cash_movements SET status = 'cancelled', decision_note = 'Register closed before it was answered' WHERE session_id = $1 AND status = 'pending'", [id]);
  const { expected, out } = await totals(tx, id, paise(s.opening_cash));
  const difference = counted - expected;
  if (difference !== 0n && !input.note) {
    throw bad('note', `The drawer is ${difference < 0n ? 'short' : 'over'} by ₹${inr(difference < 0n ? -difference : difference)}. Say why.`);
  }
  const summary = {
    ...out, counted: rupees(counted), difference: rupees(difference), kept: rupees(kept), takenOut: rupees(counted - kept), lapsedExpenses: lapsed ?? 0,
    till: s.till_name, outlet: s.outlet_name, openedBy: s.opened_by_name, openedAt: s.opened_at, closedAt: new Date(),
  };
  const { rows: [me] } = await tx.query('SELECT name FROM users WHERE id = $1', [actor.userId]);
  await tx.query(
    `UPDATE register_sessions SET status = 'closed', closed_by = $2, closed_at = now(), counted_cash = $3, closing_counts = $4, expected_cash = $5,
       difference = $6, kept_cash = $7, close_note = $8, summary = $9 WHERE id = $1`,
    [id, actor.userId, rupees(counted), input.counts ? JSON.stringify(input.counts) : null, rupees(expected), rupees(difference), rupees(kept),
      input.note ?? null, JSON.stringify({ ...summary, closedBy: me.name })]);
  await audit(tx, {
    actorId: actor.userId, action: 'register.closed', entityType: 'register', entityId: id,
    summary: { till: s.till_name, outlet: s.outlet_name, expected: rupees(expected), counted: rupees(counted), difference: rupees(difference), kept: rupees(kept), note: input.note ?? null },
  });

  // The owner hears about it: in the app now, by e-mail once this commits.
  const p = await loadProfile(tx, s.outlet_id);
  const diffText = difference === 0n ? 'cash matched' : `cash ${difference < 0n ? 'short' : 'over'} by ₹${inr(difference < 0n ? -difference : difference)}`;
  await notifyOwners(tx, {
    kind: 'register_closed', link: `/cash/registers/${id}`,
    title: `${s.till_name} closed at ${s.outlet_name}${difference === 0n ? '' : difference < 0n ? ': short' : ': over'}`,
    body: `${out.bills} bill${out.bills === 1 ? '' : 's'}, sales ₹${inr(out.sales)}. Cash expected ₹${inr(expected)}, counted ₹${inr(counted)} (${diffText}). Expenses ₹${inr(out.expenses)}. Closed by ${me.name} at ${new Intl.DateTimeFormat('en-IN', { timeZone: p.timezone, hour: 'numeric', minute: '2-digit' }).format(new Date())}.`,
  });
  await enqueue(tx, 'mail.register', id);
  return sessionDetail(tx, actor, id);
}

// ------------------------------------------------------------------ which register a payment belongs to

/**
 * The open register at the till a sale comes from. With "open the register before billing" on (the default), a sale
 * without one is refused. The row is share-locked, so a closing waits for a sale in progress and counts it.
 */
export async function sessionFor(tx: Tx, outletId: string, tillId: string | undefined, required: boolean): Promise<string | null> {
  if (!tillId) {
    if (required) throw appError(409, 'REGISTER_CLOSED', 'Open the register before billing: count the cash in the drawer first.');
    return null;
  }
  const { rows: [t] } = await tx.query('SELECT outlet_id, name FROM tills WHERE id = $1', [tillId]);
  if (!t) throw bad('tillId', 'Till not found');
  if (t.outlet_id !== outletId) throw bad('tillId', 'This till is at another outlet');
  const { rows: [s] } = await tx.query("SELECT id FROM register_sessions WHERE till_id = $1 AND status = 'open' FOR SHARE", [tillId]);
  if (s) return s.id as string;
  if (required) throw appError(409, 'REGISTER_CLOSED', `The register at ${t.name} is closed. Open it with the cash count first.`);
  return null;
}

/**
 * Money given back from the back office (a return or a void): from the till named, else the only register open at that
 * outlet. Cash needs a register when the store requires one; other methods are tagged when there is one to tag.
 */
export async function refundSession(tx: Tx, outletId: string, tillId: string | undefined, method: string, required: boolean) {
  const needed = required && method === 'cash';
  if (tillId) return sessionFor(tx, outletId, tillId, needed);
  const { rows } = await tx.query("SELECT id FROM register_sessions WHERE outlet_id = $1 AND status = 'open' FOR SHARE", [outletId]);
  if (rows.length === 1) return rows[0].id as string;
  if (!needed) return null;
  if (!rows.length) throw appError(409, 'REGISTER_CLOSED', 'No register is open at this outlet. Open one to give cash back, or refund another way.');
  throw bad('tillId', 'Choose the till the cash comes from');
}

// ------------------------------------------------------------------ cash added, taken out, expenses

async function expenseNeedsApproval(tx: Tx, actor: Actor, outletId: string, amount: bigint) {
  if (can(actor.role, 'cash.manage')) return null;
  const p = await loadProfile(tx, outletId);
  const each = paise(p.settings.expenseLimitEach);
  const day = paise(p.settings.expenseLimitDay);
  if (amount > each) return `₹${inr(amount)} is above your limit of ₹${inr(each)} for one expense`;
  const { rows: [r] } = await tx.query(
    `SELECT coalesce(sum(amount), 0) AS spent FROM cash_movements
      WHERE recorded_by = $1 AND kind = 'expense' AND status = 'posted' AND (created_at AT TIME ZONE $2)::date = $3::date`,
    [actor.userId, p.timezone, localDate(new Date(), p.timezone)]);
  const spent = paise(r.spent);
  if (spent + amount > day) return `With this, your expenses today would be ₹${inr(spent + amount)}, above your daily limit of ₹${inr(day)}`;
  return null;
}

async function drawerHas(tx: Tx, s: Record<string, any>, amount: bigint) {
  const { expected } = await totals(tx, s.id, paise(s.opening_cash));
  if (amount > expected) throw appError(409, 'NOT_ENOUGH_CASH', `The drawer should hold ₹${inr(expected > 0n ? expected : 0n)}: it can't pay out ₹${inr(amount)}.`);
}

export async function recordMovement(tx: Tx, actor: Actor, sessionId: string, input: z.infer<typeof movementInput>) {
  const s = await sessionRow(tx, sessionId, true);
  await resolveOutlet(tx, actor.userId, actor.role, s.outlet_id);
  if (s.status !== 'open') throw appError(409, 'REGISTER_CLOSED', 'This register is closed.');
  if (!(CATEGORIES[input.kind] as readonly string[]).includes(input.category)) throw bad('category', 'Pick one from the list');
  if (input.kind === 'cash_out' && !can(actor.role, 'cash.manage')) throw appError(403, 'FORBIDDEN', 'Only the owner or a manager can take cash out of the drawer.');
  const amount = paise(input.amount);
  if (amount <= 0n) throw bad('amount', 'More than ₹0');
  const why = input.kind === 'expense' ? await expenseNeedsApproval(tx, actor, s.outlet_id, amount) : null;
  if (!why && input.kind !== 'cash_in') await drawerHas(tx, s, amount);
  const { rows: [m] } = await tx.query(
    `INSERT INTO cash_movements (tenant_id, outlet_id, session_id, kind, category, amount, reason, status, recorded_by)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [s.outlet_id, sessionId, input.kind, input.category, rupees(amount), input.reason, why ? 'pending' : 'posted', actor.userId]);
  await audit(tx, {
    actorId: actor.userId, action: why ? 'cash.expense_requested' : `cash.${input.kind}`, entityType: 'cash_movement', entityId: m.id,
    summary: { till: s.till_name, category: input.category, amount: rupees(amount), reason: input.reason, ...(why ? { needsApproval: why } : {}) },
  });
  return { ...(await readMovement(tx, actor, m.id)), needsApproval: why };
}

export async function readMovement(tx: Tx, actor: Actor, id: string) {
  const { rows: [m] } = await tx.query(`${MOVEMENT} WHERE m.id = $1`, [id]);
  if (!m || (m.recorded_by !== actor.userId && !can(actor.role, 'cash.manage'))) throw appError(404, 'NOT_FOUND', 'Not found');
  return movementOut(m);
}

/** An expense above the limit, answered by an owner or manager: at the till with their PIN, or from the Approvals page. */
export async function decideMovement(tx: Tx, approver: { id: string; name: string; role: Role }, id: string, approve: boolean, via: 'pin' | 'remote', decisionNote?: string) {
  const { rows: [m0] } = await tx.query('SELECT session_id FROM cash_movements WHERE id = $1', [id]);
  if (!m0) throw appError(404, 'NOT_FOUND', 'Expense not found');
  const s = await sessionRow(tx, m0.session_id, true);
  const { rows: [m] } = await tx.query('SELECT * FROM cash_movements WHERE id = $1 FOR UPDATE', [id]);
  if (m.status !== 'pending') throw appError(409, 'ALREADY_ANSWERED', m.status === 'cancelled' ? 'This expense was cancelled.' : 'This expense was already answered.');
  if (m.recorded_by === approver.id) throw appError(403, 'FORBIDDEN', 'You can’t approve your own expense.');
  if (!can(approver.role, 'cash.manage')) throw appError(403, 'FORBIDDEN', 'Only the owner or a manager can approve an expense.');
  if (approve) await drawerHas(tx, s, paise(m.amount));
  await tx.query(
    'UPDATE cash_movements SET status = $2, decided_by = $3, decided_via = $4, decided_at = now(), decision_note = $5 WHERE id = $1',
    [id, approve ? 'posted' : 'rejected', approver.id, via, decisionNote || null]);
  await audit(tx, {
    actorId: approver.id, action: approve ? 'cash.expense_approved' : 'cash.expense_rejected', entityType: 'cash_movement', entityId: id,
    summary: { till: s.till_name, amount: fmtMoney(m.amount), category: m.category, reason: m.reason, via, note: decisionNote || null },
  });
}

export async function cancelMovement(tx: Tx, actor: Actor, id: string) {
  const { rows: [m] } = await tx.query('SELECT * FROM cash_movements WHERE id = $1 FOR UPDATE', [id]);
  if (!m || m.recorded_by !== actor.userId) throw appError(404, 'NOT_FOUND', 'Expense not found');
  if (m.status !== 'pending') throw appError(409, 'ALREADY_ANSWERED', 'This expense was already answered.');
  await tx.query("UPDATE cash_movements SET status = 'cancelled' WHERE id = $1", [id]);
  return readMovement(tx, actor, id);
}

/** Expenses waiting for this owner's or manager's answer, at the outlets they work at. */
export async function waitingExpenses(tx: Tx, actor: Actor) {
  if (!can(actor.role, 'cash.manage')) return [];
  const outlets = (await allowedOutlets(tx, actor.userId, actor.role)).map((o) => o.id);
  const { rows } = await tx.query(`${MOVEMENT} WHERE m.status = 'pending' AND m.recorded_by <> $1 AND m.outlet_id = ANY($2::uuid[]) ORDER BY m.created_at`, [actor.userId, outlets]);
  return rows.map(movementOut);
}

// ------------------------------------------------------------------ registers and the cash book

const outletScope = async (tx: Tx, actor: Actor, outletId?: string) => {
  const all = await allowedOutlets(tx, actor.userId, actor.role);
  if (outletId && !all.some((o) => o.id === outletId)) throw appError(403, 'OUTLET_NOT_ALLOWED', 'You don’t work at this outlet.');
  return outletId ? [outletId] : all.map((o) => o.id);
};

/** Registers open now and closed recently, for the outlets in view (all of them, or the one picked). */
export async function listRegisters(tx: Tx, actor: Actor, f: { outletId?: string; days: number }) {
  const outlets = await outletScope(tx, actor, f.outletId);
  const { rows } = await tx.query(
    `${SESSION} WHERE s.outlet_id = ANY($1::uuid[]) AND (s.status = 'open' OR s.closed_at > now() - make_interval(days => $2))
      ORDER BY s.status = 'open' DESC, coalesce(s.closed_at, s.opened_at) DESC LIMIT 200`, [outlets, f.days]);
  const items = [];
  for (const s of rows) {
    const t = s.status === 'open' ? (await totals(tx, s.id, paise(s.opening_cash))).out : s.summary;
    items.push({
      id: s.id as string, status: s.status as string, till: s.till_name as string, outlet: s.outlet_name as string, outletId: s.outlet_id as string,
      openedBy: s.opened_by_name as string, openedAt: s.opened_at as Date, closedBy: (s.closed_by_name as string | null) ?? null, closedAt: s.closed_at as Date | null,
      bills: t.bills as number, sales: t.sales as string, expected: (s.status === 'open' ? t.expected : fmtMoney(s.expected_cash)) as string,
      counted: fmtMoney(s.counted_cash), difference: fmtMoney(s.difference),
    });
  }
  return { items };
}

/** One day's cash at the outlets in view: every register that was open that day, and every drawer movement. */
export async function cashBook(tx: Tx, actor: Actor, f: { outletId?: string; date?: string }) {
  const outlets = await outletScope(tx, actor, f.outletId);
  const p = await loadProfile(tx);
  const day = f.date ?? localDate(new Date(), p.timezone);
  const { rows: sessions } = await tx.query(
    `${SESSION} WHERE s.outlet_id = ANY($1::uuid[]) AND (s.opened_at AT TIME ZONE $3)::date <= $2::date
        AND (s.closed_at IS NULL OR (s.closed_at AT TIME ZONE $3)::date >= $2::date)
      ORDER BY o.is_main DESC, o.name, t.name, s.opened_at`, [outlets, day, p.timezone]);
  const registers = [];
  const sum = { opening: 0n, cashSales: 0n, cashRefunds: 0n, cashIn: 0n, cashOut: 0n, expenses: 0n, expected: 0n, counted: 0n, difference: 0n };
  for (const s of sessions) {
    const t = s.status === 'open' ? (await totals(tx, s.id, paise(s.opening_cash))).out : s.summary;
    registers.push({
      id: s.id as string, status: s.status as string, till: s.till_name as string, outlet: s.outlet_name as string, openedBy: s.opened_by_name as string,
      openedAt: s.opened_at as Date, closedBy: (s.closed_by_name as string | null) ?? null, closedAt: s.closed_at as Date | null,
      opening: t.opening, cashSales: t.cashSales, cashRefunds: t.cashRefunds, cashIn: t.cashIn, cashOut: t.cashOut, expenses: t.expenses,
      expected: s.status === 'open' ? t.expected : fmtMoney(s.expected_cash), counted: fmtMoney(s.counted_cash), difference: fmtMoney(s.difference),
      bills: t.bills, sales: t.sales, closeNote: s.close_note as string | null,
    });
    for (const k of ['opening', 'cashSales', 'cashRefunds', 'cashIn', 'cashOut', 'expenses'] as const) sum[k] += paise(t[k]);
    sum.expected += paise(s.status === 'open' ? t.expected : s.expected_cash);
    if (s.status === 'closed') { sum.counted += paise(s.counted_cash); sum.difference += paise(s.difference); }
  }
  const { rows: moves } = await tx.query(
    `${MOVEMENT} WHERE m.outlet_id = ANY($1::uuid[]) AND (m.created_at AT TIME ZONE $3)::date = $2::date ORDER BY m.created_at`, [outlets, day, p.timezone]);
  return {
    date: day, registers, movements: moves.map(movementOut),
    totals: Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, rupees(v)])),
  };
}
