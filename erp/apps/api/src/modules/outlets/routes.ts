import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx, type Tx } from '../../db.js';
import { STATES } from '../../lib/gst.js';
import { authOf, can, requires } from '../../lib/phase1.js';
import { createOutlet, listOutlets, outletDetail, outletInput, outletPatch, patchOutlet, setStaff } from './service.js';

// Outlets (v2, D101). Owners and managers read them; only the owner (settings.manage) opens, edits or closes one, and
// only someone with users.manage chooses who works where.

const tx = <T>(req: FastifyRequest, fn: (t: Tx) => Promise<T>) => tenantTx(authOf(req).tenantId, fn);
const ctxOf = (req: FastifyRequest) => ({ userId: authOf(req).userId, role: authOf(req).role });
const idParam = z.object({ id: z.string().uuid() });
const states = Object.entries(STATES).map(([code, name]) => ({ code, name }));
const canOf = (req: FastifyRequest) => ({ manage: can(req, 'settings.manage'), staff: can(req, 'users.manage') });
/** An outlet's page as the screen needs it, after a read or a change (the page reads `can` and `states`). */
const page = (req: FastifyRequest, detail: Awaited<ReturnType<typeof outletDetail>>) => ({ ...detail, states, can: canOf(req) });

export async function outletRoutes(app: FastifyInstance) {
  const read = { preHandler: requires('settings.read') };
  const manage = { preHandler: requires('settings.manage') };

  app.get('/outlets', read, async (req) => ({ ...(await tx(req, listOutlets)), states, can: canOf(req) }));

  app.get('/outlets/:id', read, async (req) => {
    const { id } = idParam.parse(req.params);
    return { ...(await tx(req, (t) => outletDetail(t, id, can(req, 'users.manage')))), states, can: canOf(req) };
  });

  app.post('/outlets', manage, async (req, reply) => {
    const input = outletInput.parse(req.body);
    const id = await tx(req, (t) => createOutlet(t, ctxOf(req), input));
    return reply.code(201).send(await page(req, await tx(req, (t) => outletDetail(t, id!, can(req, 'users.manage')))));
  });

  app.patch('/outlets/:id', manage, async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = outletPatch.parse(req.body);
    return page(req, await tx(req, async (t) => { await patchOutlet(t, ctxOf(req), id, patch); return outletDetail(t, id, can(req, 'users.manage')); }));
  });

  app.put('/outlets/:id/staff', { preHandler: requires('users.manage') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { userIds } = z.object({ userIds: z.array(z.string().uuid()).max(500) }).strict().parse(req.body);
    return page(req, await tx(req, async (t) => { await setStaff(t, ctxOf(req), id, [...new Set(userIds)]); return outletDetail(t, id, true); }));
  });
}
