import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx, type Tx } from '../../db.js';
import { csvLine } from '../../lib/csv.js';
import { fmtMoney, fmtQty } from '../../lib/decimal.js';
import { STATES } from '../../lib/gst.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { appError, audit, authOf, can, requires } from '../../lib/phase1.js';

// Contacts (v2 batch 2, D96): one page for the store's customers and suppliers, each with what they bought or supplied.
// Adding and editing still go through POST/PATCH /customers (pos.sell) and /suppliers (purchase.manage); this module only
// reads. Viewing everyone's history is owner and manager work (contacts.view): a cashier finds one customer at the till.

const tx = <T>(req: FastifyRequest, fn: (t: Tx) => Promise<T>) => tenantTx(authOf(req).tenantId, fn);
const nameKey = z.tuple([z.string(), z.string().uuid()]);
const timeKey = z.tuple([z.string(), z.string().uuid()]);
const idParam = z.object({ id: z.string().uuid() });
const STATE_LIST = Object.entries(STATES).map(([code, name]) => ({ code, name }));
const like = (q: string) => q.replace(/[%_\\]/g, '\\$&');

const listQuery = z.object({
  type: z.enum(['customer', 'supplier']),
  q: z.string().trim().max(100).default(''),
  includeArchived: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(400).optional(),
}).strict();
const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(400).optional(),
}).strict();

/** Orders that count as a sale. Cancelled and failed web orders never became one. */
const SOLD = `o.status NOT IN ('cancelled', 'failed')`;

const base = (r: Record<string, any>) => ({
  id: r.id as string, name: r.name as string, phone: r.phone as string | null, email: r.email as string | null,
  gstin: r.gstin as string | null, stateCode: r.state_code as string | null, stateName: r.state_code ? STATES[r.state_code] ?? null : null,
  address: r.address as string | null, archived: r.archived_at !== null, createdAt: r.created_at as Date,
});

// ------------------------------------------------------------------ stats, one row per contact
const customerStats = (alias: string) => `
  LEFT JOIN LATERAL (
    SELECT a.*, a.spent - a.returned AS net FROM (
      SELECT count(*)::int AS orders, coalesce(sum(o.total), 0) AS spent, max(o.placed_at) AS last_at,
             coalesce((SELECT sum(cn.total) FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id
                        JOIN sales_orders o2 ON o2.id = i.order_id WHERE o2.customer_id = ${alias}.id), 0) AS returned
        FROM sales_orders o WHERE o.customer_id = ${alias}.id AND ${SOLD}) a) s ON true`;

const supplierStats = (alias: string) => `
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS receipts, max(g.posted_at) AS last_at,
           coalesce((SELECT sum(l.accepted_qty * l.unit_cost) FROM goods_receipt_lines l JOIN goods_receipts g2 ON g2.id = l.receipt_id
                      WHERE g2.supplier_id = ${alias}.id), 0) AS purchased,
           (SELECT count(*)::int FROM purchase_orders p WHERE p.supplier_id = ${alias}.id AND p.status IN ('draft', 'submitted', 'partial')) AS open_pos,
           (SELECT count(*)::int FROM supplier_returns r WHERE r.supplier_id = ${alias}.id) AS returns
      FROM goods_receipts g WHERE g.supplier_id = ${alias}.id) s ON true`;

const customerOut = (r: Record<string, any>) => ({
  ...base(r), type: 'customer' as const, fromWooCommerce: r.woo_customer_id !== null,
  stats: { orders: r.orders as number, spent: fmtMoney(r.spent)!, returned: fmtMoney(r.returned)!, net: fmtMoney(r.net)!, lastAt: r.last_at as Date | null },
});
const supplierOut = (r: Record<string, any>, showCost: boolean) => ({
  ...base(r), type: 'supplier' as const,
  stats: { receipts: r.receipts as number, purchased: showCost ? fmtMoney(r.purchased) : null, openPurchaseOrders: r.open_pos as number, returns: r.returns as number, lastAt: r.last_at as Date | null },
});

async function listContacts(t: Tx, q: z.infer<typeof listQuery>, showCost: boolean) {
  const table = q.type === 'customer' ? 'customers' : 'suppliers';
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.includeArchived === 'false') where.push('archived_at IS NULL');
  if (q.q) {
    params.push(like(q.q), q.q);
    where.push(`(name ILIKE '%' || $1 || '%' OR phone LIKE '%' || $1 || '%' OR gstin = upper($2) OR email ILIKE '%' || $1 || '%')`);
  }
  const after = decodeCursor(q.cursor, nameKey);
  if (after) { params.push(after[0], after[1]); where.push(`(lower(name), id) > ($${params.length - 1}, $${params.length}::uuid)`); }
  params.push(q.limit + 1);
  const { rows } = await t.query(
    `WITH page AS (SELECT * FROM ${table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY lower(name), id LIMIT $${params.length})
     SELECT page.*, s.* FROM page ${q.type === 'customer' ? customerStats('page') : supplierStats('page')} ORDER BY lower(page.name), page.id`, params);
  const more = rows.length > q.limit;
  const items = rows.slice(0, q.limit);
  const last = items[items.length - 1];
  return {
    items: items.map((r) => (q.type === 'customer' ? customerOut(r) : supplierOut(r, showCost))),
    nextCursor: more ? encodeCursor([last.name.toLowerCase(), last.id]) : null,
    states: STATE_LIST,
  };
}

// ------------------------------------------------------------------ history
async function customerHistory(t: Tx, id: string, h: z.infer<typeof historyQuery>) {
  const params: unknown[] = [id];
  let cond = '';
  const after = decodeCursor(h.cursor, timeKey);
  if (after) { params.push(after[0], after[1]); cond = `AND (o.placed_at, o.id) < ($2::timestamptz, $3::uuid)`; }
  params.push(h.limit + 1);
  const { rows } = await t.query(
    `SELECT o.id, o.number, o.channel, o.status, o.payment_method, o.total, o.placed_at,
            i.id AS invoice_id, i.number AS invoice_number,
            coalesce((SELECT sum(cn.total) FROM credit_notes cn WHERE cn.invoice_id = i.id), 0) AS credited,
            EXISTS (SELECT 1 FROM credit_notes cn WHERE cn.invoice_id = i.id AND cn.kind = 'void') AS voided,
            (SELECT count(*)::int FROM sales_order_lines l WHERE l.order_id = o.id) AS lines
       FROM sales_orders o LEFT JOIN invoices i ON i.order_id = o.id
      WHERE o.customer_id = $1 ${cond}
      ORDER BY o.placed_at DESC, o.id DESC LIMIT $${params.length}`, params);
  const more = rows.length > h.limit;
  const items = rows.slice(0, h.limit);
  const last = items[items.length - 1];
  return {
    items: items.map((r) => ({
      id: r.id as string, number: r.number as string, channel: r.channel as string, status: r.status as string,
      paymentMethod: r.payment_method as string | null, total: fmtMoney(r.total)!, at: r.placed_at as Date, lines: r.lines as number,
      invoice: r.invoice_id ? { id: r.invoice_id as string, number: r.invoice_number as string } : null,
      credited: fmtMoney(r.credited)!, voided: r.voided as boolean,
    })),
    nextCursor: more ? encodeCursor([last.placed_at.toISOString(), last.id]) : null,
  };
}

async function supplierHistory(t: Tx, id: string, h: z.infer<typeof historyQuery>, showCost: boolean) {
  const params: unknown[] = [id];
  let cond = '';
  const after = decodeCursor(h.cursor, timeKey);
  if (after) { params.push(after[0], after[1]); cond = `WHERE (at, id) < ($2::timestamptz, $3::uuid)`; }
  params.push(h.limit + 1);
  const { rows } = await t.query(
    `SELECT * FROM (
       SELECT 'receipt' AS kind, g.id, g.number, g.posted_at AS at, g.supplier_invoice_no AS reference, p.number AS po_number,
              (SELECT sum(l.accepted_qty * l.unit_cost) FROM goods_receipt_lines l WHERE l.receipt_id = g.id) AS value,
              (SELECT sum(l.accepted_qty) FROM goods_receipt_lines l WHERE l.receipt_id = g.id) AS qty
         FROM goods_receipts g LEFT JOIN purchase_orders p ON p.id = g.po_id WHERE g.supplier_id = $1
       UNION ALL
       SELECT 'return', r.id, r.number, r.posted_at, r.reason, NULL, NULL,
              (SELECT sum(l.qty) FROM supplier_return_lines l WHERE l.return_id = r.id)
         FROM supplier_returns r WHERE r.supplier_id = $1
     ) h ${cond} ORDER BY at DESC, id DESC LIMIT $${params.length}`, params);
  const more = rows.length > h.limit;
  const items = rows.slice(0, h.limit);
  const last = items[items.length - 1];
  return {
    items: items.map((r) => ({
      kind: r.kind as 'receipt' | 'return', id: r.id as string, number: r.number as string, at: r.at as Date,
      reference: r.reference as string | null, purchaseOrder: r.po_number as string | null,
      qty: fmtQty(r.qty), value: showCost && r.value !== null ? fmtMoney(r.value) : null,
    })),
    nextCursor: more ? encodeCursor([last.at.toISOString(), last.id]) : null,
  };
}

async function one(t: Tx, type: 'customer' | 'supplier', id: string, showCost: boolean) {
  const table = type === 'customer' ? 'customers' : 'suppliers';
  const { rows: [r] } = await t.query(
    `SELECT c.*, s.* FROM ${table} c ${type === 'customer' ? customerStats('c') : supplierStats('c')} WHERE c.id = $1`, [id]);
  if (!r) throw appError(404, 'NOT_FOUND', `${type === 'customer' ? 'Customer' : 'Supplier'} not found`);
  return type === 'customer' ? customerOut(r) : supplierOut(r, showCost);
}

export async function contactRoutes(app: FastifyInstance) {
  const view = { preHandler: requires('contacts.view') };

  app.get('/contacts', view, async (req) => {
    const q = listQuery.parse(req.query);
    return tx(req, (t) => listContacts(t, q, can(req, 'cost.view')));
  });

  for (const type of ['customer', 'supplier'] as const) {
    app.get(`/contacts/${type}s/:id`, view, async (req) => {
      const { id } = idParam.parse(req.params);
      const showCost = can(req, 'cost.view');
      return tx(req, async (t) => {
        const contact = await one(t, type, id, showCost);
        const first = { limit: 25 };
        const history = type === 'customer' ? await customerHistory(t, id, first) : await supplierHistory(t, id, first, showCost);
        return { contact, history, states: STATE_LIST, can: { edit: can(req, type === 'customer' ? 'pos.sell' : 'purchase.manage') } };
      });
    });
    app.get(`/contacts/${type}s/:id/history`, view, async (req) => {
      const { id } = idParam.parse(req.params);
      const h = historyQuery.parse(req.query);
      const showCost = can(req, 'cost.view');
      return tx(req, async (t) => {
        await one(t, type, id, showCost); // 404 for an id from another store or none at all
        return type === 'customer' ? customerHistory(t, id, h) : supplierHistory(t, id, h, showCost);
      });
    });
  }

  // Contact list as CSV. Personal data (phone, email, address) leaves the system here, so it needs both permissions
  // and is audited with the row count, like the product export.
  const exportGuard = [requires('contacts.view'), async (req: FastifyRequest) => {
    if (!can(req, 'report.export')) throw appError(403, 'FORBIDDEN', 'You do not have permission to do this');
  }];
  app.get('/exports/contacts.csv', { preHandler: exportGuard, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const { type } = z.object({ type: z.enum(['customer', 'supplier']) }).strict().parse(req.query);
    const showCost = can(req, 'cost.view');
    const body = await tx(req, async (t) => {
      const { rows } = await t.query(
        `SELECT c.*, s.* FROM ${type === 'customer' ? 'customers' : 'suppliers'} c ${type === 'customer' ? customerStats('c') : supplierStats('c')}
          WHERE c.archived_at IS NULL ORDER BY lower(c.name), c.id`);
      await audit(t, { actorId: authOf(req).userId, action: 'export.contacts', entityType: 'export', summary: { type, rows: rows.length } });
      const head = ['name', 'phone', 'email', 'gstin', 'state', 'address',
        ...(type === 'customer' ? ['orders', 'spent', 'returned', 'last_purchase'] : ['receipts', ...(showCost ? ['purchased'] : []), 'open_purchase_orders', 'last_receipt'])];
      return '﻿' + csvLine(head) + rows.map((r) => {
        const c = type === 'customer' ? customerOut(r) : supplierOut(r, showCost);
        const s = c.stats as Record<string, unknown>;
        const last = c.stats.lastAt ? new Date(c.stats.lastAt).toISOString().slice(0, 10) : '';
        return csvLine([c.name, c.phone, c.email, c.gstin, c.stateName, c.address,
          ...(type === 'customer' ? [s.orders, s.spent, s.returned, last] : [s.receipts, ...(showCost ? [s.purchased] : []), s.openPurchaseOrders, last])]);
      }).join('');
    });
    return reply.headers({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${type}s-${new Date().toISOString().slice(0, 10)}.csv"`, 'cache-control': 'no-store' }).send(body);
  });
}
