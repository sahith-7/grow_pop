import { z } from 'zod';
import type { Tx } from '../../db.js';
import { fmtMoney, fmtQty, money } from '../../lib/decimal.js';
import { localDate, paise, rateText, rupees, STATES } from '../../lib/gst.js';
import { appError, audit } from '../../lib/phase1.js';
import { qtyText } from '../../lib/quantity.js';
import { DOC_TITLE, invoiceDetail, issueInvoice } from '../billing/documents.js';
import { loadProfile, posLocation, readyProfile, type Profile } from '../billing/profile.js';
import { resolveOutlet } from '../outlets/service.js';
import { post } from '../inventory/ledger.js';
import { can } from '../../lib/permissions.js';
import { phoneProblem } from '../../lib/phone.js';
import { methodsAt, resolvePayments } from '../cash/methods.js';
import { listTills, sessionFor } from '../cash/registers.js';
import { approvalFor, spendApproval } from './approval-check.js';
import { cartInput, limitOf, priceCart, shortages, type PricedCart, type Seat } from './pricing.js';

// POS sale (J11, 01-architecture.md §4): one transaction posts the order, the stock movements, the invoice and the payments.
// The Idempotency-Key wrapper (routes.ts) makes a double click or a retried request return the first sale.

export const saleInput = cartInput.extend({
  expectedTotal: money,
  /** The till the sale is rung up at: its open register gets the money (v2, D110). */
  tillId: z.string().uuid().optional(),
  payments: z.array(z.object({
    method: z.enum(['cash', 'card', 'upi', 'other']),
    /** Which of the store's payment methods (v2, D109); without it, the built-in method of that kind. */
    methodId: z.string().uuid().optional(),
    amount: money,
    reference: z.string().trim().max(100).optional(),
  }).strict()).max(6),
}).strict();
export type SaleInput = z.infer<typeof saleInput>;

export function cartOut(c: PricedCart, p: Profile) {
  return {
    location: c.location,
    docKind: c.docKind,
    docTitle: DOC_TITLE[c.docKind],
    lines: c.lines.map((l) => ({
      variantId: l.variantId, sku: l.sku, name: l.name, attributes: l.attributes, qty: qtyText(l.qty), unitPrice: fmtMoney(l.unitPrice),
      listPrice: fmtMoney(l.listPrice), mrp: fmtMoney(l.mrp), overridden: l.overridden, gross: rupees(l.gross), discount: rupees(l.discount),
      discountPct: l.discountPctApplied, taxableValue: rupees(l.tax.taxable), gstRate: rateText(l.rate),
      tax: rupees(l.tax.cgst + l.tax.sgst + l.tax.igst), lineTotal: rupees(l.tax.total), available: qtyText(l.available > 0n ? l.available : 0n),
    })),
    subtotal: rupees(c.totals.gross),
    discountTotal: rupees(c.totals.discount),
    taxableTotal: rupees(c.totals.taxable),
    taxBreakdown: { cgst: rupees(c.totals.cgst), sgst: rupees(c.totals.sgst), igst: rupees(c.totals.igst) },
    roundOff: rupees(c.totals.roundOff),
    total: rupees(c.totals.total),
    pricesIncludeTax: p.settings.pricesIncludeTax,
    shortages: shortages(c),
    walkIn: c.walkIn,
  };
}

/** The profile of the outlet this till is at, refusing an outlet the person doesn't work at. */
export async function tillProfile(tx: Tx, seat: Seat, outletId: string | undefined, ready = true) {
  const { outlet } = await resolveOutlet(tx, seat.userId, seat.role, outletId);
  return ready ? readyProfile(tx, outlet.id) : loadProfile(tx, outlet.id);
}

export async function quote(tx: Tx, seat: Seat, cart: z.infer<typeof cartInput>) {
  const p = await tillProfile(tx, seat, cart.outletId);
  const approval = await approvalFor(tx, seat, p.outlet.id, cart.approvalId);
  const priced = await priceCart(tx, p, seat, cart, approval.opts);
  return { ...cartOut(priced, p), approval: priced.approved ? { id: approval.id, approvedBy: approval.approverName } : null };
}

/** The store's rule (v2, D104): the customer's name and a real mobile number, or the cashier's Walk-in mark. */
function checkCustomer(p: Profile, cart: PricedCart) {
  if (!p.settings.requireCustomer || cart.walkIn) return;
  if (!cart.customerId) throw appError(400, 'CUSTOMER_REQUIRED', 'Add the customer’s name and mobile number, or choose Walk-in', { customerId: ['Customer or Walk-in needed'] });
  const phone = cart.buyer.phone;
  if (!cart.buyer.name || !phone || phoneProblem(phone)) {
    throw appError(400, 'CUSTOMER_REQUIRED', `${cart.buyer.name || 'This customer'} has no usable mobile number. Add it, or choose Walk-in.`, { customerId: ['Mobile number needed'] });
  }
}

/** The old bill's credit note paying for this one (exchange, v2, D108). */
export interface SaleCredit { amount: bigint; creditNoteId: string; creditNoteNumber: string }

export async function createSale(tx: Tx, seat: Seat, input: SaleInput, opts: { credit?: SaleCredit } = {}) {
  const p = await tillProfile(tx, seat, input.outletId);
  // The till's open register (refused when the store requires one and it is closed), and each payment's method, which
  // must be switched on at this outlet.
  const sessionId = await sessionFor(tx, p.outlet.id, input.tillId, p.settings.requireRegister);
  const pays = await resolvePayments(tx, p.outlet.id, input.payments);
  const approval = await approvalFor(tx, seat, p.outlet.id, input.approvalId, true);
  const cart = await priceCart(tx, p, seat, input, approval.opts);
  checkCustomer(p, cart);
  const total = cart.totals.total;
  if (paise(input.expectedTotal) !== total) {
    throw appError(409, 'PRICE_CHANGED', `The total is now ₹${rupees(total)}. Check the cart and take payment again.`);
  }

  // Payments: an exchange credit first, then card, UPI and other exactly; only cash can be more than what is due, and the
  // difference is change.
  const credit = opts.credit?.amount ?? 0n;
  const applied = credit < total ? credit : total;
  const due = total - applied;
  const nonCash = input.payments.filter((x) => x.method !== 'cash').reduce((a, x) => a + paise(x.amount), 0n);
  const cash = input.payments.filter((x) => x.method === 'cash').reduce((a, x) => a + paise(x.amount), 0n);
  if (input.payments.some((x) => paise(x.amount) <= 0n)) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { payments: ['Each payment must be more than ₹0'] });
  if (due === 0n && input.payments.length) throw appError(400, 'PAYMENT_MISMATCH', 'The old bill covers this one: there is nothing to pay.');
  if (nonCash > due) throw appError(400, 'PAYMENT_MISMATCH', credit ? 'Card, UPI and other payments are more than what is left to pay. Only cash can give change.' : 'Card, UPI and other payments are more than the total. Only cash can give change.');
  if (nonCash + cash < due) throw appError(400, 'PAYMENT_MISMATCH', `₹${rupees(due - nonCash - cash)} still to pay`);
  const cashDue = due - nonCash;
  const change = cash - cashDue;

  // Order + lines. A POS order's number is its invoice number, so a receipt can be found by either. The number is taken last
  // (after the stock rows are locked), the same lock order as a web order's invoice, so the two never deadlock.
  const issuedLines = cart.lines;
  const { rows: [order] } = await tx.query(
    `INSERT INTO sales_orders (tenant_id, number, channel, status, payment_state, payment_method, customer_id, customer_snapshot, subtotal,
       discount_total, tax_total, total, placed_at, created_by, location_id, invoice_state, session_id)
     VALUES (current_setting('app.tenant_id')::uuid, '', 'pos', 'completed', 'paid', $1, $2, $3, $4, $5, $6, $7, now(), $8, $9, 'issued', $10)
     RETURNING id`,
    [[...new Set([...(applied > 0n ? ['Exchange'] : []), ...pays.map((x) => x.methodName)])].join(' + ') || null, cart.customerId,
      JSON.stringify(cart.walkIn ? { ...cart.buyer, walkIn: true } : cart.buyer), rupees(cart.totals.gross),
      rupees(cart.totals.discount), rupees(cart.totals.cgst + cart.totals.sgst + cart.totals.igst), rupees(total), seat.userId, cart.location.id, sessionId]);
  const { rows: lineRows } = await tx.query(
    `INSERT INTO sales_order_lines (tenant_id, order_id, position, variant_id, sku, name, qty, unit_price, list_price, discount, discount_reason,
       line_total, tax_total)
     SELECT current_setting('app.tenant_id')::uuid, $1, r.position, r.variant_id, r.sku, r.name, r.qty, r.unit_price, r.list_price, r.discount,
            r.discount_reason, r.line_total, r.tax_total
       FROM jsonb_to_recordset($2) AS r(position int, variant_id uuid, sku text, name text, qty numeric, unit_price numeric, list_price numeric,
            discount numeric, discount_reason text, line_total numeric, tax_total numeric)
      ORDER BY r.position
     RETURNING id, position`,
    [order.id, JSON.stringify(issuedLines.map((l, i) => ({
      position: i, variant_id: l.variantId, sku: l.sku, name: l.description.slice(0, 300), qty: qtyText(l.qty), unit_price: l.unitPrice,
      list_price: l.listPrice, discount: rupees(l.discount), discount_reason: l.discountReason, line_total: rupees(l.tax.total),
      tax_total: rupees(l.tax.cgst + l.tax.sgst + l.tax.igst),
    })))]);
  const lineIdAt = new Map(lineRows.map((r) => [Number(r.position), r.id as string]));
  issuedLines.forEach((l, i) => { l.orderLineId = lineIdAt.get(i)!; });

  // Stock leaves the POS location. post() refuses to go below what web orders hold (409 INSUFFICIENT_STOCK).
  await post(tx, seat.userId, issuedLines.map((l, i) => ({
    variantId: l.variantId!, locationId: cart.location.id, bucket: 'sellable' as const, delta: -l.qty, movementType: 'sale',
    sourceType: 'sales_order' as const, sourceId: order.id, sourceLineId: l.orderLineId, field: `lines.${i}.qty`,
  })));

  const inv = await issueInvoice(tx, p, {
    orderId: order.id, lines: issuedLines, buyer: cart.buyer, placeOfSupply: p.stateCode!, supply: 'intra',
    inclusive: p.settings.pricesIncludeTax, round: p.settings.roundOff, actorId: seat.userId,
  });
  await tx.query('UPDATE sales_orders SET number = $2 WHERE id = $1', [order.id, inv.number]);

  if (applied > 0n) {
    await tx.query(
      `INSERT INTO payments (tenant_id, order_id, kind, method, amount, reference, credit_note_id, recorded_by, session_id)
       VALUES (current_setting('app.tenant_id')::uuid, $1, 'payment', 'exchange', $2, $3, $4, $5, $6)`,
      [order.id, rupees(applied), opts.credit!.creditNoteNumber, opts.credit!.creditNoteId, seat.userId, sessionId]);
  }
  for (const x of pays) {
    if (x.method === 'cash') continue;
    await tx.query(
      `INSERT INTO payments (tenant_id, order_id, kind, method, amount, reference, recorded_by, method_id, session_id)
       VALUES (current_setting('app.tenant_id')::uuid, $1, 'payment', $2, $3, $4, $5, $6, $7)`,
      [order.id, x.method, x.amount, x.reference || null, seat.userId, x.methodId, sessionId]);
  }
  // Cash is one row: what the bill took from the cash handed over (the rest went back as change). If the cashier split the
  // cash over two cash methods, the first one named carries it.
  if (cashDue > 0n) {
    await tx.query(
      `INSERT INTO payments (tenant_id, order_id, kind, method, amount, tendered, recorded_by, method_id, session_id)
       VALUES (current_setting('app.tenant_id')::uuid, $1, 'payment', 'cash', $2, $3, $4, $5, $6)`,
      [order.id, rupees(cashDue), rupees(cash), seat.userId, pays.find((x) => x.method === 'cash')!.methodId, sessionId]);
  }
  await tx.query(
    `INSERT INTO sales_order_events (tenant_id, order_id, kind, message, actor_id)
     VALUES (current_setting('app.tenant_id')::uuid, $1, 'pos_sale', $2, $3)`, [order.id, `Sold at the counter, invoice ${inv.number}`, seat.userId]);

  // An approval above the limit is spent on this bill, once (D107).
  if (cart.approved && !(await spendApproval(tx, approval.id!, inv.id))) {
    throw appError(409, 'APPROVAL_USED', 'That approval was already used on another bill or has expired. Ask again.');
  }
  if (cart.flagged.length || cart.approved) {
    await audit(tx, {
      actorId: seat.userId, action: 'pos.discount_or_override', entityType: 'invoice', entityId: inv.id,
      summary: {
        invoice: inv.number, lines: cart.flagged.map((f) => ({ sku: f.sku, discountPct: f.discountPct, priceChanged: f.overridden, reason: f.reason })),
        ...(cart.approved ? { approvedBy: approval.approverName, approvedVia: approval.via, request: approval.id, limitPct: cart.limitPct } : {}),
      },
    });
  }

  return {
    orderId: order.id as string, orderNumber: inv.number, invoiceId: inv.id, invoiceNumber: inv.number, total: rupees(total), sessionId,
    credit: rupees(applied), due: rupees(due), change: rupees(change), invoice: await invoiceDetail(tx, inv.id, p.timezone),
  };
}

// ------------------------------------------------------------------ what the POS screen needs

export async function context(tx: Tx, seat: Seat, outletId?: string) {
  const { outlet, allowed } = await resolveOutlet(tx, seat.userId, seat.role, outletId);
  const p = await loadProfile(tx, outlet.id);
  let location: { id: string; name: string } | null = null;
  const problems = [...p.problems];
  try { location = await posLocation(tx, p); } catch (e) { problems.push((e as Error).message); }
  const limit = limitOf(seat.role, p);
  return {
    ready: problems.length === 0, problems, scheme: p.scheme, location,
    outlet: { id: outlet.id, name: outlet.name }, outlets: allowed.map((o) => ({ id: o.id, name: o.name })),
    seller: { name: p.seller.name, legalName: p.seller.legalName, gstin: p.seller.gstin },
    pricesIncludeTax: p.settings.pricesIncludeTax, receiptFooter: p.settings.receiptFooter, billFormat: p.settings.billFormat,
    discount: { allowed: seat.canDiscount, limitPct: seat.canDiscount ? limit : '0', reasonAbovePct: p.settings.discountReasonThresholdPct },
    canOverridePrice: seat.canOverride,
    requireCustomer: p.settings.requireCustomer,
    canExchange: can(seat.role, 'return.manage'),
    // Cash control (v2, D109–D113): what this counter takes, its tills, and the drawer rules.
    paymentMethods: await methodsAt(tx, outlet.id),
    tills: (await listTills(tx, { userId: seat.userId, role: seat.role }, outlet.id)).filter((t) => t.active),
    requireRegister: p.settings.requireRegister,
    canManageCash: can(seat.role, 'cash.manage'),
    expenseLimits: can(seat.role, 'cash.manage') ? null : { each: p.settings.expenseLimitEach, day: p.settings.expenseLimitDay },
    returnRules: { days: p.settings.returnDays, moneyBack: p.settings.returnMoneyBack, bindsMe: seat.role !== 'owner' },
    // For the new-customer form: cashiers cannot read Billing & GST, and a B2C bill of ₹50,000+ needs the buyer's state.
    states: Object.entries(STATES).map(([code, name]) => ({ code, name })),
  };
}

/** Scan or search: exact barcode or SKU first, then name. Price and free stock at the POS location, never cost. */
export async function lookup(tx: Tx, seat: Seat, q: string, outletId?: string) {
  const p = await tillProfile(tx, seat, outletId, false);
  const loc = await posLocation(tx, p).catch(() => null);
  const esc = q.replace(/[%_\\]/g, '\\$&');
  const { rows } = await tx.query(
    `SELECT v.id, v.sku, v.barcode, v.attributes, v.price, v.mrp, p.name, p.gst_rate, p.hsn_code, p.unit_code, u.allow_fraction,
            coalesce(b.on_hand - b.reserved, 0) AS available,
            (v.barcode = $1 OR lower(v.sku) = lower($1)) AS exact
       FROM product_variants v JOIN products p ON p.id = v.product_id JOIN units u ON u.code = p.unit_code
       LEFT JOIN stock_balances b ON b.variant_id = v.id AND b.location_id = $3
      WHERE v.status = 'active' AND p.status = 'active'
        AND (v.barcode = $1 OR lower(v.sku) = lower($1) OR p.name ILIKE '%' || $2 || '%' OR v.sku ILIKE $2 || '%')
      ORDER BY exact DESC, lower(p.name), v.position NULLS LAST, v.sku
      LIMIT 20`, [q, esc, loc?.id ?? null]);
  return {
    items: rows.map((r) => ({
      variantId: r.id as string, sku: r.sku as string, barcode: r.barcode as string | null, name: r.name as string, attributes: r.attributes ?? {},
      price: fmtMoney(r.price), mrp: fmtMoney(r.mrp), gstRate: fmtQty(r.gst_rate), hsnCode: r.hsn_code as string | null, unitCode: r.unit_code as string,
      allowFraction: r.allow_fraction as boolean, available: fmtQty(String(r.available)), exact: r.exact as boolean,
    })),
  };
}

/** Takings for one day at the counter (payments in, refunds out), by method. For closing the till. */
export async function daySummary(tx: Tx, seat: Seat, date: string | undefined, outletId?: string) {
  const p = await tillProfile(tx, seat, outletId, false);
  const day = date ?? localDate(new Date(), p.timezone);
  // This outlet's counter only: payments on orders sold from its stock rooms, bills from its series.
  const { rows } = await tx.query(
    `SELECT y.method, coalesce(m.name, CASE y.method WHEN 'exchange' THEN 'Exchange credit' WHEN 'original' THEN 'Original method' ELSE initcap(y.method) END) AS name,
            y.kind, count(*)::int AS n, sum(y.amount) AS amount
       FROM payments y JOIN sales_orders o ON o.id = y.order_id JOIN locations l ON l.id = o.location_id LEFT JOIN payment_methods m ON m.id = y.method_id
      WHERE (y.recorded_at AT TIME ZONE $2)::date = $1::date AND l.outlet_id = $3 GROUP BY 1, 2, 3 ORDER BY 2, 3`, [day, p.timezone, p.outlet.id]);
  const { rows: [inv] } = await tx.query(
    `SELECT count(*)::int AS n, coalesce(sum(i.total), 0) AS total FROM invoices i JOIN sales_orders o ON o.id = i.order_id
       JOIN invoice_series s ON s.id = i.series_id
      WHERE o.channel = 'pos' AND (i.issued_at AT TIME ZONE $2)::date = $1::date AND s.outlet_id = $3`, [day, p.timezone, p.outlet.id]);
  const methods = new Map<string, { method: string; in: bigint; out: bigint; count: number }>();
  for (const r of rows) {
    const e = methods.get(r.name) ?? { method: r.method as string, in: 0n, out: 0n, count: 0 };
    if (r.kind === 'payment') { e.in += paise(r.amount); e.count += r.n; } else e.out += paise(r.amount);
    methods.set(r.name, e);
  }
  return {
    date: day, outlet: p.outlet.name, sales: inv.n as number, salesTotal: fmtMoney(inv.total),
    methods: [...methods.entries()].map(([name, e]) => ({ method: e.method, name, received: rupees(e.in), refunded: rupees(e.out), net: rupees(e.in - e.out), payments: e.count })),
  };
}
