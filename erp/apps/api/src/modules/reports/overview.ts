import { locIn, orderIn, pusher, scopeOut, type Scope } from '../outlets/scope.js';
import type { FastifyRequest } from 'fastify';
import type { Tx } from '../../db.js';
import { fmtMoney, fmtQty } from '../../lib/decimal.js';
import { appError, can } from '../../lib/phase1.js';

// v2 (D90): the dashboard Overview. Numbers for a date range, one location and one sales channel, each compared with the
// same number of days just before. Every figure is left out when the user's role may not see what it counts.
// Money figures are rupees as strings; deltas are percentages (null when the earlier period was zero).

export interface OverviewQuery { from: string; to: string; locationId?: string; channel?: 'pos' | 'woocommerce'; /** v2 (D115) */ scope: Scope }

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
const n = (v: unknown) => Number(v ?? 0);
const pct = (now: number, before: number) => (before === 0 ? null : Math.round(((now - before) / Math.abs(before)) * 10_000) / 100);

interface Range { from: string; to: string }

/** `col` falls inside the store's days from…to (inclusive), in its own timezone. $1 is always the timezone. */
const inRange = (col: string, a: string, b: string) => `${col} >= (${a}::date::timestamp AT TIME ZONE $1) AND ${col} < ((${b}::date + 1)::timestamp AT TIME ZONE $1)`;

async function salesFigures(t: Tx, tz: string, r: Range, q: OverviewQuery, withCost: boolean) {
  const params: unknown[] = [tz, r.from, r.to];
  const filters: string[] = [];
  if (q.locationId) { params.push(q.locationId); filters.push(`o.location_id = $${params.length}`); }
  filters.push(orderIn(q.scope, 'o', pusher(params)));
  if (q.channel) { params.push(q.channel); filters.push(`o.channel = $${params.length}`); }
  const f = filters.map((x) => ` AND ${x}`).join('');
  const { rows: [s] } = await t.query(
    `SELECT count(*)::int AS invoices, coalesce(sum(i.total), 0) AS sales,
            count(DISTINCT coalesce(o.customer_id::text, nullif(o.customer_snapshot->>'phone', '')))::int AS customers
       FROM invoices i JOIN sales_orders o ON o.id = i.order_id
      WHERE ${inRange('i.issued_at', '$2', '$3')}${f}`, params);
  const { rows: [l] } = await t.query(
    `SELECT coalesce(sum(l.qty), 0) AS qty, coalesce(sum(l.taxable_value), 0) AS taxable,
            coalesce(sum(l.taxable_value) FILTER (WHERE v.cost IS NOT NULL), 0) AS costed_taxable,
            coalesce(sum(l.qty * v.cost) FILTER (WHERE v.cost IS NOT NULL), 0) AS cogs,
            count(*) FILTER (WHERE v.cost IS NULL)::int AS uncosted
       FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id JOIN sales_orders o ON o.id = i.order_id
       LEFT JOIN product_variants v ON v.id = l.variant_id
      WHERE l.kind = 'item' AND ${inRange('i.issued_at', '$2', '$3')}${f}`, params);
  const { rows: [c] } = await t.query(
    `SELECT count(*)::int AS notes, coalesce(sum(c.total), 0) AS total
       FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id JOIN sales_orders o ON o.id = i.order_id
      WHERE ${inRange('c.issued_at', '$2', '$3')}${f}`, params);
  const sales = n(s.sales);
  const margin = n(l.costed_taxable) - n(l.cogs);
  return {
    sales, invoices: s.invoices as number, soldQty: n(l.qty), customers: s.customers as number,
    salesReturns: n(c.total), creditNotes: c.notes as number,
    avgCart: s.invoices ? sales / s.invoices : 0,
    ...(withCost ? { margin, marginPct: n(l.costed_taxable) ? (margin / n(l.costed_taxable)) * 100 : 0, uncostedLines: l.uncosted as number } : {}),
  };
}

async function purchaseFigures(t: Tx, tz: string, r: Range, q: OverviewQuery, withCost: boolean) {
  const params: unknown[] = [tz, r.from, r.to];
  let f = '';
  if (q.locationId) { params.push(q.locationId); f = ` AND l.location_id = $${params.length}`; }
  f += ` AND ${locIn(q.scope, 'l.location_id', pusher(params))}`;
  const { rows: [p] } = await t.query(
    `SELECT count(DISTINCT g.id)::int AS bills, coalesce(sum(l.accepted_qty * l.unit_cost), 0) AS value
       FROM goods_receipts g JOIN goods_receipt_lines l ON l.receipt_id = g.id
      WHERE ${inRange('g.posted_at', '$2', '$3')}${f}`, params);
  const { rows: [rt] } = await t.query(
    `SELECT count(DISTINCT sr.id)::int AS returns, coalesce(sum(l.qty * v.cost), 0) AS value
       FROM supplier_returns sr JOIN supplier_return_lines l ON l.return_id = sr.id JOIN product_variants v ON v.id = l.variant_id
      WHERE ${inRange('sr.posted_at', '$2', '$3')}${f}`, params);
  return { bills: p.bills as number, purchaseReturns: rt.returns as number, ...(withCost ? { purchases: n(p.value), purchaseReturnValue: n(rt.value) } : {}) };
}

async function paymentFigures(t: Tx, tz: string, r: Range, q: OverviewQuery) {
  const params: unknown[] = [tz, r.from, r.to];
  const filters: string[] = [];
  if (q.locationId) { params.push(q.locationId); filters.push(`o.location_id = $${params.length}`); }
  filters.push(orderIn(q.scope, 'o', pusher(params)));
  if (q.channel) { params.push(q.channel); filters.push(`o.channel = $${params.length}`); }
  const { rows } = await t.query(
    `SELECT p.method, coalesce(sum(p.amount) FILTER (WHERE p.kind = 'payment'), 0) - coalesce(sum(p.amount) FILTER (WHERE p.kind = 'refund'), 0) AS net
       FROM payments p JOIN sales_orders o ON o.id = p.order_id
      WHERE ${inRange('p.recorded_at', '$2', '$3')}${filters.map((x) => ` AND ${x}`).join('')}
      GROUP BY p.method ORDER BY p.method`, params);
  return rows.map((x) => ({ method: x.method as string, amount: n(x.net) }));
}

export async function overview(t: Tx, req: FastifyRequest, tz: string, today: string, q: OverviewQuery) {
  if (q.from > q.to) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { from: ['Must be on or before the end date'] });
  const span = days(q.from, q.to);
  if (span > 366) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { from: ['At most 366 days at a time'] });
  if (q.locationId) {
    const { rows: [l] } = await t.query('SELECT 1 FROM locations WHERE id = $1', [q.locationId]);
    if (!l) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { locationId: ['Unknown location'] });
    if (q.scope.locs && !q.scope.locs.includes(q.locationId)) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { locationId: [`This stock room isn't at ${q.scope.outlet?.name ?? 'your outlets'}`] });
  }
  const cost = can(req, 'cost.view');
  const cur: Range = { from: q.from, to: q.to };
  const prev: Range = { from: addDays(q.from, -span), to: addDays(q.from, -1) };
  const out: Record<string, unknown> = { from: q.from, to: q.to, previous: prev, today, lastSyncedAt: new Date().toISOString(), ...scopeOut(q.scope) };
  const tiles: { key: string; label: string; value: string; kind: 'money' | 'count' | 'qty' | 'percent'; delta: number | null; href?: string }[] = [];
  const money = (v: number) => fmtMoney(v.toFixed(2))!;

  // Locations for the filter: names only, every signed-in user may pick one.
  const lp: unknown[] = [];
  const { rows: locs } = await t.query(`SELECT id, name FROM locations WHERE active AND ${locIn(q.scope, 'id', pusher(lp))} ORDER BY name`, lp);
  out.locations = locs.map((l) => ({ id: l.id as string, name: l.name as string }));

  if (can(req, 'invoice.read')) {
    const a = await salesFigures(t, tz, cur, q, cost);
    const b = await salesFigures(t, tz, prev, q, cost);
    tiles.push(
      { key: 'sales', label: 'Total sales', value: money(a.sales), kind: 'money', delta: pct(a.sales, b.sales), href: '/invoices' },
      { key: 'invoices', label: 'Total invoices', value: String(a.invoices), kind: 'count', delta: pct(a.invoices, b.invoices), href: '/invoices' },
      { key: 'soldQty', label: 'Sold quantity', value: fmtQty(a.soldQty.toFixed(3))!, kind: 'qty', delta: pct(a.soldQty, b.soldQty) },
      { key: 'customers', label: 'Customers billed', value: String(a.customers), kind: 'count', delta: pct(a.customers, b.customers) },
      { key: 'salesReturns', label: 'Sales returns', value: money(a.salesReturns), kind: 'money', delta: pct(a.salesReturns, b.salesReturns), href: '/returns' },
      { key: 'avgCart', label: 'Average bill value', value: money(a.avgCart), kind: 'money', delta: pct(a.avgCart, b.avgCart) },
    );
    if (cost && a.margin !== undefined) {
      tiles.push(
        { key: 'margin', label: 'Gross margin', value: money(a.margin), kind: 'money', delta: pct(a.margin, b.margin ?? 0) },
        { key: 'marginPct', label: 'Gross margin %', value: (Math.round(a.marginPct! * 100) / 100).toFixed(2), kind: 'percent', delta: null },
      );
      out.marginNote = a.uncostedLines ? `${a.uncostedLines} sold line${a.uncostedLines === 1 ? ' has' : 's have'} no cost and ${a.uncostedLines === 1 ? 'is' : 'are'} left out of the margin.` : null;
    }
    const modes = await paymentFigures(t, tz, cur, q);
    out.paymentModes = modes.map((p) => ({ method: p.method, amount: money(p.amount) }));
    const cash = modes.find((p) => p.method === 'cash')?.amount ?? 0;
    const cashBefore = (await paymentFigures(t, tz, prev, q)).find((p) => p.method === 'cash')?.amount ?? 0;
    tiles.push({ key: 'cash', label: 'Cash collected', value: money(cash), kind: 'money', delta: pct(cash, cashBefore) });
  }

  // Purchases and suppliers have no sales channel; the channel filter does not apply to them.
  if (can(req, 'purchase.manage') || can(req, 'purchase.receive')) {
    const a = await purchaseFigures(t, tz, cur, q, cost);
    const b = await purchaseFigures(t, tz, prev, q, cost);
    if (a.purchases !== undefined) tiles.push({ key: 'purchases', label: 'Total purchase', value: money(a.purchases), kind: 'money', delta: pct(a.purchases, b.purchases ?? 0), href: '/purchasing' });
    tiles.push({ key: 'bills', label: 'Purchase bills', value: String(a.bills), kind: 'count', delta: pct(a.bills, b.bills), href: '/purchasing' });
    if (a.purchaseReturnValue !== undefined) tiles.push({ key: 'purchaseReturns', label: 'Purchase returns', value: money(a.purchaseReturnValue), kind: 'money', delta: pct(a.purchaseReturnValue, b.purchaseReturnValue ?? 0) });
    if (can(req, 'purchase.manage')) {
      const { rows: [s] } = await t.query('SELECT count(*)::int AS n FROM suppliers WHERE archived_at IS NULL');
      tiles.push({ key: 'suppliers', label: 'Total suppliers', value: String(s.n), kind: 'count', delta: null, href: '/suppliers' });
    }
  }

  // Stock is "now", not for the date range.
  if (can(req, 'stock.read')) {
    const params: unknown[] = [];
    let f = '';
    if (q.locationId) { params.push(q.locationId); f = ' AND b.location_id = $1'; }
    f += ` AND ${locIn(q.scope, 'b.location_id', pusher(params))}`;
    const { rows: [s] } = await t.query(
      `SELECT (SELECT count(*)::int FROM products WHERE status = 'active') AS products,
              coalesce(sum(b.on_hand), 0) AS qty, coalesce(sum(greatest(b.on_hand, 0) * v.cost), 0) AS value
         FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id JOIN locations l ON l.id = b.location_id
        WHERE l.active${f}`, params);
    tiles.push(
      { key: 'products', label: 'Total products', value: String(s.products), kind: 'count', delta: null, href: '/products' },
      { key: 'stockQty', label: 'Stock quantity', value: fmtQty(n(s.qty).toFixed(3))!, kind: 'qty', delta: null, href: '/stock' },
    );
    if (cost) tiles.push({ key: 'stockValue', label: 'Stock value (at cost)', value: money(n(s.value)), kind: 'money', delta: null, href: '/reports?r=inventory-summary' });
  }
  out.tiles = tiles;

  // Daily trend for the chart: sales (invoiced) and, with cost.view, purchases received.
  if (can(req, 'invoice.read') || ((can(req, 'purchase.manage') || can(req, 'purchase.receive')) && cost)) {
    const params: unknown[] = [tz, q.from, q.to];
    const sf: string[] = [];
    if (q.locationId) { params.push(q.locationId); sf.push(`o.location_id = $${params.length}`); }
    const locParam = q.locationId ? `$${params.length}` : null;
    sf.push(orderIn(q.scope, 'o', pusher(params)));
    const roomsInView = locIn(q.scope, 'l.location_id', pusher(params));
    if (q.channel) { params.push(q.channel); sf.push(`o.channel = $${params.length}`); }
    const { rows } = await t.query(
      `WITH d AS (SELECT generate_series($2::date, $3::date, interval '1 day')::date AS day),
            s AS (SELECT (i.issued_at AT TIME ZONE $1)::date AS day, sum(i.total) AS amount
                    FROM invoices i JOIN sales_orders o ON o.id = i.order_id
                   WHERE ${inRange('i.issued_at', '$2', '$3')}${sf.map((x) => ` AND ${x}`).join('')} GROUP BY 1),
            p AS (SELECT (g.posted_at AT TIME ZONE $1)::date AS day, sum(l.accepted_qty * l.unit_cost) AS amount
                    FROM goods_receipts g JOIN goods_receipt_lines l ON l.receipt_id = g.id
                   WHERE ${inRange('g.posted_at', '$2', '$3')}${locParam ? ` AND l.location_id = ${locParam}` : ''} AND ${roomsInView} GROUP BY 1)
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day, coalesce(s.amount, 0) AS sales, coalesce(p.amount, 0) AS purchases
         FROM d LEFT JOIN s USING (day) LEFT JOIN p USING (day) ORDER BY d.day`, params);
    out.trend = rows.map((r) => ({
      day: r.day as string,
      ...(can(req, 'invoice.read') ? { sales: money(n(r.sales)) } : {}),
      ...((can(req, 'purchase.manage') || can(req, 'purchase.receive')) && cost ? { purchases: money(n(r.purchases)) } : {}),
    }));
  }
  return out;
}
