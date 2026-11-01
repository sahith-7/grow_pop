import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, tenantTx } from '../src/db.js';
import { hashPassword } from '../src/lib/crypto.js';
import { buildApp } from '../src/server.js';

const origin = { origin: 'http://localhost:3000' };
const PW = 'correct horse battery';
let app: Awaited<ReturnType<typeof buildApp>>;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => `${res.cookies[0].name}=${res.cookies[0].value}`;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie?: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { ...(method === 'GET' ? {} : origin), ...(cookie ? { cookie } : {}) } });

async function register(tag: string) {
  const res = await call('POST', '/v1/auth/register', undefined, { businessName: `Shop ${tag}`, name: 'Owner', email: `owner-${tag}-${randomUUID()}@t.test`, password: PW });
  expect(res.statusCode).toBe(201);
  return cookieOf(res);
}
const tenantIdOf = async (cookie: string) => {
  const me = (await call('GET', '/v1/auth/me', cookie)).json();
  return me.user.id as string;
};

// Creates an active staff user directly (invite emails aren't observable in tests) and signs in through the real login route.
async function staff(cookieOwner: string, role: string) {
  const ownerId = await tenantIdOf(cookieOwner);
  const email = `${role}-${randomUUID()}@t.test`;
  const owner = (await call('GET', '/v1/users', cookieOwner)).json().find((u: any) => u.id === ownerId);
  const t = (await pool.query('SELECT * FROM auth_user_by_email($1)', [owner.email])).rows[0].tenant_id;
  const id = await tenantTx(t, async (c) =>
    (await c.query("INSERT INTO users (tenant_id,email,name,password_hash,role,status) VALUES ($1,$2,'Staff',$3,$4,'active') RETURNING id", [t, email, await hashPassword(PW), role])).rows[0].id);
  const res = await call('POST', '/v1/auth/login', undefined, { email, password: PW });
  expect(res.statusCode).toBe(200);
  return { cookie: cookieOf(res), id, tenantId: t as string };
}

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); });

describe('tenant isolation (AC-01)', () => {
  it('one tenant cannot see or change another tenant, via API or database', async () => {
    const a = await register('a');
    const b = await register('b');
    await call('POST', '/v1/users/invite', a, { email: `inv-${randomUUID()}@t.test`, name: 'Invitee', role: 'cashier' });

    const aUsers = (await call('GET', '/v1/users', a)).json();
    const bUsers = (await call('GET', '/v1/users', b)).json();
    expect(aUsers).toHaveLength(2);
    expect(bUsers).toHaveLength(1);

    // guessed ID from the other tenant behaves as not found
    const victim = aUsers.find((u: any) => u.role === 'cashier').id;
    expect((await call('PATCH', `/v1/users/${victim}`, b, { status: 'disabled' })).statusCode).toBe(404);

    // RLS itself: no tenant context -> zero rows; wrong tenant context -> zero rows
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(0);
    const bTenant = (await pool.query('SELECT * FROM auth_user_by_email($1)', [(bUsers[0]).email])).rows[0].tenant_id;
    const seen = await tenantTx(bTenant, async (c) => (await c.query('SELECT 1 FROM users WHERE id = $1', [victim])).rowCount);
    expect(seen).toBe(0);
    await expect(tenantTx(bTenant, (c) => c.query("INSERT INTO store_settings (tenant_id) VALUES (gen_random_uuid())"))).rejects.toThrow();
  });
});

describe('access control', () => {
  it('rejects unauthenticated and cross-origin writes', async () => {
    expect((await call('GET', '/v1/users')).statusCode).toBe(401);
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'x@t.test', password: 'x' }, headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
  });

  it('enforces permissions on the server and revokes access immediately', async () => {
    const owner = await register('perm');
    const cashier = await staff(owner, 'cashier');
    expect((await call('GET', '/v1/users', cashier.cookie)).statusCode).toBe(403);
    expect((await call('GET', '/v1/settings', cashier.cookie)).statusCode).toBe(403);
    expect((await call('GET', '/v1/auth/me', cashier.cookie)).statusCode).toBe(200);

    const res = await call('PATCH', `/v1/users/${cashier.id}`, owner, { status: 'disabled' });
    expect(res.statusCode).toBe(200);
    expect((await call('GET', '/v1/auth/me', cashier.cookie)).statusCode).toBe(401);
  });

  it('protects the owner account', async () => {
    const owner = await register('own');
    const ownerId = await tenantIdOf(owner);
    expect((await call('PATCH', `/v1/users/${ownerId}`, owner, { status: 'disabled' })).statusCode).toBe(403);
  });
});

describe('authentication', () => {
  it('locks an account after repeated failures and gives a generic error', async () => {
    const email = `lock-${randomUUID()}@t.test`;
    await call('POST', '/v1/auth/register', undefined, { businessName: 'Lock', name: 'L', email, password: PW });
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/v1/auth/login', undefined, { email, password: 'wrong-password-123' });
      expect(r.json().code).toBe('INVALID_CREDENTIALS');
    }
    const r = await call('POST', '/v1/auth/login', undefined, { email, password: PW });
    expect(r.statusCode).toBe(401); // locked, even with the right password
  });

  it('forgot-password answers identically for unknown emails', async () => {
    const r = await call('POST', '/v1/auth/forgot-password', undefined, { email: 'nobody@t.test' });
    expect(r.statusCode).toBe(202);
  });
});

describe('plan limits and audit', () => {
  it('enforces the seat limit', async () => {
    const owner = await register('seat');
    for (let i = 0; i < 2; i++)
      expect((await call('POST', '/v1/users/invite', owner, { email: `s${i}-${randomUUID()}@t.test`, name: 'S', role: 'inventory' })).statusCode).toBe(201);
    const third = await call('POST', '/v1/users/invite', owner, { email: `s3-${randomUUID()}@t.test`, name: 'S', role: 'inventory' });
    expect(third.statusCode).toBe(409);
    expect(third.json().code).toBe('SEAT_LIMIT');
  });

  it('records audit events that cannot be altered by the app role', async () => {
    const owner = await register('aud');
    await call('PATCH', '/v1/settings', owner, { name: 'Renamed shop', gstin: '27AAPFU0939F1ZV' });
    const log = (await call('GET', '/v1/audit', owner)).json();
    expect(log.items.map((e: any) => e.action)).toEqual(expect.arrayContaining(['tenant.registered', 'settings.updated']));
    const t = (await pool.query('SELECT * FROM auth_user_by_email($1)', [(await call('GET', '/v1/auth/me', owner)).json().user.email])).rows[0].tenant_id;
    await expect(tenantTx(t, (c) => c.query('UPDATE audit_events SET action = $1', ['x']))).rejects.toThrow(/permission denied/);
    await expect(tenantTx(t, (c) => c.query('DELETE FROM audit_events'))).rejects.toThrow(/permission denied/);
  });

  it('rejects an invalid GSTIN', async () => {
    const owner = await register('gst');
    const r = await call('PATCH', '/v1/settings', owner, { gstin: 'NOT-A-GSTIN' });
    expect(r.statusCode).toBe(400);
    expect(r.json().fieldErrors.gstin).toBeTruthy();
  });
});
