import { z } from 'zod';
import type { Tx } from '../../db.js';
import { fmtMoney, fmtQty, money } from '../../lib/decimal.js';
import { localDate, paise, rateText, rupees, STATES } from '../../lib/gst.js';
import { appError, audit } from '../../lib/phase1.js';
import { qtyText } from '../../lib/quantity.js';
import { DOC_TITLE, invoiceDetail, issueInvoice } from '../billing/documents.js';
import { loadProfile, posLocation, readyProfile, type Profile } from '../billing/profile.js';
import { post } from '../inventory/ledger.js';
import { cartInput, priceCart, shortages, type PricedCart, type Seat } from './pricing.js';

// POS sale (J11, 01-architecture.md §4): one transaction posts the order, the stock movements, the invoice and the payments.
// The Idempotency-Key wrapper (routes.ts) makes a double click or a retried request return the first sale.

export const saleInput = cartInput.extend({
  expectedTotal: money,
  payments: z.array(z.object({
    method: z.enum(['cash', 'card', 'upi', 'other']),
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
  };
}

export async function quote(tx: Tx, seat: Seat, cart: z.infer<typeof cartInput>) {
  const p = await readyProfile(tx);
  return cartOut(await priceCart(tx, p, seat, cart), p);
}

export async function createSale(tx: Tx, seat: Seat, input: SaleInput) {
  const p = await readyProfile(tx);
  const cart = await priceCart(tx, p, seat, input);
  const total = cart.totals.total;
  if (paise(input.expectedTotal) !== total) {
    throw appError(409, 'PRICE_CHANGED', `The total is now ₹${rupees(total)}. Check the cart and take payment again.`);
  }

  // Payments: card, UPI and other are taken exactly; only cash can be more than what is due, and the difference is change.
  const nonCash = input.payments.filter((x) => x.method !== 'cash').reduce((a, x) => a + paise(x.amount), 0n);
  const cash = input.payments.filter((x) => x.method === 'cash').reduce((a, x) => a + paise(x.amount), 0n);
  if (input.payments.some((x) => paise(x.amount) <= 0n)) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { payments: ['Each payment must be more than ₹0'] });
  if (nonCash > total) throw appError(400, 'PAYMENT_MISMATCH', 'Card, UPI and other payments are more than the total. Only cash can give change.');
  if (nonCash + cash < total) throw appError(400, 'PAYMENT_MISMATCH', `₹${rupees(total - nonCash - cash)} still to pay`);
  const cashDue = total - nonCash;
  const change = cash - cashDue;

  // Order + lines. A POS order's number is its invoice number, so a receipt can be found by either. The number is taken last
  // (after the stock rows are locked), the same lock order as a web order's invoice, so the two never deadlock.
  const issuedLines = cart.lines;
  const { rows: [order] } = await tx.query(
    `INSERT INTO sales_orders (tenant_id, number, channel, status, payment_state, payment_method, customer_id, customer_snapshot, subtotal,
       discount_total, tax_total, total, placed_at, created_by, location_id, invoice_state)
     VALUES (current_setting('app.tenant_id')::uuid, '', 'pos', 'completed', 'paid', $1, $2, $3, $4, $5, $6, $7, now(), $8, $9, 'issued')
     RETURNING id`,
    [[...new Set(input.payments.map((x) => x.method))].join(' + ') || null, cart.customerId, JSON.stringify(cart.buyer), rupees(cart.totals.gross),
      rupees(cart.totals.discount), rupees(cart.totals.cgst + cart.totals.sgst + cart.totals.igst), rupees(total), seat.userId, cart.location.id]);
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

  for (const x of input.payments) {
    if (x.method === 'cash') continue;
    await tx.query(
      `INSERT INTO payments (tenant_id, order_id, kind, method, amount, reference, recorded_by)
       VALUES (current_setting('app.tenant_id')::uuid, $1, 'payment', $2, $3, $4, $5)`, [order.id, x.method, x.amount, x.reference || null, seat.userId]);
  }
  if (cashDue > 0n) {
    await tx.query(
      `INSERT INTO payments (tenant_id, order_id, kind, method, amount, tendered, recorded_by)
       VALUES (current_setting('app.tenant_id')::uuid, $1, 'payment', 'cash', $2, $3, $4)`, [order.id, rupees(cashDue), rupees(cash), seat.userId]);
  }
  await tx.query(
    `INSERT INTO sales_order_events (tenant_id, order_id, kind, message, actor_id)
     VALUES (current_setting('app.tenant_id')::uuid, $1, 'pos_sale', $2, $3)`, [order.id, `Sold at the counter, invoice ${inv.number}`, seat.userId]);

  if (cart.flagged.length) {
    await audit(tx, {
      actorId: seat.userId, action: 'pos.discount_or_override', entityType: 'invoice', entityId: inv.id,
      summary: { invoice: inv.number, lines: cart.flagged.map((f) => ({ sku: f.sku, discountPct: f.discountPct, priceChanged: f.overridden, reason: f.reason })) },
    });
  }

  return {
    orderId: order.id as string, orderNumber: inv.number, invoiceId: inv.id, invoiceNumber: inv.number, total: rupees(total),
    change: rupees(change), invoice: await invoiceDetail(tx, inv.id, p.timezone),
  };
}

// ------------------------------------------------------------------ what the POS screen needs

export async function context(tx: Tx, seat: Seat) {
  const p = await loadProfile(tx);
  let location: { id: string; name: string } | null = null;
  const problems = [...p.problems];
  try { location = await posLocation(tx, p); } catch (e) { problems.push((e as Error).message); }
  const limit = seat.role === 'owner' ? '100' : seat.role === 'manager' ? p.settings.managerDiscountLimitPct : p.settings.cashierDiscountLimitPct;
  return {
    ready: problems.length === 0, problems, scheme: p.scheme, location,
    seller: { name: p.seller.name, legalName: p.seller.legalName, gstin: p.seller.gstin },
    pricesIncludeTax: p.settings.pricesIncludeTax, receiptFooter: p.settings.receiptFooter,
    discount: { allowed: seat.canDiscount, limitPct: seat.canDiscount ? limit : '0', reasonAbovePct: p.settings.discountReasonThresholdPct },
    canOverridePrice: seat.canOverride,
    // For the new-customer form: cashiers cannot read Billing & GST, and a B2C bill of ₹50,000+ needs the buyer's state.
    states: Object.entries(STATES).map(([code, name]) => ({ code, name })),
  };
}

/** Scan or search: exact barcode or SKU first, then name. Price and free stock at the POS location, never cost. */
export async function lookup(tx: Tx, q: string) {
  const p = await loadProfile(tx);
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
export async function daySummary(tx: Tx, date: string | undefined) {
  const p = await loadProfile(tx);
  const day = date ?? localDate(new Date(), p.timezone);
  const { rows } = await tx.query(
    `SELECT method, kind, count(*)::int AS n, sum(amount) AS amount FROM payments
      WHERE (recorded_at AT TIME ZONE $2)::date = $1::date GROUP BY method, kind ORDER BY method, kind`, [day, p.timezone]);
  const { rows: [inv] } = await tx.query(
    `SELECT count(*)::int AS n, coalesce(sum(i.total), 0) AS total FROM invoices i JOIN sales_orders o ON o.id = i.order_id
      WHERE o.channel = 'pos' AND (i.issued_at AT TIME ZONE $2)::date = $1::date`, [day, p.timezone]);
  const methods = new Map<string, { in: bigint; out: bigint; count: number }>();
  for (const r of rows) {
    const e = methods.get(r.method) ?? { in: 0n, out: 0n, count: 0 };
    if (r.kind === 'payment') { e.in += paise(r.amount); e.count += r.n; } else e.out += paise(r.amount);
    methods.set(r.method, e);
  }
  return {
    date: day, sales: inv.n as number, salesTotal: fmtMoney(inv.total),
    methods: [...methods.entries()].map(([method, e]) => ({ method, received: rupees(e.in), refunded: rupees(e.out), net: rupees(e.in - e.out), payments: e.count })),
  };
}
