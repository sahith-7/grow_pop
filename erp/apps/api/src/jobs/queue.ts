import type { Tx } from '../db.js';

export type JobKind = 'import' | 'woo.product' | 'woo.stock' | 'woo.inbound' | 'woo.reconcile' | 'woo.match' | 'woo.fulfilment' | 'export';

/** Lower runs first. Incoming orders go before stock pushes, so Woo is never told stock an unprocessed order already took. */
const PRIORITY: Record<JobKind, number> = { 'woo.inbound': 1, import: 5, 'woo.stock': 3, 'woo.product': 5, 'woo.reconcile': 7, 'woo.match': 5, 'woo.fulfilment': 2, export: 8 };

/** Queue a background job inside the caller's transaction. A pending job for the same resource is reused (D21). */
export async function enqueue(tx: Tx, kind: JobKind, resourceId: string, opts: { maxAttempts?: number; delaySec?: number } = {}) {
  await tx.query(
    `INSERT INTO sync_jobs (tenant_id, kind, resource_id, max_attempts, priority, next_attempt_at)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, now() + make_interval(secs => $5))
     ON CONFLICT (tenant_id, kind, resource_id) WHERE status = 'pending' DO NOTHING`,
    [kind, resourceId, opts.maxAttempts ?? 8, PRIORITY[kind], opts.delaySec ?? 0]);
}
