import { hostname } from 'node:os';
import type { FastifyBaseLogger } from 'fastify';
import { pool, tenantTx, type Tx } from '../db.js';
import { jobGate } from '../lib/saas.js';
import type { JobKind } from './queue.js';

export interface Job { id: string; tenantId: string; kind: JobKind; resourceId: string }
type Handler = (job: Job) => Promise<void>;

const handlers = new Map<JobKind, Handler>();
export function register(kind: JobKind, handler: Handler) { handlers.set(kind, handler); }

/** Retryable by default. Throw this for errors a retry cannot fix (bad data, missing row). */
export class PermanentJobError extends Error {}

/** Not a failure: run again after `delaySec` without using up an attempt (another worker holds the lock, 429, tenant suspended). */
export class RetryLaterError extends Error {
  constructor(public delaySec: number, message = 'rescheduled') { super(message); }
}

const BATCH = 5;
const POLL_MS = 5_000;
const HEARTBEAT_MS = 60_000;

// A job going back to 'pending' would break the one-pending-per-resource index (D21) when a newer pending job for the same
// resource was queued while this one ran. That newer job does the same work, so this one is closed as done instead.
const SUPERSEDED = `EXISTS (SELECT 1 FROM sync_jobs o WHERE o.tenant_id = sync_jobs.tenant_id AND o.kind = sync_jobs.kind
                     AND o.resource_id = sync_jobs.resource_id AND o.status = 'pending' AND o.id <> sync_jobs.id)`;

async function finish(job: Job, error: unknown) {
  await tenantTx(job.tenantId, async (tx) => {
    if (!error) {
      await tx.query("UPDATE sync_jobs SET status = 'done', done_at = now(), locked_by = NULL, last_error = NULL WHERE id = $1", [job.id]);
      return;
    }
    if (error instanceof RetryLaterError) {
      await tx.query(
        `UPDATE sync_jobs SET locked_by = NULL, attempts = greatest(attempts - 1, 0), last_error = $2,
           status = CASE WHEN ${SUPERSEDED} THEN 'done' ELSE 'pending' END,
           done_at = CASE WHEN ${SUPERSEDED} THEN now() END,
           next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1`,
        [job.id, error.message.slice(0, 1000), error.delaySec]);
      return;
    }
    const msg = String((error as Error)?.message ?? error).slice(0, 1000);
    await tx.query(
      `UPDATE sync_jobs SET locked_by = NULL, last_error = $2,
         status = CASE WHEN $3 THEN 'failed' WHEN attempts >= max_attempts THEN 'dead' WHEN ${SUPERSEDED} THEN 'done' ELSE 'pending' END,
         -- exponential backoff with full jitter: up to 10 s, 20 s, 40 s … capped at 1 h
         next_attempt_at = now() + make_interval(secs => random() * least(3600, 10 * 2 ^ (attempts - 1)))
       WHERE id = $1`,
      [job.id, msg, error instanceof PermanentJobError]);
  });
}

async function runOne(job: Job, log: FastifyBaseLogger) {
  const handler = handlers.get(job.kind);
  // Keep the claim alive so a long import is not reclaimed by another worker after 5 minutes.
  const beat = setInterval(() => {
    tenantTx(job.tenantId, (tx) => tx.query('UPDATE sync_jobs SET locked_at = now() WHERE id = $1', [job.id])).catch(() => {});
  }, HEARTBEAT_MS);
  try {
    if (!handler) throw new PermanentJobError(`no handler for ${job.kind}`);
    // B7: a suspended store's jobs wait (web orders stay in the inbox until it is reactivated); a closed store's are dropped.
    const gate = await jobGate(job.tenantId, job.kind);
    if (gate === 'pause') throw new RetryLaterError(1800, 'store suspended or plan does not include this');
    if (gate === 'stop') throw new PermanentJobError('store closed');
    await handler(job);
    await finish(job, null);
  } catch (e) {
    if (!(e instanceof RetryLaterError)) log.error({ err: e, jobId: job.id, kind: job.kind }, 'job failed');
    await finish(job, e).catch((e2) => log.error({ err: e2, jobId: job.id }, 'could not record job failure'));
  } finally {
    clearInterval(beat);
  }
}

/** Claim and run jobs until stop() is called. Woken by NOTIFY jobs; polls as a fallback. */
export function startRunner(log: FastifyBaseLogger, workerId = `${hostname()}:${process.pid}`) {
  let stopping = false;
  let wake: () => void = () => {};
  let listener: Tx | null = null;

  const connectListener = async () => {
    try {
      const c = await pool.connect();
      listener = c;
      c.on('notification', () => wake());
      c.on('error', () => { c.release(true); listener = null; });
      await c.query('LISTEN jobs');
    } catch (e) { log.warn({ err: e }, 'LISTEN failed; polling only'); listener = null; }
  };

  const loop = (async () => {
    await connectListener();
    while (!stopping) {
      if (!listener) await connectListener();
      let jobs: Job[] = [];
      try {
        const { rows } = await pool.query('SELECT * FROM claim_jobs($1, $2)', [workerId, BATCH]);
        jobs = rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, kind: r.kind, resourceId: r.resource_id }));
      } catch (e) { log.error({ err: e }, 'claim failed'); }
      for (const job of jobs) await runOne(job, log);
      if (jobs.length === BATCH) continue;
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, POLL_MS); wake = () => { clearTimeout(t); resolve(); }; });
    }
    (listener as Tx | null)?.release();
  })();

  return {
    /** Finish the current job, then stop. */
    async stop() { stopping = true; wake(); await loop; },
  };
}
