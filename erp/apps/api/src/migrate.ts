import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is required');

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  await c.query('SELECT pg_advisory_lock(727274)');
  await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await c.query('BEGIN');
    try {
      await c.query(readFileSync(path.join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      console.log('applied', f);
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  }
} finally {
  await c.end();
}
