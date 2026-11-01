import { pool } from '../db.js';
import { RetryLaterError } from './runner.js';

/**
 * Run `fn` while holding a session advisory lock named `key`, so two workers never push the same product or shop at once
 * (a pending and a running job for one resource can coexist, D21). If another worker holds it, the job is rescheduled.
 * The lock lives on its own connection because `fn` makes HTTP calls outside any transaction.
 */
export async function withJobLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let locked = false;
  try {
    locked = (await c.query('SELECT pg_try_advisory_lock(hashtextextended($1, 42)) AS ok', [key])).rows[0].ok;
    if (!locked) throw new RetryLaterError(5, 'another worker is handling this');
    return await fn();
  } finally {
    if (locked) await c.query('SELECT pg_advisory_unlock(hashtextextended($1, 42))', [key]).catch(() => {});
    c.release();
  }
}

/**
 * Like withJobLock, for a request a person is waiting on: wait up to `waitMs` for the lock instead of rescheduling,
 * then give up with `onBusy()`.
 */
export async function withLockWait<T>(key: string, fn: () => Promise<T>, onBusy: () => Error, waitMs = 30_000): Promise<T> {
  const c = await pool.connect();
  let locked = false;
  try {
    for (const until = Date.now() + waitMs; ;) {
      locked = (await c.query('SELECT pg_try_advisory_lock(hashtextextended($1, 42)) AS ok', [key])).rows[0].ok;
      if (locked) break;
      if (Date.now() > until) throw onBusy();
      await new Promise((r) => setTimeout(r, 250));
    }
    return await fn();
  } finally {
    if (locked) await c.query('SELECT pg_advisory_unlock(hashtextextended($1, 42))', [key]).catch(() => {});
    c.release();
  }
}
