import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tenantTx, type Tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { burnPasswordCheck, hashPassword, hashToken, newToken, verifyPassword } from '../lib/crypto.js';
import { AppError, invalid } from '../lib/errors.js';
import { sendMail } from '../lib/notify.js';
import { permissionsOf } from '../lib/permissions.js';
import { open, seal } from '../lib/secret-box.js';
import { clearSessionCookie, createSession, requires, sessionToken, setSessionCookie, totpSetupNeeded } from '../lib/session.js';
import { newSecret, otpauthUri, verify as verifyCode } from '../lib/totp.js';
import { wooEnv } from './woocommerce/env.js';

// Sign-up, sign-in (password, plus an authenticator code for owners who have one), sign-out, invitations and password
// resets. Per-address rate limits on these routes come from lib/auth-limits.ts; per-account lockout is here.

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const RESET_HOURS = 1;
const INVITE_HOURS = 72;
const CHALLENGE_MINUTES = 5;

const email = z.string().trim().toLowerCase().email('Enter a valid e-mail').max(200);
const password = z.string().min(12, 'Use at least 12 characters').max(200);
const code = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');

const badCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'E-mail or password is wrong');
const badToken = () => new AppError(400, 'INVALID_TOKEN', 'This link has expired or was already used. Ask for a new one.');
const totpField = (tenantId: string, userId: string) => `owner-totp:${tenantId}:${userId}`;
const link = (path: string) => `${config.WEB_ORIGIN}${path}`;

async function signIn(c: Tx, tenantId: string, userId: string, req: FastifyRequest, reply: FastifyReply) {
  setSessionCookie(reply, await createSession(c, tenantId, userId, req));
}

/** Records a wrong password; the account locks for 15 minutes after the fifth in a row. */
const failLogin = (c: Tx, userId: string) => c.query(
  `UPDATE users SET failed_logins = failed_logins + 1,
     locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
   WHERE id = $1`, [userId, MAX_FAILED, LOCK_MINUTES]);

export async function authRoutes(app: FastifyInstance) {
  app.post('/register', async (req, reply) => {
    const b = z.object({ businessName: z.string().trim().min(1).max(120), name: z.string().trim().min(1).max(120), email, password }).parse(req.body);
    if (b.password.toLowerCase().includes(b.email.split('@')[0])) throw invalid('password', 'Don’t use your e-mail name in the password');
    const hash = await hashPassword(b.password);
    const tenantId = (await pool.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
    try {
      await tenantTx(tenantId, async (c) => {
        await c.query('INSERT INTO tenants (id, name, legal_name) VALUES ($1, $2, $2)', [tenantId, b.businessName]);
        await c.query('INSERT INTO store_settings (tenant_id) VALUES ($1)', [tenantId]);
        const { rows: [u] } = await c.query(
          "INSERT INTO users (tenant_id, email, name, password_hash, role, status) VALUES ($1, $2, $3, $4, 'owner', 'active') RETURNING id",
          [tenantId, b.email, b.name, hash]);
        await audit(c, { tenantId, actorId: u.id, action: 'tenant.registered', entity: 'tenant', entityId: tenantId, requestId: req.id });
        await signIn(c, tenantId, u.id, req, reply);
      });
    } catch (e: any) {
      if (e.code === '23505') throw new AppError(409, 'EMAIL_TAKEN', 'That e-mail already has an account. Sign in instead.', { email: ['Already registered'] });
      throw e;
    }
    return reply.code(201).send({ ok: true });
  });

  app.post('/login', async (req, reply) => {
    const b = z.object({ email, password: z.string().min(1).max(200) }).parse(req.body);
    const hit = (await pool.query('SELECT * FROM auth_user_by_email($1)', [b.email])).rows[0];
    if (!hit) { await burnPasswordCheck(b.password); throw badCredentials(); }
    const out = await tenantTx(hit.tenant_id, async (c) => {
      const { rows: [u] } = await c.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [hit.id]);
      if (u.status !== 'active' || !u.password_hash) { await burnPasswordCheck(b.password); return null; }
      if (u.locked_until && new Date(u.locked_until) > new Date()) return null;   // locked: even the right password fails
      if (!(await verifyPassword(u.password_hash, b.password))) { await failLogin(c, u.id); return null; }
      await c.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
      if (u.totp_enabled_at) {
        const token = newToken();
        await c.query(`INSERT INTO login_challenges (tenant_id, user_id, token_hash, expires_at)
                       VALUES ($1, $2, $3, now() + make_interval(mins => $4))`, [hit.tenant_id, u.id, hashToken(token), CHALLENGE_MINUTES]);
        return { challenge: `${hit.tenant_id}.${token}` };
      }
      await signIn(c, hit.tenant_id, u.id, req, reply);
      await audit(c, { tenantId: hit.tenant_id, actorId: u.id, action: 'user.signed_in', entity: 'user', entityId: u.id, requestId: req.id });
      return { ok: true };
    });
    if (!out) throw badCredentials();
    return out.challenge ? { totpRequired: true, challenge: out.challenge } : { ok: true };
  });

  // Second step for owners with an authenticator app.
  app.post('/login/code', async (req, reply) => {
    const b = z.object({ challenge: z.string().max(200), code }).parse(req.body);
    const [tenantId, token] = b.challenge.split('.');
    if (!z.string().uuid().safeParse(tenantId).success || !token) throw new AppError(401, 'CHALLENGE_EXPIRED', 'Sign in again');
    const ok = await tenantTx(tenantId, async (c) => {
      const { rows: [ch] } = await c.query(
        `SELECT ch.*, u.totp_secret_enc, u.totp_last_step, u.status FROM login_challenges ch JOIN users u ON u.id = ch.user_id
         WHERE ch.token_hash = $1 AND ch.used_at IS NULL AND ch.expires_at > now() FOR UPDATE OF ch, u`, [hashToken(token)]);
      if (!ch || ch.status !== 'active' || ch.attempts >= MAX_FAILED || !ch.totp_secret_enc) return 'expired';
      const step = verifyCode(open(ch.totp_secret_enc, tenantId, totpField(tenantId, ch.user_id)), b.code);
      if (step === null || step <= Number(ch.totp_last_step)) {
        await c.query('UPDATE login_challenges SET attempts = attempts + 1 WHERE id = $1', [ch.id]);
        return 'wrong';
      }
      await c.query('UPDATE login_challenges SET used_at = now() WHERE id = $1', [ch.id]);
      await c.query('UPDATE users SET totp_last_step = $2 WHERE id = $1', [ch.user_id, step]);
      await signIn(c, tenantId, ch.user_id, req, reply);
      await audit(c, { tenantId, actorId: ch.user_id, action: 'user.signed_in', entity: 'user', entityId: ch.user_id, summary: { totp: true }, requestId: req.id });
      return 'ok';
    });
    if (ok === 'expired') throw new AppError(401, 'CHALLENGE_EXPIRED', 'Too slow or too many tries. Sign in again.');
    if (ok === 'wrong') throw new AppError(401, 'INVALID_CODE', 'That code is wrong or already used', { code: ['Wrong code'] });
    return { ok: true };
  });

  app.post('/logout', async (req, reply) => {
    const token = sessionToken(req);
    if (token) {
      const s = (await pool.query('SELECT * FROM auth_session_lookup($1)', [hashToken(token)])).rows[0];
      if (s) await tenantTx(s.tenant_id, (c) => c.query('DELETE FROM sessions WHERE id = $1', [s.session_id]));
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/me', { preHandler: requires(undefined, { setup: true }) }, async (req) => {
    const a = req.auth!;
    const tenant = await tenantTx(a.tenantId, async (c) => (await c.query('SELECT id, name FROM tenants WHERE id = $1', [a.tenantId])).rows[0]);
    return {
      user: { id: a.userId, name: a.name, email: a.email, role: a.role },
      tenant,
      permissions: totpSetupNeeded(a) ? [] : permissionsOf(a.role),
      totp: { enabled: a.totpEnabled, setupRequired: totpSetupNeeded(a) },
    };
  });

  // Always 202, so the answer doesn't reveal whether an e-mail has an account.
  app.post('/forgot-password', async (req, reply) => {
    const b = z.object({ email }).parse(req.body);
    const hit = (await pool.query('SELECT * FROM auth_user_by_email($1)', [b.email])).rows[0];
    if (hit) {
      const token = newToken();
      const sent = await tenantTx(hit.tenant_id, async (c) => {
        const { rows: [u] } = await c.query("SELECT id, name FROM users WHERE id = $1 AND status = 'active'", [hit.id]);
        if (!u) return false;
        await c.query("UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND kind = 'reset' AND used_at IS NULL", [u.id]);
        await c.query(`INSERT INTO user_tokens (tenant_id, user_id, kind, token_hash, expires_at)
                       VALUES ($1, $2, 'reset', $3, now() + make_interval(hours => $4))`, [hit.tenant_id, u.id, hashToken(token), RESET_HOURS]);
        await audit(c, { tenantId: hit.tenant_id, actorId: u.id, action: 'user.password_reset_requested', entity: 'user', entityId: u.id, requestId: req.id });
        return true;
      });
      if (sent) await sendMail({ to: [b.email], subject: `Reset your ${wooEnv.APP_NAME} password`,
        text: `Someone asked to reset the password for this e-mail.\n\nReset it here within ${RESET_HOURS} hour:\n${link(`/reset?token=${token}`)}\n\nIf it wasn't you, ignore this e-mail; your password stays the same.` }, req.log);
    }
    return reply.code(202).send({ ok: true });
  });

  /** Sets a password from a reset or invitation link. Signs out every other device of that user. */
  async function useToken(kind: 'reset' | 'invite', token: string, newPassword: string, req: FastifyRequest, reply: FastifyReply) {
    const t = (await pool.query('SELECT * FROM auth_token_lookup($1)', [hashToken(token)])).rows[0];
    if (!t || t.kind !== kind) throw badToken();
    const hash = await hashPassword(newPassword);
    await tenantTx(t.tenant_id, async (c) => {
      const { rowCount } = await c.query('UPDATE user_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL', [t.id]);
      if (!rowCount) throw badToken();
      const { rows: [u] } = await c.query('SELECT status FROM users WHERE id = $1 FOR UPDATE', [t.user_id]);
      if (!u || u.status === 'disabled' || (kind === 'invite' && u.status !== 'invited')) throw badToken();
      await c.query("UPDATE users SET password_hash = $2, status = 'active', failed_logins = 0, locked_until = NULL WHERE id = $1", [t.user_id, hash]);
      await c.query('DELETE FROM sessions WHERE user_id = $1', [t.user_id]);
      await audit(c, { tenantId: t.tenant_id, actorId: t.user_id, action: kind === 'invite' ? 'user.joined' : 'user.password_reset', entity: 'user', entityId: t.user_id, requestId: req.id });
      await signIn(c, t.tenant_id, t.user_id, req, reply);
    });
    return { ok: true };
  }

  app.post('/reset-password', async (req, reply) => {
    const b = z.object({ token: z.string().min(10).max(200), password }).parse(req.body);
    return useToken('reset', b.token, b.password, req, reply);
  });

  app.post('/accept-invite', async (req, reply) => {
    const b = z.object({ token: z.string().min(10).max(200), password }).parse(req.body);
    return useToken('invite', b.token, b.password, req, reply);
  });

  app.post('/change-password', { preHandler: requires(undefined, { setup: true }) }, async (req) => {
    const b = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password }).parse(req.body);
    const a = req.auth!;
    const hash = await hashPassword(b.newPassword);
    await tenantTx(a.tenantId, async (c) => {
      const { rows: [u] } = await c.query('SELECT password_hash FROM users WHERE id = $1 FOR UPDATE', [a.userId]);
      if (!u?.password_hash || !(await verifyPassword(u.password_hash, b.currentPassword)))
        throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { currentPassword: ['That isn’t your current password'] });
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [a.userId, hash]);
      await c.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [a.userId, a.sessionId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'user.password_changed', entity: 'user', entityId: a.userId, requestId: req.id });
    });
    return { ok: true };
  });

  // ---- authenticator app (owners; D83). Setup: start → scan → confirm with the first code.
  app.post('/totp/start', { preHandler: requires(undefined, { setup: true }) }, async (req) => {
    const a = req.auth!;
    if (a.role !== 'owner') throw new AppError(403, 'FORBIDDEN', 'Only the owner uses an authenticator app');
    if (a.totpEnabled) throw new AppError(409, 'TOTP_ALREADY_ON', 'Your authenticator app is already set up');
    const secret = newSecret();
    await tenantTx(a.tenantId, (c) => c.query('UPDATE users SET totp_pending_enc = $2 WHERE id = $1',
      [a.userId, seal(secret, a.tenantId, totpField(a.tenantId, a.userId))]));
    return { secret, otpauthUri: otpauthUri(wooEnv.APP_NAME, a.email, secret) };
  });

  app.post('/totp/confirm', { preHandler: requires(undefined, { setup: true }) }, async (req) => {
    const b = z.object({ code }).parse(req.body);
    const a = req.auth!;
    await tenantTx(a.tenantId, async (c) => {
      const { rows: [u] } = await c.query('SELECT totp_pending_enc, totp_enabled_at FROM users WHERE id = $1 FOR UPDATE', [a.userId]);
      if (u.totp_enabled_at || !u.totp_pending_enc) throw new AppError(409, 'TOTP_NOT_STARTED', 'Start the setup again');
      const step = verifyCode(open(u.totp_pending_enc, a.tenantId, totpField(a.tenantId, a.userId)), b.code);
      if (step === null) throw new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { code: ['Wrong code. Check the phone’s clock.'] });
      await c.query(`UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled_at = now(), totp_last_step = $2
                     WHERE id = $1`, [a.userId, step]);
      // Every other device signed in with the password alone must sign in again with a code.
      await c.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [a.userId, a.sessionId]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'user.totp_enabled', entity: 'user', entityId: a.userId, requestId: req.id });
    });
    return { ok: true };
  });
}
