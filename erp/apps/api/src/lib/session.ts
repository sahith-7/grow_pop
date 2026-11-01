import type { FastifyReply, FastifyRequest } from 'fastify';
import { config, isProd } from '../config.js';
import { pool, tenantTx, type Tx } from '../db.js';
import { hashToken, newToken } from './crypto.js';
import { AppError, forbidden, unauthenticated } from './errors.js';
import { can, type Permission, type Role } from './permissions.js';

const COOKIE = isProd ? '__Host-sid' : 'sid';
const IDLE_HOURS = 12;
const TOUCH_AFTER_MIN = 5;

export type Auth = { sessionId: string; tenantId: string; userId: string; role: Role; name: string; email: string; totpEnabled: boolean };
declare module 'fastify' {
  interface FastifyRequest {
    auth?: Auth;
  }
}

export async function createSession(c: Tx, tenantId: string, userId: string, req: FastifyRequest) {
  const token = newToken();
  await c.query(
    `INSERT INTO sessions (tenant_id, user_id, token_hash, user_agent, expires_at)
     VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5))`,
    [tenantId, userId, hashToken(token), (req.headers['user-agent'] ?? '').slice(0, 300), IDLE_HOURS],
  );
  return token;
}

export const setSessionCookie = (reply: FastifyReply, token: string) =>
  reply.setCookie(COOKIE, token, { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/', maxAge: IDLE_HOURS * 3600 });
export const clearSessionCookie = (reply: FastifyReply) => reply.clearCookie(COOKIE, { path: '/' });
export const sessionToken = (req: FastifyRequest) => req.cookies[COOKIE];

async function authenticate(req: FastifyRequest) {
  const token = req.cookies[COOKIE];
  if (!token) throw unauthenticated();
  const { rows } = await pool.query('SELECT * FROM auth_session_lookup($1)', [hashToken(token)]);
  const s = rows[0];
  if (!s || s.user_status !== 'active' || s.tenant_status !== 'active') throw unauthenticated();
  // Sliding expiry, written at most every few minutes to keep the hot path read-only.
  if (Date.now() - new Date(s.last_seen_at).getTime() > TOUCH_AFTER_MIN * 60_000) {
    await tenantTx(s.tenant_id, (c) =>
      c.query('UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(hours => $2) WHERE id = $1', [s.session_id, IDLE_HOURS]),
    );
  }
  req.auth = { sessionId: s.session_id, tenantId: s.tenant_id, userId: s.user_id, role: s.role, name: s.name, email: s.email, totpEnabled: s.totp_enabled };
}

/** The owner must have an authenticator app before using the store (D83). Off in development and tests unless set. */
export const totpSetupNeeded = (a: Auth) => a.role === 'owner' && !a.totpEnabled && config.OWNER_TOTP === 'required';

/**
 * Route guard: valid session, plus an optional permission checked on the server. An owner without an authenticator app
 * gets 403 TOTP_SETUP_REQUIRED everywhere except the sign-in routes that set one up (`setup: true`).
 */
export const requires = (permission?: Permission, opts: { setup?: boolean } = {}) => async (req: FastifyRequest) => {
  await authenticate(req);
  if (!opts.setup && totpSetupNeeded(req.auth!))
    throw new AppError(403, 'TOTP_SETUP_REQUIRED', 'Set up your authenticator app first');
  if (permission && !can(req.auth!.role, permission)) throw forbidden();
};
