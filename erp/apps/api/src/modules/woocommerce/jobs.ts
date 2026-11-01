import type { FastifyBaseLogger } from 'fastify';
import { pool, tenantTx } from '../../db.js';
import { enqueue } from '../../jobs/queue.js';
import { register } from '../../jobs/runner.js';
import { pushFulfilment } from './fulfilment.js';
import { processWebhook } from './inbound.js';
import { runMatch } from './match.js';
import { publishProduct } from './publish.js';
import { RECONCILE_EVERY_MIN, reconcile } from './reconcile.js';
import { pushStock } from './stock.js';

register('woo.inbound', (job) => processWebhook(job.tenantId, job.resourceId));
register('woo.product', (job) => publishProduct(job.tenantId, job.resourceId));
register('woo.stock', (job) => pushStock(job.tenantId));
register('woo.reconcile', (job) => reconcile(job.tenantId));
register('woo.match', (job) => runMatch(job.tenantId));
register('woo.fulfilment', (job) => pushFulfilment(job.tenantId, job.resourceId));   // B6

/**
 * Turns outbox rows into jobs, and starts the periodic reconcile. Changes are captured by triggers in the same
 * transaction as the stock or product change (0300), so nothing that commits can be missed; this only decides when
 * the worker acts on them. One pass every 2 s keeps website stock well inside the 10 s target.
 */
export async function sweepOnce() {
  const { rows } = await pool.query('SELECT tenant_id FROM woo_due_tenants(200)');
  for (const { tenant_id: tenantId } of rows) {
    await tenantTx(tenantId, async (tx) => {
      const { rows: [c] } = await tx.query(
        "SELECT id, reconcile_due_at <= now() AS due, match_state FROM woo_connections WHERE status <> 'disconnected'");
      if (!c) { await tx.query('DELETE FROM woo_outbox'); return; }
      // Nothing is pushed to the shop until the owner has reviewed and confirmed the first SKU match (decision 6).
      const { rows: products } = c.match_state !== 'confirmed' ? { rows: [] } : await tx.query(
        "DELETE FROM woo_outbox WHERE kind = 'product' AND id IN (SELECT id FROM woo_outbox WHERE kind = 'product' ORDER BY id LIMIT 500) RETURNING ref_id");
      const ids = [...new Set(products.map((p) => p.ref_id as string))];
      for (const id of ids) await enqueue(tx, 'woo.product', id);
      if (ids.length) await tx.query("UPDATE products SET publish_state = 'queued' WHERE id = ANY($1) AND publish_to_web AND publish_state <> 'queued'", [ids]);
      const { rows: [s] } = await tx.query("SELECT EXISTS (SELECT 1 FROM woo_outbox WHERE kind = 'stock') AS any");
      if (s.any) await enqueue(tx, 'woo.stock', c.id);
      if (c.due) {
        await enqueue(tx, 'woo.reconcile', c.id);
        await tx.query(`UPDATE woo_connections SET reconcile_due_at = now() + interval '${RECONCILE_EVERY_MIN} minutes'`);
      }
    });
  }
}

export function startSweeper(log: FastifyBaseLogger, everyMs = 2000) {
  let stopped = false;
  let timer: NodeJS.Timeout;
  const tick = async () => {
    try { await sweepOnce(); } catch (e) { log.error({ err: e }, 'woo sweep failed'); }
    if (!stopped) timer = setTimeout(tick, everyMs);
  };
  timer = setTimeout(tick, everyMs);
  return { stop() { stopped = true; clearTimeout(timer); } };
}
