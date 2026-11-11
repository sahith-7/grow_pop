import type { Tx } from '../../db.js';
import { fmtMoney, fmtQty } from '../../lib/decimal.js';
import {
  amountInWords, financialYear, localDate, paise, rateText, roundOff, rupees, seriesPrefix, STATES, stateTaxLabel, type LineTax,
} from '../../lib/gst.js';
import { appError } from '../../lib/phase1.js';
import { milli, qtyText } from '../../lib/quantity.js';
import { sellerSnapshot, type Profile, type Scheme } from './profile.js';

// The only writer of invoices and credit notes and of their numbers (01-architecture.md §3: "invoicing is the only writer
// of invoice numbers"). Documents are snapshots: nothing on them is ever recomputed from today's products or settings.

export interface PricedLine {
  kind: 'item' | 'shipping';
  orderLineId: string | null;
  variantId: string | null;
  sku: string;
  description: string;
  hsn: string | null;
  uqc: string;
  qty: bigint;               // thousandths
  unitPrice: string;         // as charged, up to 4 decimals
  gross: bigint;             // paise, qty × unit price
  discount: bigint;          // paise
  rate: bigint;              // hundredths of a percent
  tax: LineTax;
}

export interface Totals { taxable: bigint; cgst: bigint; sgst: bigint; igst: bigint; roundOff: bigint; total: bigint; gross: bigint; discount: bigint }

export function totalsOf(lines: PricedLine[], round: boolean): Totals {
  const s = (f: (l: PricedLine) => bigint) => lines.reduce((a, l) => a + f(l), 0n);
  const before = s((l) => l.tax.total);
  const ro = roundOff(before, round);
  return {
    taxable: s((l) => l.tax.taxable), cgst: s((l) => l.tax.cgst), sgst: s((l) => l.tax.sgst), igst: s((l) => l.tax.igst),
    roundOff: ro, total: before + ro, gross: s((l) => l.gross), discount: s((l) => l.discount),
  };
}

/** Printed title (Rule 46, 46A, 49). */
export function docKind(scheme: Scheme, lines: PricedLine[]) {
  if (scheme === 'unregistered') return 'bill';
  if (scheme === 'composition') return 'bill_of_supply';
  const taxed = lines.some((l) => l.rate > 0n), exempt = lines.some((l) => l.rate === 0n);
  return taxed && exempt ? 'invoice_cum_bos' : taxed ? 'tax_invoice' : 'bill_of_supply';
}

export const DOC_TITLE: Record<string, string> = {
  tax_invoice: 'Tax Invoice', invoice_cum_bos: 'Tax Invoice-cum-Bill of Supply', bill_of_supply: 'Bill of Supply', bill: 'Bill',
  credit_note: 'Credit Note',
};

// ------------------------------------------------------------------ numbering

/**
 * Next number in this financial year's series, gap-free: the series row is locked until the document commits, and a
 * rollback gives the number back. A year's series is created on first use with the default prefix (INV/26-27/).
 */
export async function takeNumber(tx: Tx, docType: 'invoice' | 'credit_note', fy: string, basePrefix: string, outletId: string) {
  // Each outlet has its own series (v2, D101), so two counters never wait for each other.
  await tx.query(
    `INSERT INTO invoice_series (tenant_id, outlet_id, doc_type, financial_year, prefix, start_number, next_number)
     VALUES (current_setting('app.tenant_id')::uuid, $4, $1, $2, $3, 1, 1) ON CONFLICT DO NOTHING`, [docType, fy, seriesPrefix(basePrefix, fy), outletId]);
  const { rows: [s] } = await tx.query(
    'SELECT id, prefix, next_number FROM invoice_series WHERE doc_type = $1 AND financial_year = $2 AND outlet_id = $3 FOR UPDATE', [docType, fy, outletId]);
  const number = `${s.prefix}${s.next_number}`;
  if (number.length > 16) {
    throw appError(409, 'SERIES_FULL', `The ${fy} ${docType === 'invoice' ? 'invoice' : 'credit note'} series has run out of 16-character numbers. Ask the owner to start a new series with a shorter prefix.`);
  }
  await tx.query('UPDATE invoice_series SET next_number = next_number + 1 WHERE id = $1', [s.id]);
  return { seriesId: s.id as string, number };
}

export function fyNow(p: Profile, at = new Date()) {
  return financialYear(localDate(at, p.timezone));
}

// ------------------------------------------------------------------ issuing an invoice

export interface Buyer { name?: string; phone?: string; gstin?: string | null; stateCode?: string | null; stateName?: string | null; address?: string }

export async function issueInvoice(tx: Tx, p: Profile, x: {
  orderId: string; lines: PricedLine[]; buyer: Buyer; placeOfSupply: string; supply: 'intra' | 'inter'; inclusive: boolean;
  round: boolean; actorId: string | null;
}) {
  const scheme = p.scheme!;
  const t = totalsOf(x.lines, x.round);
  const fy = fyNow(p);
  const { seriesId, number } = await takeNumber(tx, 'invoice', fy, p.settings.invoicePrefix, p.outlet.id);
  const { rows: [inv] } = await tx.query(
    `INSERT INTO invoices (tenant_id, number, series_id, financial_year, order_id, doc_kind, gst_scheme, seller, buyer, place_of_supply,
       supply_type, prices_include_tax, taxable_total, cgst, sgst, igst, round_off, total, issued_by)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING id, number, issued_at`,
    [number, seriesId, fy, x.orderId, docKind(scheme, x.lines), scheme, JSON.stringify(sellerSnapshot(p)), JSON.stringify(x.buyer),
      x.placeOfSupply, x.supply, x.inclusive, rupees(t.taxable), rupees(t.cgst), rupees(t.sgst), rupees(t.igst), rupees(t.roundOff),
      rupees(t.total), x.actorId]);
  await tx.query(
    `INSERT INTO invoice_lines (tenant_id, invoice_id, position, kind, order_line_id, variant_id, sku, description, hsn_code, uqc, qty,
       unit_price, gross, discount, taxable_value, gst_rate, cgst, sgst, igst, line_total)
     SELECT current_setting('app.tenant_id')::uuid, $1, r.position, r.kind, r.order_line_id, r.variant_id, r.sku, r.description, r.hsn_code,
            r.uqc, r.qty, r.unit_price, r.gross, r.discount, r.taxable_value, r.gst_rate, r.cgst, r.sgst, r.igst, r.line_total
       FROM jsonb_to_recordset($2) AS r(position int, kind text, order_line_id uuid, variant_id uuid, sku text, description text,
            hsn_code text, uqc text, qty numeric, unit_price numeric, gross numeric, discount numeric, taxable_value numeric,
            gst_rate numeric, cgst numeric, sgst numeric, igst numeric, line_total numeric)`,
    [inv.id, JSON.stringify(x.lines.map((l, i) => ({
      position: i + 1, kind: l.kind, order_line_id: l.orderLineId, variant_id: l.variantId, sku: l.sku, description: l.description.slice(0, 300),
      hsn_code: l.hsn, uqc: l.uqc, qty: qtyText(l.qty), unit_price: l.unitPrice, gross: rupees(l.gross), discount: rupees(l.discount),
      taxable_value: rupees(l.tax.taxable), gst_rate: rateText(l.rate), cgst: rupees(l.tax.cgst), sgst: rupees(l.tax.sgst),
      igst: rupees(l.tax.igst), line_total: rupees(l.tax.total),
    })))]);
  return { id: inv.id as string, number: inv.number as string, issuedAt: inv.issued_at as Date, totals: t };
}

// ------------------------------------------------------------------ reading documents

const m = (v: string | null) => fmtMoney(v);

function docOut(d: Record<string, any>, type: 'invoice' | 'credit_note', tz: string) {
  const pos = d.place_of_supply as string | undefined;
  return {
    id: d.id as string,
    type,
    number: d.number as string,
    title: DOC_TITLE[type === 'invoice' ? d.doc_kind : 'credit_note'],
    docKind: (d.doc_kind ?? 'credit_note') as string,
    gstScheme: d.gst_scheme as string,
    issuedAt: d.issued_at as Date,
    issuedDate: localDate(d.issued_at, tz),
    financialYear: d.financial_year as string,
    seller: d.seller,
    buyer: d.buyer,
    ...(pos ? { placeOfSupply: { code: pos, name: STATES[pos] ?? pos }, supplyType: d.supply_type as string } : {}),
    stateTaxLabel: stateTaxLabel(d.seller?.stateCode ?? ''),
    pricesIncludeTax: d.prices_include_tax as boolean | undefined,
    taxableTotal: m(d.taxable_total), cgst: m(d.cgst), sgst: m(d.sgst), igst: m(d.igst), cess: m(d.cess), roundOff: m(d.round_off),
    total: m(d.total), totalInWords: amountInWords(paise(d.total)),
    issuedBy: (d.issued_by_name as string | null) ?? null,
  };
}

const lineOut = (l: Record<string, any>) => ({
  id: l.id as string, kind: (l.kind ?? 'item') as string, variantId: (l.variant_id ?? null) as string | null, sku: (l.sku ?? '') as string,
  description: l.description as string, hsnCode: l.hsn_code as string | null, uqc: l.uqc as string, qty: fmtQty(l.qty),
  unitPrice: l.unit_price !== undefined ? m(l.unit_price) : undefined, gross: l.gross !== undefined ? m(l.gross) : undefined,
  discount: l.discount !== undefined ? m(l.discount) : undefined, taxableValue: m(l.taxable_value), gstRate: fmtQty(l.gst_rate),
  cgst: m(l.cgst), sgst: m(l.sgst), igst: m(l.igst), lineTotal: m(l.line_total),
});

/** An invoice with its lines, what has been credited on each line, its credit notes and payments. */
export async function invoiceDetail(tx: Tx, id: string, tz: string) {
  const { rows: [d] } = await tx.query(
    `SELECT i.*, u.name AS issued_by_name, o.number AS order_number, o.channel, o.external_id
       FROM invoices i JOIN sales_orders o ON o.id = i.order_id LEFT JOIN users u ON u.id = i.issued_by WHERE i.id = $1`, [id]);
  if (!d) return null;
  const { rows: lines } = await tx.query(
    `SELECT l.*, coalesce(c.qty, 0) AS credited_qty, un.allow_fraction
       FROM invoice_lines l
       LEFT JOIN units un ON un.code = l.uqc
       LEFT JOIN (SELECT invoice_line_id, sum(qty) AS qty FROM credit_note_lines GROUP BY invoice_line_id) c ON c.invoice_line_id = l.id
      WHERE l.invoice_id = $1 ORDER BY l.position`, [id]);
  const { rows: notes } = await tx.query(
    `SELECT c.id, c.number, c.kind, c.total, c.issued_at, r.number AS return_number FROM credit_notes c
       JOIN customer_returns r ON r.id = c.return_id WHERE c.invoice_id = $1 ORDER BY c.issued_at`, [id]);
  const { rows: pays } = await tx.query(
    `SELECT kind, method, amount, tendered, reference, recorded_at FROM payments WHERE order_id = $1 ORDER BY recorded_at, kind`, [d.order_id]);
  return {
    ...docOut(d, 'invoice', tz),
    order: { id: d.order_id as string, number: d.order_number as string, channel: d.channel as string, externalId: d.external_id as string | null },
    voided: notes.some((n) => n.kind === 'void'),
    lines: lines.map((l) => ({
      ...lineOut(l), creditedQty: fmtQty(l.credited_qty), returnableQty: qtyText(milli(l.qty) - milli(l.credited_qty)),
      allowFraction: l.allow_fraction ?? false,
    })),
    creditNotes: notes.map((n) => ({ id: n.id as string, number: n.number as string, kind: n.kind as string, total: m(n.total), issuedAt: n.issued_at as Date, returnNumber: n.return_number as string })),
    payments: pays.map((p) => ({ kind: p.kind as string, method: p.method as string, amount: m(p.amount), tendered: m(p.tendered), change: p.tendered ? rupees(paise(p.tendered) - paise(p.amount)) : null, reference: p.reference as string | null, at: p.recorded_at as Date })),
  };
}

export async function creditNoteDetail(tx: Tx, id: string, tz: string) {
  const { rows: [d] } = await tx.query(
    `SELECT c.*, u.name AS issued_by_name, i.number AS invoice_number, i.issued_at AS invoice_issued_at, i.place_of_supply, i.supply_type,
            i.gst_scheme, i.order_id, r.number AS return_number, r.refund_method
       FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id JOIN customer_returns r ON r.id = c.return_id
       LEFT JOIN users u ON u.id = c.issued_by WHERE c.id = $1`, [id]);
  if (!d) return null;
  const { rows: lines } = await tx.query('SELECT * FROM credit_note_lines WHERE credit_note_id = $1 ORDER BY position', [id]);
  return {
    ...docOut(d, 'credit_note', tz),
    kind: d.kind as string,
    reason: d.reason as string,
    originalInvoice: { id: d.invoice_id as string, number: d.invoice_number as string, date: localDate(d.invoice_issued_at, tz) },
    return: { id: d.return_id as string, number: d.return_number as string, refundMethod: d.refund_method as string },
    lines: lines.map(lineOut),
  };
}
