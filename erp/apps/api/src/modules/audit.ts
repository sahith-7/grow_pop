import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from '../db.js';
import { requires } from '../lib/session.js';

// The store's own audit log, newest first, `limit` (default 50) at a time, older pages with ?before=<nextCursor>. Rows are append-only for the app role (001).

export async function auditRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requires('audit.read') }, async (req) => {
    const q = z.object({
      before: z.string().regex(/^\d{1,18}$/).optional(),          // the previous page's nextCursor
      limit: z.coerce.number().int().min(1).max(100).default(50),
      action: z.string().max(80).optional(),
    }).parse(req.query);
    const PAGE = q.limit;
    return tenantTx(req.auth!.tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT a.id, a.action, a.entity_type, a.entity_id, a.summary, a.created_at, u.name AS actor
           FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE ($1::bigint IS NULL OR a.id < $1) AND ($2::text IS NULL OR a.action LIKE $2 || '%')
          ORDER BY a.id DESC LIMIT $3`, [q.before ?? null, q.action ?? null, PAGE + 1]);
      const items = rows.slice(0, PAGE).map((r) => ({ id: String(r.id), action: r.action, entityType: r.entity_type, entityId: r.entity_id,
        actor: r.actor, createdAt: r.created_at, summary: r.summary }));
      return { items, nextCursor: rows.length > PAGE ? items[PAGE - 1].id : null };
    });
  });
}
