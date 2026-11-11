import { outletScope } from '../outlets/scope.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx } from '../../db.js';
import { idempotent } from '../../lib/idempotency.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { appError, authOf, requires, requiresAny } from '../../lib/phase1.js';
import { ctxOf } from '../inventory/routes.js';
import * as s from './schemas.js';
import * as svc from './service.js';

const tx = <T>(req: FastifyRequest, fn: Parameters<typeof tenantTx<T>>[1]) => tenantTx(authOf(req).tenantId, fn);
const page = z.tuple([z.string(), z.string().uuid()]);

/** If-Match: "3". Required on PO edits so two people cannot overwrite each other's draft. */
function ifMatch(req: FastifyRequest): number {
  const raw = req.headers['if-match'];
  const m = typeof raw === 'string' ? /^(?:W\/)?"?(\d+)"?$/.exec(raw.trim()) : null;
  if (!m) throw appError(428, 'VERSION_REQUIRED', 'Reload the page and try again');
  return Number(m[1]);
}
const withEtag = (reply: FastifyReply, body: { version: number }) => reply.header('etag', `"${body.version}"`).send(body);

export async function purchasingRoutes(app: FastifyInstance) {
  const manage = { preHandler: requires('purchase.manage') };
  const view = { preHandler: requiresAny('purchase.manage', 'purchase.receive') };

  // ---------------------------------------------------------------- suppliers
  app.get('/suppliers', view, async (req) => {
    const q = s.supplierListQuery.parse(req.query);
    const out = await tx(req, (t) => svc.listSuppliers(t, { ...q, includeArchived: q.includeArchived === 'true', after: decodeCursor(q.cursor, page) }));
    return { items: out.items, nextCursor: out.last ? encodeCursor(out.last) : null };
  });
  app.get('/suppliers/:id', view, async (req) => tx(req, (t) => svc.getSupplier(t, s.idParam.parse(req.params).id)));
  app.post('/suppliers', manage, async (req, reply) => {
    const input = s.supplierInput.parse(req.body);
    return reply.code(201).send(await tx(req, (t) => svc.createSupplier(t, ctxOf(req), input)));
  });
  app.patch('/suppliers/:id', manage, async (req) => {
    const { id } = s.idParam.parse(req.params);
    const patch = s.supplierPatch.parse(req.body);
    return tx(req, (t) => svc.patchSupplier(t, ctxOf(req), id, patch));
  });

  // ---------------------------------------------------------------- purchase orders
  app.get('/purchase-orders', view, async (req) => {
    const q = s.poListQuery.parse(req.query);
    const out = await tx(req, (t) => svc.listPos(t, { ...q, after: decodeCursor(q.cursor, page) }));
    return { items: out.items, nextCursor: out.last ? encodeCursor(out.last) : null };
  });
  app.post('/purchase-orders', manage, async (req, reply) => {
    const input = s.poInput.parse(req.body);
    const out = await tx(req, (t) => idempotent(t, req.headers['idempotency-key'], { url: req.url, body: req.body }, async () =>
      ({ status: 201, body: await svc.createPo(t, ctxOf(req), input) })));
    return withEtag(reply.code(out.status), out.body);
  });
  app.get('/purchase-orders/:id', view, async (req, reply) =>
    withEtag(reply, await tx(req, (t) => svc.getPo(t, ctxOf(req), s.idParam.parse(req.params).id))));
  app.patch('/purchase-orders/:id', manage, async (req, reply) => {
    const { id } = s.idParam.parse(req.params);
    const version = ifMatch(req);
    const input = s.poInput.parse(req.body);
    return withEtag(reply, await tx(req, (t) => svc.patchPo(t, ctxOf(req), id, version, input)));
  });
  app.post('/purchase-orders/:id/:action', manage, async (req, reply) => {
    const { id, action } = s.poAction.parse(req.params);
    return withEtag(reply, await tx(req, (t) => svc.transitionPo(t, ctxOf(req), id, action)));
  });

  // ---------------------------------------------------------------- goods receipts
  const receive = { preHandler: requires('purchase.receive') };
  app.get('/goods-receipts', view, async (req) => {
    const q = s.docListQuery.parse(req.query);
    const out = await tx(req, async (t) => svc.listReceipts(t, { ...q, after: decodeCursor(q.cursor, page), scope: await outletScope(t, req) }));
    return { items: out.items, nextCursor: out.last ? encodeCursor(out.last) : null };
  });
  app.get('/goods-receipts/:id', view, async (req) => tx(req, (t) => svc.getReceipt(t, ctxOf(req), s.idParam.parse(req.params).id)));
  app.post('/goods-receipts', receive, async (req, reply) => {
    const input = s.receiptInput.parse(req.body);
    const out = await tx(req, (t) => idempotent(t, req.headers['idempotency-key'], { url: req.url, body: req.body }, async () =>
      ({ status: 201, body: await svc.postReceipt(t, ctxOf(req), input) })));
    return reply.code(out.status).send(out.body);
  });

  // ---------------------------------------------------------------- supplier returns
  app.get('/supplier-returns', view, async (req) => {
    const q = s.docListQuery.parse(req.query);
    const out = await tx(req, async (t) => svc.listSupplierReturns(t, { ...q, after: decodeCursor(q.cursor, page), scope: await outletScope(t, req) }));
    return { items: out.items, nextCursor: out.last ? encodeCursor(out.last) : null };
  });
  app.post('/supplier-returns', manage, async (req, reply) => {
    const input = s.supplierReturnInput.parse(req.body);
    const out = await tx(req, (t) => idempotent(t, req.headers['idempotency-key'], { url: req.url, body: req.body }, async () =>
      ({ status: 201, body: await svc.postSupplierReturn(t, ctxOf(req), input) })));
    return reply.code(out.status).send(out.body);
  });
}
