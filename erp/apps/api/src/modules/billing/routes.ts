import { outletScope } from '../outlets/scope.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx, type Tx } from '../../db.js';
import { fmtMoney } from '../../lib/decimal.js';
import { financialYear, localDate, STATES } from '../../lib/gst.js';
import { idempotent } from '../../lib/idempotency.js';
import { decodeCursor, encodeCursor, limitParam } from '../../lib/pagination.js';
import { appError, audit, authOf, can, requires } from '../../lib/phase1.js';
import { listLocations } from '../inventory/service.js';
import { voidInput, voidInvoice } from '../returns/service.js';
import { creditNoteDetail, invoiceDetail } from './documents.js';
import { BILL_FORMATS, loadProfile } from './profile.js';

// Billing & GST settings, invoice series, and reading invoices and credit notes (B5).
// Routes sit at /v1/billing/* rather than the design's /v1/settings/tax, clear of Phase 1's settings routes (as D33 did).

const tx = <T>(req: FastifyRequest, fn: (t: Tx) => Promise<T>) => tenantTx(authOf(req).tenantId, fn);
const pct = z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter a percentage like 10').refine((v) => Number(v) <= 100, 'At most 100%');

const settingsPatch = z.object({
  gstScheme: z.enum(['regular', 'composition', 'unregistered']),
  stateCode: z.string().refine((v) => !!STATES[v], 'Pick a state').nullable(),
  pricesIncludeTax: z.boolean(),
  roundOff: z.boolean(),
  posLocationId: z.string().uuid().nullable(),
  discountReasonThresholdPct: pct,
  cashierDiscountLimitPct: pct,
  managerDiscountLimitPct: pct,
  invoicePrefix: z.string().trim().regex(/^[A-Za-z0-9-]{1,6}$/, '1 to 6 letters, digits or -'),
  creditNotePrefix: z.string().trim().regex(/^[A-Za-z0-9-]{1,6}$/, '1 to 6 letters, digits or -'),
  invoiceWebOrders: z.boolean(),
  receiptFooter: z.string().trim().max(300).nullable(),
  billFormat: z.enum(BILL_FORMATS),
  requireCustomer: z.boolean(),
  requireRegister: z.boolean(),
  expenseLimitEach: z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/, 'Enter an amount like 500'),
  expenseLimitDay: z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/, 'Enter an amount like 1000'),
  returnDays: z.number().int().min(1, 'At least 1 day').max(365, 'At most 365 days').nullable(),
  returnMoneyBack: z.boolean(),
}).partial().strict();

const COLUMN: Record<string, string> = {
  gstScheme: 'gst_scheme', stateCode: 'state_code', pricesIncludeTax: 'prices_include_tax', roundOff: 'round_off', posLocationId: 'pos_location_id',
  discountReasonThresholdPct: 'discount_reason_threshold_pct', cashierDiscountLimitPct: 'cashier_discount_limit_pct',
  managerDiscountLimitPct: 'manager_discount_limit_pct', invoicePrefix: 'invoice_prefix', creditNotePrefix: 'credit_note_prefix',
  invoiceWebOrders: 'invoice_web_orders', receiptFooter: 'receipt_footer', billFormat: 'bill_format',
  requireCustomer: 'require_customer', requireRegister: 'require_register', expenseLimitEach: 'expense_limit_each', expenseLimitDay: 'expense_limit_day',
  returnDays: 'return_days', returnMoneyBack: 'return_money_back',
};

const seriesInput = z.object({
  docType: z.enum(['invoice', 'credit_note']),
  financialYear: z.string().regex(/^\d{4}-\d{2}$/),
  prefix: z.string().trim().regex(/^[A-Za-z0-9/-]{0,12}$/, 'Up to 12 letters, digits, / or -'),
  startAt: z.number().int().min(1).max(99_999_999).default(1),
}).strict();

const listQuery = z.object({
  type: z.enum(['invoice', 'credit_note']).default('invoice'),
  q: z.string().trim().max(100).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: limitParam, cursor: z.string().optional(),
}).strict();
const idParam = z.object({ id: z.string().uuid() });

async function settingsOut(t: Tx) {
  const p = await loadProfile(t);
  return {
    ready: p.ready, problems: p.problems, gstScheme: p.scheme, stateCode: p.stateCode, seller: p.seller, timezone: p.timezone,
    ...p.settings, locations: (await listLocations(t)).filter((l) => l.active && l.isSellable && l.outletId === p.outlet.id).map((l) => ({ id: l.id, name: l.name })),
    states: Object.entries(STATES).map(([code, name]) => ({ code, name })),
  };
}

async function seriesOut(t: Tx) {
  const p = await loadProfile(t);
  const current = financialYear(localDate(new Date(), p.timezone));
  const { rows } = await t.query(
    `SELECT s.*, (s.next_number > s.start_number) AS used, o.name AS outlet_name, o.is_main FROM invoice_series s JOIN outlets o ON o.id = s.outlet_id
      ORDER BY s.financial_year DESC, NOT o.is_main, o.created_at, s.doc_type`);
  return {
    currentFinancialYear: current,
    items: rows.map((r) => ({
      id: r.id as string, docType: r.doc_type as string, financialYear: r.financial_year as string, prefix: r.prefix as string,
      startNumber: r.start_number as number, nextNumber: r.next_number as number, nextDocument: `${r.prefix}${r.next_number}`, used: r.used as boolean,
      outlet: r.outlet_name as string, mainOutlet: r.is_main as boolean,
    })),
    defaults: { invoice: `${p.settings.invoicePrefix}/${current.slice(2)}/`, creditNote: `${p.settings.creditNotePrefix}/${current.slice(2)}/` },
  };
}

export async function billingRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- settings
  app.get('/billing/settings', { preHandler: requires('settings.read') }, async (req) =>
    ({ ...(await tx(req, settingsOut)), can: { manage: can(req, 'settings.manage') } }));

  app.patch('/billing/settings', { preHandler: requires('settings.manage') }, async (req) => {
    const input = settingsPatch.parse(req.body);
    return tx(req, async (t) => {
      const before = await loadProfile(t);
      if (input.posLocationId) {
        const loc = (await listLocations(t)).find((l) => l.id === input.posLocationId);
        if (!loc || !loc.active || !loc.isSellable || loc.outletId !== before.outlet.id) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { posLocationId: ['Pick an active, sellable stock room of the main outlet'] });
      }
      // The main outlet's bill prefixes must stay different from every other outlet's (v2, D101).
      for (const [k, col] of [['invoicePrefix', 'invoice_prefix'], ['creditNotePrefix', 'credit_note_prefix']] as const) {
        if (!input[k]) continue;
        const { rows: [o] } = await t.query(`SELECT name FROM outlets WHERE NOT is_main AND upper(${col}) = upper($1) LIMIT 1`, [input[k]]);
        if (o) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { [k]: [`${o.name} uses this prefix`] });
      }
      const keys = Object.keys(input) as (keyof typeof input)[];
      if (keys.length) {
        await t.query(
          `UPDATE sales_settings SET ${keys.map((k, i) => `${COLUMN[k]} = $${i + 1}`).join(', ')}, updated_at = now()`,
          keys.map((k) => input[k] ?? null));
        const was = { ...before.settings, gstScheme: before.scheme, stateCode: before.stateCode } as Record<string, unknown>;
        const changed = Object.fromEntries(keys.filter((k) => String(was[k] ?? null) !== String(input[k] ?? null)).map((k) => [k, { from: was[k] ?? null, to: input[k] ?? null }]));
        if (Object.keys(changed).length) await audit(t, { actorId: authOf(req).userId, action: 'billing.settings_changed', entityType: 'sales_settings', summary: changed });
      }
      return { ...(await settingsOut(t)), can: { manage: true } };
    });
  });

  // ---------------------------------------------------------------- series
  app.get('/billing/series', { preHandler: requires('settings.read') }, async (req) => tx(req, seriesOut));

  // Set a year's prefix and first number (e.g. continuing from old software) before its first document. Never after.
  app.post('/billing/series', { preHandler: requires('settings.manage') }, async (req) => {
    const input = seriesInput.parse(req.body);
    return tx(req, async (t) => {
      const p = await loadProfile(t);
      const current = financialYear(localDate(new Date(), p.timezone));
      const next = `${Number(current.slice(0, 4)) + 1}-${String((Number(current.slice(0, 4)) + 2) % 100).padStart(2, '0')}`;
      if (input.financialYear !== current && input.financialYear !== next) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { financialYear: [`Use ${current} or ${next}`] });
      if (`${input.prefix}${input.startAt}`.length > 16) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { prefix: ['Prefix and number together must fit in 16 characters'] });
      // The main outlet's series; another outlet's numbers follow its own prefix.
      const { rows: [s] } = await t.query('SELECT id, next_number, start_number FROM invoice_series WHERE doc_type = $1 AND financial_year = $2 AND outlet_id = $3 FOR UPDATE', [input.docType, input.financialYear, p.outlet.id]);
      if (s && s.next_number > s.start_number) throw appError(409, 'SERIES_IN_USE', 'This series already has documents; its numbers cannot change');
      if (s) await t.query('UPDATE invoice_series SET prefix = $2, start_number = $3, next_number = $3 WHERE id = $1', [s.id, input.prefix, input.startAt]);
      else {
        await t.query(
          `INSERT INTO invoice_series (tenant_id, outlet_id, doc_type, financial_year, prefix, start_number, next_number, created_by)
           VALUES (current_setting('app.tenant_id')::uuid, $6, $1, $2, $3, $4, $4, $5)`, [input.docType, input.financialYear, input.prefix, input.startAt, authOf(req).userId, p.outlet.id]);
      }
      await audit(t, { actorId: authOf(req).userId, action: 'billing.series_set', entityType: 'invoice_series', summary: input });
      return seriesOut(t);
    });
  });

  // ---------------------------------------------------------------- invoices and credit notes
  app.get('/invoices', { preHandler: requires('invoice.read') }, async (req) => {
    const q = listQuery.parse(req.query);
    const after = decodeCursor(q.cursor, z.tuple([z.string(), z.string().uuid()]));
    return tx(req, async (t) => {
      const p = await loadProfile(t);
      // $1 is always the store's timezone (typed, so Postgres accepts it even when no date filter uses it).
      const params: unknown[] = [p.timezone];
      const where: string[] = ['$1::text IS NOT NULL'];
      const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
      const d = q.type === 'invoice' ? 'i' : 'c';
      // v2 (D115): the outlet in view, by the series that numbered the document.
      const scope = await outletScope(t, req);
      if (scope.ids) add(`${d}.series_id IN (SELECT ss.id FROM invoice_series ss WHERE ss.outlet_id = ANY(?::uuid[]))`, scope.ids);
      if (q.q) add(`(${d}.number ILIKE '%' || ? || '%' OR i.buyer->>'name' ILIKE '%' || ? || '%' OR i.buyer->>'phone' LIKE '%' || ? || '%' OR o.number ILIKE '%' || ? || '%')`, q.q.replace(/[%_\\]/g, '\\$&'));
      if (q.from) add(`(${d}.issued_at AT TIME ZONE $1::text)::date >= ?::date`, q.from);
      if (q.to) add(`(${d}.issued_at AT TIME ZONE $1::text)::date <= ?::date`, q.to);
      if (after) { params.push(after[0], after[1]); where.push(`(${d}.issued_at, ${d}.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`); }
      params.push(q.limit + 1);
      const sql = q.type === 'invoice'
        ? `SELECT i.id, i.number, i.issued_at, i.doc_kind, i.total, i.buyer->>'name' AS customer, o.channel, o.number AS order_number,
                  EXISTS (SELECT 1 FROM credit_notes c WHERE c.invoice_id = i.id AND c.kind = 'void') AS voided,
                  (SELECT coalesce(sum(c.total), 0) FROM credit_notes c WHERE c.invoice_id = i.id) AS credited
             FROM invoices i JOIN sales_orders o ON o.id = i.order_id`
        : `SELECT c.id, c.number, c.issued_at, 'credit_note' AS doc_kind, c.total, i.buyer->>'name' AS customer, o.channel, o.number AS order_number,
                  c.kind = 'void' AS voided, NULL AS credited, i.number AS invoice_number, i.id AS invoice_id
             FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id JOIN sales_orders o ON o.id = i.order_id`;
      const { rows } = await t.query(`${sql} WHERE ${where.join(' AND ')} ORDER BY ${d}.issued_at DESC, ${d}.id DESC LIMIT $${params.length}`, params);
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((r) => ({
          id: r.id as string, type: q.type, number: r.number as string, issuedAt: r.issued_at as Date, docKind: r.doc_kind as string,
          total: fmtMoney(r.total), customer: (r.customer as string | null) || null, channel: r.channel as string, orderNumber: r.order_number as string,
          voided: r.voided as boolean, credited: r.credited === null ? null : fmtMoney(r.credited),
          ...(r.invoice_id ? { invoice: { id: r.invoice_id as string, number: r.invoice_number as string } } : {}),
        })),
        nextCursor: rows.length > q.limit ? encodeCursor([page[page.length - 1].issued_at.toISOString(), page[page.length - 1].id]) : null,
      };
    });
  });

  app.get('/invoices/:id', { preHandler: requires('invoice.read') }, async (req) => {
    const { id } = idParam.parse(req.params);
    return tx(req, async (t) => {
      const p = await loadProfile(t);
      const doc = (await invoiceDetail(t, id, p.timezone)) ?? (await creditNoteDetail(t, id, p.timezone));
      if (!doc) throw appError(404, 'NOT_FOUND', 'Invoice not found');
      return { ...doc, receiptFooter: p.settings.receiptFooter, billFormat: p.settings.billFormat, can: { void: can(req, 'invoice.void'), return: can(req, 'return.manage') } };
    });
  });

  app.post('/invoices/:id/void', { preHandler: requires('invoice.void') }, async (req) => {
    const { id } = idParam.parse(req.params);
    if (req.headers['idempotency-key'] === undefined) throw appError(400, 'VALIDATION_ERROR', 'Idempotency-Key header is required');
    const input = voidInput.parse(req.body);
    const out = await tx(req, (t) => idempotent(t, req.headers['idempotency-key'], { id, ...input }, async () =>
      ({ status: 200, body: await voidInvoice(t, { userId: authOf(req).userId, role: authOf(req).role }, id, input) })));
    return out.body;
  });
}
