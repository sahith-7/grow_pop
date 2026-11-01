import pg from 'pg';
import { config } from './config.js';

export type Tx = pg.PoolClient;
export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000 });

/** Run `fn` in a transaction scoped to one tenant. RLS reads app.tenant_id, so every query is tenant-filtered by the database. */
export async function tenantTx<T>(tenantId: string, fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
