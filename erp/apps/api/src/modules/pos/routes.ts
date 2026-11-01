import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx, type Tx } from '../../db.js';
import { idempotent } from '../../lib/idempotency.js';
import { appError, authOf, can, requires } from '../../lib/phase1.js';
import { cartInput, type Seat } from './pricing.js';
import { context, createSale, daySummary, lookup, quote, saleInput } from './service.js';

// POS (B5, J11). Every route needs pos.sell; discounts and price changes are checked per line in pricing.ts.

const tx = <T>(req: FastifyRequest, fn: (t: Tx) => Promise<T>) => tenantTx(authOf(req).tenantId, fn);
const seatOf = (req: FastifyRequest): Seat => ({
  userId: authOf(req).userId, role: authOf(req).role, canDiscount: can(req, 'pos.discount'), canOverride: can(req, 'pos.price_override'),
});

export async function posRoutes(app: FastifyInstance) {
  const sell = { preHandler: requires('pos.sell') };

  app.get('/pos/context', sell, async (req) => tx(req, (t) => context(t, seatOf(req))));

  // Scanners send a burst of lookups; allow more than the global limit.
  app.get('/pos/lookup', { ...sell, config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(64) }).strict().parse(req.query);
    return tx(req, (t) => lookup(t, q));
  });

  app.post('/pos/quote', { ...sell, config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (req) => {
    const cart = cartInput.parse(req.body);
    return tx(req, (t) => quote(t, seatOf(req), cart));
  });

  app.post('/pos/sales', sell, async (req, reply) => {
    if (req.headers['idempotency-key'] === undefined) throw appError(400, 'VALIDATION_ERROR', 'Idempotency-Key header is required');
    const input = saleInput.parse(req.body);
    const out = await tx(req, (t) => idempotent(t, req.headers['idempotency-key'], input, async () => ({ status: 201, body: await createSale(t, seatOf(req), input) })));
    return reply.code(out.status).send(out.body);
  });

  app.get('/pos/summary', sell, async (req) => {
    const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict().parse(req.query);
    return tx(req, (t) => daySummary(t, date));
  });
}
