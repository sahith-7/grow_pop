import type { Tx } from '../../db.js';
import { fmtMoney } from '../../lib/decimal.js';
import { nextNumber } from '../../lib/doc-numbers.js';
import { appError, audit } from '../../lib/phase1.js';
import { mapUniqueViolation } from '../../lib/pg-errors.js';
import { amount, milli, qtyText } from '../../lib/quantity.js';
import { applyCost, type Move, movementsByIds, post } from '../inventory/ledger.js';
import { activeLocation, activeVariants, type Ctx } from '../inventory/service.js';
import type { PoInput, ReceiptInput, SupplierInput, SupplierPatch, SupplierReturnInput } from './schemas.js';

// Purchasing (PUR-01…06). Unit costs exclude GST (B3 default). A PO line's outstanding quantity is ordered − accepted,
// so damaged goods stay outstanding until the supplier replaces them.

const invalid = (fieldErrors: Record<string, string[]>) => appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', fieldErrors);
const notFound = (what: string) => appError(404, 'NOT_FOUND', `${what} not found`);

// ------------------------------------------------------------------ suppliers

const supplierOut = (r: Record<string, any>) => ({
  id: r.id as string, name: r.name as string, phone: r.phone as string | null, email: r.email as string | null,
  gstin: r.gstin as string | null, stateCode: r.state_code as string | null, address: r.address as string | null,
  archived: r.archived_at !== null,
});
const dupSupplier = () => appError(409, 'NAME_DUPLICATE', 'Another supplier already has this name');

export async function listSuppliers(tx: Tx, f: { q?: string; includeArchived: boolean; limit: number; after: [string, string] | null }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (!f.includeArchived) where.push('archived_at IS NULL');
  if (f.q) { params.push(`%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`); where.push(`(lower(name) LIKE $${params.length} OR gstin = upper($${params.length}))`); }
  if (f.after) { params.push(f.after[0], f.after[1]); where.push(`(lower(name), id) > ($${params.length - 1}, $${params.length}::uuid)`); }
  params.push(f.limit + 1);
  const { rows } = await tx.query(
    `SELECT * FROM suppliers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY lower(name), id LIMIT $${params.length}`, params);
  const more = rows.length > f.limit;
  const page = rows.slice(0, f.limit);
  return { items: page.map(supplierOut), last: more ? [page[page.length - 1].name.toLowerCase(), page[page.length - 1].id] as [string, string] : null };
}

export async function getSupplier(tx: Tx, id: string) {
  const { rows } = await tx.query('SELECT * FROM suppliers WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Supplier');
  return supplierOut(rows[0]);
}

async function activeSupplier(tx: Tx, id: string) {
  const { rows } = await tx.query('SELECT * FROM suppliers WHERE id = $1', [id]);
  if (!rows[0] || rows[0].archived_at) throw invalid({ supplierId: ['Supplier not found or archived'] });
  return supplierOut(rows[0]);
}

export async function createSupplier(tx: Tx, ctx: Ctx, s: SupplierInput) {
  try {
    const { rows } = await tx.query(
      `INSERT INTO suppliers (tenant_id, name, phone, email, gstin, state_code, address)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6) RETURNING *`,
      [s.name, s.phone ?? null, s.email ?? null, s.gstin ?? null, s.stateCode ?? (s.gstin ? s.gstin.slice(0, 2) : null), s.address ?? null]);
    await audit(tx, { actorId: ctx.userId, action: 'supplier.created', entityType: 'supplier', entityId: rows[0].id, summary: { name: s.name } });
    return supplierOut(rows[0]);
  } catch (e) { mapUniqueViolation(e, { suppliers_name_uq: dupSupplier }); }
}

export async function patchSupplier(tx: Tx, ctx: Ctx, id: string, p: SupplierPatch) {
  const cols: Record<string, unknown> = { name: p.name, phone: p.phone, email: p.email, gstin: p.gstin, state_code: p.stateCode, address: p.address };
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [id];
  for (const [c, v] of Object.entries(cols)) if (v !== undefined) { params.push(v); sets.push(`${c} = $${params.length}`); }
  if (p.archived !== undefined) sets.push(p.archived ? 'archived_at = coalesce(archived_at, now())' : 'archived_at = NULL');
  try {
    const { rows } = await tx.query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    if (!rows[0]) throw notFound('Supplier');
    await audit(tx, { actorId: ctx.userId, action: p.archived ? 'supplier.archived' : 'supplier.updated', entityType: 'supplier', entityId: id,
      summary: { fields: Object.keys(p) } });
    return supplierOut(rows[0]);
  } catch (e) { mapUniqueViolation(e, { suppliers_name_uq: dupSupplier }); }
}

// ------------------------------------------------------------------ purchase orders (PUR-01/02/06)

/** Whole-unit items (pcs, box …) cannot be ordered or received in fractions. */
async function wholeUnitErrors(tx: Tx, lines: { variantId: string; qty: string }[], field: (i: number) => string) {
  const { rows } = await tx.query(
    `SELECT v.id, v.sku FROM product_variants v JOIN products p ON p.id = v.product_id JOIN units u ON u.code = p.unit_code
      WHERE v.id = ANY($1) AND NOT u.allow_fraction`, [lines.map((l) => l.variantId)]);
  const whole = new Map(rows.map((r) => [r.id, r.sku]));
  const errors: Record<string, string[]> = {};
  lines.forEach((l, i) => { if (whole.has(l.variantId) && milli(l.qty) % 1000n !== 0n) errors[field(i)] = [`${whole.get(l.variantId)} is counted in whole units`]; });
  return errors;
}

async function checkPoLines(tx: Tx, lines: PoInput['lines']) {
  const seen = new Set<string>();
  const errors: Record<string, string[]> = {};
  lines.forEach((l, i) => { if (seen.has(l.variantId)) errors[`lines.${i}.variantId`] = ['This item is listed twice']; seen.add(l.variantId); });
  if (Object.keys(errors).length) throw invalid(errors);
  await activeVariants(tx, lines.map((l) => l.variantId), (i) => `lines.${i}.variantId`);
  const frac = await wholeUnitErrors(tx, lines.map((l) => ({ variantId: l.variantId, qty: l.orderedQty })), (i) => `lines.${i}.orderedQty`);
  if (Object.keys(frac).length) throw invalid(frac);
}

async function insertPoLines(tx: Tx, poId: string, lines: PoInput['lines']) {
  await tx.query(
    `INSERT INTO purchase_order_lines (tenant_id, po_id, variant_id, position, ordered_qty, unit_cost)
     SELECT current_setting('app.tenant_id')::uuid, $1, l.variant_id, l.ord, l.qty, l.cost
       FROM unnest($2::uuid[], $3::numeric[], $4::numeric[]) WITH ORDINALITY AS l(variant_id, qty, cost, ord)`,
    [poId, lines.map((l) => l.variantId), lines.map((l) => l.orderedQty), lines.map((l) => l.unitCost)]);
}

export async function createPo(tx: Tx, ctx: Ctx, input: PoInput) {
  await activeSupplier(tx, input.supplierId);
  await checkPoLines(tx, input.lines);
  const number = await nextNumber(tx, 'PO');
  const { rows } = await tx.query(
    `INSERT INTO purchase_orders (tenant_id, number, supplier_id, expected_date, notes, created_by)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5) RETURNING id`,
    [number, input.supplierId, input.expectedDate ?? null, input.notes || null, ctx.userId]);
  await insertPoLines(tx, rows[0].id, input.lines);
  return getPo(tx, ctx, rows[0].id);
}

async function poHeader(tx: Tx, id: string, lock = false) {
  const { rows } = await tx.query(`SELECT * FROM purchase_orders WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw notFound('Purchase order');
  return rows[0];
}

export async function patchPo(tx: Tx, ctx: Ctx, id: string, version: number, input: PoInput) {
  const h = await poHeader(tx, id, true);
  if (h.status !== 'draft') throw appError(409, 'INVALID_STATE', `${h.number} has been sent to the supplier and can no longer be edited`);
  if (h.version !== version) throw appError(412, 'VERSION_CONFLICT', 'Someone else changed this purchase order. Reload to see their changes.');
  await activeSupplier(tx, input.supplierId);
  await checkPoLines(tx, input.lines);
  await tx.query('DELETE FROM purchase_order_lines WHERE po_id = $1', [id]);
  await insertPoLines(tx, id, input.lines);
  await tx.query('UPDATE purchase_orders SET supplier_id = $2, expected_date = $3, notes = $4, version = version + 1, updated_at = now() WHERE id = $1',
    [id, input.supplierId, input.expectedDate ?? null, input.notes || null]);
  return getPo(tx, ctx, id);
}

export async function transitionPo(tx: Tx, ctx: Ctx, id: string, action: 'submit' | 'cancel' | 'close') {
  const h = await poHeader(tx, id, true);
  const rules = { submit: { from: ['draft'], to: 'submitted' }, cancel: { from: ['draft', 'submitted'], to: 'cancelled' }, close: { from: ['partial'], to: 'closed' } }[action];
  if (!rules.from.includes(h.status)) {
    const hint = action === 'cancel' && h.status === 'partial' ? ' Goods were already received, so close it instead.' : '';
    throw appError(409, 'INVALID_STATE', `${h.number} is ${h.status}, so it cannot be ${action === 'submit' ? 'submitted' : action === 'cancel' ? 'cancelled' : 'closed'}.${hint}`);
  }
  await tx.query('UPDATE purchase_orders SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [id, rules.to]);
  await audit(tx, { actorId: ctx.userId, action: `purchase_order.${rules.to}`, entityType: 'purchase_order', entityId: id, summary: { number: h.number, from: h.status } });
  return getPo(tx, ctx, id);
}

export async function getPo(tx: Tx, ctx: Ctx, id: string) {
  const { rows: [h] } = await tx.query(
    `SELECT po.*, po.expected_date::text AS expected, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [id]);
  if (!h) throw notFound('Purchase order');
  const { rows: lines } = await tx.query(
    `SELECT l.*, v.sku, v.barcode, v.attributes, p.name AS product_name FROM purchase_order_lines l
       JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id
      WHERE l.po_id = $1 ORDER BY l.position`, [id]);
  const { rows: receipts } = await tx.query('SELECT id, number, posted_at, supplier_invoice_no FROM goods_receipts WHERE po_id = $1 ORDER BY posted_at', [id]);
  let total = 0n;
  const outLines = lines.map((l) => {
    const ordered = milli(l.ordered_qty), accepted = milli(l.accepted_qty);
    const outstanding = h.status === 'cancelled' || h.status === 'closed' ? 0n : ordered > accepted ? ordered - accepted : 0n;
    const lineTotal = amount(ordered, l.unit_cost);
    total += BigInt(lineTotal.replace('.', '')); // amount() always has two decimals, so this is paise
    return {
      id: l.id as string, variantId: l.variant_id as string, sku: l.sku as string, barcode: l.barcode as string | null, name: l.product_name as string,
      attributes: l.attributes as Record<string, string>,
      orderedQty: qtyText(ordered), receivedQty: qtyText(milli(l.received_qty)), acceptedQty: qtyText(accepted), outstandingQty: qtyText(outstanding),
      ...(ctx.showCost ? { unitCost: fmtMoney(l.unit_cost), lineTotal } : {}),
    };
  });
  return {
    id: h.id as string, number: h.number as string, status: h.status as string, version: h.version as number,
    supplier: { id: h.supplier_id as string, name: h.supplier_name as string },
    expectedDate: h.expected as string | null, notes: h.notes as string | null, createdAt: h.created_at as Date,
    lines: outLines,
    ...(ctx.showCost ? { total: `${total / 100n}.${(total % 100n).toString().padStart(2, '0')}` } : {}),
    receipts: receipts.map((r) => ({ id: r.id as string, number: r.number as string, postedAt: r.posted_at as Date, supplierInvoiceNo: r.supplier_invoice_no as string | null })),
  };
}

export async function listPos(tx: Tx, f: { status?: string; supplierId?: string; q?: string; limit: number; after: [string, string] | null }) {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, ...v: unknown[]) => { const base = params.length; params.push(...v); where.push(sql.replace(/\?(\d)/g, (_, n) => `$${base + Number(n)}`)); };
  if (f.status) add('po.status = ?1', f.status);
  if (f.supplierId) add('po.supplier_id = ?1', f.supplierId);
  if (f.q) add('upper(po.number) LIKE ?1', `%${f.q.toUpperCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  if (f.after) add('(po.created_at, po.id) < (?1::timestamptz, ?2::uuid)', f.after[0], f.after[1]);
  params.push(f.limit + 1);
  const { rows } = await tx.query(
    `SELECT po.id, po.number, po.status, po.created_at, po.expected_date::text AS expected, s.id AS supplier_id, s.name AS supplier_name,
            count(l.id)::int AS lines,
            coalesce(sum(greatest(l.ordered_qty - l.accepted_qty, 0)) FILTER (WHERE po.status IN ('submitted', 'partial')), 0) AS outstanding
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN purchase_order_lines l ON l.po_id = po.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY po.id, s.id ORDER BY po.created_at DESC, po.id DESC LIMIT $${params.length}`, params);
  const more = rows.length > f.limit;
  const page = rows.slice(0, f.limit);
  return {
    items: page.map((r) => ({ id: r.id, number: r.number, status: r.status, createdAt: r.created_at, expectedDate: r.expected,
      supplier: { id: r.supplier_id, name: r.supplier_name }, lineCount: r.lines, outstandingQty: qtyText(milli(r.outstanding)) })),
    last: more ? [page[page.length - 1].created_at.toISOString(), page[page.length - 1].id] as [string, string] : null,
  };
}

// ------------------------------------------------------------------ goods receipts (PUR-03/04, AC-05)

/**
 * Post a receipt. Accepted quantity goes to sellable stock, the rest of what arrived (damaged) to non-sellable.
 * Against a PO, a line cannot accept more than is outstanding (B3 default); extras go on a line without poLineId.
 */
export async function postReceipt(tx: Tx, ctx: Ctx, input: ReceiptInput) {
  const errors: Record<string, string[]> = {};
  input.lines.forEach((l, i) => {
    if (milli(l.acceptedQty) > milli(l.receivedQty)) errors[`lines.${i}.acceptedQty`] = ['Cannot accept more than arrived'];
    if (l.poLineId && !input.purchaseOrderId) errors[`lines.${i}.poLineId`] = ['Choose the purchase order this line belongs to'];
  });
  if (Object.keys(errors).length) throw invalid(errors);
  if (!ctx.showCost && input.lines.some((l) => l.unitCost !== undefined)) throw appError(403, 'FORBIDDEN', 'You do not have permission to set cost');
  const supplier = await activeSupplier(tx, input.supplierId);
  const variants = await activeVariants(tx, input.lines.map((l) => l.variantId), (i) => `lines.${i}.variantId`);
  const frac = await wholeUnitErrors(tx, input.lines.flatMap((l) => [{ variantId: l.variantId, qty: l.receivedQty }]), (i) => `lines.${i}.receivedQty`);
  Object.assign(frac, await wholeUnitErrors(tx, input.lines.map((l) => ({ variantId: l.variantId, qty: l.acceptedQty })), (i) => `lines.${i}.acceptedQty`));
  if (Object.keys(frac).length) throw invalid(frac);
  const locations = new Map<string, { id: string; name: string }>();
  for (const [i, l] of input.lines.entries()) if (!locations.has(l.locationId)) locations.set(l.locationId, await activeLocation(tx, l.locationId, `lines.${i}.locationId`));

  // PO: lock it, check every line against what is still outstanding.
  let po: Record<string, any> | null = null;
  const poLines = new Map<string, Record<string, any>>();
  if (input.purchaseOrderId) {
    const h = await poHeader(tx, input.purchaseOrderId, true);
    po = h;
    if (h.status !== 'submitted' && h.status !== 'partial') throw appError(409, 'INVALID_STATE', `${h.number} is ${h.status}; only submitted purchase orders can be received`);
    if (h.supplier_id !== supplier.id) throw invalid({ supplierId: [`${h.number} is from a different supplier`] });
    const { rows } = await tx.query('SELECT * FROM purchase_order_lines WHERE po_id = $1 FOR UPDATE', [h.id]);
    for (const r of rows) poLines.set(r.id, { ...r, accepting: 0n });
    input.lines.forEach((l, i) => {
      if (!l.poLineId) return;
      const pl = poLines.get(l.poLineId);
      if (!pl) { errors[`lines.${i}.poLineId`] = [`Not a line of ${h.number}`]; return; }
      if (pl.variant_id !== l.variantId) { errors[`lines.${i}.variantId`] = ['This is not the item on that purchase order line']; return; }
      pl.accepting += milli(l.acceptedQty);
      const left = milli(pl.ordered_qty) - milli(pl.accepted_qty);
      if (pl.accepting > left)
        errors[`lines.${i}.acceptedQty`] = [`Only ${qtyText(left > 0n ? left : 0n)} still to receive on ${h.number}. Put the extra on its own line.`];
    });
    if (Object.keys(errors).length) throw appError(409, 'OVER_RECEIPT', 'More accepted than the purchase order has outstanding', errors);
  }

  const number = await nextNumber(tx, 'GRN');
  const { rows: [doc] } = await tx.query(
    `INSERT INTO goods_receipts (tenant_id, number, po_id, supplier_id, supplier_invoice_no, note, posted_by)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6) RETURNING id, posted_at`,
    [number, po?.id ?? null, supplier.id, input.supplierInvoiceNo || null, input.note || null, ctx.userId]);
  const lineCost = (l: ReceiptInput['lines'][number]) => l.unitCost ?? (l.poLineId ? poLines.get(l.poLineId)!.unit_cost as string : null);
  const { rows: inserted } = await tx.query(
    `INSERT INTO goods_receipt_lines (tenant_id, receipt_id, po_line_id, variant_id, location_id, received_qty, accepted_qty, unit_cost)
     SELECT current_setting('app.tenant_id')::uuid, $1, l.po_line_id, l.variant_id, l.location_id, l.received, l.accepted, l.cost
       FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::numeric[], $6::numeric[], $7::numeric[]) WITH ORDINALITY
            AS l(po_line_id, variant_id, location_id, received, accepted, cost, ord)
      ORDER BY l.ord RETURNING id`,
    [doc.id, input.lines.map((l) => l.poLineId ?? null), input.lines.map((l) => l.variantId), input.lines.map((l) => l.locationId),
      input.lines.map((l) => l.receivedQty), input.lines.map((l) => l.acceptedQty), input.lines.map(lineCost)]);

  // Cost first (it needs stock as it was before this receipt), then stock.
  for (const l of input.lines) { const c = lineCost(l); if (c !== null) await applyCost(tx, l.variantId, milli(l.acceptedQty), c); }
  const moves: Move[] = [];
  input.lines.forEach((l, i) => {
    const accepted = milli(l.acceptedQty), damaged = milli(l.receivedQty) - accepted;
    const base = { variantId: l.variantId, locationId: l.locationId, movementType: 'receipt', sourceType: 'goods_receipt' as const,
      sourceId: doc.id, sourceLineId: inserted[i].id, unitCost: lineCost(l), note: input.supplierInvoiceNo ? `Invoice ${input.supplierInvoiceNo}` : null };
    if (accepted > 0n) moves.push({ ...base, bucket: 'sellable', delta: accepted, field: `lines.${i}.acceptedQty` });
    if (damaged > 0n) moves.push({ ...base, bucket: 'non_sellable', delta: damaged, reasonCode: 'damage', field: `lines.${i}.receivedQty` });
  });
  const posted = await post(tx, ctx.userId, moves);

  if (po) {
    for (const l of input.lines) if (l.poLineId)
      await tx.query('UPDATE purchase_order_lines SET received_qty = received_qty + $2, accepted_qty = accepted_qty + $3 WHERE id = $1',
        [l.poLineId, l.receivedQty, l.acceptedQty]);
    const { rows: [left] } = await tx.query('SELECT bool_and(accepted_qty >= ordered_qty) AS done FROM purchase_order_lines WHERE po_id = $1', [po.id]);
    await tx.query('UPDATE purchase_orders SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [po.id, left.done ? 'closed' : 'partial']);
  }
  await audit(tx, { actorId: ctx.userId, action: 'goods_receipt.posted', entityType: 'goods_receipt', entityId: doc.id, summary: {
    number, purchaseOrder: po?.number ?? null, supplier: supplier.name, supplierInvoiceNo: input.supplierInvoiceNo ?? null,
    lines: input.lines.map((l) => ({ sku: variants.get(l.variantId)!.sku, received: l.receivedQty, accepted: l.acceptedQty, location: locations.get(l.locationId)!.name })),
  } });
  return { id: doc.id as string, number, postedAt: doc.posted_at as Date, movements: await movementsByIds(tx, posted.map((p) => p.id), ctx.showCost) };
}

export async function getReceipt(tx: Tx, ctx: Ctx, id: string) {
  const { rows: [h] } = await tx.query(
    `SELECT g.*, s.name AS supplier_name, po.number AS po_number, u.name AS posted_by_name FROM goods_receipts g
       JOIN suppliers s ON s.id = g.supplier_id LEFT JOIN purchase_orders po ON po.id = g.po_id LEFT JOIN users u ON u.id = g.posted_by
      WHERE g.id = $1`, [id]);
  if (!h) throw notFound('Goods receipt');
  const { rows } = await tx.query(
    `SELECT l.*, v.sku, v.attributes, p.name AS product_name, loc.name AS location_name FROM goods_receipt_lines l
       JOIN product_variants v ON v.id = l.variant_id JOIN products p ON p.id = v.product_id JOIN locations loc ON loc.id = l.location_id
      WHERE l.receipt_id = $1 ORDER BY v.sku`, [id]);
  return {
    id: h.id as string, number: h.number as string, postedAt: h.posted_at as Date, postedBy: h.posted_by_name as string | null,
    supplier: { id: h.supplier_id as string, name: h.supplier_name as string },
    purchaseOrder: h.po_id ? { id: h.po_id as string, number: h.po_number as string } : null,
    supplierInvoiceNo: h.supplier_invoice_no as string | null, note: h.note as string | null,
    lines: rows.map((l) => ({
      id: l.id as string, poLineId: l.po_line_id as string | null, variantId: l.variant_id as string, sku: l.sku as string, name: l.product_name as string,
      attributes: l.attributes as Record<string, string>, locationId: l.location_id as string, locationName: l.location_name as string,
      receivedQty: qtyText(milli(l.received_qty)), acceptedQty: qtyText(milli(l.accepted_qty)), damagedQty: qtyText(milli(l.damaged_qty)),
      ...(ctx.showCost ? { unitCost: fmtMoney(l.unit_cost) } : {}),
    })),
  };
}

export async function listReceipts(tx: Tx, f: { supplierId?: string; purchaseOrderId?: string; limit: number; after: [string, string] | null }) {
  const params: unknown[] = [f.supplierId ?? null, f.purchaseOrderId ?? null];
  let where = '($1::uuid IS NULL OR g.supplier_id = $1) AND ($2::uuid IS NULL OR g.po_id = $2)';
  if (f.after) { params.push(f.after[0], f.after[1]); where += ' AND (g.posted_at, g.id) < ($3::timestamptz, $4::uuid)'; }
  params.push(f.limit + 1);
  const { rows } = await tx.query(
    `SELECT g.id, g.number, g.posted_at, g.supplier_invoice_no, s.name AS supplier_name, po.number AS po_number,
            (SELECT sum(received_qty) FROM goods_receipt_lines x WHERE x.receipt_id = g.id) AS received,
            (SELECT sum(accepted_qty) FROM goods_receipt_lines x WHERE x.receipt_id = g.id) AS accepted
       FROM goods_receipts g JOIN suppliers s ON s.id = g.supplier_id LEFT JOIN purchase_orders po ON po.id = g.po_id
      WHERE ${where} ORDER BY g.posted_at DESC, g.id DESC LIMIT $${params.length}`, params);
  const more = rows.length > f.limit;
  const page = rows.slice(0, f.limit);
  return {
    items: page.map((r) => ({ id: r.id, number: r.number, postedAt: r.posted_at, supplierName: r.supplier_name, purchaseOrderNumber: r.po_number,
      supplierInvoiceNo: r.supplier_invoice_no, receivedQty: qtyText(milli(r.received)), acceptedQty: qtyText(milli(r.accepted)) })),
    last: more ? [page[page.length - 1].posted_at.toISOString(), page[page.length - 1].id] as [string, string] : null,
  };
}

// ------------------------------------------------------------------ supplier returns (PUR-05)

export async function postSupplierReturn(tx: Tx, ctx: Ctx, input: SupplierReturnInput) {
  const supplier = await activeSupplier(tx, input.supplierId);
  const variants = await activeVariants(tx, input.lines.map((l) => l.variantId), (i) => `lines.${i}.variantId`);
  for (const [i, l] of input.lines.entries()) await activeLocation(tx, l.locationId, `lines.${i}.locationId`);
  let receiptNumber: string | null = null;
  if (input.receiptId) {
    const { rows: [g] } = await tx.query('SELECT number, supplier_id FROM goods_receipts WHERE id = $1', [input.receiptId]);
    if (!g || g.supplier_id !== supplier.id) throw invalid({ receiptId: ['Receipt not found for this supplier'] });
    receiptNumber = g.number;
    const { rows } = await tx.query('SELECT DISTINCT variant_id FROM goods_receipt_lines WHERE receipt_id = $1', [input.receiptId]);
    const onReceipt = new Set(rows.map((r) => r.variant_id));
    const errors: Record<string, string[]> = {};
    input.lines.forEach((l, i) => { if (!onReceipt.has(l.variantId)) errors[`lines.${i}.variantId`] = [`Not on receipt ${g.number}`]; });
    if (Object.keys(errors).length) throw invalid(errors);
  }
  const number = await nextNumber(tx, 'SR');
  const { rows: [doc] } = await tx.query(
    `INSERT INTO supplier_returns (tenant_id, number, supplier_id, receipt_id, reason, posted_by)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5) RETURNING id, posted_at`,
    [number, supplier.id, input.receiptId ?? null, input.reason, ctx.userId]);
  const { rows: inserted } = await tx.query(
    `INSERT INTO supplier_return_lines (tenant_id, return_id, variant_id, location_id, bucket, qty)
     SELECT current_setting('app.tenant_id')::uuid, $1, l.v, l.loc, l.b, l.q
       FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::numeric[]) WITH ORDINALITY AS l(v, loc, b, q, ord) ORDER BY l.ord RETURNING id`,
    [doc.id, input.lines.map((l) => l.variantId), input.lines.map((l) => l.locationId), input.lines.map((l) => l.bucket), input.lines.map((l) => l.qty)]);
  const posted = await post(tx, ctx.userId, input.lines.map((l, i): Move => ({
    variantId: l.variantId, locationId: l.locationId, bucket: l.bucket, delta: -milli(l.qty), movementType: 'supplier_return',
    sourceType: 'supplier_return', sourceId: doc.id, sourceLineId: inserted[i].id, reasonCode: 'supplier_return', note: input.reason, field: `lines.${i}.qty`,
  })));
  await audit(tx, { actorId: ctx.userId, action: 'supplier_return.posted', entityType: 'supplier_return', entityId: doc.id, summary: {
    number, supplier: supplier.name, receipt: receiptNumber, reason: input.reason,
    lines: input.lines.map((l) => ({ sku: variants.get(l.variantId)!.sku, bucket: l.bucket, qty: l.qty })),
  } });
  return { id: doc.id as string, number, postedAt: doc.posted_at as Date, movements: await movementsByIds(tx, posted.map((p) => p.id), ctx.showCost) };
}

export async function listSupplierReturns(tx: Tx, f: { supplierId?: string; limit: number; after: [string, string] | null }) {
  const params: unknown[] = [f.supplierId ?? null];
  let where = '($1::uuid IS NULL OR r.supplier_id = $1)';
  if (f.after) { params.push(f.after[0], f.after[1]); where += ' AND (r.posted_at, r.id) < ($2::timestamptz, $3::uuid)'; }
  params.push(f.limit + 1);
  const { rows } = await tx.query(
    `SELECT r.id, r.number, r.posted_at, r.reason, s.name AS supplier_name, g.number AS receipt_number,
            (SELECT sum(qty) FROM supplier_return_lines x WHERE x.return_id = r.id) AS qty
       FROM supplier_returns r JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN goods_receipts g ON g.id = r.receipt_id
      WHERE ${where} ORDER BY r.posted_at DESC, r.id DESC LIMIT $${params.length}`, params);
  const more = rows.length > f.limit;
  const page = rows.slice(0, f.limit);
  return {
    items: page.map((r) => ({ id: r.id, number: r.number, postedAt: r.posted_at, reason: r.reason, supplierName: r.supplier_name,
      receiptNumber: r.receipt_number, qty: qtyText(milli(r.qty)) })),
    last: more ? [page[page.length - 1].posted_at.toISOString(), page[page.length - 1].id] as [string, string] : null,
  };
}
