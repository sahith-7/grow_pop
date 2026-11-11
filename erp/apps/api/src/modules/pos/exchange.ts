import { z } from 'zod';
import type { Tx } from '../../db.js';
import { money, qty } from '../../lib/decimal.js';
import { inr, paise, rupees } from '../../lib/gst.js';
import { appError, audit } from '../../lib/phase1.js';
import { qtyText } from '../../lib/quantity.js';
import { posLocation, type Profile } from '../billing/profile.js';
import { lockBalances } from '../inventory/ledger.js';
import { refundMethodId } from '../cash/methods.js';
import { checkReturnRules, lockInvoice, planReturn, postReturn } from '../returns/service.js';
import type { Seat } from './pricing.js';
import { createSale, saleInput, tillProfile } from './service.js';

// Exchange at the counter (v2, D108). The customer brings back items from an old bill and takes new ones. In one
// transaction: a credit note on the old bill (as any return), a new tax invoice, and the credit note paying for the new
// bill. If the new bill costs more, the customer pays the rest; if less, the rest is given back. Both bills keep their
// own GST: the old one is reduced by the credit note (s.34), the new one is a normal sale.

const returnLines = z.array(z.object({
  invoiceLineId: z.string().uuid(),
  qty,
  condition: z.enum(['resellable', 'damaged']),
}).strict()).min(1, 'Pick at least one item from the old bill').max(200);

export const exchangeQuoteInput = z.object({ outletId: z.string().uuid().optional(), invoiceId: z.string().uuid(), lines: returnLines }).strict();

export const exchangeInput = saleInput.extend({
  exchange: z.object({
    invoiceId: z.string().uuid(),
    reason: z.string().trim().min(3, 'Give a reason').max(500),
    lines: returnLines,
    /** The credit the cashier saw, so a return posted meanwhile at another till can't change it unseen. */
    expectedCredit: money,
  }).strict(),
  /** How to give back what the new bill doesn't use. */
  refundMethod: z.enum(['cash', 'card', 'upi', 'other', 'original']).optional(),
}).strict();
export type ExchangeInput = z.infer<typeof exchangeInput>;

/** A credit note of one GST registration can't pay a bill of another (two outlets in different states). */
function sameRegistration(old: Profile, till: Profile) {
  if ((old.seller.gstin ?? null) !== (till.seller.gstin ?? null)) {
    throw appError(409, 'EXCHANGE_OTHER_GSTIN', `The old bill is from ${old.outlet.name}, which bills under another GSTIN. Exchange it there, or take it back as a return with a refund.`);
  }
}

export async function exchangeQuote(tx: Tx, seat: Seat, input: z.infer<typeof exchangeQuoteInput>) {
  const till = await tillProfile(tx, seat, input.outletId, false);
  const plan = await planReturn(tx, input);
  sameRegistration(plan.p, till);
  await checkReturnRules(tx, seat, plan, 'exchange');
  return {
    invoice: { id: plan.inv.id as string, number: plan.inv.number as string, customerId: (plan.inv.order_customer_id as string | null) ?? null, customer: (plan.inv.buyer?.name as string | undefined) ?? null },
    creditNoteFrom: plan.p.outlet.name, credit: rupees(plan.total),
    lines: plan.out.map((o) => ({ invoiceLineId: o.line.id as string, sku: o.line.sku as string, description: o.line.description as string, qty: qtyText(o.q), condition: o.condition, credit: rupees(o.taxable + o.cgst + o.sgst + o.igst) })),
  };
}

export async function createExchange(tx: Tx, seat: Seat, input: ExchangeInput) {
  const { exchange, refundMethod, ...saleIn } = input;
  const till = await tillProfile(tx, seat, input.outletId);
  await lockInvoice(tx, exchange.invoiceId);
  const plan = await planReturn(tx, exchange);
  sameRegistration(plan.p, till);
  if (paise(exchange.expectedCredit) !== plan.total) {
    throw appError(409, 'PRICE_CHANGED', `The old bill's credit is now ₹${rupees(plan.total)} (part of it was returned meanwhile). Check and try again.`);
  }

  // Every stock row both halves touch, locked first and in the ledger's order: this can't deadlock with a sale or a return.
  const location = await posLocation(tx, till);
  await lockBalances(tx, [
    ...saleIn.lines.map((l) => [l.variantId, location.id] as [string, string]),
    ...plan.out.filter((o) => o.line.variant_id).map((o) => [o.line.variant_id as string, location.id] as [string, string]),
  ]);

  // The old bill: a credit note, the goods back into this counter's stock room.
  const ret = await postReturn(tx, seat, { invoiceId: exchange.invoiceId, reason: exchange.reason, refundMethod: 'exchange', locationId: location.id, lines: exchange.lines });
  const credit = paise(ret.refundAmount);

  // The new bill, paid first by the credit note.
  const sale = await createSale(tx, seat, saleIn, { credit: { amount: credit, creditNoteId: ret.creditNoteId, creditNoteNumber: ret.creditNoteNumber } });
  const applied = paise(sale.credit);
  const rest = credit - applied;
  if (rest > 0n && !refundMethod) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { refundMethod: [`Choose how to give back ₹${rupees(rest)}`] });
  // Exchange only (D113): the new items must use up the credit, unless the owner gives the rest back.
  if (rest > 0n && !till.settings.returnMoneyBack && seat.role !== 'owner') {
    throw appError(409, 'EXCHANGE_ONLY', `This store gives exchanges, not money back: ₹${inr(rest)} of the credit is unused. Add items worth that much, or ask the owner.`);
  }
  // The rest goes back the way the old bill was paid, if it was paid one way; else the cashier says how. Cash leaves the
  // drawer of the till the exchange is done at (the new bill's register).
  let restMethod: string | undefined = refundMethod;
  if (rest > 0n && refundMethod === 'original') {
    const { rows } = await tx.query("SELECT DISTINCT method FROM payments WHERE order_id = $1 AND kind = 'payment'", [plan.inv.order_id]);
    if (rows.length !== 1 || rows[0].method === 'exchange') {
      throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { refundMethod: ['The old bill was paid more than one way: choose how to give the rest back'] });
    }
    restMethod = rows[0].method as string;
  }

  // The old order shows where its money went: used on the new bill, and any rest given back.
  if (applied > 0n) {
    await tx.query(
      `INSERT INTO payments (tenant_id, order_id, kind, method, amount, reference, return_id, credit_note_id, recorded_by, session_id)
       VALUES (current_setting('app.tenant_id')::uuid, $1, 'refund', 'exchange', $2, $3, $4, $5, $6, $7)`,
      [plan.inv.order_id, rupees(applied), sale.invoiceNumber, ret.id, ret.creditNoteId, seat.userId, sale.sessionId]);
  }
  if (rest > 0n) {
    await tx.query(
      `INSERT INTO payments (tenant_id, order_id, kind, method, amount, return_id, recorded_by, method_id, session_id)
       VALUES (current_setting('app.tenant_id')::uuid, $1, 'refund', $2, $3, $4, $5, $6, $7)`,
      [plan.inv.order_id, restMethod, rupees(rest), ret.id, seat.userId, await refundMethodId(tx, restMethod!), sale.sessionId]);
  }
  await tx.query(
    `INSERT INTO sales_order_events (tenant_id, order_id, kind, message, actor_id)
     VALUES (current_setting('app.tenant_id')::uuid, $1, 'exchange', $2, $3)`,
    [sale.orderId, `Exchange: credit note ${ret.creditNoteNumber} on bill ${plan.inv.number} paid ₹${rupees(applied)} of this bill`, seat.userId]);
  await audit(tx, {
    actorId: seat.userId, action: 'pos.exchange', entityType: 'invoice', entityId: sale.invoiceId,
    summary: { oldInvoice: plan.inv.number, creditNote: ret.creditNoteNumber, newInvoice: sale.invoiceNumber, credit: rupees(credit), used: rupees(applied),
      givenBack: rest > 0n ? { method: restMethod, amount: rupees(rest) } : null },
  });

  return {
    ...sale,
    exchange: {
      returnId: ret.id, returnNumber: ret.number, creditNoteId: ret.creditNoteId, creditNoteNumber: ret.creditNoteNumber, oldInvoice: plan.inv.number as string,
      credit: rupees(credit), used: rupees(applied), givenBack: rest > 0n ? { method: restMethod!, amount: rupees(rest) } : null,
    },
  };
}
