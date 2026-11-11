import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config, isProd } from '../../config.js';
import { pool } from '../../db.js';
import { appError } from '../../lib/phase1.js';
import { open } from '../../lib/secret-box.js';
import { saasEnv } from '../../lib/saas-env.js';
import { verify as verifyCode } from '../../lib/totp.js';

// The platform console (B7, D70): for the people who run the service, not for stores. Its own accounts (created with
// scripts/platform-admin.ts), password + authenticator code on every sign-in, 8-hour sessions that end after 30 idle
// minutes. Every read and change goes through a SECURITY DEFINER function that checks the session first and writes the
// console's own audit log; the app's database role cannot touch the platform tables directly.

export const ADMIN_COOKIE = isProd ? '__Host-tz_admin' : 'tz_admin';
const sha256 = (s: string) => createHash('sha256').update(s).digest();
// Same work as a real check when the e-mail is unknown, so response time does not reveal which e-mails exist.
const DUMMY_HASH = await argon2.hash('not-a-real-password', { type: argon2.argon2id });

const sessionHash = (req: FastifyRequest) => {
  const t = req.cookies?.[ADMIN_COOKIE];
  if (!t || !/^[A-Za-z0-9_-]{43}$/.test(t)) throw appError(401, 'PLATFORM_AUTH', 'Sign in to the console');
  return sha256(t);
};

/** Runs a platform function and turns its errors into API errors. */
async function call<T = Record<string, any>>(sql: string, params: unknown[]): Promise<T[]> {
  try {
    return (await pool.query(sql, params)).rows as T[];
  } catch (e: any) {
    if (e.code === '42501' && e.hint === 'no_grant') throw appError(403, 'NO_SUPPORT_ACCESS', 'The store owner has not given support access, or it has run out.');
    if (e.code === '42501') throw appError(401, 'PLATFORM_AUTH', 'Your console session has ended. Sign in again.');
    if (e.code === 'P0002') throw appError(404, 'NOT_FOUND', 'Store not found');
    if (e.code === '22023' || e.code === '55000') throw appError(409, 'NOT_ALLOWED', e.message);
    if (e.code === '23505') throw appError(409, 'DUPLICATE', 'That payment reference has already been recorded');
    if (e.code === '23503') throw appError(400, 'VALIDATION_ERROR', 'Unknown plan', { planId: ['Unknown plan'] });
    throw e;
  }
}

const id = z.object({ id: z.string().uuid() });
const reason = z.string().trim().min(3, 'Say why').max(300);

export async function platformRoutes(app: FastifyInstance) {
  // Per address: 10 tries in 15 minutes (tests sign in many times from one address). Per account: 5 wrong → 15-minute lock.
  app.post('/login', { config: { rateLimit: { max: config.NODE_ENV === 'test' ? 1000 : 10, timeWindow: '15 minutes' } } }, async (req, reply: FastifyReply) => {
    const b = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200), code: z.string().trim().max(10) }).strict().parse(req.body);
    const wrong = () => appError(401, 'LOGIN_FAILED', 'E-mail, password or code is wrong');
    const [a] = await call('SELECT * FROM platform_login_lookup($1)', [b.email.toLowerCase()]);
    if (!a) { await argon2.verify(DUMMY_HASH, b.password).catch(() => false); throw wrong(); }
    if (a.status !== 'active') throw wrong();
    if (a.locked_until && new Date(a.locked_until) > new Date()) throw appError(429, 'LOCKED', 'Too many wrong attempts. Try again in 15 minutes.');
    const passwordOk = await argon2.verify(a.password_hash, b.password).catch(() => false);
    const step = passwordOk ? verifyCode(open(a.totp_secret_enc, 'platform', `platform-totp:${a.id}`), b.code) : null;
    if (!passwordOk || step === null || step <= Number(a.totp_last_step)) {
      await call('SELECT platform_login_result($1, false, 0, NULL, NULL, $2)', [a.id, req.ip]);
      throw wrong();
    }
    const token = randomBytes(32).toString('base64url');
    const [r] = await call<{ ok: boolean }>('SELECT platform_login_result($1, true, $2, $3, $4, $5) AS ok',
      [a.id, step, sha256(token), String(req.headers['user-agent'] ?? ''), req.ip]);
    if (!r.ok) throw wrong();
    reply.setCookie(ADMIN_COOKIE, token, { path: '/', httpOnly: true, secure: isProd, sameSite: 'strict', maxAge: 8 * 3600 });
    return { ok: true };
  });

  app.post('/logout', async (req, reply) => {
    const t = req.cookies?.[ADMIN_COOKIE];
    if (t) await pool.query('SELECT platform_logout($1)', [sha256(t)]);
    reply.clearCookie(ADMIN_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const [me] = await call('SELECT * FROM platform_whoami($1)', [sessionHash(req)]);
    return { id: me.id, email: me.email, name: me.name };
  });

  app.get('/plans', async (req) => {
    await call('SELECT * FROM platform_whoami($1)', [sessionHash(req)]);
    const { rows } = await pool.query('SELECT id, name, max_users, features, price_month_paise, price_year_paise FROM plans ORDER BY sort_order, id');
    return { items: rows.map((p) => ({ id: p.id, name: p.name, maxUsers: p.max_users, online: p.features?.online === true,
      priceMonthPaise: p.price_month_paise, priceYearPaise: p.price_year_paise })), gstPercent: saasEnv.BILLING_GST_PERCENT ?? null };
  });

  app.get('/tenants', async (req) => {
    const rows = await call('SELECT * FROM platform_tenants($1)', [sessionHash(req)]);
    return { items: rows.map((t) => ({ id: t.id, name: t.name, createdAt: t.created_at, state: t.state, storeCode: t.store_code,
      planId: t.plan_id, planName: t.plan_name, trialEndsAt: t.trial_ends_at, paidUntil: t.paid_until, ownerEmail: t.owner_email,
      users: t.users, lastSeenAt: t.last_seen_at })) };
  });

  app.get('/tenants/:id', async (req) => {
    const { id: tenant } = id.parse(req.params);
    const [r] = await call<{ t: Record<string, unknown> | null }>('SELECT platform_tenant($1, $2) AS t', [sessionHash(req), tenant]);
    if (!r?.t) throw appError(404, 'NOT_FOUND', 'Store not found');
    const [o] = await call<{ o: unknown }>('SELECT platform_tenant_outlets($1, $2) AS o', [sessionHash(req), tenant]);
    return { ...r.t, outlets: o.o };
  });

  app.post('/tenants/:id/payments', async (req, reply) => {
    const { id: tenant } = id.parse(req.params);
    const b = z.object({
      amountPaise: z.number().int().min(100).max(10_000_000),
      method: z.enum(['upi', 'bank', 'cash', 'other']),
      reference: z.string().trim().min(4, 'The UPI transaction id or bank reference').max(100),
      paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      planId: z.string().min(1).max(40),
      months: z.number().int().min(1).max(36),
      note: z.string().trim().max(300).optional(),
    }).strict().parse(req.body);
    const [r] = await call('SELECT * FROM platform_record_payment($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [sessionHash(req), tenant, b.amountPaise, b.method, b.reference, b.paidOn, b.planId, b.months, b.note || null, req.ip]);
    return reply.code(201).send({ receiptNo: r.receipt_no, periodFrom: r.period_from, periodTo: r.period_to });
  });

  app.post('/tenants/:id/state', async (req) => {
    const { id: tenant } = id.parse(req.params);
    const b = z.object({ state: z.enum(['active', 'past_due', 'suspended', 'closed']), reason }).strict().parse(req.body);
    await call('SELECT platform_set_state($1, $2, $3, $4, $5)', [sessionHash(req), tenant, b.state, b.reason, req.ip]);
    return { ok: true };
  });

  app.post('/tenants/:id/trial', async (req) => {
    const { id: tenant } = id.parse(req.params);
    const b = z.object({ until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason }).strict().parse(req.body);
    // End of that day in India; the console is run from India.
    await call("SELECT platform_set_trial($1, $2, ($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata', $4, $5)",
      [sessionHash(req), tenant, b.until, b.reason, req.ip]);
    return { ok: true };
  });

  app.post('/tenants/:id/plan', async (req) => {
    const { id: tenant } = id.parse(req.params);
    const b = z.object({ planId: z.string().min(1).max(40), reason }).strict().parse(req.body);
    await call('SELECT platform_set_plan($1, $2, $3, $4, $5)', [sessionHash(req), tenant, b.planId, b.reason, req.ip]);
    return { ok: true };
  });

  // Extra outlets (v2, D101): switched on after the owner pays for them.
  app.post('/tenants/:id/outlets', async (req) => {
    const { id: tenant } = id.parse(req.params);
    const b = z.object({ extraOutlets: z.number().int().min(0).max(50), reason }).strict().parse(req.body);
    await call('SELECT platform_set_outlets($1, $2, $3, $4, $5)', [sessionHash(req), tenant, b.extraOutlets, b.reason, req.ip]);
    return { ok: true };
  });

  app.get('/tenants/:id/support', async (req) => {
    const { id: tenant } = id.parse(req.params);
    const [r] = await call<{ v: unknown }>('SELECT platform_support_view($1, $2, $3) AS v', [sessionHash(req), tenant, req.ip]);
    return r.v;
  });

  app.get('/audit', async (req) => {
    const rows = await call('SELECT * FROM platform_audit_log($1, 200)', [sessionHash(req)]);
    return { items: rows.map((r) => ({ id: Number(r.id), adminEmail: r.admin_email, action: r.action, tenantId: r.tenant_id,
      detail: r.detail, ip: r.ip, at: r.created_at })) };
  });
}
