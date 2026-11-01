import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pool, tenantTx } from '../src/db.js';
import { createSession } from '../src/lib/session.js';
import { buildApp } from '../src/server.js';

// Superuser pool for assertions the runtime role is not allowed to make. B7: CI migrates as a non-superuser owner,
// like RDS (D77), and FORCE RLS hides rows from that owner, so assertions use TEST_SUPERUSER_URL when it is set.
export const owner = new pg.Pool({ connectionString: process.env.TEST_SUPERUSER_URL ?? process.env.MIGRATION_DATABASE_URL });

let app: FastifyInstance | undefined;
export async function getApp() { return (app ??= await buildApp()); }

let cookieName = 'sid';

/** A new tenant with its owner, created through Phase 1's real sign-up route so it always fits the current schema. */
export async function makeTenant() {
  const email = `owner-${randomUUID()}@b2.test`;
  const res = await (await getApp()).inject({
    method: 'POST', url: '/v1/auth/register', headers: { origin: 'http://localhost:3000' },
    payload: { businessName: `Shop ${randomUUID().slice(0, 8)}`, name: 'Owner', email, password: 'correct horse battery' },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  cookieName = res.cookies[0].name;
  const cookie = `${cookieName}=${res.cookies[0].value}`;
  const tenantId: string = (await pool.query('SELECT tenant_id FROM auth_user_by_email($1)', [email])).rows[0].tenant_id;
  const me = await (await getApp()).inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
  return { tenantId, userId: me.json().user.id as string, cookie };
}

/** An active staff user with a live session (invite emails can't be followed in tests), using Phase 1's own createSession. */
export async function makeUser(tenantId: string, role: 'manager' | 'inventory' | 'cashier' | 'fulfillment') {
  return tenantTx(tenantId, async (tx) => {
    const { rows } = await tx.query(
      "INSERT INTO users (tenant_id, email, name, role, status) VALUES ($1, $2, 'B2 test', $3, 'active') RETURNING id",
      [tenantId, `${role}-${randomUUID()}@b2.test`, role]);
    const token = await createSession(tx, tenantId, rows[0].id, { headers: {} } as FastifyRequest);
    return { userId: rows[0].id as string, cookie: `${cookieName}=${token}` };
  });
}
