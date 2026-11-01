import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { tenantTx, type Tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { hashToken, newToken } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import { sendMail } from '../lib/notify.js';
import { ASSIGNABLE_ROLES } from '../lib/permissions.js';
import { requires } from '../lib/session.js';
import { wooEnv } from './woocommerce/env.js';

// The store's team: list, invite by e-mail, change role, disable. The owner can't be changed here, and only one exists.

const INVITE_HOURS = 72;
const shape = (u: any) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, createdAt: u.created_at });
const idParam = z.object({ id: z.string().uuid() });
const userId = (req: FastifyRequest) => {
  const p = idParam.safeParse(req.params);
  if (!p.success) throw notFound('User not found');
  return p.data.id;
};

/** Replaces any earlier invitation for the user and e-mails a new link. Returns the mail to send after commit. */
async function issueInvite(c: Tx, tenantId: string, user: { id: string; email: string; name: string }, storeName: string, invitedBy: string) {
  const token = newToken();
  await c.query("UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND kind = 'invite' AND used_at IS NULL", [user.id]);
  await c.query(`INSERT INTO user_tokens (tenant_id, user_id, kind, token_hash, expires_at)
                 VALUES ($1, $2, 'invite', $3, now() + make_interval(hours => $4))`, [tenantId, user.id, hashToken(token), INVITE_HOURS]);
  return { to: [user.email], subject: `${invitedBy} invited you to ${storeName} on ${wooEnv.APP_NAME}`,
    text: `Hello ${user.name},\n\n${invitedBy} added you to ${storeName}. Choose your password here within ${INVITE_HOURS} hours:\n${config.WEB_ORIGIN}/invite?token=${token}\n` };
}

async function seats(c: Tx) {
  const { rows: [r] } = await c.query(
    `SELECT p.max_users, (SELECT count(*) FROM users WHERE status <> 'disabled')::int AS used
       FROM tenants t JOIN plans p ON p.id = t.plan_id`);
  return r as { max_users: number; used: number };
}

export async function userRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requires('users.read') }, (req) => tenantTx(req.auth!.tenantId, async (c) =>
    (await c.query("SELECT * FROM users ORDER BY role = 'owner' DESC, created_at")).rows.map(shape)));

  app.get('/seats', { preHandler: requires('users.read') }, (req) => tenantTx(req.auth!.tenantId, async (c) => {
    const s = await seats(c);
    return { max: s.max_users, used: s.used };
  }));

  app.post('/invite', { preHandler: requires('users.manage') }, async (req, reply) => {
    const b = z.object({
      email: z.string().trim().toLowerCase().email('Enter a valid e-mail').max(200),
      name: z.string().trim().min(1).max(120),
      role: z.enum(ASSIGNABLE_ROLES),
    }).parse(req.body);
    const a = req.auth!;
    const { user, mail } = await tenantTx(a.tenantId, async (c) => {
      // One invitation at a time per store, so two quick invites can't both take the last seat.
      await c.query('SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE', [a.tenantId]);
      const s = await seats(c);
      if (s.used >= s.max_users) throw new AppError(409, 'SEAT_LIMIT', `Your plan allows ${s.max_users} people. Disable someone or change plan.`);
      let user;
      try {
        ({ rows: [user] } = await c.query(
          "INSERT INTO users (tenant_id, email, name, role, status) VALUES ($1, $2, $3, $4, 'invited') RETURNING *", [a.tenantId, b.email, b.name, b.role]));
      } catch (e: any) {
        if (e.code === '23505') throw new AppError(409, 'EMAIL_TAKEN', 'That e-mail already belongs to an account', { email: ['Already in use'] });
        throw e;
      }
      const store = (await c.query('SELECT name FROM tenants WHERE id = $1', [a.tenantId])).rows[0].name;
      const mail = await issueInvite(c, a.tenantId, user, store, a.name);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'user.invited', entity: 'user', entityId: user.id, summary: { role: b.role }, requestId: req.id });
      return { user, mail };
    });
    await sendMail(mail, req.log);
    return reply.code(201).send(shape(user));
  });

  app.post('/:id/resend-invite', { preHandler: requires('users.manage') }, async (req) => {
    const id = userId(req);
    const a = req.auth!;
    const mail = await tenantTx(a.tenantId, async (c) => {
      const { rows: [u] } = await c.query('SELECT * FROM users WHERE id = $1', [id]);
      if (!u) throw notFound('User not found');
      if (u.status !== 'invited') throw new AppError(409, 'NOT_INVITED', 'This person has already joined');
      const store = (await c.query('SELECT name FROM tenants WHERE id = $1', [a.tenantId])).rows[0].name;
      const m = await issueInvite(c, a.tenantId, u, store, a.name);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'user.invite_resent', entity: 'user', entityId: u.id, requestId: req.id });
      return m;
    });
    await sendMail(mail, req.log);
    return { ok: true };
  });

  app.patch('/:id', { preHandler: requires('users.manage') }, async (req) => {
    const id = userId(req);
    const b = z.object({ status: z.enum(['active', 'disabled']).optional(), role: z.enum(ASSIGNABLE_ROLES).optional(),
      name: z.string().trim().min(1).max(120).optional() }).strict().parse(req.body);
    const a = req.auth!;
    return tenantTx(a.tenantId, async (c) => {
      await c.query('SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE', [a.tenantId]);
      const { rows: [u] } = await c.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (!u) throw notFound('User not found');
      if (u.role === 'owner') throw new AppError(403, 'OWNER_PROTECTED', 'The owner account can’t be changed here');
      // Someone who never chose a password can't be made active by hand: re-enabling them goes back to "invited".
      let status: string | null = null;
      if (b.status === 'disabled') status = 'disabled';
      else if (b.status === 'active' && u.status === 'disabled') {
        const s = await seats(c);
        if (s.used >= s.max_users) throw new AppError(409, 'SEAT_LIMIT', `Your plan allows ${s.max_users} people.`);
        status = u.password_hash ? 'active' : 'invited';
      }
      const { rows: [r] } = await c.query(
        'UPDATE users SET status = coalesce($2, status), role = coalesce($3, role), name = coalesce($4, name) WHERE id = $1 RETURNING *',
        [id, status, b.role ?? null, b.name ?? null]);
      // Disabling or a role change ends their sessions at once; the next request asks them to sign in.
      if (b.status === 'disabled' || (b.role && b.role !== u.role)) await c.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      if (b.status === 'disabled') await c.query('UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [id]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'user.updated', entity: 'user', entityId: id,
        summary: { from: { status: u.status, role: u.role }, to: { status: r.status, role: r.role } }, requestId: req.id });
      return shape(r);
    });
  });
}
