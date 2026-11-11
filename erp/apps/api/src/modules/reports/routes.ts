import { locIn, orderIn, outletScope, pusher, scopeOut, seriesIn } from '../outlets/scope.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx, type Tx } from '../../db.js';
import { csvLine } from '../../lib/csv.js';
import { fmtMoney, fmtQty } from '../../lib/decimal.js';
import { localDate } from '../../lib/gst.js';
import { appError, audit, authOf, can, requires, signedIn } from '../../lib/phase1.js';
import { REPORTS, type Col, type Ctx, type ReportDef } from './definitions.js';
import { overview } from './overview.js';

// Reports (PRD 8) and the dashboard (B6). Reports need report.view; CSV needs report.export; cost columns need cost.view.
// The screen gets the first 500 rows with totals over all of them; a CSV gets every row, up to 50,000 (D61).

const SCREEN_ROWS = 500;
const CSV_ROWS = 50_000;
const MAX_DAYS = 366;

const tx = <T>(req: FastifyRequest, fn: (t: Tx) => Promise<T>) => tenantTx(authOf(req).tenantId, fn);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Not a date');
const reportQuery = z.object({
  from: day.optional(), to: day.optional(), locationId: z.string().uuid().optional(), format: z.enum(['json', 'csv']).default('json'),
}).strict();

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function storeZone(t: Tx) {
  const { rows: [r] } = await t.query("SELECT timezone FROM tenants WHERE id = current_setting('app.tenant_id')::uuid");
  return (r?.timezone as string | undefined) ?? 'Asia/Kolkata';
}

function cell(c: Col, v: unknown) {
  if (v === null || v === undefined) return null;
  if (c.type === 'money') return fmtMoney(String(v));
  if (c.type === 'qty') return fmtQty(String(v));
  if (c.type === 'int') return Number(v);
  return String(v);
}

/** Runs the report's SQL once for rows and once for totals, inside the caller's transaction. */
async function run(t: Tx, def: ReportDef, ctx: Ctx, cols: Col[], limit: number) {
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const base = def.sql(ctx, p);
  const { rows } = await t.query(`SELECT * FROM (${base}) r ORDER BY ${def.order} LIMIT ${limit + 1}`, params);
  const summed = cols.filter((c) => c.total);
  const { rows: [tot] } = await t.query(
    `SELECT count(*)::int AS row_count${summed.map((c) => `, sum(r.${c.key}) AS ${c.key}`).join('')} FROM (${base}) r`, params);
  return {
    rows: rows.slice(0, limit).map((r) => Object.fromEntries(cols.map((c) => [c.key, cell(c, r[c.key])]))),
    truncated: rows.length > limit,
    rowCount: tot.row_count as number,
    totals: Object.fromEntries(summed.map((c) => [c.key, cell(c, tot[c.key] ?? 0)])),
  };
}

export async function reportRoutes(app: FastifyInstance) {
  app.get('/reports', { preHandler: requires('report.view') }, async (req) => ({
    items: Object.entries(REPORTS)
      .filter(([, d]) => !d.extra || can(req, d.extra))
      .map(([key, d]) => ({ key, title: d.title, description: d.description, dated: d.dated, location: d.location })),
    can: { export: can(req, 'report.export'), cost: can(req, 'cost.view') },
  }));

  app.get('/reports/:report', { preHandler: requires('report.view') }, async (req, reply) => {
    const { report } = z.object({ report: z.string() }).parse(req.params);
    const def = Object.hasOwn(REPORTS, report) ? REPORTS[report] : undefined;
    if (!def) throw appError(404, 'NOT_FOUND', 'No such report');
    if (def.extra && !can(req, def.extra)) throw appError(403, 'FORBIDDEN', 'You do not have permission to see this report');
    const q = reportQuery.parse(req.query);
    if (q.format === 'csv' && !can(req, 'report.export')) throw appError(403, 'FORBIDDEN', 'You are not allowed to export reports');
    const cols = def.columns.filter((c) => !c.cost || can(req, 'cost.view'));

    const out = await tx(req, async (t) => {
      await t.query("SET LOCAL statement_timeout = '30s'");
      const tz = await storeZone(t);
      const today = localDate(new Date(), tz);
      const to = q.to ?? today;
      const from = q.from ?? addDays(to, -29);
      if (def.dated) {
        if (from > to) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { from: ['Must be on or before the end date'] });
        if (addDays(from, MAX_DAYS - 1) < to) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { from: [`At most ${MAX_DAYS} days at a time`] });
      }
      const scope = await outletScope(t, req);
      if (q.locationId) {
        const { rows: [l] } = await t.query('SELECT 1 FROM locations WHERE id = $1', [q.locationId]);
        if (!l) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { locationId: ['Unknown location'] });
        if (scope.locs && !scope.locs.includes(q.locationId)) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { locationId: [`This stock room isn't at ${scope.outlet?.name ?? 'your outlets'}`] });
      }
      const ctx: Ctx = { from, to, tz, locationId: def.location ? q.locationId ?? null : null, scope };
      const r = await run(t, def, ctx, cols, q.format === 'csv' ? CSV_ROWS : SCREEN_ROWS);
      if (q.format === 'csv') {
        if (r.truncated) throw appError(422, 'REPORT_TOO_LARGE', `More than ${CSV_ROWS.toLocaleString('en-IN')} rows; choose fewer days or one location`);
        // Exports can carry cost and sales figures out of the system: record who took what.
        await audit(t, { actorId: authOf(req).userId, action: 'report.exported', entityType: 'report',
          summary: { report, from: def.dated ? from : null, to: def.dated ? to : null, locationId: ctx.locationId, outlet: scope.outlet?.name ?? null, rows: r.rowCount, costColumns: cols.some((c) => c.cost) } });
      }
      return { ...r, from, to, scope: scopeOut(scope) };
    });

    if (q.format === 'csv') {
      const body = csvLine(cols.map((c) => c.label)) + out.rows.map((row) => csvLine(cols.map((c) => row[c.key]))).join('');
      const where = out.scope.outletName ? `_${out.scope.outletName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : '';
      const name = def.dated ? `${report}${where}_${out.from}_to_${out.to}.csv` : `${report}${where}_${out.to}.csv`;
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`)
        .header('cache-control', 'no-store').send(`﻿${body}`);
    }
    return {
      report, title: def.title, description: def.description, from: def.dated ? out.from : null, to: def.dated ? out.to : null,
      columns: cols.map(({ key, label, type, total }) => ({ key, label, type, total: !!total })),
      rows: out.rows, truncated: out.truncated, rowCount: out.rowCount, totals: out.totals, ...out.scope,
    };
  });

  // v2 (D90): the Overview at the top of the dashboard. Default range: the 1st of this month to today, store time.
  app.get('/dashboard/overview', { preHandler: signedIn() }, async (req) => {
    const q = z.object({ from: day.optional(), to: day.optional(), locationId: z.string().uuid().optional(),
      channel: z.enum(['pos', 'woocommerce']).optional() }).strict().parse(req.query);
    return tx(req, async (t) => {
      await t.query("SET LOCAL statement_timeout = '30s'");
      const tz = await storeZone(t);
      const today = localDate(new Date(), tz);
      const to = q.to ?? today;
      const from = q.from ?? `${to.slice(0, 8)}01`;
      return overview(t, req, tz, today, { ...q, from, to, scope: await outletScope(t, req) });
    });
  });

  // Every signed-in user gets a dashboard; each tile is left out when they may not see what it counts.
  app.get('/dashboard', { preHandler: signedIn() }, async (req) => tx(req, async (t) => {
    const tz = await storeZone(t);
    const today = localDate(new Date(), tz);
    const yesterday = addDays(today, -1);
    const out: Record<string, unknown> = {};
    // v2 (D115): every tile counts the outlet in view.
    const scope = await outletScope(t, req);

    if (can(req, 'invoice.read')) {
      const sp: unknown[] = [tz, yesterday];
      const sIn = seriesIn(scope, 'series_id', pusher(sp));
      const bp: unknown[] = [today, tz];
      // Net of credit notes, per store day. Two days only: the same "invoiced − credited" as the sales report.
      const { rows } = await t.query(
        `WITH d AS (
           SELECT (issued_at AT TIME ZONE $1)::date AS day, total AS amount, 1 AS n FROM invoices
            WHERE issued_at >= ($2::date::timestamp AT TIME ZONE $1) AND ${sIn}
           UNION ALL
           SELECT (issued_at AT TIME ZONE $1)::date, -total, 0 FROM credit_notes
            WHERE issued_at >= ($2::date::timestamp AT TIME ZONE $1) AND ${sIn})
         SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(amount) AS net, sum(n)::int AS invoices FROM d GROUP BY day`, sp);
      const of = (d: string) => rows.find((r) => r.day === d);
      out.sales = { today: fmtMoney(String(of(today)?.net ?? '0')), yesterday: fmtMoney(String(of(yesterday)?.net ?? '0')), invoicesToday: of(today)?.invoices ?? 0 };
      const { rows: best } = await t.query(
        `SELECT l.description AS name, l.sku, sum(l.qty) AS qty FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
          WHERE l.kind = 'item' AND i.issued_at >= (($1::date - 29)::timestamp AT TIME ZONE $2) AND ${seriesIn(scope, 'i.series_id', pusher(bp))}
          GROUP BY l.description, l.sku ORDER BY sum(l.qty) DESC, l.description LIMIT 5`, bp);
      out.bestSellers = best.map((b) => ({ name: b.name as string, sku: b.sku as string | null, qty: fmtQty(b.qty) }));
    }

    if (can(req, 'stock.read')) {
      const kp: unknown[] = [];
      const { rows: [s] } = await t.query(
        `SELECT count(*)::int AS items, count(*) FILTER (WHERE v.reorder_level IS NOT NULL AND s.available <= v.reorder_level)::int AS low,
                round(sum(greatest(s.on_hand, 0) * v.cost), 2) AS value
           FROM product_variants v JOIN products p ON p.id = v.product_id
           CROSS JOIN LATERAL (SELECT coalesce(sum(b.on_hand), 0) AS on_hand,
                                      coalesce(sum(b.on_hand - b.reserved) FILTER (WHERE l.is_sellable AND l.active), 0) AS available
                                 FROM stock_balances b JOIN locations l ON l.id = b.location_id WHERE b.variant_id = v.id AND ${locIn(scope, 'b.location_id', pusher(kp))}) s
          WHERE v.status = 'active' AND p.status <> 'archived'`, kp);
      out.stock = { itemCount: s.items, lowStockCount: s.low, ...(can(req, 'cost.view') ? { value: fmtMoney(String(s.value ?? '0')) } : {}) };
    }

    const attention: Record<string, number> = {};
    if (can(req, 'order.read')) {
      const { rows: [o] } = await t.query(
        `SELECT count(*) FILTER (WHERE status IN ('stock_exception', 'needs_review'))::int AS exceptions,
                count(*) FILTER (WHERE status = 'ready_to_pick')::int AS ready, count(*) FILTER (WHERE status IN ('picking', 'packed'))::int AS in_progress
           FROM sales_orders WHERE channel = 'woocommerce' AND status IN ('stock_exception', 'needs_review', 'ready_to_pick', 'picking', 'packed') AND ${scope.main ? 'true' : 'false'}`);
      Object.assign(attention, { ordersNeedingAttention: o.exceptions, readyToPick: o.ready, beingPicked: o.in_progress });
    }
    if (can(req, 'order.fulfil')) {
      const { rows: [w] } = await t.query("SELECT count(*)::int AS n FROM shipments WHERE woo_update_state IN ('pending', 'failed') AND created_at < now() - interval '15 minutes'");
      attention.dispatchUpdatesStuck = w.n;
    }
    if (can(req, 'sync.manage')) {
      const { rows: [j] } = await t.query("SELECT count(*)::int AS n FROM sync_jobs WHERE status IN ('failed', 'dead') AND created_at > now() - interval '7 days'");
      attention.failedSyncJobs = j.n;
    }
    if (can(req, 'stocktake.approve')) {
      const tp: unknown[] = [];
      const { rows: [st] } = await t.query(`SELECT count(*)::int AS n FROM stocktakes WHERE status = 'review' AND ${locIn(scope, 'location_id', pusher(tp))}`, tp);
      attention.stocktakesInReview = st.n;
    }
    if (Object.keys(attention).length) out.attention = attention;

    if (can(req, 'order.read')) {
      const rp: unknown[] = [];
      const { rows } = await t.query(
        `SELECT id, number, channel, status, total, placed_at, customer_snapshot->>'name' AS customer FROM sales_orders o
          WHERE status NOT IN ('awaiting_payment', 'failed') AND ${orderIn(scope, 'o', pusher(rp))} ORDER BY placed_at DESC LIMIT 5`, rp);
      out.recentSales = rows.map((r) => ({
        id: r.id as string, number: r.number as string, channel: r.channel as string, status: r.status as string,
        total: fmtMoney(r.total), placedAt: r.placed_at as Date, customerName: (r.customer as string) || null,
      }));
    }
    return { today, ...out, ...scopeOut(scope) };
  }));
}
