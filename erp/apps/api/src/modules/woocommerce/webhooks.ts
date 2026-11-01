import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool, tenantTx } from '../../db.js';
import { enqueue } from '../../jobs/queue.js';
import { audit } from '../../lib/phase1.js';
import { storeInfo } from '../../lib/saas.js';
import { webhookSecret } from './connection.js';
import { readImage } from './media.js';

// The public endpoints WooCommerce calls (T3). No session and no Origin check (server.ts skips /v1/webhooks/ for that).
// Order of checks: token format → token lookup (unknown = bare 404) → Woo's ping → HMAC over the raw body (constant time)
// → inbox insert keyed on topic + body hash (a replay is a no-op, AC-08) → 200. The worker does the rest.

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ACCEPTED = new Set(['order.created', 'order.updated', 'order.deleted', 'order.restored', 'product.deleted']);
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

export async function wooWebhookRoutes(app: FastifyInstance) {
  // Keep the exact bytes: the signature is over them, not over re-serialised JSON. (This plugin only.)
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.post('/woocommerce/:token', {
    bodyLimit: 2 * 1024 * 1024,
    // A bulk status change in Woo sends one webhook per order; Woo disables a webhook after 5 failed deliveries, so be generous.
    config: { rateLimit: { max: 1200, timeWindow: '1 minute', keyGenerator: (req) => `woo:${(req.params as { token?: string }).token ?? ''}` } },
  }, async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!TOKEN.test(token)) return reply.code(404).send();
    const { rows: [hit] } = await pool.query('SELECT tenant_id, connection_id FROM woo_endpoint_lookup($1)', [sha256(token)]);
    if (!hit) return reply.code(404).send();

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const topic = String(req.headers['x-wc-webhook-topic'] ?? '');
    // Woo's "ping" when a webhook is saved: form-encoded webhook_id, unsigned, nothing to do.
    if (!topic && /^webhook_id=\d+$/.test(raw.toString('utf8'))) return reply.code(200).send({ ok: true });

    const tenantId: string = hit.tenant_id;
    // B7: a closed store takes nothing more (04 §1 tenant lifecycle). A suspended one still stores orders for later.
    if ((await storeInfo(tenantId)).state === 'closed') return reply.code(410).send();
    const given = Buffer.from(String(req.headers['x-wc-webhook-signature'] ?? ''), 'utf8');
    const ok = await tenantTx(tenantId, async (tx) => {
      const secret = await webhookSecret(tx);
      if (!secret) return false;
      const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('base64'), 'utf8');
      const good = given.length === expected.length && timingSafeEqual(given, expected);
      if (!good) {
        await audit(tx, { actorId: null, action: 'woo.webhook_rejected', entityType: 'woo_connection', entityId: hit.connection_id,
          summary: { reason: given.length ? 'bad signature' : 'no signature', topic: topic.slice(0, 50), ip: req.ip } });
      }
      return good;
    });
    if (!ok) {
      req.log.warn({ tenantId, topic }, 'woo webhook signature rejected');
      return reply.code(401).send({ code: 'INVALID_SIGNATURE', message: 'Invalid signature', correlationId: req.id, retryable: false });
    }

    let payload: any;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({ code: 'BAD_REQUEST', message: 'Body is not JSON', correlationId: req.id, retryable: false }); }
    const resourceId = Number.isSafeInteger(payload?.id) ? payload.id : null;
    const known = ACCEPTED.has(topic) && resourceId !== null;

    await tenantTx(tenantId, async (tx) => {
      const { rows: [ev] } = await tx.query(
        `INSERT INTO webhook_events (tenant_id, event_key, topic, resource_id, delivery_id, payload, status, processed_at)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, event_key) DO NOTHING RETURNING id`,
        [`${topic}:${sha256(raw).toString('hex')}`, topic.slice(0, 50), resourceId, String(req.headers['x-wc-webhook-delivery-id'] ?? '').slice(0, 100) || null,
          known ? raw.toString('utf8') : null, known ? 'received' : 'ignored', known ? null : new Date()]);
      if (ev && known) await enqueue(tx, 'woo.inbound', ev.id);
    });
    return reply.code(200).send({ ok: true });
  });

  // Product images, for WooCommerce to download while the bucket stays private. Signed, expires in 15 minutes (media.ts).
  app.get('/woocommerce/media/:sig', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { sig } = req.params as { sig: string };
    const img = await readImage(sig);
    if (!img) return reply.code(404).send();
    return reply.header('content-type', img.contentType).header('cache-control', 'private, no-store')
      .header('content-security-policy', "default-src 'none'").header('x-content-type-options', 'nosniff').send(img.body);
  });
}
