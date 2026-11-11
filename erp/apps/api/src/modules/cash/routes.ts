import { outletScope } from '../outlets/scope.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx, type Tx } from '../../db.js';
import { appError, authOf, requires, signedIn } from '../../lib/phase1.js';
import { allowedOutlets } from '../outlets/service.js';
import { checkPin, pinInput } from '../pos/approvals.js';
import { createMethod, listMethods, methodInput, methodPatch, patchMethod } from './methods.js';
import { listNotifications, markRead, readInput, unreadCount } from './notifications.js';
import {
  cancelMovement, cashBook, CATEGORIES, closeInput, closeRegister, createTill, decideMovement, decideMovementInput, DENOMINATIONS, listRegisters,
  listTills, movementInput, openInput, openRegister, patchTill, readMovement, recordMovement, sessionDetail, tillInput, tillPatch, waitingExpenses,
} from './registers.js';

// Cash control (v2, D109–D112). Selling staff open and close the registers at their outlets and record drawer movements;
// the owner and managers (cash.manage) see every register and the cash book, take cash out, answer expenses above the
// limit, and manage tills and payment methods.

const tx = <T>(req: FastifyRequest, fn: (t: Tx) => Promise<T>) => tenantTx(authOf(req).tenantId, fn);
const actorOf = (req: FastifyRequest) => ({ userId: authOf(req).userId, role: authOf(req).role });
const idParam = z.object({ id: z.string().uuid() });
const outletQ = z.string().uuid().optional();

export async function cashRoutes(app: FastifyInstance) {
  const sell = { preHandler: requires('pos.sell') };
  const manage = { preHandler: requires('cash.manage') };

  // ---------------------------------------------------------------- payment methods (D109)
  app.get('/payment-methods', manage, async (req) => tx(req, async (t) => ({
    items: await listMethods(t), outlets: (await allowedOutlets(t, authOf(req).userId, authOf(req).role)).map(({ id, name }) => ({ id, name })),
  })));
  app.post('/payment-methods', manage, async (req, reply) => {
    const input = methodInput.parse(req.body);
    return reply.code(201).send(await tx(req, (t) => createMethod(t, authOf(req).userId, input)));
  });
  app.patch('/payment-methods/:id', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = methodPatch.parse(req.body);
    return tx(req, (t) => patchMethod(t, authOf(req).userId, id, patch));
  });

  // ---------------------------------------------------------------- tills (D110)
  app.get('/tills', sell, async (req) => {
    const { outletId } = z.object({ outletId: outletQ }).strict().parse(req.query);
    // Without one named, the outlet in view (D115); "all" lists every outlet this person may sell at.
    return { items: await tx(req, async (t) => listTills(t, actorOf(req), outletId ?? (await outletScope(t, req)).outlet?.id)) };
  });
  app.post('/tills', manage, async (req, reply) => {
    const input = tillInput.parse(req.body);
    return reply.code(201).send(await tx(req, (t) => createTill(t, actorOf(req), input)));
  });
  app.patch('/tills/:id', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = tillPatch.parse(req.body);
    return tx(req, (t) => patchTill(t, actorOf(req), id, patch));
  });

  // ---------------------------------------------------------------- registers (D110, D112)
  app.get('/registers/options', sell, async () => ({ denominations: DENOMINATIONS, categories: CATEGORIES }));
  app.post('/registers', sell, async (req, reply) => {
    const input = openInput.parse(req.body);
    return reply.code(201).send(await tx(req, (t) => openRegister(t, actorOf(req), input)));
  });
  app.get('/registers', manage, async (req) => {
    const f = z.object({ outletId: outletQ, days: z.coerce.number().int().min(1).max(90).default(7) }).strict().parse(req.query);
    return tx(req, async (t) => listRegisters(t, actorOf(req), { ...f, outletId: f.outletId ?? (await outletScope(t, req)).outlet?.id }));
  });
  app.get('/registers/:id', sell, async (req) => {
    const { id } = idParam.parse(req.params);
    return tx(req, (t) => sessionDetail(t, actorOf(req), id));
  });
  app.post('/registers/:id/close', sell, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = closeInput.parse(req.body);
    return tx(req, (t) => closeRegister(t, actorOf(req), id, input));
  });
  app.post('/registers/:id/movements', sell, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const input = movementInput.parse(req.body);
    return reply.code(201).send(await tx(req, (t) => recordMovement(t, actorOf(req), id, input)));
  });

  // ---------------------------------------------------------------- an expense above the limit (D111)
  app.get('/cash-movements/waiting', manage, async (req) => ({ items: await tx(req, (t) => waitingExpenses(t, actorOf(req))) }));
  app.get('/cash-movements/:id', { ...sell, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = idParam.parse(req.params);
    return tx(req, (t) => readMovement(t, actorOf(req), id));
  });
  app.post('/cash-movements/:id/cancel', sell, async (req) => {
    const { id } = idParam.parse(req.params);
    return tx(req, (t) => cancelMovement(t, actorOf(req), id));
  });
  // The approver's PIN on the cashier's screen. Wrong tries are saved before the error is sent (see checkPin).
  app.post('/cash-movements/:id/pin', { ...sell, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = pinInput.parse(req.body);
    const actor = actorOf(req);
    const r = await tx(req, async (t) => {
      const m = await readMovement(t, actor, id);
      const { rows: [own] } = await t.query('SELECT recorded_by FROM cash_movements WHERE id = $1', [id]);
      if (own.recorded_by !== actor.userId) throw appError(404, 'NOT_FOUND', 'Expense not found');
      if (m.status !== 'pending') throw appError(409, 'ALREADY_ANSWERED', 'This expense was already answered.');
      const pin = await checkPin(t, { ...actor, canDiscount: false, canOverride: false }, input, { expense: id });
      if ('problem' in pin) return pin;
      await decideMovement(t, pin.approver, id, true, 'pin');
      return { movement: await readMovement(t, actor, id) };
    });
    if ('problem' in r) throw appError(r.problem.status, r.problem.code, r.problem.message);
    return r.movement;
  });
  app.post('/cash-movements/:id/decide', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = decideMovementInput.parse(req.body);
    return tx(req, async (t) => {
      const { rows: [me] } = await t.query('SELECT id, name, role FROM users WHERE id = $1', [authOf(req).userId]);
      await decideMovement(t, me, id, input.approve, 'remote', input.note);
      return readMovement(t, actorOf(req), id);
    });
  });

  // ---------------------------------------------------------------- the cash book (D110)
  app.get('/cash-book', manage, async (req) => {
    const f = z.object({ outletId: outletQ, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict().parse(req.query);
    return tx(req, async (t) => cashBook(t, actorOf(req), { ...f, outletId: f.outletId ?? (await outletScope(t, req)).outlet?.id }));
  });

  // ---------------------------------------------------------------- notifications (D112): one's own
  app.get('/notifications', { preHandler: signedIn() }, async (req) => tx(req, (t) => listNotifications(t, authOf(req).userId)));
  app.get('/notifications/count', { preHandler: signedIn(), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req) => tx(req, (t) => unreadCount(t, authOf(req).userId)));
  app.post('/notifications/read', { preHandler: signedIn() }, async (req) => {
    const { ids } = readInput.parse(req.body ?? {});
    return tx(req, (t) => markRead(t, authOf(req).userId, ids));
  });
}
