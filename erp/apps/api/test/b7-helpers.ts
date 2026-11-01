import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { seal } from '../src/lib/secret-box.js';
import { codeAt, newSecret, stepAt } from '../src/lib/totp.js';
import { getApp, owner } from './b2-helpers.js';

export const PASSWORD = 'console password 123';

/** A console account, created the way scripts/platform-admin.ts does it. */
export async function makeAdmin() {
  const email = `admin-${randomUUID().slice(0, 8)}@platform.test`;
  const secret = newSecret();
  const { rows: [a] } = await owner.query(
    "INSERT INTO platform_admins (email, name, password_hash, totp_secret_enc) VALUES ($1, 'Admin', $2, '\\x00') RETURNING id",
    [email, await argon2.hash(PASSWORD, { type: argon2.argon2id })]);
  await owner.query('UPDATE platform_admins SET totp_secret_enc = $2 WHERE id = $1', [a.id, seal(secret, 'platform', `platform-totp:${a.id}`)]);
  return { id: a.id as string, email, secret, code: (offset = 0) => codeAt(secret, stepAt(Date.now()) + offset) };
}

export async function adminLogin(body: Record<string, unknown>) {
  const res = await (await getApp()).inject({
    method: 'POST', url: '/v1/platform/login', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, payload: JSON.stringify(body),
  });
  const c = res.cookies.find((x) => x.name === 'tz_admin');
  return { status: res.statusCode, body: res.json(), cookie: c ? `tz_admin=${c.value}` : '' };
}

/** A signed-in console session. */
export async function adminSession() {
  const a = await makeAdmin();
  const r = await adminLogin({ email: a.email, password: PASSWORD, code: a.code() });
  if (r.status !== 200) throw new Error(`admin login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...a, cookie: r.cookie };
}

export const setSub = (tenantId: string, sql: string, params: unknown[] = []) =>
  owner.query(`UPDATE subscriptions SET ${sql} WHERE tenant_id = $1`, [tenantId, ...params]);
export const subOf = async (tenantId: string) => (await owner.query('SELECT * FROM subscriptions WHERE tenant_id = $1', [tenantId])).rows[0];
