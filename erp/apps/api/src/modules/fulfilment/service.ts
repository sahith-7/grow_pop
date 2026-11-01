import { z } from 'zod';
import type { Tx } from '../../db.js';
import { fmtQty, qty } from '../../lib/decimal.js';
import { nextNumber } from '../../lib/doc-numbers.js';
import { appError, audit } from '../../lib/phase1.js';
import { isWhole, milli, qtyText } from '../../lib/quantity.js';
import { enqueue } from '../../jobs/queue.js';
import { convert } from '../inventory/reservations.js';
import { invoiceAfterDispatch } from '../sales/web-invoice.js';
import { dropFromPickLists, refreshPickList } from './pick-lists.js';

// Pick, pack and dispatch for web orders (PRD 6.6, J13, AC-10). Stock is held by B4's reservations the whole time and
// leaves once, at dispatch (convert). Picking and packing move nothing in the ledger.
// Every step takes the same per-order advisory lock as a WooCommerce webhook for that order, so a cancellation from the
// shop and a click in the ERP never interleave.

const invalid = (fieldErrors: Record<string, string[]>) => appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', fieldErrors);

async function event(tx: Tx, orderId: string, kind: string, message: string, actorId: string | null) {
  await tx.query(
    "INSERT INTO sales_order_events (tenant_id, order_id, kind, message, actor_id) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4)",
    [orderId, kind, message.slice(0, 1000), actorId]);
}

/** Lock one web order the way applyWooOrder does (advisory lock, then the row) and return it. */
async function lockOrder(tx: Tx, orderId: string) {
  const { rows: [o] } = await tx.query("SELECT id, external_id FROM sales_orders WHERE id = $1 AND channel = 'woocommerce'", [orderId]);
  if (!o) throw appError(404, 'NOT_FOUND', 'Order not found');
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7))', [`woo-order:${o.external_id}`]);
  const { rows: [row] } = await tx.query('SELECT * FROM sales_orders WHERE id = $1 FOR UPDATE', [orderId]);
  return row;
}

const STAGE_LABEL: Record<string, string> = { ready_to_pick: 'Ready to pick', picking: 'Picking', packed: 'Packed', dispatched: 'Dispatched' };
const wrongState = (o: { number: string; status: string }, want: string) =>
  appError(409, 'INVALID_STATE', `Order #${o.number} is ${(STAGE_LABEL[o.status] ?? o.status.replace(/_/g, ' ')).toLowerCase()}; ${want}`);

// ------------------------------------------------------------------ queue

/** The shop update as people should see it: "pending" with no job left to run it means it gave up, so show "failed". */
export const WEB_UPDATE_SQL = `CASE WHEN s.woo_update_state = 'pending' AND NOT EXISTS (SELECT 1 FROM sync_jobs j WHERE j.kind = 'woo.fulfilment'
  AND j.resource_id = s.id AND j.status IN ('pending', 'running')) THEN 'failed' ELSE s.woo_update_state END`;

export const STAGES = ['ready_to_pick', 'picking', 'packed', 'dispatched_pending_web', 'stock_exception'] as const;
export type Stage = (typeof STAGES)[number];

/** Orders by fulfilment stage, oldest paid first, with each stage's count for the tabs. */
export async function queue(tx: Tx, stage: Stage, limit: number, after: [string, string] | null) {
  const where = stage === 'dispatched_pending_web'
    ? "o.status = 'dispatched' AND s.woo_update_state IN ('pending', 'failed')"
    : `o.status = '${stage}'`;
  const params: unknown[] = [];
  let page = '';
  if (after) { params.push(after[0], after[1]); page = ` AND (o.placed_at, o.id) > ($1::timestamptz, $2::uuid)`; }
  params.push(limit + 1);
  const { rows } = await tx.query(
    `SELECT o.*, o.placed_at AS queue_at, s.carrier, s.tracking_no, ${WEB_UPDATE_SQL} AS woo_update_state, s.woo_error,
            (SELECT coalesce(sum(qty), 0) FROM sales_order_lines l WHERE l.order_id = o.id) AS item_count,
            (SELECT p.number FROM pick_list_lines pl JOIN pick_lists p ON p.id = pl.pick_list_id
              WHERE pl.order_id = o.id AND pl.state = 'active' LIMIT 1) AS pick_list_number,
            (SELECT pl.pick_list_id FROM pick_list_lines pl WHERE pl.order_id = o.id AND pl.state = 'active' LIMIT 1) AS pick_list_id,
            (SELECT bool_and(pl.qty_picked = pl.qty_required) FROM pick_list_lines pl WHERE pl.order_id = o.id AND pl.state = 'active') AS all_picked
       FROM sales_orders o LEFT JOIN shipments s ON s.order_id = o.id
      WHERE o.channel = 'woocommerce' AND ${where}${page}
      ORDER BY o.placed_at, o.id LIMIT $${params.length}`, params);
  const { rows: [counts] } = await tx.query(
    `SELECT count(*) FILTER (WHERE o.status = 'ready_to_pick')::int AS ready_to_pick, count(*) FILTER (WHERE o.status = 'picking')::int AS picking,
            count(*) FILTER (WHERE o.status = 'packed')::int AS packed, count(*) FILTER (WHERE o.status = 'stock_exception')::int AS stock_exception,
            count(*) FILTER (WHERE o.status = 'dispatched' AND s.woo_update_state IN ('pending', 'failed'))::int AS dispatched_pending_web
       FROM sales_orders o LEFT JOIN shipments s ON s.order_id = o.id
      WHERE o.channel = 'woocommerce' AND o.status IN ('ready_to_pick', 'picking', 'packed', 'stock_exception', 'dispatched')`);
  const items = rows.slice(0, limit);
  return {
    items: items.map((r) => ({
      id: r.id as string, number: r.number as string, status: r.status as string, customerName: (r.customer_snapshot?.name as string) || null,
      city: (r.customer_snapshot?.shipping?.city || r.customer_snapshot?.billing?.city || null) as string | null,
      itemCount: Number(r.item_count), total: String(r.total), paymentMethod: r.payment_method as string | null, queuedAt: r.queue_at as Date,
      exceptionReason: r.exception_reason as string | null,
      pickList: r.pick_list_id ? { id: r.pick_list_id as string, number: r.pick_list_number as string, allPicked: !!r.all_picked } : null,
      shipment: r.carrier ? { carrier: r.carrier as string, trackingNo: r.tracking_no as string | null, webUpdate: r.woo_update_state as string, webError: r.woo_error as string | null } : null,
    })),
    counts,
    nextCursor: rows.length > limit ? [items[items.length - 1].queue_at.toISOString(), items[items.length - 1].id] as [string, string] : null,
  };
}

// ------------------------------------------------------------------ pick lists

export const pickListInput = z.object({ orderIds: z.array(z.string().uuid()).min(1, 'Pick at least one order').max(30, 'At most 30 orders per pick list') }).strict();

/** One list for one or more ready orders (batch picking). The orders move to "picking". */
export async function createPickList(tx: Tx, actorId: string, input: z.infer<typeof pickListInput>) {
  const ids = [...new Set(input.orderIds)].sort();
  const orders: Record<string, any>[] = [];
  for (const id of ids) orders.push(await lockOrder(tx, id));   // sorted: two people batching overlapping orders can't deadlock
  const errors: Record<string, string[]> = {};
  orders.forEach((o, i) => { if (o.status !== 'ready_to_pick') errors[`orderIds.${input.orderIds.indexOf(ids[i])}`] = [`Order #${o.number} is not ready to pick`]; });
  if (Object.keys(errors).length) throw appError(409, 'INVALID_STATE', Object.values(errors).flat().join('; '), errors);

  const { rows: holds } = await tx.query(
    `SELECT r.order_id, r.order_line_id, r.variant_id, r.location_id, r.qty
       FROM stock_reservations r JOIN sales_order_lines l ON l.id = r.order_line_id
      WHERE r.order_id = ANY($1) AND r.state = 'active' ORDER BY r.order_id, l.position`, [ids]);
  const empty = orders.filter((o) => !holds.some((h) => h.order_id === o.id));
  if (empty.length) throw appError(409, 'INVALID_STATE', `Nothing is held for order ${empty.map((o) => `#${o.number}`).join(', ')}; try to hold stock again first`);

  const number = await nextNumber(tx, 'PK');
  const { rows: [list] } = await tx.query(
    `INSERT INTO pick_lists (tenant_id, number, created_by) VALUES (current_setting('app.tenant_id')::uuid, $1, $2) RETURNING id`, [number, actorId]);
  await tx.query(
    `INSERT INTO pick_list_lines (tenant_id, pick_list_id, order_id, order_line_id, variant_id, location_id, qty_required)
     SELECT current_setting('app.tenant_id')::uuid, $1, u.o, u.l, u.v, u.loc, u.q
       FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::numeric[]) AS u(o, l, v, loc, q)`,
    [list.id, holds.map((h) => h.order_id), holds.map((h) => h.order_line_id), holds.map((h) => h.variant_id), holds.map((h) => h.location_id), holds.map((h) => h.qty)]);
  await tx.query("UPDATE sales_orders SET status = 'picking', updated_at = now() WHERE id = ANY($1)", [ids]);
  for (const o of orders) await event(tx, o.id, 'picking', `On pick list ${number}`, actorId);
  return pickListDetail(tx, list.id);
}

/** A pick list in walking order: by location, then SKU. Each line says which order (bag) the item goes in. */
export async function pickListDetail(tx: Tx, id: string) {
  const { rows: [p] } = await tx.query(
    'SELECT p.*, u.name AS created_by_name FROM pick_lists p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = $1', [id]);
  if (!p) throw appError(404, 'NOT_FOUND', 'Pick list not found');
  const { rows: lines } = await tx.query(
    `SELECT l.id, l.order_id, o.number AS order_number, o.status AS order_status, l.variant_id, v.sku, v.barcode, v.attributes, pr.name,
            pr.unit_code, loc.name AS location, l.qty_required, l.qty_picked, l.state, u.allow_fraction
       FROM pick_list_lines l JOIN sales_orders o ON o.id = l.order_id JOIN product_variants v ON v.id = l.variant_id
       JOIN products pr ON pr.id = v.product_id JOIN units u ON u.code = pr.unit_code JOIN locations loc ON loc.id = l.location_id
      WHERE l.pick_list_id = $1 ORDER BY l.state, loc.name, v.sku, o.placed_at, o.id, l.id`, [id]);
  const live = lines.filter((l) => l.state === 'active');
  const orders = [...new Map(lines.map((l) => [l.order_id, { id: l.order_id as string, number: l.order_number as string, status: l.order_status as string }])).values()];
  return {
    id: p.id as string, number: p.number as string, status: p.status as string, createdAt: p.created_at as Date, createdBy: p.created_by_name as string | null,
    progress: { picked: qtyText(live.reduce((a, l) => a + milli(l.qty_picked), 0n)), required: qtyText(live.reduce((a, l) => a + milli(l.qty_required), 0n)) },
    orders: orders.map((o) => ({ ...o, removed: !live.some((l) => l.order_id === o.id), picked: live.filter((l) => l.order_id === o.id).every((l) => milli(l.qty_picked) === milli(l.qty_required)) })),
    lines: lines.map((l) => ({
      id: l.id as string, orderId: l.order_id as string, orderNumber: l.order_number as string, variantId: l.variant_id as string,
      sku: l.sku as string, barcode: l.barcode as string | null, name: l.name as string, attributes: l.attributes ?? {}, unitCode: l.unit_code as string,
      allowFraction: l.allow_fraction as boolean, location: l.location as string, qtyRequired: fmtQty(l.qty_required), qtyPicked: fmtQty(l.qty_picked),
      removed: l.state === 'removed',
    })),
  };
}

export async function listPickLists(tx: Tx, open: boolean) {
  const { rows } = await tx.query(
    `SELECT p.id, p.number, p.status, p.created_at, u.name AS created_by,
            (SELECT count(DISTINCT l.order_id)::int FROM pick_list_lines l WHERE l.pick_list_id = p.id AND l.state = 'active') AS orders,
            (SELECT coalesce(sum(l.qty_picked), 0) FROM pick_list_lines l WHERE l.pick_list_id = p.id AND l.state = 'active') AS picked,
            (SELECT coalesce(sum(l.qty_required), 0) FROM pick_list_lines l WHERE l.pick_list_id = p.id AND l.state = 'active') AS required
       FROM pick_lists p LEFT JOIN users u ON u.id = p.created_by
      WHERE ${open ? "p.status IN ('open', 'picking', 'picked') AND EXISTS (SELECT 1 FROM pick_list_lines l JOIN sales_orders o ON o.id = l.order_id WHERE l.pick_list_id = p.id AND l.state = 'active' AND o.status = 'picking')" : 'true'}
      ORDER BY p.created_at DESC LIMIT 50`);
  return {
    items: rows.map((r) => ({
      id: r.id as string, number: r.number as string, status: r.status as string, createdAt: r.created_at as Date, createdBy: r.created_by as string | null,
      orders: r.orders as number, picked: fmtQty(r.picked), required: fmtQty(r.required),
    })),
  };
}

async function lockList(tx: Tx, id: string) {
  const { rows: [p] } = await tx.query('SELECT * FROM pick_lists WHERE id = $1 FOR UPDATE', [id]);
  if (!p) throw appError(404, 'NOT_FOUND', 'Pick list not found');
  if (p.status === 'cancelled') throw appError(409, 'INVALID_STATE', `Pick list ${p.number} was cancelled`);
  return p;
}

export const scanInput = z.object({ code: z.string().trim().min(1).max(64), qty: qty.optional() }).strict();

/**
 * Record items picked by scanning a barcode or typing a SKU. Fills this item's lines in order (oldest order first).
 * A code not on the list, or more than the list needs, is refused with PICK_MISMATCH and changes nothing.
 */
export async function scan(tx: Tx, actorId: string, listId: string, input: z.infer<typeof scanInput>) {
  const p = await lockList(tx, listId);
  const { rows: lines } = await tx.query(
    `SELECT l.id, l.order_id, o.number AS order_number, l.qty_required, l.qty_picked, v.sku, u.allow_fraction
       FROM pick_list_lines l JOIN product_variants v ON v.id = l.variant_id JOIN sales_orders o ON o.id = l.order_id
       JOIN products pr ON pr.id = v.product_id JOIN units u ON u.code = pr.unit_code
      WHERE l.pick_list_id = $1 AND l.state = 'active' AND o.status = 'picking' AND (v.barcode = $2 OR lower(v.sku) = lower($2))
      ORDER BY o.placed_at, o.id, l.id FOR UPDATE OF l`, [listId, input.code]);
  if (!lines.length) {
    const { rows: [known] } = await tx.query('SELECT v.sku, pr.name FROM product_variants v JOIN products pr ON pr.id = v.product_id WHERE v.barcode = $1 OR lower(v.sku) = lower($1) LIMIT 1', [input.code]);
    throw appError(409, 'PICK_MISMATCH', known ? `Wrong item: ${known.name} (${known.sku}) is not on pick list ${p.number}` : `“${input.code}” is not a product in the ERP`);
  }
  let want = milli(input.qty ?? '1');
  if (want <= 0n) throw invalid({ qty: ['Quantity must be more than 0'] });
  if (!lines[0].allow_fraction && !isWhole(want)) throw invalid({ qty: [`${lines[0].sku} is picked in whole units`] });
  const room = lines.reduce((a, l) => a + milli(l.qty_required) - milli(l.qty_picked), 0n);
  if (want > room) {
    throw appError(409, 'PICK_MISMATCH', room === 0n
      ? `All ${lines[0].sku} on this list are already picked. Put this one back.`
      : `Only ${qtyText(room)} more ${lines[0].sku} needed; you scanned ${qtyText(want)}.`);
  }
  const into: { orderNumber: string; qty: string }[] = [];
  for (const l of lines) {
    const free = milli(l.qty_required) - milli(l.qty_picked);
    if (want <= 0n || free <= 0n) continue;
    const take = want < free ? want : free;
    await tx.query('UPDATE pick_list_lines SET qty_picked = qty_picked + $2, picked_at = now(), picked_by = $3 WHERE id = $1', [l.id, qtyText(take), actorId]);
    into.push({ orderNumber: l.order_number, qty: qtyText(take) });
    want -= take;
  }
  await refreshPickList(tx, listId);
  return { ...(await pickListDetail(tx, listId)), scanned: { sku: lines[0].sku as string, into } };
}

export const setPickedInput = z.object({ qtyPicked: qty }).strict();

/** Correct one line by hand: an item with no barcode, or a mis-scan to undo. 0 … required. */
export async function setPicked(tx: Tx, actorId: string, listId: string, lineId: string, input: z.infer<typeof setPickedInput>) {
  await lockList(tx, listId);
  const { rows: [l] } = await tx.query(
    `SELECT l.qty_required, o.status, u.allow_fraction, v.sku FROM pick_list_lines l JOIN sales_orders o ON o.id = l.order_id
       JOIN product_variants v ON v.id = l.variant_id JOIN products pr ON pr.id = v.product_id JOIN units u ON u.code = pr.unit_code
      WHERE l.id = $1 AND l.pick_list_id = $2 AND l.state = 'active' FOR UPDATE OF l`, [lineId, listId]);
  if (!l) throw appError(404, 'NOT_FOUND', 'Pick list line not found');
  if (l.status !== 'picking') throw appError(409, 'INVALID_STATE', 'This order is already packed; take it off packing first');
  const q = milli(input.qtyPicked);
  if (q > milli(l.qty_required)) throw invalid({ qtyPicked: [`At most ${fmtQty(l.qty_required)}`] });
  if (!l.allow_fraction && !isWhole(q)) throw invalid({ qtyPicked: [`${l.sku} is picked in whole units`] });
  await tx.query('UPDATE pick_list_lines SET qty_picked = $2, picked_at = now(), picked_by = $3 WHERE id = $1', [lineId, qtyText(q), actorId]);
  await refreshPickList(tx, listId);
  return pickListDetail(tx, listId);
}

/**
 * Take an order off picking or packing and back to "ready to pick" (an item can't be found, the customer called …).
 * Stock stays held for it. Picked items go back on the shelf.
 */
export async function unpick(tx: Tx, actorId: string, orderId: string, reason: string) {
  const o = await lockOrder(tx, orderId);
  if (o.status !== 'picking' && o.status !== 'packed') throw wrongState(o, 'only orders being picked or packed can go back');
  await dropFromPickLists(tx, orderId);
  await tx.query("UPDATE sales_orders SET status = 'ready_to_pick', updated_at = now() WHERE id = $1", [orderId]);
  await event(tx, orderId, 'unpicked', `Back to ready to pick: ${reason}. Put the picked items back on the shelf`, actorId);
}

export async function cancelPickList(tx: Tx, actorId: string, listId: string, reason: string) {
  const p = await lockList(tx, listId);
  const { rows } = await tx.query("SELECT DISTINCT order_id FROM pick_list_lines WHERE pick_list_id = $1 AND state = 'active' ORDER BY order_id", [listId]);
  for (const r of rows) {
    const o = await lockOrder(tx, r.order_id);
    if (o.status === 'picking') await unpick(tx, actorId, o.id, `pick list ${p.number} cancelled (${reason})`);
  }
  await tx.query("UPDATE pick_list_lines SET state = 'removed' WHERE pick_list_id = $1 AND state = 'active'", [listId]);
  await tx.query("UPDATE pick_lists SET status = 'cancelled', updated_at = now() WHERE id = $1", [listId]);
}

// ------------------------------------------------------------------ pack

export const packInput = z.object({ lines: z.array(z.object({ lineId: z.string().uuid(), qty }).strict()).min(1).max(500) }).strict();

/** Confirm what is in the box. Substitutions are off (V1): each line must be exactly what is held, and fully picked. */
export async function pack(tx: Tx, actorId: string, orderId: string, input: z.infer<typeof packInput>) {
  const o = await lockOrder(tx, orderId);
  if (o.status !== 'picking') throw wrongState(o, 'pick it before packing');
  const { rows: holds } = await tx.query(
    `SELECT r.order_line_id, r.qty, l.sku, l.name, pl.qty_picked, pl.qty_required
       FROM stock_reservations r JOIN sales_order_lines l ON l.id = r.order_line_id
       LEFT JOIN pick_list_lines pl ON pl.order_line_id = r.order_line_id AND pl.state = 'active'
      WHERE r.order_id = $1 AND r.state = 'active' ORDER BY l.position`, [orderId]);
  const notPicked = holds.filter((h) => h.qty_picked === null || milli(h.qty_picked) < milli(h.qty_required));
  if (notPicked.length) throw appError(409, 'NOT_PICKED', `Not picked yet: ${notPicked.map((h) => h.sku || h.name).join(', ')}`);
  const errors: Record<string, string[]> = {};
  const given = new Map(input.lines.map((l, i) => [l.lineId, { q: milli(l.qty), i }]));
  for (const h of holds) {
    const g = given.get(h.order_line_id);
    if (!g) { errors.lines = [...(errors.lines ?? []), `${h.sku || h.name} is missing from the box`]; continue; }
    if (g.q !== milli(h.qty)) errors[`lines.${g.i}.qty`] = [`Pack exactly ${fmtQty(h.qty)} (substitutions are off)`];
    given.delete(h.order_line_id);
  }
  for (const g of given.values()) errors[`lines.${g.i}.lineId`] = ['Not an item held for this order'];
  if (Object.keys(errors).length) throw invalid(errors);
  await tx.query("UPDATE sales_orders SET status = 'packed', packed_at = now(), packed_by = $2, updated_at = now() WHERE id = $1", [orderId, actorId]);
  await event(tx, orderId, 'packed', `Packed: ${holds.map((h) => `${fmtQty(h.qty)} × ${h.sku || h.name}`).join(', ')}`, actorId);
}

// ------------------------------------------------------------------ dispatch

export const dispatchInput = z.object({
  carrier: z.string().trim().min(1, 'Enter the courier, or “Hand delivery”').max(60),
  service: z.string().trim().max(60).optional(),
  trackingNo: z.string().trim().max(60).optional(),
  shippedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

/**
 * The parcel leaves: held stock becomes a stock-out exactly once (convert's state guard, AC-10), the shipment is
 * recorded, the GST invoice is issued (B5), and WooCommerce is told "completed" with the tracking number by a job that
 * retries until the shop accepts it. The ERP side never waits for the shop.
 */
export async function dispatch(tx: Tx, actorId: string, orderId: string, input: z.infer<typeof dispatchInput>) {
  const o = await lockOrder(tx, orderId);
  const { rows: [already] } = await tx.query('SELECT id FROM shipments WHERE order_id = $1', [orderId]);
  if (already) throw appError(409, 'ALREADY_DISPATCHED', `Order #${o.number} was already dispatched`);
  if (o.status !== 'packed') throw wrongState(o, 'pack it before dispatch');
  const shippedAt = input.shippedAt ? new Date(input.shippedAt) : new Date();
  if (shippedAt.getTime() > Date.now() + 5 * 60_000) throw invalid({ shippedAt: ['Dispatch date cannot be in the future'] });

  const moved = await convert(tx, orderId, actorId, `Web order #${o.number} dispatched (${input.carrier}${input.trackingNo ? ` ${input.trackingNo}` : ''})`);
  if (!moved.length) throw appError(409, 'INVALID_STATE', `Nothing is held for order #${o.number}`);

  const { rows: [conn] } = await tx.query("SELECT 1 FROM woo_connections WHERE status <> 'disconnected'");
  const { rows: [s] } = await tx.query(
    `INSERT INTO shipments (tenant_id, order_id, carrier, service, tracking_no, shipped_at, dispatched_by, woo_update_state, woo_error)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [orderId, input.carrier, input.service || null, input.trackingNo || null, shippedAt, actorId,
      conn ? 'pending' : 'not_needed', conn ? null : 'WooCommerce is not connected; update the order in the shop by hand']);
  await tx.query("UPDATE sales_orders SET status = 'dispatched', updated_at = now() WHERE id = $1", [orderId]);
  const { rows: done } = await tx.query(
    "UPDATE pick_list_lines SET state = 'removed' WHERE order_id = $1 AND state = 'active' RETURNING pick_list_id", [orderId]);
  for (const id of new Set(done.map((r) => r.pick_list_id as string))) await refreshPickList(tx, id);
  await event(tx, orderId, 'dispatched',
    `Dispatched via ${input.carrier}${input.service ? ` ${input.service}` : ''}${input.trackingNo ? `, tracking ${input.trackingNo}` : ''}: reserved stock deducted`, actorId);
  if (conn) await enqueue(tx, 'woo.fulfilment', s.id, { maxAttempts: 12 });
  await audit(tx, { actorId, action: 'order.dispatched', entityType: 'sales_order', entityId: orderId,
    summary: { order: o.number, carrier: input.carrier, trackingNo: input.trackingNo ?? null, lines: moved.length } });
  await invoiceAfterDispatch(tx, orderId, actorId);   // B5: the GST invoice, when the goods leave
}

/** Send the shop update again (after fixing the connection, or when it failed for good). */
export async function retryWebUpdate(tx: Tx, actorId: string, orderId: string) {
  const { rows: [s] } = await tx.query('SELECT id, woo_update_state FROM shipments WHERE order_id = $1', [orderId]);
  if (!s) throw appError(404, 'NOT_FOUND', 'This order has not been dispatched');
  if (s.woo_update_state === 'synced') throw appError(409, 'INVALID_STATE', 'The shop already has this update');
  const { rows: [conn] } = await tx.query("SELECT 1 FROM woo_connections WHERE status <> 'disconnected'");
  if (!conn) throw appError(409, 'NOT_CONNECTED', 'WooCommerce is not connected');
  await tx.query("UPDATE shipments SET woo_update_state = 'pending', woo_error = NULL WHERE id = $1", [s.id]);
  await enqueue(tx, 'woo.fulfilment', s.id, { maxAttempts: 12 });
  await audit(tx, { actorId, action: 'order.web_update_retried', entityType: 'sales_order', entityId: orderId });
}
