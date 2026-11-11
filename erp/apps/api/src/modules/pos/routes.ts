import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx, type Tx } from '../../db.js';
import { idempotent } from '../../lib/idempotency.js';
import { appError, authOf, can, requires } from '../../lib/phase1.js';
import { cartInput, type Seat } from './pricing.js';
import { context, createSale, daySummary, lookup, quote, saleInput } from './service.js';
import { holdBill, holdInput, listHeld, takeHeld } from './held.js';
import {
  approveWithPin, approvers, cancelRequest, decideInput, decideRemote, listRequests, pinInput, pinStatus, readRequest, removePin, requestDiscount,
  requestInput, setPin, setPinInput, waitingCount,
} from './approvals.js';
import { createExchange, exchangeInput, exchangeQuote, exchangeQuoteInput } from './exchange.js';

// POS (B5, J11). Every route needs pos.sell; discounts and price changes are checked per line in pricing.ts.

const tx = <T>(req: FastifyRequest, fn: (t: Tx) => Promise<T>) => tenantTx(authOf(req).tenantId, fn);
const seatOf = (req: FastifyRequest): Seat => ({
  userId: authOf(req).userId, role: authOf(req).role, canDiscount: can(req, 'pos.discount'), canOverride: can(req, 'pos.price_override'),
});

export async function posRoutes(app: FastifyInstance) {
  const sell = { preHandler: requires('pos.sell') };

  const outletQ = z.string().uuid().optional();
  app.get('/pos/context', sell, async (req) => {
    const { outletId } = z.object({ outletId: outletQ }).strict().parse(req.query);
    return tx(req, (t) => context(t, seatOf(req), outletId));
  });

  // Scanners send a burst of lookups; allow more than the global limit.
  app.get('/pos/lookup', { ...sell, config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (req) => {
    const { q, outletId } = z.object({ q: z.string().trim().min(1).max(64), outletId: outletQ }).strict().parse(req.query);
    return tx(req, (t) => lookup(t, seatOf(req), q, outletId));
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
    const { date, outletId } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), outletId: outletQ }).strict().parse(req.query);
    return tx(req, (t) => daySummary(t, seatOf(req), date, outletId));
  });

  // ---------------------------------------------------------------- held bills (v2, D105)
  const idParam = z.object({ id: z.string().uuid() });
  app.get('/pos/held', sell, async (req) => {
    const { outletId } = z.object({ outletId: outletQ }).strict().parse(req.query);
    return tx(req, (t) => listHeld(t, seatOf(req), outletId));
  });
  app.post('/pos/held', sell, async (req, reply) => {
    const input = holdInput.parse(req.body);
    return reply.code(201).send(await tx(req, (t) => holdBill(t, seatOf(req), input)));
  });
  app.post('/pos/held/:id/resume', sell, async (req) => {
    const { id } = idParam.parse(req.params);
    const { outletId } = z.object({ outletId: outletQ }).strict().parse(req.body ?? {});
    return tx(req, (t) => takeHeld(t, seatOf(req), id, outletId, 'resumed'));
  });
  app.delete('/pos/held/:id', sell, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { outletId } = z.object({ outletId: outletQ }).strict().parse(req.query);
    await tx(req, (t) => takeHeld(t, seatOf(req), id, outletId, 'discarded'));
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- discount approval (v2, D107)
  const approve = { preHandler: requires('pos.discount_approve') };
  app.post('/pos/discount-requests', sell, async (req, reply) => {
    const input = requestInput.parse(req.body);
    return reply.code(201).send(await tx(req, (t) => requestDiscount(t, seatOf(req), input)));
  });
  // The till asks every few seconds while it waits for a remote answer.
  app.get('/pos/discount-requests/:id', { ...sell, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = idParam.parse(req.params);
    return tx(req, (t) => readRequest(t, seatOf(req), id));
  });
  app.post('/pos/discount-requests/:id/cancel', sell, async (req) => {
    const { id } = idParam.parse(req.params);
    return tx(req, (t) => cancelRequest(t, seatOf(req), id));
  });
  // A wrong PIN is counted (and can lock the PIN) even though the request fails, so it is reported after the commit.
  app.post('/pos/discount-requests/:id/pin', { ...sell, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = pinInput.parse(req.body);
    const r = await tx(req, (t) => approveWithPin(t, seatOf(req), id, input));
    if (r.problem) throw appError(r.problem.status, r.problem.code, r.problem.message);
    return r.request;
  });
  app.get('/pos/approvers', sell, async (req) => tx(req, (t) => approvers(t, seatOf(req))));

  app.get('/approvals', approve, async (req) => tx(req, (t) => listRequests(t, seatOf(req))));
  app.get('/approvals/count', { ...approve, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => tx(req, (t) => waitingCount(t, seatOf(req))));
  app.post('/approvals/:id', approve, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = decideInput.parse(req.body);
    return tx(req, (t) => decideRemote(t, seatOf(req), id, input));
  });

  // One's own approval PIN (Password & sign-in page).
  app.get('/pos/pin', approve, async (req) => tx(req, (t) => pinStatus(t, authOf(req).userId)));
  app.put('/pos/pin', { ...approve, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const input = setPinInput.parse(req.body);
    return tx(req, (t) => setPin(t, authOf(req).userId, input));
  });
  app.delete('/pos/pin', approve, async (req) => tx(req, (t) => removePin(t, authOf(req).userId)));

  // ---------------------------------------------------------------- exchange (v2, D108): needs returns as well as selling
  const exchanges = { preHandler: [requires('pos.sell'), async (req: FastifyRequest) => {
    if (!can(req, 'return.manage')) throw appError(403, 'FORBIDDEN', 'You do not have permission to do this');
  }] };
  app.post('/pos/exchanges/quote', exchanges, async (req) => {
    const input = exchangeQuoteInput.parse(req.body);
    return tx(req, (t) => exchangeQuote(t, seatOf(req), input));
  });
  app.post('/pos/exchanges', exchanges, async (req, reply) => {
    if (req.headers['idempotency-key'] === undefined) throw appError(400, 'VALIDATION_ERROR', 'Idempotency-Key header is required');
    const input = exchangeInput.parse(req.body);
    const out = await tx(req, (t) => idempotent(t, req.headers['idempotency-key'], input, async () => ({ status: 201, body: await createExchange(t, seatOf(req), input) })));
    return reply.code(out.status).send(out.body);
  });
}
