import { z } from 'zod';
import type { Tx } from '../../db.js';
import { fmtMoney } from '../../lib/decimal.js';
import { rupees } from '../../lib/gst.js';
import { appError, audit } from '../../lib/phase1.js';
import { loadProfile } from '../billing/profile.js';
import { resolveOutlet } from '../outlets/service.js';
import { cartInput, priceCart, type CartInput, type Seat } from './pricing.js';

// Held bills (v2, D105). A cashier parks a bill (payment trouble, a customer gone to fetch something) and serves the next
// customer. Any cashier at the same outlet picks it up again; it is priced afresh then, and no stock is set aside meanwhile.

export const MAX_HELD = 50;
export const holdInput = z.object({ cart: cartInput, label: z.string().trim().min(1).max(60).optional() }).strict();

const out = (r: Record<string, any>) => ({
  id: r.id as string, label: r.label as string | null, itemCount: r.item_count as number, total: fmtMoney(r.total), customer: r.customer_name as string | null,
  heldBy: r.held_by_name as string | null, heldAt: r.created_at as Date,
});

export async function listHeld(tx: Tx, seat: Seat, outletId: string | undefined) {
  const { outlet } = await resolveOutlet(tx, seat.userId, seat.role, outletId);
  const { rows } = await tx.query(
    `SELECT h.*, u.name AS held_by_name FROM pos_held_bills h LEFT JOIN users u ON u.id = h.held_by WHERE h.outlet_id = $1 ORDER BY h.created_at`, [outlet.id]);
  return { items: rows.map(out), max: MAX_HELD };
}

export async function holdBill(tx: Tx, seat: Seat, input: z.infer<typeof holdInput>) {
  const { outlet } = await resolveOutlet(tx, seat.userId, seat.role, input.cart.outletId);
  // One outlet's held bills at a time, so two tills can't both pass the limit check.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 5))', [`held:${outlet.id}`]);
  const { rows: [{ n }] } = await tx.query('SELECT count(*)::int AS n FROM pos_held_bills WHERE outlet_id = $1', [outlet.id]);
  if (n >= MAX_HELD) throw appError(409, 'TOO_MANY_HELD', `${MAX_HELD} bills are on hold at ${outlet.name}. Finish or discard some first.`);

  // An approval belongs to one cashier and one moment; whoever picks the bill up asks again if they need it.
  const cart: CartInput = { ...input.cart, outletId: outlet.id };
  delete cart.approvalId;

  // The total shown in the list, when the cart can be priced now (it may not: a discount above this person's limit).
  let total: string | null = null;
  let customer: string | null = cart.walkIn ? (cart.walkInName || 'Walk-in') : null;
  await tx.query('SAVEPOINT held_price');
  try {
    const p = await loadProfile(tx, outlet.id);
    const priced = await priceCart(tx, p, seat, cart, { requesting: { reason: 'held' } });
    total = rupees(priced.totals.total);
    if (priced.buyer.name) customer = priced.buyer.name;
    await tx.query('RELEASE SAVEPOINT held_price');
  } catch {
    await tx.query('ROLLBACK TO SAVEPOINT held_price');
  }
  if (!customer && cart.customerId) {
    const { rows: [c] } = await tx.query('SELECT name FROM customers WHERE id = $1', [cart.customerId]);
    customer = c?.name || null;
  }

  const { rows: [h] } = await tx.query(
    `INSERT INTO pos_held_bills (tenant_id, outlet_id, label, cart, item_count, total, customer_name, held_by)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [outlet.id, input.label ?? null, JSON.stringify(cart), cart.lines.length, total, customer?.slice(0, 200) ?? null, seat.userId]);
  await audit(tx, { actorId: seat.userId, action: 'pos.bill_held', entityType: 'pos_held_bill', entityId: h.id, summary: { outlet: outlet.name, items: cart.lines.length, total, label: input.label ?? null } });
  return out({ ...h, held_by_name: null });
}

/** Take a held bill back to the till: it leaves the list in the same step, so two tills can't both pick it up. */
export async function takeHeld(tx: Tx, seat: Seat, id: string, outletId: string | undefined, action: 'resumed' | 'discarded') {
  const { outlet } = await resolveOutlet(tx, seat.userId, seat.role, outletId);
  const { rows: [h] } = await tx.query(
    `DELETE FROM pos_held_bills h WHERE h.id = $1 AND h.outlet_id = $2
     RETURNING h.*, (SELECT name FROM users WHERE id = h.held_by) AS held_by_name`, [id, outlet.id]);
  if (!h) throw appError(404, 'NOT_FOUND', 'This held bill is gone: someone picked it up or discarded it.');
  const cart = h.cart as CartInput;
  // What the till shows for each item, as the catalogue has it now.
  const { rows: items } = await tx.query(
    `SELECT v.id, v.sku, v.attributes, v.price, v.mrp, p.name, p.unit_code, u.allow_fraction
       FROM product_variants v JOIN products p ON p.id = v.product_id JOIN units u ON u.code = p.unit_code WHERE v.id = ANY($1)`,
    [[...new Set((cart.lines ?? []).map((l) => l.variantId))]]);
  await audit(tx, {
    actorId: seat.userId, action: action === 'resumed' ? 'pos.bill_resumed' : 'pos.held_bill_discarded', entityType: 'pos_held_bill', entityId: h.id,
    summary: { outlet: outlet.name, items: h.item_count, total: h.total === null ? null : fmtMoney(h.total), heldBy: h.held_by_name, label: h.label },
  });
  return {
    ...out(h), cart,
    items: items.map((r) => ({ variantId: r.id as string, sku: r.sku as string, name: r.name as string, attributes: r.attributes ?? {}, price: fmtMoney(r.price), mrp: fmtMoney(r.mrp), unitCode: r.unit_code as string, allowFraction: r.allow_fraction as boolean })),
  };
}
