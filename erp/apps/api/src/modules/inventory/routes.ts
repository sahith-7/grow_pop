import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx } from '../../db.js';
import { csvLine } from '../../lib/csv.js';
import { idempotent } from '../../lib/idempotency.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { authOf, can, requires, requiresAny } from '../../lib/phase1.js';
import { listMovements } from './ledger.js';
import * as s from './schemas.js';
import * as svc from './service.js';
import * as st from './stocktakes.js';

type Perm = Parameters<typeof can>[1];
export const ctxOf = (req: FastifyRequest): svc.Ctx => ({
  userId: authOf(req).userId, showCost: can(req, 'cost.view'), can: (p) => can(req, p as Perm),
});
const tx = <T>(req: FastifyRequest, fn: Parameters<typeof tenantTx<T>>[1]) => tenantTx(authOf(req).tenantId, fn);

/** A write that posts stock: runs once per Idempotency-Key, so a double click or a network retry cannot post twice. */
const once = <T>(req: FastifyRequest, status: number, fn: (t: Parameters<Parameters<typeof tenantTx>[1]>[0]) => Promise<T>) =>
  tx(req, (t) => idempotent(t, req.headers['idempotency-key'], { url: req.url, body: req.body }, async () => ({ status, body: await fn(t) })));

export async function inventoryRoutes(app: FastifyInstance) {
  const read = { preHandler: requires('stock.read') };
  const settings = { preHandler: requires('settings.manage') };

  // What the stock screens need in one call: locations and what this user may do.
  app.get('/stock/meta', read, async (req) => ({
    locations: await tx(req, svc.listLocations),
    can: {
      adjust: can(req, 'stock.adjust'), writeoff: can(req, 'stock.writeoff'), transfer: can(req, 'stock.transfer'),
      overrideNegative: can(req, 'stock.override_negative'), count: can(req, 'stocktake.count'), approve: can(req, 'stocktake.approve'),
      purchaseManage: can(req, 'purchase.manage'), purchaseReceive: can(req, 'purchase.receive'),
      manageLocations: can(req, 'settings.manage'), seeCost: can(req, 'cost.view'),
    },
  }));

  // ---------------------------------------------------------------- locations
  app.get('/locations', read, async (req) => ({ items: await tx(req, svc.listLocations) }));
  app.post('/locations', settings, async (req, reply) => {
    const input = s.locationInput.parse(req.body);
    return reply.code(201).send(await tx(req, (t) => svc.createLocation(t, ctxOf(req), input)));
  });
  app.patch('/locations/:id', settings, async (req) => {
    const { id } = s.idParam.parse(req.params);
    const patch = s.locationPatch.parse(req.body);
    return tx(req, (t) => svc.patchLocation(t, ctxOf(req), id, patch));
  });

  // ---------------------------------------------------------------- balances and history
  app.get('/stock/balances', read, async (req) => {
    const q = s.balancesQuery.parse(req.query);
    const after = decodeCursor(q.cursor, z.tuple([z.string(), z.string(), z.string().uuid()]));
    const page = await tx(req, (t) => svc.listBalances(t, { ...q, lowStock: q.lowStock === 'true', after }, can(req, 'cost.view')));
    return { items: page.items, nextCursor: page.last ? encodeCursor(page.last) : null };
  });

  app.get('/stock/movements', read, async (req) => {
    const q = s.movementsQuery.parse(req.query);
    const after = decodeCursor(q.cursor, z.tuple([z.number().int()]));
    const page = await tx(req, (t) => listMovements(t, { ...q, afterSeq: after?.[0] ?? null }, can(req, 'cost.view')));
    return { items: page.items, nextCursor: page.last ? encodeCursor([page.last]) : null };
  });

  app.get('/stock/reconciliation', { preHandler: requires('stock.adjust') }, async (req) => ({ mismatches: await tx(req, svc.reconciliation) }));

  // ---------------------------------------------------------------- postings
  app.post('/stock/adjustments', { preHandler: requiresAny('stock.adjust', 'stock.writeoff') }, async (req, reply) => {
    const input = s.adjustmentInput.parse(req.body);
    const out = await once(req, 201, (t) => svc.postAdjustment(t, ctxOf(req), input));
    return reply.code(out.status).send(out.body);
  });

  app.post('/stock/transfers', { preHandler: requires('stock.transfer') }, async (req, reply) => {
    const input = s.transferInput.parse(req.body);
    const out = await once(req, 201, (t) => svc.postTransfer(t, ctxOf(req), input));
    return reply.code(out.status).send(out.body);
  });

  app.post('/stock/movements/:id/reverse', { preHandler: requires('stock.adjust') }, async (req, reply) => {
    const { id } = s.idParam.parse(req.params);
    const { note } = s.reverseInput.parse(req.body);
    const out = await once(req, 201, (t) => svc.reverseDocument(t, ctxOf(req), id, note));
    return reply.code(out.status).send(out.body);
  });

  // ---------------------------------------------------------------- opening stock CSV
  app.get('/stock/opening-import/template.csv', { preHandler: requires('stock.adjust') }, async (req, reply) => {
    const cols = ['sku', 'qty', 'location', ...(can(req, 'cost.view') ? ['unit_cost'] : [])];
    const ex = [['TS-RED-M', '24', 'Shop floor', '220'], ['TS-RED-L', '12', 'Back room', '220'], ['RICE-5', '40', '', '510']];
    return reply.headers({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="opening-stock-template.csv"', 'cache-control': 'no-store' })
      .send('﻿' + csvLine(cols) + ex.map((r) => csvLine(r.slice(0, cols.length))).join(''));
  });
  app.post('/stock/opening-import', { preHandler: requires('stock.adjust') }, async (req, reply) => {
    const input = s.openingImportInput.parse(req.body);
    if (!input.commit) return tx(req, (t) => svc.openingImport(t, ctxOf(req), input));
    const out = await once(req, 201, (t) => svc.openingImport(t, ctxOf(req), input));
    return reply.code(out.status).send(out.body);
  });

  // ---------------------------------------------------------------- stocktakes (INV-05)
  const count = { preHandler: requires('stocktake.count') };
  const approve = { preHandler: requires('stocktake.approve') };

  app.get('/stocktakes', count, async (req) => {
    const q = s.stocktakeListQuery.parse(req.query);
    const after = decodeCursor(q.cursor, z.tuple([z.string(), z.string().uuid()]));
    const page = await tx(req, (t) => st.listStocktakes(t, { ...q, after }));
    return { items: page.items, nextCursor: page.last ? encodeCursor(page.last) : null };
  });
  app.post('/stocktakes', count, async (req, reply) => {
    const input = s.stocktakeInput.parse(req.body);
    return reply.code(201).send(await tx(req, (t) => st.createStocktake(t, ctxOf(req), input)));
  });
  app.get('/stocktakes/:id', count, async (req) => {
    const { id } = s.idParam.parse(req.params);
    return tx(req, (t) => st.getStocktake(t, ctxOf(req), id));
  });
  // Every scan saves, so this gets the scanner rate limit (conventions.md).
  app.put('/stocktakes/:id/counts', { ...count, config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = s.idParam.parse(req.params);
    const { counts } = s.countsInput.parse(req.body);
    return tx(req, (t) => st.saveCounts(t, ctxOf(req), id, counts));
  });
  app.post('/stocktakes/:id/submit', count, async (req) => tx(req, (t) => st.submitStocktake(t, ctxOf(req), s.idParam.parse(req.params).id)));
  app.post('/stocktakes/:id/reopen', approve, async (req) => tx(req, (t) => st.reopenStocktake(t, ctxOf(req), s.idParam.parse(req.params).id)));
  app.post('/stocktakes/:id/cancel', approve, async (req) => tx(req, (t) => st.cancelStocktake(t, ctxOf(req), s.idParam.parse(req.params).id)));
  app.post('/stocktakes/:id/post', approve, async (req, reply) => {
    const { id } = s.idParam.parse(req.params);
    const out = await once(req, 200, (t) => st.postStocktake(t, ctxOf(req), id));
    return reply.code(out.status).send(out.body);
  });
}
