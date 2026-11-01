import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx } from '../../db.js';
import { enqueue } from '../../jobs/queue.js';
import { decodeCursor, encodeCursor, limitParam } from '../../lib/pagination.js';
import { appError, audit, authOf, can, requires } from '../../lib/phase1.js';
import { connect, disconnect, setOnlineLocation, status, testConnection } from './connection.js';
import { confirmMatch } from './match.js';

const tx = <T>(req: FastifyRequest, fn: Parameters<typeof tenantTx<T>>[1]) => tenantTx(authOf(req).tenantId, fn);

const connectInput = z.object({
  siteUrl: z.string().trim().min(8).max(300),
  consumerKey: z.string().trim().regex(/^ck_[a-f0-9]{40}$/, 'A consumer key starts with ck_ followed by 40 letters and digits'),
  consumerSecret: z.string().trim().regex(/^cs_[a-f0-9]{40}$/, 'A consumer secret starts with cs_ followed by 40 letters and digits'),
}).strict();
const settingsInput = z.object({ onlineLocationId: z.string().uuid() }).strict();
const idParam = z.object({ id: z.string().uuid() });
const jobsQuery = z.object({
  status: z.enum(['pending', 'running', 'failed', 'dead', 'done', 'problems']).optional(),
  kind: z.enum(['woo.product', 'woo.stock', 'woo.inbound', 'woo.reconcile', 'woo.match']).optional(),
  limit: limitParam, cursor: z.string().optional(),
}).strict();

// Rate limits on the calls that reach out to the shop, so the screen cannot be used to hammer a third-party site.
const outbound = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export async function wooRoutes(app: FastifyInstance) {
  const manage = { preHandler: requires('sync.manage') };
  const owner = { preHandler: requires('woo.connect'), config: outbound };

  app.get('/integrations/woocommerce', manage, async (req) => ({ ...(await tx(req, status)), can: { connect: can(req, 'woo.connect') } }));

  app.post('/integrations/woocommerce/test', owner, async (req) => {
    const r = await testConnection(connectInput.parse(req.body));
    const { siteUrl: _drop, ...out } = r;
    return out;
  });

  app.put('/integrations/woocommerce', owner, async (req) => {
    const input = connectInput.parse(req.body);
    const { tenantId, userId } = authOf(req);
    return connect(tenantId, userId, input);
  });

  app.delete('/integrations/woocommerce', owner, async (req, reply) => {
    const { tenantId, userId } = authOf(req);
    await disconnect(tenantId, userId);
    return reply.code(204).send();
  });

  app.patch('/integrations/woocommerce', { preHandler: requires('woo.connect') }, async (req) => {
    const input = settingsInput.parse(req.body);
    return tx(req, async (t) => { await setOnlineLocation(t, authOf(req).userId, input.onlineLocationId); return status(t); });
  });

  // ---------------------------------------------------------------- first SKU match (J9)
  app.get('/integrations/woocommerce/match', manage, async (req) => tx(req, async (t) => {
    const { rows: [c] } = await t.query("SELECT match_state, match_result FROM woo_connections WHERE status <> 'disconnected'");
    if (!c) throw appError(404, 'NOT_CONNECTED', 'WooCommerce is not connected');
    return { state: c.match_state, ...(c.match_result ?? {}) };
  }));

  app.post('/integrations/woocommerce/match', { ...manage, config: outbound }, async (req, reply) => {
    await tx(req, async (t) => {
      const { rows: [c] } = await t.query("SELECT id, match_state FROM woo_connections WHERE status <> 'disconnected'");
      if (!c) throw appError(404, 'NOT_CONNECTED', 'WooCommerce is not connected');
      await enqueue(t, 'woo.match', c.id);
      await t.query("UPDATE woo_connections SET match_state = CASE WHEN match_state = 'confirmed' THEN 'confirmed' ELSE 'running' END");
    });
    return reply.code(202).send({ queued: true });
  });

  app.post('/integrations/woocommerce/match/confirm', manage, async (req) => tx(req, (t) => confirmMatch(t, authOf(req).userId)));

  // ---------------------------------------------------------------- jobs, retry, reconcile (J10)
  app.get('/sync/jobs', manage, async (req) => {
    const q = jobsQuery.parse(req.query);
    const after = decodeCursor(q.cursor, z.tuple([z.string(), z.string().uuid()]));
    return tx(req, async (t) => {
      const where = ["j.kind LIKE 'woo.%'"];
      const params: unknown[] = [];
      const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
      if (q.status === 'problems') where.push("j.status IN ('failed', 'dead')");
      else if (q.status) add('j.status = ?', q.status);
      if (q.kind) add('j.kind = ?', q.kind);
      if (after) { params.push(after[0], after[1]); where.push(`(j.created_at, j.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`); }
      params.push(q.limit + 1);
      const { rows } = await t.query(
        `SELECT j.id, j.kind, j.resource_id, j.status, j.attempts, j.max_attempts, j.next_attempt_at, j.last_error, j.created_at, j.done_at,
                p.name AS product_name, o.number AS order_number, e.topic
           FROM sync_jobs j
           LEFT JOIN products p ON j.kind = 'woo.product' AND p.id = j.resource_id
           LEFT JOIN webhook_events e ON j.kind = 'woo.inbound' AND e.id = j.resource_id
           LEFT JOIN sales_orders o ON e.topic LIKE 'order.%' AND o.channel = 'woocommerce' AND o.external_id = e.resource_id::text
          WHERE ${where.join(' AND ')} ORDER BY j.created_at DESC, j.id DESC LIMIT $${params.length}`, params);
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((r) => ({
          id: r.id, kind: r.kind, status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts,
          nextAttemptAt: r.status === 'pending' ? r.next_attempt_at : null, lastError: r.last_error, createdAt: r.created_at, doneAt: r.done_at,
          resource: r.kind === 'woo.product' ? { type: 'product', id: r.resource_id, label: r.product_name ?? 'Deleted product' }
            : r.kind === 'woo.inbound' ? { type: 'order', id: r.resource_id, label: r.order_number ? `Order #${r.order_number}` : (r.topic ?? 'Webhook') }
            : { type: 'shop', id: r.resource_id, label: { 'woo.stock': 'Stock levels', 'woo.reconcile': 'Reconcile', 'woo.match': 'Product match' }[r.kind as string] ?? r.kind },
        })),
        nextCursor: rows.length > q.limit ? encodeCursor([page[page.length - 1].created_at.toISOString(), page[page.length - 1].id]) : null,
      };
    });
  });

  app.post('/sync/jobs/:id/retry', manage, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const out = await tx(req, async (t) => {
      const { rows: [j] } = await t.query("SELECT id, kind, resource_id, status FROM sync_jobs WHERE id = $1 AND kind LIKE 'woo.%' FOR UPDATE", [id]);
      if (!j) throw appError(404, 'NOT_FOUND', 'Job not found');
      if (j.status !== 'failed' && j.status !== 'dead') throw appError(409, 'INVALID_STATE', 'Only failed jobs can be retried');
      const { rows: [dup] } = await t.query("SELECT id FROM sync_jobs WHERE kind = $1 AND resource_id = $2 AND status = 'pending'", [j.kind, j.resource_id]);
      if (dup) await t.query("UPDATE sync_jobs SET status = 'done', done_at = now(), last_error = 'Replaced by a newer job' WHERE id = $1", [id]);
      else await t.query("UPDATE sync_jobs SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_by = NULL WHERE id = $1", [id]);
      if (j.kind === 'woo.product') await t.query("UPDATE products SET publish_state = 'queued', publish_error = NULL WHERE id = $1", [j.resource_id]);
      await audit(t, { actorId: authOf(req).userId, action: 'sync.job_retried', entityType: 'sync_job', entityId: id, summary: { kind: j.kind } });
      return { id, status: 'pending' };
    });
    return reply.code(202).send(out);
  });

  app.post('/sync/reconcile', { ...manage, config: outbound }, async (req, reply) => {
    await tx(req, async (t) => {
      const { rows: [c] } = await t.query("SELECT id FROM woo_connections WHERE status <> 'disconnected'");
      if (!c) throw appError(404, 'NOT_CONNECTED', 'WooCommerce is not connected');
      await enqueue(t, 'woo.reconcile', c.id);
      await audit(t, { actorId: authOf(req).userId, action: 'sync.reconcile_requested', entityType: 'woo_connection', entityId: c.id });
    });
    return reply.code(202).send({ queued: true });
  });

  // ---------------------------------------------------------------- publish one product (CAT-07)
  app.post('/products/:id/publish', manage, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await tx(req, async (t) => {
      const { rows: [c] } = await t.query("SELECT match_state FROM woo_connections WHERE status <> 'disconnected'");
      if (!c) throw appError(409, 'NOT_CONNECTED', 'Connect WooCommerce first');
      if (c.match_state !== 'confirmed') throw appError(409, 'MATCH_NOT_CONFIRMED', 'Review and confirm the product match on the WooCommerce screen first');
      const { rows: [p] } = await t.query('SELECT id, status FROM products WHERE id = $1 FOR UPDATE', [id]);
      if (!p) throw appError(404, 'NOT_FOUND', 'Product not found');
      if (p.status !== 'active') throw appError(409, 'INVALID_STATE', 'Only active products can be sold online');
      // Deleted in Woo earlier: the owner chose to put it back.
      await t.query("DELETE FROM woo_product_map WHERE product_id = $1 AND state = 'deleted_in_woo'", [id]);
      await t.query("UPDATE products SET publish_to_web = true, publish_state = 'queued', publish_error = NULL WHERE id = $1", [id]);
      await enqueue(t, 'woo.product', id);
      await audit(t, { actorId: authOf(req).userId, action: 'product.publish_requested', entityType: 'product', entityId: id });
    });
    return reply.code(202).send({ queued: true });
  });
}
