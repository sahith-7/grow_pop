import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx, type Tx } from '../../db.js';
import { fmtMoney, fmtQty } from '../../lib/decimal.js';
import { decodeCursor, encodeCursor, limitParam } from '../../lib/pagination.js';
import { appError, audit, authOf, can, requires } from '../../lib/phase1.js';
import { STATES } from '../../lib/gst.js';
import { WEB_UPDATE_SQL } from '../fulfilment/service.js';
import { invoiceWebOrder } from './web-invoice.js';
import { settleStock } from './woo-orders.js';

// Web orders (B4) and POS sales (B5, channel 'pos'). Pick, pack and dispatch are in modules/fulfilment (B6).

const STATUSES = ['awaiting_payment', 'on_hold', 'stock_exception', 'ready_to_pick', 'picking', 'packed', 'dispatched', 'completed', 'cancelled', 'failed', 'refunded', 'needs_review'] as const;
const listQuery = z.object({
  channel: z.enum(['pos', 'woocommerce']).optional(),
  status: z.enum([...STATUSES, 'attention']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: limitParam, cursor: z.string().optional(),
}).strict();
const idParam = z.object({ id: z.string().uuid() });
const mapLineInput = z.object({ lineId: z.string().uuid(), variantId: z.string().uuid() }).strict();
const invoiceInput = z.object({ placeOfSupply: z.string().refine((v) => !!STATES[v], 'Pick a state').optional() }).strict();

const tx = <T>(req: FastifyRequest, fn: (t: Tx) => Promise<T>) => tenantTx(authOf(req).tenantId, fn);

const summary = (r: Record<string, any>) => ({
  id: r.id as string, number: r.number as string, channel: r.channel as string, externalId: r.external_id as string | null,
  wooStatus: r.woo_status as string | null, status: r.status as string, paymentState: r.payment_state as string,
  paymentMethod: r.payment_method as string | null, exceptionReason: r.exception_reason as string | null,
  customerName: (r.customer_snapshot?.name as string) || null, itemCount: Number(r.item_count ?? 0),
  total: fmtMoney(r.total), currency: r.currency as string, placedAt: r.placed_at as Date,
});

export async function detail(t: Tx, id: string) {
  const { rows: [o] } = await t.query(
    `SELECT o.*, (SELECT coalesce(sum(qty), 0) FROM sales_order_lines l WHERE l.order_id = o.id) AS item_count FROM sales_orders o WHERE o.id = $1`, [id]);
  if (!o) throw appError(404, 'NOT_FOUND', 'Order not found');
  const { rows: lines } = await t.query(
    `SELECT l.*, v.sku AS erp_sku, p.name AS product_name, v.attributes,
            (SELECT r.state FROM stock_reservations r WHERE r.order_line_id = l.id ORDER BY r.created_at DESC LIMIT 1) AS reservation,
            (SELECT loc.name FROM stock_reservations r JOIN locations loc ON loc.id = r.location_id WHERE r.order_line_id = l.id ORDER BY r.created_at DESC LIMIT 1) AS location_name
       FROM sales_order_lines l LEFT JOIN product_variants v ON v.id = l.variant_id LEFT JOIN products p ON p.id = v.product_id
      WHERE l.order_id = $1 ORDER BY l.position`, [id]);
  const { rows: docs } = await t.query(
    `SELECT i.id, i.number, 'invoice' AS type, i.total, i.issued_at FROM invoices i WHERE i.order_id = $1
     UNION ALL
     SELECT c.id, c.number, 'credit_note', c.total, c.issued_at FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id WHERE i.order_id = $1
     ORDER BY issued_at`, [id]);
  const { rows: pays } = await t.query('SELECT kind, method, amount, reference, recorded_at FROM payments WHERE order_id = $1 ORDER BY recorded_at, kind', [id]);
  const { rows: [ship] } = await t.query(
    `SELECT s.*, ${WEB_UPDATE_SQL} AS web_update, u.name AS dispatched_by_name FROM shipments s LEFT JOIN users u ON u.id = s.dispatched_by
      WHERE s.order_id = $1`, [id]);
  const { rows: [pick] } = await t.query(
    `SELECT p.id, p.number FROM pick_list_lines l JOIN pick_lists p ON p.id = l.pick_list_id WHERE l.order_id = $1 AND l.state = 'active' LIMIT 1`, [id]);
  const { rows: events } = await t.query(
    `SELECT e.kind, e.message, e.created_at, u.name AS actor FROM sales_order_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.order_id = $1 ORDER BY e.id`, [id]);
  return {
    ...summary(o),
    customer: o.customer_snapshot,
    totals: { subtotal: fmtMoney(o.subtotal), discount: fmtMoney(o.discount_total), shipping: fmtMoney(o.shipping_total), tax: fmtMoney(o.tax_total), total: fmtMoney(o.total) },
    lines: lines.map((l) => ({
      id: l.id as string, variantId: l.variant_id as string | null, sku: l.sku as string, name: l.name as string,
      erp: l.variant_id ? { sku: l.erp_sku as string, name: l.product_name as string, attributes: l.attributes } : null,
      qty: fmtQty(l.qty), unitPrice: fmtMoney(l.unit_price), lineTotal: fmtMoney(l.line_total),
      reservation: l.reservation as string | null, location: l.location_name as string | null,
    })),
    events: events.map((e) => ({ kind: e.kind, message: e.message, at: e.created_at, actor: e.actor })),
    packedAt: o.packed_at as Date | null,
    pickList: pick ? { id: pick.id as string, number: pick.number as string } : null,
    shipment: ship ? {
      carrier: ship.carrier as string, service: ship.service as string | null, trackingNo: ship.tracking_no as string | null,
      shippedAt: ship.shipped_at as Date, dispatchedBy: ship.dispatched_by_name as string | null,
      webUpdate: ship.web_update as string, webError: ship.woo_error as string | null, webSyncedAt: ship.woo_synced_at as Date | null,
    } : null,
    invoiceState: o.invoice_state as string | null,
    invoiceNote: o.invoice_note as string | null,
    documents: docs.map((d) => ({ id: d.id as string, number: d.number as string, type: d.type as string, total: fmtMoney(d.total), issuedAt: d.issued_at as Date })),
    payments: pays.map((x) => ({ kind: x.kind as string, method: x.method as string, amount: fmtMoney(x.amount), reference: x.reference as string | null, at: x.recorded_at as Date })),
  };
}

async function resettle(t: Tx, id: string, userId: string) {
  const { rows: [o] } = await t.query("SELECT id, external_id, woo_status, status FROM sales_orders WHERE id = $1 AND channel = 'woocommerce'", [id]);
  if (!o) throw appError(404, 'NOT_FOUND', 'Order not found');
  await t.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7))', [`woo-order:${o.external_id}`]);
  const { rows: [c] } = await t.query("SELECT online_location_id FROM woo_connections WHERE status <> 'disconnected'");
  if (!c) throw appError(409, 'NOT_CONNECTED', 'WooCommerce is not connected');
  await settleStock(t, id, c.online_location_id, o.woo_status, o.status, userId);
  return o;
}

export async function salesRoutes(app: FastifyInstance) {
  app.get('/orders', { preHandler: requires('order.read') }, async (req) => {
    const q = listQuery.parse(req.query);
    const after = decodeCursor(q.cursor, z.tuple([z.string(), z.string().uuid()]));
    return tx(req, async (t) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
      if (q.channel) add('o.channel = ?', q.channel);
      if (q.status === 'attention') where.push("o.status IN ('stock_exception', 'needs_review')");
      else if (q.status) add('o.status = ?', q.status);
      if (q.q) add(`(o.number ILIKE '%' || ? || '%' OR o.customer_snapshot->>'phone' LIKE '%' || ? || '%' OR o.customer_snapshot->>'name' ILIKE '%' || ? || '%')`,
        q.q.replace(/[%_\\]/g, '\\$&'));
      if (after) { params.push(after[0], after[1]); where.push(`(o.placed_at, o.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`); }
      params.push(q.limit + 1);
      const { rows } = await t.query(
        `SELECT o.*, (SELECT coalesce(sum(qty), 0) FROM sales_order_lines l WHERE l.order_id = o.id) AS item_count
           FROM sales_orders o ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.placed_at DESC, o.id DESC LIMIT $${params.length}`, params);
      const page = rows.slice(0, q.limit);
      const { rows: [counts] } = await t.query(
        "SELECT count(*) FILTER (WHERE status IN ('stock_exception', 'needs_review'))::int AS attention, count(*) FILTER (WHERE status = 'ready_to_pick')::int AS ready FROM sales_orders");
      return {
        items: page.map(summary),
        counts,
        nextCursor: rows.length > q.limit ? encodeCursor([page[page.length - 1].placed_at.toISOString(), page[page.length - 1].id]) : null,
        can: { fulfil: can(req, 'order.fulfil'), mapLines: can(req, 'product.write') },
      };
    });
  });

  app.get('/orders/:id', { preHandler: requires('order.read') }, async (req) => {
    const { id } = idParam.parse(req.params);
    return { ...(await tx(req, (t) => detail(t, id))), can: { fulfil: can(req, 'order.fulfil'), mapLines: can(req, 'product.write'), issueInvoice: can(req, 'order.fulfil') && can(req, 'invoice.read') } };
  });

  // Stock arrived for an order on a stock exception: try to hold it now.
  app.post('/orders/:id/retry-reservation', { preHandler: requires('order.fulfil') }, async (req) => {
    const { id } = idParam.parse(req.params);
    return tx(req, async (t) => {
      const { rows: [o] } = await t.query('SELECT status FROM sales_orders WHERE id = $1', [id]);
      if (!o) throw appError(404, 'NOT_FOUND', 'Order not found');
      if (o.status !== 'stock_exception' && o.status !== 'needs_review') throw appError(409, 'INVALID_STATE', 'This order is not waiting for stock');
      await resettle(t, id, authOf(req).userId);
      return detail(t, id);
    });
  });

  // B5: a completed web order whose invoice could not be issued automatically (settings missing, unknown state, …).
  app.post('/orders/:id/invoice', { preHandler: requires('order.fulfil') }, async (req) => {
    // Issuing a tax document also needs invoice.read: owner and manager, not the fulfilment role.
    if (!can(req, 'invoice.read')) throw appError(403, 'FORBIDDEN', 'You are not allowed to issue invoices');
    const { id } = idParam.parse(req.params);
    const input = invoiceInput.parse(req.body ?? {});
    return tx(req, async (t) => {
      const { rows: [o] } = await t.query('SELECT status, channel, external_id FROM sales_orders WHERE id = $1', [id]);
      if (!o) throw appError(404, 'NOT_FOUND', 'Order not found');
      if (o.channel !== 'woocommerce' || !['dispatched', 'completed', 'refunded', 'needs_review'].includes(o.status)) throw appError(409, 'INVALID_STATE', 'Only web orders whose goods have left the shop are invoiced');
      const { rows: [moved] } = await t.query("SELECT 1 FROM stock_reservations WHERE order_id = $1 AND state = 'converted' LIMIT 1", [id]);
      if (!moved) throw appError(409, 'INVALID_STATE', 'The stock for this order has not left the shop yet');
      await t.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7))', [`woo-order:${o.external_id}`]);   // same lock as a webhook for this order
      const { rows: [has] } = await t.query('SELECT number FROM invoices WHERE order_id = $1', [id]);
      if (has) throw appError(409, 'ALREADY_INVOICED', `This order already has invoice ${has.number}`);
      const r = await invoiceWebOrder(t, id, authOf(req).userId, { placeOfSupply: input.placeOfSupply });
      if (r.state !== 'issued') throw appError(409, 'INVOICE_NOT_ISSUED', r.note);
      await audit(t, { actorId: authOf(req).userId, action: 'invoice.issued_manually', entityType: 'sales_order', entityId: id, summary: { invoice: r.number } });
      return detail(t, id);
    });
  });

  // A line whose Woo SKU matched nothing: say which ERP item it is, then reserve again.
  app.post('/orders/:id/map-line', { preHandler: requires('product.write') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = mapLineInput.parse(req.body);
    return tx(req, async (t) => {
      const { rows: [l] } = await t.query('SELECT id, variant_id, sku FROM sales_order_lines WHERE id = $1 AND order_id = $2 FOR UPDATE', [input.lineId, id]);
      if (!l) throw appError(404, 'NOT_FOUND', 'Order line not found');
      if (l.variant_id) throw appError(409, 'INVALID_STATE', 'This line is already matched to a product');
      const { rows: [v] } = await t.query("SELECT v.id, v.sku FROM product_variants v WHERE v.id = $1 AND v.status = 'active'", [input.variantId]);
      if (!v) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { variantId: ['Pick an active product'] });
      await t.query('UPDATE sales_order_lines SET variant_id = $2 WHERE id = $1', [l.id, v.id]);
      await audit(t, { actorId: authOf(req).userId, action: 'order.line_mapped', entityType: 'sales_order', entityId: id, summary: { wooSku: l.sku, erpSku: v.sku } });
      await resettle(t, id, authOf(req).userId);
      return detail(t, id);
    });
  });
}
