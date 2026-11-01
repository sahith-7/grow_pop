import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx, type Tx } from '../../db.js';
import { idempotent } from '../../lib/idempotency.js';
import { decodeCursor, encodeCursor, limitParam } from '../../lib/pagination.js';
import { appError, authOf, can, requires } from '../../lib/phase1.js';
import { detail } from '../sales/routes.js';
import {
  cancelPickList, createPickList, dispatch, dispatchInput, listPickLists, pack, packInput, pickListDetail, pickListInput, queue,
  retryWebUpdate, scan, scanInput, setPicked, setPickedInput, STAGES, unpick,
} from './service.js';

// Fulfilment of web orders (B6, J13). Every route needs order.fulfil.

const tx = <T>(req: FastifyRequest, fn: (t: Tx) => Promise<T>) => tenantTx(authOf(req).tenantId, fn);
const idParam = z.object({ id: z.string().uuid() });
const lineParam = z.object({ id: z.string().uuid(), lineId: z.string().uuid() });
const reasonInput = z.object({ reason: z.string().trim().min(3, 'Say why').max(200) }).strict();
const orderOut = async (req: FastifyRequest, t: Tx, id: string) =>
  ({ ...(await detail(t, id)), can: { fulfil: true, mapLines: can(req, 'product.write'), issueInvoice: can(req, 'invoice.read') } });

export async function fulfilmentRoutes(app: FastifyInstance) {
  const fulfil = { preHandler: requires('order.fulfil') };
  // Scanning sends a burst of requests; allow more than the global limit.
  const scanning = { ...fulfil, config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } };

  app.get('/fulfilment/queue', fulfil, async (req) => {
    const q = z.object({ stage: z.enum(STAGES).default('ready_to_pick'), limit: limitParam, cursor: z.string().optional() }).strict().parse(req.query);
    const after = decodeCursor(q.cursor, z.tuple([z.string(), z.string().uuid()]));
    const r = await tx(req, (t) => queue(t, q.stage, q.limit, after));
    return { ...r, nextCursor: r.nextCursor ? encodeCursor(r.nextCursor) : null };
  });

  app.get('/pick-lists', fulfil, async (req) => {
    const { open } = z.object({ open: z.enum(['true', 'false']).default('true') }).strict().parse(req.query);
    return tx(req, (t) => listPickLists(t, open === 'true'));
  });

  app.post('/pick-lists', fulfil, async (req, reply) => {
    const input = pickListInput.parse(req.body);
    return reply.code(201).send(await tx(req, (t) => createPickList(t, authOf(req).userId, input)));
  });

  app.get('/pick-lists/:id', fulfil, async (req) => {
    const { id } = idParam.parse(req.params);
    return tx(req, (t) => pickListDetail(t, id));
  });

  app.post('/pick-lists/:id/scan', scanning, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = scanInput.parse(req.body);
    return tx(req, (t) => scan(t, authOf(req).userId, id, input));
  });

  app.patch('/pick-lists/:id/lines/:lineId', scanning, async (req) => {
    const { id, lineId } = lineParam.parse(req.params);
    const input = setPickedInput.parse(req.body);
    return tx(req, (t) => setPicked(t, authOf(req).userId, id, lineId, input));
  });

  app.post('/pick-lists/:id/cancel', fulfil, async (req) => {
    const { id } = idParam.parse(req.params);
    const { reason } = reasonInput.parse(req.body);
    return tx(req, async (t) => { await cancelPickList(t, authOf(req).userId, id, reason); return pickListDetail(t, id); });
  });

  app.post('/orders/:id/unpick', fulfil, async (req) => {
    const { id } = idParam.parse(req.params);
    const { reason } = reasonInput.parse(req.body);
    return tx(req, async (t) => { await unpick(t, authOf(req).userId, id, reason); return orderOut(req, t, id); });
  });

  app.post('/orders/:id/pack', fulfil, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = packInput.parse(req.body);
    return tx(req, async (t) => { await pack(t, authOf(req).userId, id, input); return orderOut(req, t, id); });
  });

  // Stock leaves here. A retried request with the same key gets the first answer; a second dispatch is refused anyway.
  app.post('/orders/:id/dispatch', fulfil, async (req, reply) => {
    if (req.headers['idempotency-key'] === undefined) throw appError(400, 'VALIDATION_ERROR', 'Idempotency-Key header is required');
    const { id } = idParam.parse(req.params);
    const input = dispatchInput.parse(req.body);
    const out = await tx(req, (t) => idempotent(t, req.headers['idempotency-key'], { id, ...input }, async () => {
      await dispatch(t, authOf(req).userId, id, input);
      return { status: 200, body: await orderOut(req, t, id) };
    }));
    return reply.code(out.status).send(out.body);
  });

  app.post('/orders/:id/web-update/retry', fulfil, async (req) => {
    const { id } = idParam.parse(req.params);
    return tx(req, async (t) => { await retryWebUpdate(t, authOf(req).userId, id); return orderOut(req, t, id); });
  });
}
