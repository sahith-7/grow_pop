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

export const cartInput = z.object({
  customerId: z.string().uuid().nullable().optional(),
  lines: z.array(z.object({
    variantId: z.string().uuid(),
    qty,
    unitPriceOverride: money.optional(),
    discountPct: pctText.optional(),
    discountReason: z.string().trim().max(200).optional(),
  }).strict()).min(1, 'Add at least one item').max(200),
  cartDiscountPct: pctText.optional(),
  cartDiscountReason: z.string().trim().max(200).optional(),
}).strict();
export type CartInput = z.infer<typeof cartInput>;

/** Rule 46(e): an unregistered buyer's name, address and state must be on an invoice of ₹50,000 or more. */
export const B2C_DETAILS_FROM = 50_000_00n;

export interface Seat { userId: string; role: Role; canDiscount: boolean; canOverride: boolean }

export interface PricedCart {
  location: { id: string; name: string };
  buyer: Buyer;
  customerId: string | null;
  lines: (PricedLine & { listPrice: string; mrp: string | null; discountReason: string | null; available: bigint; overridden: boolean; name: string; attributes: Record<string, string>; discountPctApplied: string })[];
  docKind: string;
  totals: ReturnType<typeof totalsOf>;
  /** Discounts above the reason threshold or price overrides: audited when the sale is posted. */
  flagged: { lineIndex: number; sku: string; discountPct: string; overridden: boolean; reason: string | null }[];
}

/** '99.9' -> 999000n: prices to 4 decimals, for exact comparisons. */
const p4 = (v: string) => { const [i, f = ''] = v.split('.'); return BigInt(i) * 10000n + BigInt(f.padEnd(4, '0').slice(0, 4)); };

const invalid = (fieldErrors: Record<string, string[]>) => appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', fieldErrors);

/** discount / gross as a percentage with 2 decimals, for messages and the audit log. */
const pctOfGross = (discount: bigint, gross: bigint) => (gross === 0n ? '0' : (Number((discount * 10000n) / gross) / 100).toString());

export async function priceCart(tx: Tx, p: Profile, seat: Seat, cart: CartInput): Promise<PricedCart> {
  const location = await posLocation(tx, p);
  const scheme = p.scheme!;

  // ---- buyer
  let buyer: Buyer = {};
  let customerId: string | null = null;
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
  if (cartPct !== '0' && Number(cartPct) > 0 && !seat.canDiscount) throw appError(403, 'FORBIDDEN', 'You are not allowed to give discounts');
  const limit = seat.role === 'owner' ? '100' : seat.role === 'manager' ? p.settings.managerDiscountLimitPct : p.settings.cashierDiscountLimitPct;
  const threshold = p.settings.discountReasonThresholdPct;

  const lines: PricedCart['lines'] = [];
  const flagged: PricedCart['flagged'] = [];
  const usedQty = new Map<string, bigint>();

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
    const linePct = l.discountPct ?? '0';
    if (Number(linePct) > 0 && !seat.canDiscount) throw appError(403, 'FORBIDDEN', 'You are not allowed to give discounts');
    const d1 = pctOf(gross, linePct);
    const d2 = pctOf(gross - d1, cartPct);
    const discount = d1 + d2;
    const net = gross - discount;

    // Combined discount against the role's limit and the "reason needed" threshold (04-tenancy-and-permissions.md §3 rule 3).
    const reason = (l.discountReason || cart.cartDiscountReason || '').trim() || null;
    if (discount * 10000n > rateBp(limit) * gross) {
      throw appError(403, 'DISCOUNT_LIMIT', `${v.sku}: discount of ${pctOfGross(discount, gross)}% is above your limit of ${limit}%`, { [f('discountPct')]: [`Your limit is ${limit}%`] });
    }
    const overThreshold = discount * 10000n > rateBp(threshold) * gross;
    if (overThreshold && !reason) { err(f('discountReason'), `Give a reason for a discount above ${threshold}%`); continue; }
    if (overThreshold || overridden) flagged.push({ lineIndex: i, sku: v.sku, discountPct: pctOfGross(discount, gross), overridden, reason });

    const used = (usedQty.get(v.id) ?? 0n) + q;
    usedQty.set(v.id, used);
    lines.push({
      kind: 'item', orderLineId: null, variantId: v.id, sku: v.sku, name: v.name, attributes: v.attributes ?? {},
      description: [v.name, ...Object.values((v.attributes ?? {}) as Record<string, string>)].join(' · '),
      hsn: v.hsn_code, uqc: v.unit_code, qty: q, unitPrice, gross, discount, rate,
      tax: lineTax(net, rate, 'intra', p.settings.pricesIncludeTax),
      listPrice: v.price, mrp: v.mrp, discountReason: discount > 0n ? reason : null, overridden,
      available: milli(v.available), discountPctApplied: pctOfGross(discount, gross),
    });
  }
  if (Object.keys(errors).length) throw invalid(errors);

  const totals = totalsOf(lines, p.settings.roundOff);
  if (scheme !== 'unregistered' && !b2b && totals.total >= B2C_DETAILS_FROM && !(buyer.name && buyer.address && buyer.stateCode)) {
    throw appError(400, 'CUSTOMER_DETAILS_REQUIRED', 'For a bill of ₹50,000 or more, add the customer with name, address and state', { customerId: ['Name, address and state needed'] });
  }
  return { location, buyer, customerId, lines, docKind: docKind(scheme, lines), totals, flagged };
}

/** Stock still free at the POS location after this cart, per line, for the quote screen. */
export function shortages(c: PricedCart) {
  const need = new Map<string, bigint>();
  for (const l of c.lines) need.set(l.variantId!, (need.get(l.variantId!) ?? 0n) + l.qty);
  return c.lines.filter((l) => need.get(l.variantId!)! > l.available).map((l) => ({ variantId: l.variantId, sku: l.sku, available: qtyText(l.available > 0n ? l.available : 0n) }));
}
