// The reports (PRD 8, B6). Each is one SQL query; the route runs it for rows and again for totals, so totals always cover
// every row even when the screen shows only the first 500. Nothing here is called profit: the ERP knows prices and
// purchase costs, not the store's overheads.
//
// Dates are the store's own calendar days (tenants.timezone). Columns marked `cost` appear only with cost.view.

import { locIn, seriesIn, type Scope } from '../outlets/scope.js';

export type ColType = 'text' | 'qty' | 'money' | 'int';
export interface Col { key: string; label: string; type: ColType; cost?: boolean; total?: boolean }
export interface Ctx { from: string; to: string; tz: string; locationId: string | null; /** v2 (D115): the outlet in view */ scope: Scope }
export type Param = (v: unknown) => string;

export interface ReportDef {
  title: string;
  description: string;
  /** Needed on top of report.view. */
  extra?: 'invoice.read' | 'sync.manage';
  dated: boolean;
  location: boolean;
  columns: Col[];
  /** SELECT … producing the columns' keys (and any `_`-prefixed sort keys). */
  sql: (c: Ctx, p: Param) => string;
  order: string;
}

/** `col` falls within the store's from…to days, inclusive, in its own timezone. Index friendly (no function on col). */
const within = (col: string, c: Ctx, p: Param) =>
  `${col} >= (${p(c.from)}::date::timestamp AT TIME ZONE ${p(c.tz)}) AND ${col} < ((${p(c.to)}::date + 1)::timestamp AT TIME ZONE ${p(c.tz)})`;
const localTime = (col: string, c: Ctx, p: Param, fmt = 'YYYY-MM-DD HH24:MI') => `to_char(${col} AT TIME ZONE ${p(c.tz)}, '${fmt}')`;
const atLocation = (col: string, c: Ctx, p: Param) => `(${p(c.locationId)}::uuid IS NULL OR ${col} = ${p(c.locationId)}::uuid) AND ${locIn(c.scope, col, p)}`;
const LIVE = "v.status = 'active' AND p.status <> 'archived'";

export const REPORTS: Record<string, ReportDef> = {
  'inventory-summary': {
    title: 'Inventory summary',
    description: 'Stock of every active item now. Value is on hand × current average cost; negative stock counts as zero.',
    dated: false, location: true,
    columns: [
      { key: 'sku', label: 'SKU', type: 'text' }, { key: 'product', label: 'Product', type: 'text' },
      { key: 'category', label: 'Category', type: 'text' },
      { key: 'on_hand', label: 'On hand', type: 'qty' }, { key: 'reserved', label: 'Reserved', type: 'qty' },
      { key: 'available', label: 'Available', type: 'qty' }, { key: 'non_sellable', label: 'Damaged / quarantined', type: 'qty' },
      { key: 'unit_cost', label: 'Average cost', type: 'money', cost: true },
      { key: 'value', label: 'Stock value', type: 'money', cost: true, total: true },
    ],
    sql: (c, p) => `
      SELECT v.sku, p.name AS product, cat.name AS category,
             coalesce(sum(b.on_hand), 0) AS on_hand, coalesce(sum(b.reserved), 0) AS reserved,
             coalesce(sum(b.on_hand - b.reserved) FILTER (WHERE l.is_sellable AND l.active), 0) AS available,
             coalesce(sum(b.non_sellable), 0) AS non_sellable, v.cost AS unit_cost,
             round(greatest(coalesce(sum(b.on_hand), 0), 0) * v.cost, 2) AS value
        FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN categories cat ON cat.id = p.category_id
        LEFT JOIN stock_balances b ON b.variant_id = v.id AND ${atLocation('b.location_id', c, p)}
        LEFT JOIN locations l ON l.id = b.location_id
       WHERE ${LIVE}
       GROUP BY v.id, p.id, cat.name`,
    order: 'lower(product), lower(sku)',
  },

  'low-stock': {
    title: 'Low stock',
    description: 'Items at or below their reorder level, counting only sellable locations. "On order" is what open purchase orders still expect.',
    dated: false, location: true,
    columns: [
      { key: 'sku', label: 'SKU', type: 'text' }, { key: 'product', label: 'Product', type: 'text' },
      { key: 'available', label: 'Available', type: 'qty' }, { key: 'reorder_level', label: 'Reorder level', type: 'qty' },
      { key: 'short_by', label: 'Short by', type: 'qty' }, { key: 'on_order', label: 'On order', type: 'qty' },
    ],
    sql: (c, p) => `
      SELECT v.sku, p.name AS product, s.available, v.reorder_level, v.reorder_level - s.available AS short_by,
             coalesce((SELECT sum(greatest(pl.ordered_qty - pl.received_qty, 0)) FROM purchase_order_lines pl
                         JOIN purchase_orders po ON po.id = pl.po_id
                        WHERE pl.variant_id = v.id AND po.status IN ('submitted', 'partial')), 0) AS on_order
        FROM product_variants v JOIN products p ON p.id = v.product_id
        CROSS JOIN LATERAL (SELECT coalesce(sum(b.on_hand - b.reserved), 0) AS available
                              FROM stock_balances b JOIN locations l ON l.id = b.location_id
                             WHERE b.variant_id = v.id AND l.is_sellable AND l.active AND ${atLocation('b.location_id', c, p)}) s
       WHERE ${LIVE} AND v.reorder_level IS NOT NULL AND s.available <= v.reorder_level`,
    order: 'short_by DESC, lower(product), lower(sku)',
  },

  'stock-movements': {
    title: 'Stock movements',
    description: 'Every change to stock, newest first, from the ledger.',
    dated: true, location: true,
    columns: [
      { key: 'at', label: 'When', type: 'text' }, { key: 'sku', label: 'SKU', type: 'text' }, { key: 'product', label: 'Product', type: 'text' },
      { key: 'location', label: 'Location', type: 'text' }, { key: 'movement', label: 'Movement', type: 'text' },
      { key: 'bucket', label: 'Bucket', type: 'text' }, { key: 'qty', label: 'Change', type: 'qty' },
      { key: 'balance_after', label: 'Balance after', type: 'qty' }, { key: 'reason', label: 'Reason', type: 'text' },
      { key: 'note', label: 'Note', type: 'text' }, { key: 'posted_by', label: 'By', type: 'text' },
      { key: 'unit_cost', label: 'Unit cost', type: 'money', cost: true },
    ],
    sql: (c, p) => `
      SELECT ${localTime('m.posted_at', c, p)} AS at, m.posted_at AS _at, m.seq AS _seq, v.sku, p.name AS product, l.name AS location,
             replace(m.movement_type, '_', ' ') AS movement, m.bucket, m.qty_delta AS qty, m.balance_after, m.reason_code AS reason,
             m.note, u.name AS posted_by, m.unit_cost
        FROM stock_ledger m JOIN product_variants v ON v.id = m.variant_id JOIN products p ON p.id = v.product_id
        JOIN locations l ON l.id = m.location_id LEFT JOIN users u ON u.id = m.posted_by
       WHERE ${within('m.posted_at', c, p)} AND ${atLocation('m.location_id', c, p)}`,
    order: '_at DESC, _seq DESC',
  },

  'stocktake-variance': {
    title: 'Stocktake variance',
    description: 'Counted minus expected for every posted stocktake closed in the period, leaving out sales made during the count. Value uses the current average cost.',
    dated: true, location: true,
    columns: [
      { key: 'stocktake', label: 'Stocktake', type: 'text' }, { key: 'closed', label: 'Posted', type: 'text' },
      { key: 'location', label: 'Location', type: 'text' }, { key: 'sku', label: 'SKU', type: 'text' }, { key: 'product', label: 'Product', type: 'text' },
      { key: 'expected', label: 'Expected', type: 'qty' }, { key: 'moved', label: 'Moved during count', type: 'qty' },
      { key: 'counted', label: 'Counted', type: 'qty' }, { key: 'variance', label: 'Variance', type: 'qty' },
      { key: 'variance_value', label: 'Variance value', type: 'money', cost: true, total: true },
    ],
    sql: (c, p) => `
      SELECT st.number AS stocktake, ${localTime('st.closed_at', c, p, 'YYYY-MM-DD')} AS closed, st.closed_at AS _at, l.name AS location,
             v.sku, p.name AS product, sl.expected_qty AS expected, coalesce(sl.moved_during_count, 0) AS moved, sl.counted_qty AS counted,
             sl.counted_qty - sl.expected_qty - coalesce(sl.moved_during_count, 0) AS variance,
             round((sl.counted_qty - sl.expected_qty - coalesce(sl.moved_during_count, 0)) * v.cost, 2) AS variance_value
        FROM stocktakes st JOIN stocktake_lines sl ON sl.stocktake_id = st.id JOIN locations l ON l.id = st.location_id
        JOIN product_variants v ON v.id = sl.variant_id JOIN products p ON p.id = v.product_id
       WHERE st.status = 'posted' AND sl.counted_qty IS NOT NULL
         AND sl.counted_qty - sl.expected_qty - coalesce(sl.moved_during_count, 0) <> 0
         AND ${within('st.closed_at', c, p)} AND ${atLocation('st.location_id', c, p)}`,
    order: '_at DESC, stocktake, lower(product), lower(sku)',
  },

  purchasing: {
    title: 'Purchasing',
    description: 'Purchase orders raised in the period: ordered, received and accepted quantities, and their value at the PO cost. Purchase orders are for the whole store, so this report shows every outlet.',
    dated: true, location: false,
    columns: [
      { key: 'po', label: 'PO', type: 'text' }, { key: 'date', label: 'Raised', type: 'text' }, { key: 'supplier', label: 'Supplier', type: 'text' },
      { key: 'status', label: 'Status', type: 'text' }, { key: 'expected', label: 'Expected', type: 'text' },
      { key: 'ordered', label: 'Ordered', type: 'qty' }, { key: 'received', label: 'Received', type: 'qty' }, { key: 'accepted', label: 'Accepted', type: 'qty' },
      { key: 'ordered_value', label: 'Ordered value', type: 'money', cost: true, total: true },
      { key: 'accepted_value', label: 'Accepted value', type: 'money', cost: true, total: true },
    ],
    sql: (c, p) => `
      SELECT po.number AS po, ${localTime('po.created_at', c, p, 'YYYY-MM-DD')} AS date, po.created_at AS _at, s.name AS supplier, po.status,
             to_char(po.expected_date, 'YYYY-MM-DD') AS expected,
             coalesce(sum(pl.ordered_qty), 0) AS ordered, coalesce(sum(pl.received_qty), 0) AS received, coalesce(sum(pl.accepted_qty), 0) AS accepted,
             coalesce(round(sum(pl.ordered_qty * pl.unit_cost), 2), 0) AS ordered_value, coalesce(round(sum(pl.accepted_qty * pl.unit_cost), 2), 0) AS accepted_value
        FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN purchase_order_lines pl ON pl.po_id = po.id
       WHERE ${within('po.created_at', c, p)}
       GROUP BY po.id, s.name`,
    order: '_at DESC, po',
  },

  sales: {
    title: 'Sales',
    description: 'Invoiced and credited per day and channel, from issued GST documents (voids and returns are credits). Not profit.',
    extra: 'invoice.read', dated: true, location: false,
    columns: [
      { key: 'day', label: 'Day', type: 'text' }, { key: 'channel', label: 'Channel', type: 'text' },
      { key: 'invoices', label: 'Invoices', type: 'int', total: true }, { key: 'credit_notes', label: 'Credit notes', type: 'int', total: true },
      { key: 'invoiced', label: 'Invoiced', type: 'money', total: true }, { key: 'credited', label: 'Credited', type: 'money', total: true },
      { key: 'net_sales', label: 'Net sales', type: 'money', total: true },
      { key: 'net_taxable', label: 'Net taxable value', type: 'money', total: true }, { key: 'net_tax', label: 'Net GST', type: 'money', total: true },
    ],
    sql: (c, p) => `
      WITH docs AS (
        SELECT i.issued_at AS at, o.channel, 1 AS inv, 0 AS cn, i.total AS invoiced, 0 AS credited, i.taxable_total AS taxable,
               i.cgst + i.sgst + i.igst + i.cess AS tax
          FROM invoices i JOIN sales_orders o ON o.id = i.order_id WHERE ${within('i.issued_at', c, p)} AND ${seriesIn(c.scope, 'i.series_id', p)}
        UNION ALL
        SELECT cn.issued_at, o.channel, 0, 1, 0, cn.total, -cn.taxable_total, -(cn.cgst + cn.sgst + cn.igst + cn.cess)
          FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id JOIN sales_orders o ON o.id = i.order_id
         WHERE ${within('cn.issued_at', c, p)} AND ${seriesIn(c.scope, 'cn.series_id', p)})
      SELECT to_char((at AT TIME ZONE ${p(c.tz)})::date, 'YYYY-MM-DD') AS day,
             CASE channel WHEN 'pos' THEN 'Counter' ELSE 'Website' END AS channel,
             sum(inv)::int AS invoices, sum(cn)::int AS credit_notes, sum(invoiced) AS invoiced, sum(credited) AS credited,
             sum(invoiced) - sum(credited) AS net_sales, sum(taxable) AS net_taxable, sum(tax) AS net_tax
        FROM docs GROUP BY 1, 2`,
    order: 'day DESC, channel',
  },

  'sync-health': {
    title: 'Sync health',
    description: 'WooCommerce jobs that failed or are retrying, and webhooks that could not be processed. For the whole store.',
    extra: 'sync.manage', dated: true, location: false,
    columns: [
      { key: 'at', label: 'When', type: 'text' }, { key: 'source', label: 'Source', type: 'text' }, { key: 'what', label: 'What', type: 'text' },
      { key: 'status', label: 'Status', type: 'text' }, { key: 'attempts', label: 'Attempts', type: 'int' }, { key: 'error', label: 'Last error', type: 'text' },
    ],
    sql: (c, p) => `
      SELECT ${localTime('j.created_at', c, p)} AS at, j.created_at AS _at, 'Job' AS source,
             CASE j.kind WHEN 'woo.product' THEN 'Publish product' WHEN 'woo.stock' THEN 'Stock to website' WHEN 'woo.inbound' THEN 'Incoming order'
                         WHEN 'woo.reconcile' THEN 'Reconcile' WHEN 'woo.match' THEN 'SKU match' WHEN 'woo.fulfilment' THEN 'Dispatch update'
                         WHEN 'import' THEN 'CSV import' ELSE j.kind END AS what,
             CASE j.status WHEN 'dead' THEN 'gave up' WHEN 'pending' THEN 'retrying' ELSE j.status END AS status, j.attempts, j.last_error AS error
        FROM sync_jobs j
       WHERE (j.status IN ('failed', 'dead') OR (j.status = 'pending' AND j.attempts > 0)) AND ${within('j.created_at', c, p)}
      UNION ALL
      SELECT ${localTime('w.received_at', c, p)}, w.received_at, 'Webhook', w.topic, w.status, NULL, w.last_error
        FROM webhook_events w WHERE w.status = 'failed' AND ${within('w.received_at', c, p)}`,
    order: '_at DESC',
  },
};
