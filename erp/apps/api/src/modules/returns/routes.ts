import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx, type Tx } from '../../db.js';
import { idempotent } from '../../lib/idempotency.js';
import { decodeCursor, encodeCursor, limitParam } from '../../lib/pagination.js';
import { appError, authOf, requires } from '../../lib/phase1.js';
import { outletScope } from '../outlets/scope.js';
import { listReturns, postReturn, returnInput } from './service.js';

const tx = <T>(req: FastifyRequest, fn: (t: Tx) => Promise<T>) => tenantTx(authOf(req).tenantId, fn);
const listQuery = z.object({ q: z.string().trim().max(100).optional(), limit: limitParam, cursor: z.string().optional() }).strict();

export async function returnRoutes(app: FastifyInstance) {
  app.get('/returns', { preHandler: requires('return.manage') }, async (req) => {
    const q = listQuery.parse(req.query);
    const after = decodeCursor(q.cursor, z.tuple([z.string(), z.string().uuid()]));
    return tx(req, async (t) => {
      const { rows, more } = await listReturns(t, { q: q.q, limit: q.limit, after, scope: await outletScope(t, req) });
      const last = rows[rows.length - 1];
      return { items: rows, nextCursor: more ? encodeCursor([new Date(last.postedAt).toISOString(), last.id]) : null };
    });
  });

  app.post('/returns', { preHandler: requires('return.manage') }, async (req, reply) => {
    if (req.headers['idempotency-key'] === undefined) throw appError(400, 'VALIDATION_ERROR', 'Idempotency-Key header is required');
    const input = returnInput.parse(req.body);
    const out = await tx(req, (t) => idempotent(t, req.headers['idempotency-key'], input, async () =>
      ({ status: 201, body: await postReturn(t, { userId: authOf(req).userId, role: authOf(req).role }, input) })));
    return reply.code(out.status).send(out.body);
  });
}
