import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, tenantTx, type Tx } from '../../db.js';
import { enqueue } from '../../jobs/queue.js';
import { objects } from '../../lib/objects.js';
import { appError, audit, authOf, can, requires, signedIn } from '../../lib/phase1.js';
import { saasEnv } from '../../lib/saas-env.js';
import { storeInfo } from '../../lib/saas.js';
import './export-job.js'; // registers the 'export' handler in the worker

// The store's own account (B7): its plan and state, payment history, how to pay, data export and support access.
// The subscription itself is read-only here; only the platform console changes it (0600_saas.sql).

const tx = <T>(req: FastifyRequest, fn: (t: Tx) => Promise<T>) => tenantTx(authOf(req).tenantId, fn);
const owner = { preHandler: requires('account.manage') };
const GRACE_DAYS = 7;          // keep in step with saas_lifecycle_tick()
const CLOSED_EXPORT_DAYS = 30; // 06 §4: a closed store's data can be exported for 30 days
const addDays = (d: Date | null, n: number) => d ? new Date(d.getTime() + n * 86_400_000).toISOString() : null;

const plan = (p: Record<string, unknown>) => ({
  id: p.id, name: p.name, maxUsers: p.max_users, online: (p.features as { online?: boolean })?.online === true,
  priceMonthPaise: p.price_month_paise, priceYearPaise: p.price_year_paise,
});

export async function accountRoutes(app: FastifyInstance) {
  // Banner and Account page. Everyone signed in sees the state; only the owner sees how to pay.
  app.get('/subscription', { preHandler: signedIn() }, async (req) => tx(req, async (t) => {
    const { rows: [s] } = await t.query(
      `SELECT s.*, row_to_json(p) AS plan FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id JOIN plans p ON p.id = t.plan_id`);
    if (!s) throw appError(404, 'NOT_FOUND', 'No subscription for this store');
    const isOwner = can(req, 'account.manage');
    return {
      state: s.state,
      readOnly: s.state === 'suspended' || s.state === 'closed',
      storeCode: s.store_code,
      trialEndsAt: s.trial_ends_at, paidUntil: s.paid_until, pastDueSince: s.past_due_since,
      suspendsAt: s.state === 'past_due' ? addDays(s.past_due_since, GRACE_DAYS) : null,
      closedAt: s.closed_at, exportUntil: s.state === 'closed' ? addDays(s.closed_at, CLOSED_EXPORT_DAYS) : null,
      plan: plan(s.plan), online: (await storeInfo(authOf(req).tenantId)).online,
      payTo: isOwner && saasEnv.BILLING_UPI_ID ? { upiId: saasEnv.BILLING_UPI_ID, payee: saasEnv.BILLING_UPI_NAME ?? null, note: s.store_code } : null,
      support: { email: saasEnv.SUPPORT_EMAIL ?? null, whatsapp: saasEnv.SUPPORT_WHATSAPP ?? null },
      can: { manage: isOwner },
    };
  }));

  app.get('/account/plans', owner, async () => {
    const { rows } = await pool.query('SELECT * FROM plans WHERE is_public ORDER BY sort_order, id'); // configuration, no tenant rows
    return { items: rows.map(plan), gstPercent: saasEnv.BILLING_GST_PERCENT ?? null };
  });

  app.get('/account/payments', owner, async (req) => tx(req, async (t) => {
    const { rows: payments } = await t.query(
      `SELECT receipt_no, amount_paise, method, reference, paid_on, plan_id, months, period_from, period_to, created_at
         FROM subscription_payments ORDER BY created_at DESC LIMIT 100`);
    const { rows: events } = await t.query(
      `SELECT from_state, to_state, reason, created_at, actor = 'system' AS automatic FROM subscription_events ORDER BY id DESC LIMIT 50`);
    return {
      payments: payments.map((p) => ({ receiptNo: p.receipt_no, amountPaise: p.amount_paise, method: p.method, reference: p.reference,
        paidOn: p.paid_on, planId: p.plan_id, months: p.months, periodFrom: p.period_from, periodTo: p.period_to })),
      // Who changed it is not shown to the store; the platform console has that.
      events: events.map((e) => ({ from: e.from_state, to: e.to_state, reason: e.reason, at: e.created_at, automatic: e.automatic })),
    };
  }));

  // ---------------------------------------------------------------- support access (D71)
  const grantView = (g: Record<string, any>) => ({ id: g.id, reason: g.reason, createdAt: g.created_at, expiresAt: g.expires_at,
    revokedAt: g.revoked_at, active: !g.revoked_at && new Date(g.expires_at) > new Date() });

  app.get('/account/support-access', owner, async (req) => tx(req, async (t) => {
    const { rows: grants } = await t.query('SELECT * FROM support_grants ORDER BY created_at DESC LIMIT 20');
    const { rows: views } = await t.query(
      "SELECT created_at, summary->>'by' AS by FROM audit_events WHERE action = 'support.viewed' ORDER BY id DESC LIMIT 50");
    return { items: grants.map(grantView), views: views.map((v) => ({ at: v.created_at, by: v.by })) };
  }));

  app.post('/account/support-access', owner, async (req, reply) => {
    const b = z.object({ hours: z.number().int().min(1).max(72), reason: z.string().trim().max(200).optional() }).strict().parse(req.body);
    const g = await tx(req, async (t) => {
      const me = authOf(req).userId;
      // One live grant at a time: a new one replaces the old.
      await t.query('UPDATE support_grants SET revoked_at = now(), revoked_by = $1 WHERE revoked_at IS NULL AND expires_at > now()', [me]);
      const { rows: [g] } = await t.query(
        `INSERT INTO support_grants (tenant_id, granted_by, reason, expires_at)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, now() + make_interval(hours => $3)) RETURNING *`, [me, b.reason || null, b.hours]);
      await audit(t, { actorId: me, action: 'support.granted', entityType: 'support_grant', entityId: g.id, summary: { hours: b.hours, reason: b.reason ?? null } });
      return g;
    });
    return reply.code(201).send(grantView(g));
  });

  app.post('/account/support-access/revoke', owner, async (req) => tx(req, async (t) => {
    const me = authOf(req).userId;
    const { rows } = await t.query(
      'UPDATE support_grants SET revoked_at = now(), revoked_by = $1 WHERE revoked_at IS NULL AND expires_at > now() RETURNING id', [me]);
    for (const r of rows) await audit(t, { actorId: me, action: 'support.revoked', entityType: 'support_grant', entityId: r.id });
    return { revoked: rows.length };
  }));

  // ---------------------------------------------------------------- data export (D72)
  const exportView = (e: Record<string, any>) => ({ id: e.id, status: e.status, sizeBytes: e.size_bytes === null ? null : Number(e.size_bytes),
    rowCounts: e.row_counts, error: e.status === 'failed' ? 'The export failed. Try again, or contact support.' : null,
    createdAt: e.created_at, finishedAt: e.finished_at, expiresAt: e.expires_at,
    downloadable: e.status === 'ready' && new Date(e.expires_at) > new Date() });

  app.get('/account/exports', owner, async (req) => tx(req, async (t) => {
    const { rows } = await t.query('SELECT * FROM data_exports ORDER BY created_at DESC LIMIT 10');
    return { items: rows.map(exportView) };
  }));

  app.post('/account/exports', owner, async (req, reply) => {
    const e = await tx(req, async (t) => {
      await t.query("SELECT pg_advisory_xact_lock(hashtext('data_export:' || current_setting('app.tenant_id')))");
      const { rows: [n] } = await t.query(
        `SELECT count(*) FILTER (WHERE status IN ('pending', 'running'))::int AS running,
                count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS today FROM data_exports`);
      if (n.running) throw appError(409, 'EXPORT_RUNNING', 'An export is already being prepared.');
      if (n.today >= 3) throw appError(429, 'EXPORT_LIMIT', 'You can make 3 exports a day. Try again tomorrow.');
      const me = authOf(req).userId;
      const { rows: [e] } = await t.query(
        "INSERT INTO data_exports (tenant_id, requested_by) VALUES (current_setting('app.tenant_id')::uuid, $1) RETURNING *", [me]);
      await enqueue(t, 'export', e.id, { maxAttempts: 1 });
      await audit(t, { actorId: me, action: 'account.export_requested', entityType: 'data_export', entityId: e.id });
      return e;
    });
    return reply.code(202).send(exportView(e));
  });

  app.get('/account/exports/:id/download', owner, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const key = await tx(req, async (t) => {
      const { rows: [e] } = await t.query('SELECT * FROM data_exports WHERE id = $1', [id]);
      if (!e || !exportView(e).downloadable) throw appError(404, 'NOT_FOUND', 'This export is not available. Make a new one.');
      await audit(t, { actorId: authOf(req).userId, action: 'account.export_downloaded', entityType: 'data_export', entityId: id, summary: { sizeBytes: Number(e.size_bytes) } });
      return e.object_key as string;
    });
    const body = await objects.get(key);
    return reply.header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="store-export-${new Date().toISOString().slice(0, 10)}.zip"`)
      .header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').send(body);
  });

  // ---------------------------------------------------------------- Getting started (onboarding checklist)
  app.get('/onboarding', { preHandler: signedIn() }, async (req) => {
    const role = authOf(req).role;
    if (role !== 'owner' && role !== 'manager') return { steps: [] };
    const online = (await storeInfo(authOf(req).tenantId)).online;
    return tx(req, async (t) => {
      const { rows: [r] } = await t.query(`SELECT
        EXISTS (SELECT 1 FROM store_settings WHERE address IS NOT NULL AND address <> '') AS store,
        EXISTS (SELECT 1 FROM sales_settings WHERE gst_scheme IS NOT NULL AND state_code IS NOT NULL) AS billing,
        EXISTS (SELECT 1 FROM products) AS products,
        EXISTS (SELECT 1 FROM product_variants WHERE barcode IS NOT NULL) AS barcodes,
        EXISTS (SELECT 1 FROM woo_connections WHERE status = 'connected') AS shop,
        (SELECT count(*) FROM users WHERE status <> 'disabled') > 1 AS staff,
        EXISTS (SELECT 1 FROM invoices) AS sale`);
      const steps = [
        { key: 'store', title: 'Add your store address and GSTIN', href: '/settings', done: r.store },
        { key: 'billing', title: 'Set up GST billing', href: '/billing', done: r.billing },
        { key: 'products', title: 'Add or import your products', href: '/products/import', done: r.products },
        { key: 'barcodes', title: 'Give products barcodes and print labels', href: '/products/labels', done: r.barcodes },
        ...(online ? [{ key: 'shop', title: 'Connect your WooCommerce shop', href: '/integrations/woocommerce', done: r.shop }] : []),
        { key: 'staff', title: 'Invite your staff', href: '/team', done: r.staff },
        { key: 'sale', title: 'Make your first sale', href: '/pos', done: r.sale },
      ];
      return { steps };
    });
  });
}
