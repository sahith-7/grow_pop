import { z } from 'zod';
import type { Tx } from '../../db.js';
import { qty } from '../../lib/decimal.js';
import { creditNoteDeadline, divRound, localDate, paise, roundOff, rupees } from '../../lib/gst.js';
import { nextNumber } from '../../lib/doc-numbers.js';
import { appError, audit } from '../../lib/phase1.js';
import { isWhole, milli, qtyText } from '../../lib/quantity.js';
import { creditNoteDetail, fyNow, takeNumber } from '../billing/documents.js';
import { loadProfile, posLocation } from '../billing/profile.js';
import { activeLocation } from '../inventory/service.js';
import { post, type Move } from '../inventory/ledger.js';

// Customer returns (J12, 5.7, AC-14) and invoice voids. Each one posts a credit note against the original invoice, which is
// never changed (CGST s.34). Amounts are the invoice's own, in proportion to the quantity returned, never today's prices;
// the last return of a line takes exactly what is left, so the credit notes of a fully returned invoice add up to it exactly.

export const returnInput = z.object({
  invoiceId: z.string().uuid(),
  reason: z.string().trim().min(3, 'Give a reason').max(500),
  refundMethod: z.enum(['cash', 'card', 'upi', 'other', 'original', 'none']),
  locationId: z.string().uuid().optional(),
  lines: z.array(z.object({
    invoiceLineId: z.string().uuid(),
    qty,
    condition: z.enum(['resellable', 'damaged', 'not_returned']),
  }).strict()).min(1, 'Pick at least one item').max(200),
}).strict();
export type ReturnInput = z.infer<typeof returnInput>;

export const voidInput = z.object({
  reason: z.string().trim().min(3, 'Give a reason').max(500),
  restock: z.boolean(),
  refundMethod: z.enum(['cash', 'card', 'upi', 'other', 'original', 'none']),
}).strict();

const invalid = (fieldErrors: Record<string, string[]>) => appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', fieldErrors);

interface Credited { qty: bigint; taxable: bigint; cgst: bigint; sgst: bigint; igst: bigint }

export async function postReturn(tx: Tx, actorId: string, input: ReturnInput, kind: 'return' | 'void' = 'return') {
  const p = await loadProfile(tx);
  // One return per invoice at a time: the second waits, then sees what the first credited. (A row lock would need UPDATE
  // on invoices, which the runtime role does not have.)
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 5))', [`invoice:${input.invoiceId}`]);
  const { rows: [inv] } = await tx.query(
    `SELECT i.*, o.location_id AS order_location_id, o.channel, o.number AS order_number FROM invoices i JOIN sales_orders o ON o.id = i.order_id WHERE i.id = $1`,
    [input.invoiceId]);
  if (!inv) throw appError(404, 'NOT_FOUND', 'Invoice not found');
  const { rows: [voided] } = await tx.query("SELECT number FROM credit_notes WHERE invoice_id = $1 AND kind = 'void'", [inv.id]);
  if (voided) throw appError(409, 'INVOICE_VOIDED', `This invoice was voided by credit note ${voided.number}`);

  // s.34(2): no GST credit note after 30 November following the end of the invoice's financial year.
  const today = localDate(new Date(), p.timezone);
  if (inv.gst_scheme === 'regular' && today > creditNoteDeadline(inv.financial_year)) {
    throw appError(409, 'CREDIT_NOTE_TOO_LATE', `GST credit notes for ${inv.financial_year} invoices could only be issued until ${creditNoteDeadline(inv.financial_year)}. Ask your tax adviser how to handle this return.`);
  }

  const { rows: lines } = await tx.query(
    `SELECT l.*, un.allow_fraction FROM invoice_lines l LEFT JOIN units un ON un.code = l.uqc WHERE l.invoice_id = $1 ORDER BY l.position`, [inv.id]);
  const { rows: prev } = await tx.query(
    `SELECT cl.invoice_line_id, sum(cl.qty) AS qty, sum(cl.taxable_value) AS taxable, sum(cl.cgst) AS cgst, sum(cl.sgst) AS sgst, sum(cl.igst) AS igst
       FROM credit_note_lines cl JOIN credit_notes c ON c.id = cl.credit_note_id WHERE c.invoice_id = $1 GROUP BY cl.invoice_line_id`, [inv.id]);
  const credited = new Map<string, Credited>(prev.map((r) => [r.invoice_line_id, {
    qty: milli(r.qty), taxable: paise(r.taxable), cgst: paise(r.cgst), sgst: paise(r.sgst), igst: paise(r.igst),
  }]));
  const byId = new Map(lines.map((l) => [l.id as string, l]));

  const errors: Record<string, string[]> = {};
  const seen = new Set<string>();
  const out: { line: Record<string, any>; q: bigint; condition: string; taxable: bigint; cgst: bigint; sgst: bigint; igst: bigint }[] = [];
  for (const [i, r] of input.lines.entries()) {
    const f = (k: string) => `lines.${i}.${k}`;
    const l = byId.get(r.invoiceLineId);
    if (!l) { errors[f('invoiceLineId')] = ['Not a line of this invoice']; continue; }
    if (seen.has(l.id)) { errors[f('invoiceLineId')] = ['This line is listed twice']; continue; }
    seen.add(l.id);
    const q = milli(r.qty);
    const sold = milli(l.qty);
    const c = credited.get(l.id) ?? { qty: 0n, taxable: 0n, cgst: 0n, sgst: 0n, igst: 0n };
    if (q <= 0n) { errors[f('qty')] = ['Quantity must be more than 0']; continue; }
    if (l.allow_fraction === false && !isWhole(q)) { errors[f('qty')] = [`${l.sku || l.description} is counted in whole units`]; continue; }
    if (q > sold - c.qty) {
      throw appError(409, 'RETURN_EXCEEDS_SOLD', `Only ${qtyText(sold - c.qty)} of ${l.sku || l.description} can still be returned`, { [f('qty')]: [`At most ${qtyText(sold - c.qty)}`] });
    }
    if (l.kind === 'shipping' && r.condition !== 'not_returned') { errors[f('condition')] = ['Shipping is refunded as "not returned"']; continue; }
    const last = q === sold - c.qty;
    const part = (whole: string, done: bigint) => (last ? paise(whole) - done : divRound(paise(whole) * q, sold));
    out.push({ line: l, q, condition: r.condition, taxable: part(l.taxable_value, c.taxable), cgst: part(l.cgst, c.cgst), sgst: part(l.sgst, c.sgst), igst: part(l.igst, c.igst) });
  }
  if (Object.keys(errors).length) throw invalid(errors);

  // Totals. When this credit note finishes the invoice, it is whatever is left of the invoice total, so the round-offs of
  // the invoice and all its credit notes cancel out exactly.
  const sum = out.reduce((a, o) => a + o.taxable + o.cgst + o.sgst + o.igst, 0n);
  const totalsBefore = (await tx.query('SELECT coalesce(sum(total), 0) AS t FROM credit_notes WHERE invoice_id = $1', [inv.id])).rows[0].t as string;
  const finishes = lines.every((l) => {
    const now = out.find((o) => o.line.id === l.id)?.q ?? 0n;
    return (credited.get(l.id)?.qty ?? 0n) + now === milli(l.qty);
  });
  // Counter sales are rounded to the rupee (if the store rounds); web-order invoices carry the shop's exact total.
  let ro = roundOff(sum, p.settings.roundOff && inv.channel === 'pos');
  if (finishes) {
    const rest = paise(inv.total) - paise(totalsBefore) - sum;
    if (rest > -100n && rest < 100n) ro = rest;
  }
  const total = sum + ro;

  // Stock comes back: resellable to sellable stock, damaged to non-sellable (written off or returned to the supplier later).
  const location = input.locationId
    ? await activeLocation(tx, input.locationId, 'locationId')
    : inv.order_location_id ? await activeLocation(tx, inv.order_location_id, 'locationId') : await posLocation(tx, p);

  const number = await nextNumber(tx, 'RET');
  const { rows: [ret] } = await tx.query(
    `INSERT INTO customer_returns (tenant_id, number, order_id, invoice_id, location_id, reason, refund_method, posted_by)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7) RETURNING id, posted_at`,
    [number, inv.order_id, inv.id, location.id, input.reason, input.refundMethod, actorId]);
  const { rows: retLines } = await tx.query(
    `INSERT INTO customer_return_lines (tenant_id, return_id, invoice_line_id, variant_id, qty, condition)
     SELECT current_setting('app.tenant_id')::uuid, $1, r.invoice_line_id, r.variant_id, r.qty, r.condition
       FROM jsonb_to_recordset($2) AS r(ord int, invoice_line_id uuid, variant_id uuid, qty numeric, condition text) ORDER BY r.ord
     RETURNING id, invoice_line_id`,
    [ret.id, JSON.stringify(out.map((o, i) => ({ ord: i, invoice_line_id: o.line.id, variant_id: o.line.variant_id, qty: qtyText(o.q), condition: o.condition })))]);
  const retLineOf = new Map(retLines.map((r) => [r.invoice_line_id as string, r.id as string]));

  const moves: Move[] = out.filter((o) => o.condition !== 'not_returned' && o.line.variant_id).map((o) => ({
    variantId: o.line.variant_id, locationId: location.id, bucket: o.condition === 'resellable' ? 'sellable' as const : 'non_sellable' as const,
    delta: o.q, movementType: 'return_in', sourceType: 'customer_return' as const, sourceId: ret.id, sourceLineId: retLineOf.get(o.line.id),
    note: `Return ${number} of invoice ${inv.number}`,
  }));
  await post(tx, actorId, moves);

  const fy = fyNow(p);
  const { seriesId, number: cnNumber } = await takeNumber(tx, 'credit_note', fy, p.settings.creditNotePrefix);
  const tSum = (k: 'taxable' | 'cgst' | 'sgst' | 'igst') => rupees(out.reduce((a, o) => a + o[k], 0n));
  const { rows: [cn] } = await tx.query(
    `INSERT INTO credit_notes (tenant_id, number, series_id, financial_year, invoice_id, return_id, kind, reason, seller, buyer,
       taxable_total, cgst, sgst, igst, round_off, total, issued_by)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [cnNumber, seriesId, fy, inv.id, ret.id, kind, input.reason, JSON.stringify(inv.seller), JSON.stringify(inv.buyer),
      tSum('taxable'), tSum('cgst'), tSum('sgst'), tSum('igst'), rupees(ro), rupees(total), actorId]);
  await tx.query(
    `INSERT INTO credit_note_lines (tenant_id, credit_note_id, position, invoice_line_id, description, hsn_code, uqc, qty, taxable_value,
       gst_rate, cgst, sgst, igst, line_total)
     SELECT current_setting('app.tenant_id')::uuid, $1, r.position, r.invoice_line_id, r.description, r.hsn_code, r.uqc, r.qty, r.taxable_value,
            r.gst_rate, r.cgst, r.sgst, r.igst, r.line_total
       FROM jsonb_to_recordset($2) AS r(position int, invoice_line_id uuid, description text, hsn_code text, uqc text, qty numeric,
            taxable_value numeric, gst_rate numeric, cgst numeric, sgst numeric, igst numeric, line_total numeric)`,
    [cn.id, JSON.stringify(out.map((o, i) => ({
      position: i + 1, invoice_line_id: o.line.id, description: o.line.description, hsn_code: o.line.hsn_code, uqc: o.line.uqc, qty: qtyText(o.q),
      taxable_value: rupees(o.taxable), gst_rate: o.line.gst_rate, cgst: rupees(o.cgst), sgst: rupees(o.sgst), igst: rupees(o.igst),
      line_total: rupees(o.taxable + o.cgst + o.sgst + o.igst),
    })))]);

  if (input.refundMethod !== 'none' && total > 0n) {
    await tx.query(
      `INSERT INTO payments (tenant_id, order_id, kind, method, amount, return_id, recorded_by)
       VALUES (current_setting('app.tenant_id')::uuid, $1, 'refund', $2, $3, $4, $5)`, [inv.order_id, input.refundMethod, rupees(total), ret.id, actorId]);
  }

  // The order shows it: fully credited → refunded.
  await tx.query(
    `UPDATE sales_orders SET payment_state = CASE WHEN $2 THEN 'refunded' ELSE 'partially_refunded' END,
       status = CASE WHEN $2 AND channel = 'pos' THEN 'refunded' ELSE status END, updated_at = now() WHERE id = $1`, [inv.order_id, finishes]);
  await tx.query(
    `INSERT INTO sales_order_events (tenant_id, order_id, kind, message, actor_id)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4)`,
    [inv.order_id, kind === 'void' ? 'voided' : 'returned',
      `${kind === 'void' ? 'Invoice voided' : 'Return'} ${number}: credit note ${cnNumber} for ₹${rupees(total)}${moves.length ? `, ${moves.length} line(s) back in stock` : ''}`, actorId]);
  await audit(tx, {
    actorId, action: kind === 'void' ? 'invoice.voided' : 'return.posted', entityType: 'invoice', entityId: inv.id,
    summary: { invoice: inv.number, return: number, creditNote: cnNumber, total: rupees(total), refundMethod: input.refundMethod, reason: input.reason,
      lines: out.map((o) => ({ sku: o.line.sku, qty: qtyText(o.q), condition: o.condition })) },
  });

  return {
    id: ret.id as string, number, creditNoteId: cn.id as string, creditNoteNumber: cnNumber, refundAmount: rupees(total),
    refundMethod: input.refundMethod, restockedLines: moves.filter((m) => m.bucket === 'sellable').length,
    creditNote: await creditNoteDetail(tx, cn.id, p.timezone),
  };
}

/** Void = credit everything still uncredited on the invoice, in one credit note (owner only, invoice.void). */
export async function voidInvoice(tx: Tx, actorId: string, invoiceId: string, input: z.infer<typeof voidInput>) {
  const { rows: [voided] } = await tx.query("SELECT number FROM credit_notes WHERE invoice_id = $1 AND kind = 'void'", [invoiceId]);
  if (voided) throw appError(409, 'INVOICE_VOIDED', `This invoice was already voided by credit note ${voided.number}`);
  const { rows } = await tx.query(
    `SELECT l.id, l.qty - coalesce((SELECT sum(cl.qty) FROM credit_note_lines cl WHERE cl.invoice_line_id = l.id), 0) AS left_qty, l.kind
       FROM invoice_lines l WHERE l.invoice_id = $1 ORDER BY l.position`, [invoiceId]);
  if (!rows.length) throw appError(404, 'NOT_FOUND', 'Invoice not found');
  const open = rows.filter((r) => milli(r.left_qty) > 0n);
  if (!open.length) throw appError(409, 'NOTHING_TO_CREDIT', 'Everything on this invoice has already been returned');
  return postReturn(tx, actorId, {
    invoiceId, reason: input.reason, refundMethod: input.refundMethod,
    lines: open.map((r) => ({ invoiceLineId: r.id, qty: qtyText(milli(r.left_qty)), condition: input.restock && r.kind === 'item' ? 'resellable' as const : 'not_returned' as const })),
  }, 'void');
}

export async function listReturns(tx: Tx, f: { q?: string; limit: number; after: [string, string] | null }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (f.q) { params.push(f.q.replace(/[%_\\]/g, '\\$&')); where.push(`(r.number ILIKE '%' || $${params.length} || '%' OR i.number ILIKE '%' || $${params.length} || '%' OR c.number ILIKE '%' || $${params.length} || '%')`); }
  if (f.after) { params.push(f.after[0], f.after[1]); where.push(`(r.posted_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`); }
  params.push(f.limit + 1);
  const { rows } = await tx.query(
    `SELECT r.id, r.number, r.posted_at, r.reason, r.refund_method, i.id AS invoice_id, i.number AS invoice_number, c.id AS cn_id, c.number AS cn_number,
            c.total, c.kind, u.name AS posted_by, i.buyer->>'name' AS customer
       FROM customer_returns r JOIN invoices i ON i.id = r.invoice_id JOIN credit_notes c ON c.return_id = r.id LEFT JOIN users u ON u.id = r.posted_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.posted_at DESC, r.id DESC LIMIT $${params.length}`, params);
  return {
    rows: rows.slice(0, f.limit).map((r) => ({
      id: r.id as string, number: r.number as string, postedAt: r.posted_at as Date, reason: r.reason as string, refundMethod: r.refund_method as string,
      kind: r.kind as string, invoice: { id: r.invoice_id as string, number: r.invoice_number as string },
      creditNote: { id: r.cn_id as string, number: r.cn_number as string }, refundAmount: rupees(paise(r.total)),
      customer: (r.customer as string | null) || null, postedBy: r.posted_by as string | null,
    })),
    more: rows.length > f.limit,
  };
}
