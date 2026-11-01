import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { testOutbox } from '../src/lib/notify.js';
import { codeAt, stepAt } from '../src/lib/totp.js';
import { buildApp } from '../src/server.js';

// TRIDENT Phase 1 sign-in flows: owner authenticator codes (D83), invitations, password reset and change.
const origin = { origin: 'http://localhost:3000' };
const PW = 'correct horse battery';
let app: Awaited<ReturnType<typeof buildApp>>;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => `${res.cookies[0].name}=${res.cookies[0].value}`;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie?: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { ...(method === 'GET' ? {} : origin), ...(cookie ? { cookie } : {}) } });

async function register() {
  const email = `owner-${randomUUID()}@auth.test`;
  const res = await call('POST', '/v1/auth/register', undefined, { businessName: 'Auth shop', name: 'Owner', email, password: PW });
  expect(res.statusCode).toBe(201);
  return { email, cookie: cookieOf(res) };
}
const linkToken = (text: string) => /token=([\w-]+)/.exec(text)![1];
const mailTo = (email: string) => [...testOutbox].reverse().find((m) => m.to.includes(email))!;

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { (config as { OWNER_TOTP: string }).OWNER_TOTP = 'optional'; await app.close(); await pool.end(); });

describe('owner authenticator app (D83)', () => {
  it('when required, an owner without one can only reach setup; after setup, sign-in needs a single-use code', async () => {
    const { email, cookie } = await register();
    (config as { OWNER_TOTP: string }).OWNER_TOTP = 'required';
    try {
      expect((await call('GET', '/v1/products', cookie)).json().code).toBe('TOTP_SETUP_REQUIRED');
      const me = (await call('GET', '/v1/auth/me', cookie)).json();
      expect(me.totp).toEqual({ enabled: false, setupRequired: true });
      expect(me.permissions).toEqual([]);

      const start = (await call('POST', '/v1/auth/totp/start', cookie)).json();
      expect(start.otpauthUri).toContain('otpauth://totp/');
      const wrong = await call('POST', '/v1/auth/totp/confirm', cookie, { code: '000000' });
      expect(wrong.statusCode).toBe(400);
      const step = stepAt(Date.now());
      expect((await call('POST', '/v1/auth/totp/confirm', cookie, { code: codeAt(start.secret, step) })).statusCode).toBe(200);
      expect((await call('GET', '/v1/products', cookie)).statusCode).toBe(200);

      // Password alone is no longer enough.
      const login = (await call('POST', '/v1/auth/login', undefined, { email, password: PW })).json();
      expect(login).toMatchObject({ totpRequired: true });
      // The code used at setup can't be replayed.
      expect((await call('POST', '/v1/auth/login/code', undefined, { challenge: login.challenge, code: codeAt(start.secret, step) })).json().code).toBe('INVALID_CODE');
      const ok = await call('POST', '/v1/auth/login/code', undefined, { challenge: login.challenge, code: codeAt(start.secret, step + 1) });
      expect(ok.statusCode).toBe(200);
      expect((await call('GET', '/v1/auth/me', cookieOf(ok))).json().totp.enabled).toBe(true);
      // The challenge works once.
      expect((await call('POST', '/v1/auth/login/code', undefined, { challenge: login.challenge, code: codeAt(start.secret, step + 1) })).statusCode).toBe(401);
    } finally { (config as { OWNER_TOTP: string }).OWNER_TOTP = 'optional'; }
  });

  it('a challenge dies after 5 wrong codes, and a forged one is refused', async () => {
    const { email, cookie } = await register();
    const start = (await call('POST', '/v1/auth/totp/start', cookie)).json();
    await call('POST', '/v1/auth/totp/confirm', cookie, { code: codeAt(start.secret, stepAt(Date.now())) });
    const { challenge } = (await call('POST', '/v1/auth/login', undefined, { email, password: PW })).json();
    for (let i = 0; i < 5; i++) await call('POST', '/v1/auth/login/code', undefined, { challenge, code: '000000' });
    const r = await call('POST', '/v1/auth/login/code', undefined, { challenge, code: codeAt(start.secret, stepAt(Date.now()) + 1) });
    expect(r.json().code).toBe('CHALLENGE_EXPIRED');
    expect((await call('POST', '/v1/auth/login/code', undefined, { challenge: `${randomUUID()}.forged`, code: '123456' })).statusCode).toBe(401);
  });

  it('staff cannot start an authenticator setup', async () => {
    const { cookie } = await register();
    const invited = await call('POST', '/v1/users/invite', cookie, { email: `c-${randomUUID()}@auth.test`, name: 'C', role: 'cashier' });
    const token = linkToken(mailTo(invited.json().email).text);
    const joined = await call('POST', '/v1/auth/accept-invite', undefined, { token, password: PW });
    expect((await call('POST', '/v1/auth/totp/start', cookieOf(joined))).statusCode).toBe(403);
  });
});

describe('invitations, resets and password changes', () => {
  it('an invitation link sets the password once and signs the person in', async () => {
    const { cookie } = await register();
    const email = `inv-${randomUUID()}@auth.test`;
    expect((await call('POST', '/v1/users/invite', cookie, { email, name: 'New person', role: 'inventory' })).statusCode).toBe(201);
    const token = linkToken(mailTo(email).text);
    expect((await call('POST', '/v1/auth/accept-invite', undefined, { token, password: 'short' })).statusCode).toBe(400);
    const res = await call('POST', '/v1/auth/accept-invite', undefined, { token, password: PW });
    expect(res.statusCode).toBe(200);
    expect((await call('GET', '/v1/auth/me', cookieOf(res))).json().user.role).toBe('inventory');
    expect((await call('POST', '/v1/auth/accept-invite', undefined, { token, password: PW })).json().code).toBe('INVALID_TOKEN');
    // A reset link can't be used as an invitation and the other way round.
    expect((await call('POST', '/v1/auth/reset-password', undefined, { token, password: PW })).statusCode).toBe(400);
  });

  it('a resend replaces the earlier invitation link', async () => {
    const { cookie } = await register();
    const email = `re-${randomUUID()}@auth.test`;
    const u = (await call('POST', '/v1/users/invite', cookie, { email, name: 'R', role: 'cashier' })).json();
    const first = linkToken(mailTo(email).text);
    expect((await call('POST', `/v1/users/${u.id}/resend-invite`, cookie)).statusCode).toBe(200);
    const second = linkToken(mailTo(email).text);
    expect(second).not.toBe(first);
    expect((await call('POST', '/v1/auth/accept-invite', undefined, { token: first, password: PW })).statusCode).toBe(400);
    expect((await call('POST', '/v1/auth/accept-invite', undefined, { token: second, password: PW })).statusCode).toBe(200);
  });

  it('a reset link changes the password, ends other sessions, and works once', async () => {
    const { email, cookie } = await register();
    await call('POST', '/v1/auth/forgot-password', undefined, { email });
    const token = linkToken(mailTo(email).text);
    const res = await call('POST', '/v1/auth/reset-password', undefined, { token, password: 'a brand new long password' });
    expect(res.statusCode).toBe(200);
    expect((await call('GET', '/v1/auth/me', cookie)).statusCode).toBe(401);
    expect((await call('POST', '/v1/auth/login', undefined, { email, password: PW })).statusCode).toBe(401);
    expect((await call('POST', '/v1/auth/login', undefined, { email, password: 'a brand new long password' })).statusCode).toBe(200);
    expect((await call('POST', '/v1/auth/reset-password', undefined, { token, password: PW })).statusCode).toBe(400);
  });

  it('changing the password needs the current one and signs out other devices', async () => {
    const { email, cookie } = await register();
    const other = cookieOf(await call('POST', '/v1/auth/login', undefined, { email, password: PW }));
    expect((await call('POST', '/v1/auth/change-password', cookie, { currentPassword: 'nope', newPassword: 'another long password' })).statusCode).toBe(400);
    expect((await call('POST', '/v1/auth/change-password', cookie, { currentPassword: PW, newPassword: 'another long password' })).statusCode).toBe(200);
    expect((await call('GET', '/v1/auth/me', cookie)).statusCode).toBe(200);
    expect((await call('GET', '/v1/auth/me', other)).statusCode).toBe(401);
  });

  it('logout ends the session; a duplicate e-mail and a role change behave', async () => {
    const { email, cookie } = await register();
    expect((await call('POST', '/v1/auth/register', undefined, { businessName: 'Dup', name: 'D', email, password: PW })).json().code).toBe('EMAIL_TAKEN');
    const staffEmail = `s-${randomUUID()}@auth.test`;
    const s = (await call('POST', '/v1/users/invite', cookie, { email: staffEmail, name: 'S', role: 'cashier' })).json();
    const sc = cookieOf(await call('POST', '/v1/auth/accept-invite', undefined, { token: linkToken(mailTo(staffEmail).text), password: PW }));
    expect((await call('PATCH', `/v1/users/${s.id}`, cookie, { role: 'manager' })).json().role).toBe('manager');
    expect((await call('GET', '/v1/auth/me', sc)).statusCode).toBe(401);   // role change signs them out
    await call('POST', '/v1/auth/logout', cookie);
    expect((await call('GET', '/v1/auth/me', cookie)).statusCode).toBe(401);
  });
});
