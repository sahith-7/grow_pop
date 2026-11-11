import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Tx } from '../../db.js';
import { money, qty } from '../../lib/decimal.js';
import { gstinProblem, lineTax, paise, pctOf, rateBp, rupees } from '../../lib/gst.js';
import { appError } from '../../lib/phase1.js';
import type { Role } from '../../lib/permissions.js';
import { amount, isWhole, milli, qtyText } from '../../lib/quantity.js';
import { docKind, totalsOf, type Buyer, type PricedLine } from '../billing/documents.js';
import { posLocation, type Profile } from '../billing/profile.js';

// Prices a POS cart on the server (J11: "price, tax, total from server"). Used by both the quote and the sale, so what the
// cashier sees is exactly what gets invoiced; the sale also re-checks the total the cashier saw (expectedTotal).

const pctText = z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter a percentage like 10 or 12.5')
  .refine((v) => Number(v) <= 100, 'At most 100%');
/** A discount in rupees and paise (v2, D106). */
const rupeeText = z.string().trim().regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter an amount like 50 or 49.50');

export const cartInput = z.object({
  /** The outlet this till is at (v2, D101); without it, the person's only outlet or the main one. */
  outletId: z.string().uuid().optional(),
  customerId: z.string().uuid().nullable().optional(),
  /** No customer details: the cashier marks the bill Walk-in, with a name if the customer gave one (v2, D104). */
  walkIn: z.boolean().optional(),
  walkInName: z.string().trim().max(100).optional(),
  lines: z.array(z.object({
    variantId: z.string().uuid(),
    qty,
    unitPriceOverride: money.optional(),
    discountPct: pctText.optional(),
    discountAmount: rupeeText.optional(),
    discountReason: z.string().trim().max(200).optional(),
  }).strict()).min(1, 'Add at least one item').max(200),
  cartDiscountPct: pctText.optional(),
  cartDiscountAmount: rupeeText.optional(),
  cartDiscountReason: z.string().trim().max(200).optional(),
  /** An approved discount request for exactly this cart (v2, D107). */
  approvalId: z.string().uuid().optional(),
}).strict();
export type CartInput = z.infer<typeof cartInput>;

/** Rule 46(e): an unregistered buyer's name, address and state must be on an invoice of ₹50,000 or more. */
export const B2C_DETAILS_FROM = 50_000_00n;

export interface Seat { userId: string; role: Role; canDiscount: boolean; canOverride: boolean }

export interface PricedCart {
  location: { id: string; name: string };
  buyer: Buyer;
  customerId: string | null;
  walkIn: boolean;
  lines: (PricedLine & { listPrice: string; mrp: string | null; discountReason: string | null; available: bigint; overridden: boolean; name: string; attributes: Record<string, string>; discountPctApplied: string })[];
  docKind: string;
  totals: ReturnType<typeof totalsOf>;
  /** Discounts above the reason threshold or price overrides: audited when the sale is posted. */
  flagged: { lineIndex: number; sku: string; discountPct: string; overridden: boolean; reason: string | null }[];
  /** Items, quantities, prices and discounts in paise: what a discount approval is for (v2, D107). */
  hash: string;
  /** This person's discount limit, and the lines above it (allowed only with an approval or while asking for one). */
  limitPct: string;
  overLimit: { lineIndex: number; sku: string; name: string; pct: string }[];
  /** True when an approval let a discount above the limit through. */
  approved: boolean;
}

export interface PriceOptions {
  /** An approved request: lets discounts above the limit through when the cart is the one approved. */
  approval?: { hash: string; reason: string };
  /** Why the approval passed in can't be used (expired, waiting, someone else's), for the error message. */
  approvalProblem?: string;
  /** Pricing a cart to ask for approval: discounts above the limit are expected. */
  requesting?: { reason: string };
}

/** '99.9' -> 999000n: prices to 4 decimals, for exact comparisons. */
const p4 = (v: string) => { const [i, f = ''] = v.split('.'); return BigInt(i) * 10000n + BigInt(f.padEnd(4, '0').slice(0, 4)); };

const invalid = (fieldErrors: Record<string, string[]>) => appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', fieldErrors);

/** discount / gross as a percentage with 2 decimals, for messages and the audit log. */
const pctOfGross = (discount: bigint, gross: bigint) => (gross === 0n ? '0' : (Number((discount * 10000n) / gross) / 100).toString());

/** The discount limit of a role: the owner has none; manager and cashier limits are set in Billing & GST. */
export const limitOf = (role: Role, p: Profile) => (role === 'owner' ? '100' : role === 'manager' ? p.settings.managerDiscountLimitPct : p.settings.cashierDiscountLimitPct);

/**
 * Split a bill discount in ₹ over the lines in proportion to what each line still costs, to the paisa: the parts add up
 * to exactly the amount (largest remainder; ties to the earlier line), and no line gets more than it costs.
 */
export function spread(amount: bigint, bases: bigint[]): bigint[] {
  const sum = bases.reduce((a, b) => a + b, 0n);
  if (amount === 0n || sum === 0n) return bases.map(() => 0n);
  const parts = bases.map((b) => (amount * b) / sum);
  let left = amount - parts.reduce((a, b) => a + b, 0n);
  const order = bases.map((b, i) => ({ i, r: (amount * b) % sum })).sort((x, y) => (x.r === y.r ? x.i - y.i : x.r > y.r ? -1 : 1));
  for (const o of order) { if (left === 0n) break; parts[o.i] += 1n; left -= 1n; }
  return parts;
}

export async function priceCart(tx: Tx, p: Profile, seat: Seat, cart: CartInput, opts: PriceOptions = {}): Promise<PricedCart> {
  const location = await posLocation(tx, p);
  const scheme = p.scheme!;

  // ---- buyer
  let buyer: Buyer = {};
  let customerId: string | null = null;
  if (cart.walkIn && cart.customerId) throw invalid({ customerId: ['Choose a customer or Walk-in, not both'] });
  if (cart.customerId) {
    const { rows: [c] } = await tx.query('SELECT id, name, phone, gstin, state_code, address, archived_at FROM customers WHERE id = $1', [cart.customerId]);
    if (!c || c.archived_at) throw invalid({ customerId: ['Customer not found'] });
    customerId = c.id;
    buyer = { name: c.name || undefined, phone: c.phone ?? undefined, gstin: c.gstin, stateCode: c.state_code, address: c.address ?? undefined };
    if (c.gstin) {
      const problem = gstinProblem(c.gstin);
      if (problem) throw invalid({ customerId: [`Customer's GSTIN: ${problem}`] });
      if (p.seller.gstin && c.gstin === p.seller.gstin) throw invalid({ customerId: ['The customer has your own GSTIN'] });
      buyer.stateCode = c.gstin.slice(0, 2);
    }
  }
  const walkIn = !customerId && !!cart.walkIn;
  if (walkIn && cart.walkInName) buyer = { name: cart.walkInName };
  const b2b = scheme === 'regular' && !!buyer.gstin;

  // ---- items
  const ids = [...new Set(cart.lines.map((l) => l.variantId))];
  const { rows } = await tx.query(
    `SELECT v.id, v.sku, v.barcode, v.attributes, v.price, v.mrp, v.status AS v_status, p.name, p.status AS p_status, p.hsn_code,
            p.gst_rate, p.unit_code, u.allow_fraction, coalesce(b.on_hand - b.reserved, 0) AS available
       FROM product_variants v JOIN products p ON p.id = v.product_id JOIN units u ON u.code = p.unit_code
       LEFT JOIN stock_balances b ON b.variant_id = v.id AND b.location_id = $2
      WHERE v.id = ANY($1)`, [ids, location.id]);
  const byId = new Map(rows.map((r) => [r.id as string, r]));

  const errors: Record<string, string[]> = {};
  const err = (k: string, msg: string) => { (errors[k] ??= []).push(msg); };
  const cartPct = cart.cartDiscountPct ?? '0';
  const cartAmount = cart.cartDiscountAmount ? paise(cart.cartDiscountAmount) : 0n;
  if (cart.cartDiscountAmount && Number(cartPct) > 0) err('cartDiscountAmount', 'Give the bill discount in % or ₹, not both');
  if ((Number(cartPct) > 0 || cartAmount > 0n) && !seat.canDiscount) throw appError(403, 'FORBIDDEN', 'You are not allowed to give discounts');
  const limit = limitOf(seat.role, p);
  const threshold = p.settings.discountReasonThresholdPct;

  // First pass: each line's price and its own discount (% or ₹).
  const staged: { i: number; v: Record<string, any>; q: bigint; unitPrice: string; overridden: boolean; rate: bigint; gross: bigint; d1: bigint; reason: string | null }[] = [];
  for (const [i, l] of cart.lines.entries()) {
    const v = byId.get(l.variantId);
    const f = (name: string) => `lines.${i}.${name}`;
    if (!v || v.v_status !== 'active' || v.p_status !== 'active') { err(f('variantId'), 'This item is not on sale (archived or draft)'); continue; }
    const q = milli(l.qty);
    if (q <= 0n) { err(f('qty'), 'Quantity must be more than 0'); continue; }
    if (!v.allow_fraction && !isWhole(q)) { err(f('qty'), `${v.sku} is sold in whole units`); continue; }

    // Price: the catalogue price, or an override (owner/manager), never above MRP (Legal Metrology rules).
    const overridden = l.unitPriceOverride !== undefined && p4(l.unitPriceOverride) !== p4(v.price);
    if (overridden && !seat.canOverride) throw appError(403, 'FORBIDDEN', 'You are not allowed to change prices');
    const unitPrice = overridden ? l.unitPriceOverride! : v.price;
    if (overridden && v.mrp !== null && p4(unitPrice) > p4(v.mrp)) { err(f('unitPriceOverride'), `Above the MRP of ₹${rupees(paise(v.mrp))}`); continue; }

    // Rate: from the product for a regular GST seller; no GST is charged on a bill of supply or an unregistered seller's bill.
    let rate = 0n;
    if (scheme === 'regular') {
      if (v.gst_rate === null) { err(f('variantId'), `Set a GST rate on ${v.sku} before selling it`); continue; }
      rate = rateBp(v.gst_rate);
    }
    if (b2b && !v.hsn_code) { err(f('variantId'), `${v.sku} needs an HSN code on a B2B invoice`); continue; }

    const gross = paise(amount(q, unitPrice));
    if (l.discountAmount && Number(l.discountPct ?? '0') > 0) { err(f('discountAmount'), 'Give the discount in % or ₹, not both'); continue; }
    const d1 = l.discountAmount ? paise(l.discountAmount) : pctOf(gross, l.discountPct ?? '0');
    if (d1 > 0n && !seat.canDiscount) throw appError(403, 'FORBIDDEN', 'You are not allowed to give discounts');
    if (d1 > gross) { err(f(l.discountAmount ? 'discountAmount' : 'discountPct'), `More than the item's ₹${rupees(gross)}`); continue; }
    staged.push({ i, v, q, unitPrice, overridden, rate, gross, d1, reason: (l.discountReason || cart.cartDiscountReason || '').trim() || null });
  }
  if (Object.keys(errors).length) throw invalid(errors);

  // The bill discount: a % of what each line still costs, or a ₹ amount shared over the lines.
  const bases = staged.map((s) => s.gross - s.d1);
  const totalBase = bases.reduce((a, b) => a + b, 0n);
  if (cartAmount > totalBase) throw invalid({ cartDiscountAmount: [`More than the bill of ₹${rupees(totalBase)}`] });
  const d2s = cart.cartDiscountAmount ? spread(cartAmount, bases) : bases.map((b) => pctOf(b, cartPct));
  const slack = cartAmount > 0n ? 1n : 0n;

  const lines: PricedCart['lines'] = [];
  const flagged: PricedCart['flagged'] = [];
  const overLimit: PricedCart['overLimit'] = [];
  const needReason: number[] = [];
  for (const [k, s] of staged.entries()) {
    const { i, v, q, gross } = s;
    const discount = s.d1 + d2s[k];
    const net = gross - discount;
    // Combined discount against the role's limit and the "reason needed" threshold (04-tenancy-and-permissions.md §3 rule 3).
    // A ₹ bill discount shared over the lines can round a line a paisa above an exact limit: that paisa is not counted.
    if ((discount - slack) * 10000n > rateBp(limit) * gross) overLimit.push({ lineIndex: i, sku: v.sku, name: v.name, pct: pctOfGross(discount, gross) });
    const overThreshold = (discount - slack) * 10000n > rateBp(threshold) * gross;
    if (overThreshold && !s.reason) needReason.push(lines.length);
    if (overThreshold || s.overridden) flagged.push({ lineIndex: i, sku: v.sku, discountPct: pctOfGross(discount, gross), overridden: s.overridden, reason: s.reason });
    lines.push({
      kind: 'item', orderLineId: null, variantId: v.id, sku: v.sku, name: v.name, attributes: v.attributes ?? {},
      description: [v.name, ...Object.values((v.attributes ?? {}) as Record<string, string>)].join(' · '),
      hsn: v.hsn_code, uqc: v.unit_code, qty: q, unitPrice: s.unitPrice, gross, discount, rate: s.rate,
      tax: lineTax(net, s.rate, 'intra', p.settings.pricesIncludeTax),
      listPrice: v.price, mrp: v.mrp, discountReason: discount > 0n ? s.reason : null, overridden: s.overridden,
      available: milli(v.available), discountPctApplied: pctOfGross(discount, gross),
    });
  }

  const hash = createHash('sha256').update(JSON.stringify([p.outlet.id, lines.map((l) => [l.variantId, l.qty.toString(), p4(l.unitPrice).toString(), l.discount.toString()])])).digest('hex');
  const approved = overLimit.length > 0 && !opts.requesting && !!opts.approval && opts.approval.hash === hash;
  if (overLimit.length && !opts.requesting && !approved) {
    const o = overLimit[0];
    const why = opts.approval ? ' The bill changed after it was approved: ask again.' : opts.approvalProblem ? ` ${opts.approvalProblem}` : '';
    throw appError(403, 'DISCOUNT_LIMIT', `${o.name}: discount of ${o.pct}% is above your limit of ${limit}%.${why}`,
      Object.fromEntries(overLimit.map((x) => [`lines.${x.lineIndex}.discountPct`, [`Your limit is ${limit}%`]])));
  }

  // A discount approved (or being asked for) carries the reason given to the approver when the cashier typed none.
  const fallback = opts.requesting?.reason ?? (approved ? opts.approval!.reason : null);
  for (const li of needReason) {
    if (fallback) {
      lines[li].discountReason = fallback;
      const fl = flagged.find((x) => x.lineIndex === staged[li].i);
      if (fl) fl.reason = fallback;
    } else err(`lines.${staged[li].i}.discountReason`, `Give a reason for a discount above ${threshold}%`);
  }
  if (Object.keys(errors).length) throw invalid(errors);

  const totals = totalsOf(lines, p.settings.roundOff);
  if (scheme !== 'unregistered' && !b2b && totals.total >= B2C_DETAILS_FROM && !(buyer.name && buyer.address && buyer.stateCode)) {
    throw appError(400, 'CUSTOMER_DETAILS_REQUIRED', 'For a bill of ₹50,000 or more, add the customer with name, address and state', { customerId: ['Name, address and state needed'] });
  }
  return { location, buyer, customerId, walkIn, lines, docKind: docKind(scheme, lines), totals, flagged, hash, limitPct: limit, overLimit, approved };
}

/** Stock still free at the POS location after this cart, per line, for the quote screen. */
export function shortages(c: PricedCart) {
  const need = new Map<string, bigint>();
  for (const l of c.lines) need.set(l.variantId!, (need.get(l.variantId!) ?? 0n) + l.qty);
  return c.lines.filter((l) => need.get(l.variantId!)! > l.available).map((l) => ({ variantId: l.variantId, sku: l.sku, available: qtyText(l.available > 0n ? l.available : 0n) }));
}
