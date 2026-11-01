import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx } from '../../db.js';
import { appError } from '../../lib/phase1.js';
import { idempotent } from '../../lib/idempotency.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { authOf, can, requires } from '../../lib/phase1.js';
import * as s from './schemas.js';
import * as svc from './service.js';

const ctxOf = (req: FastifyRequest): svc.Ctx => ({ userId: authOf(req).userId, showCost: can(req, 'cost.view') });
const tx = <T>(req: FastifyRequest, fn: Parameters<typeof tenantTx<T>>[1]) => tenantTx(authOf(req).tenantId, fn);

/** If-Match: "3" (or 3). Required on PATCH so two people editing the same product cannot silently overwrite each other. */
function ifMatch(req: FastifyRequest): number {
  const raw = req.headers['if-match'];
  const m = typeof raw === 'string' ? /^(?:W\/)?"?(\d+)"?$/.exec(raw.trim()) : null;
  if (!m) throw appError(428, 'VERSION_REQUIRED', 'Reload the page and try again');
  return Number(m[1]);
}
const withEtag = (reply: FastifyReply, body: { version: number }) => reply.header('etag', `"${body.version}"`).send(body);

export async function catalogRoutes(app: FastifyInstance) {
  const read = { preHandler: requires('product.read') };
  const write = { preHandler: requires('product.write') };

  // ---------------------------------------------------------------- categories, brands, units
  for (const table of ['categories', 'brands'] as const) {
    app.get(`/${table}`, read, async (req) => {
      const { includeArchived } = z.object({ includeArchived: z.enum(['true', 'false']).optional() }).parse(req.query);
      return { items: await tx(req, (t) => svc.listRefs(t, table, includeArchived === 'true')) };
    });
    app.post(`/${table}`, write, async (req, reply) => {
      const body = s.refInput.parse(req.body);
      if (table === 'brands' && body.parentId) throw appError(400, 'VALIDATION_ERROR', 'Brands have no parent', { parentId: ['Not allowed'] });
      return reply.code(201).send(await tx(req, (t) => svc.createRef(t, table, body)));
    });
    app.patch(`/${table}/:id`, write, async (req) => {
      const { id } = s.idParam.parse(req.params);
      return tx(req, (t) => svc.patchRef(t, table, id, s.refInput.parse(req.body)));
    });
  }
  app.get('/units', read, async (req) => ({ items: await tx(req, svc.listUnits) }));

  // What the product screens need in one call: reference lists and what this user may do.
  app.get('/catalog/meta', read, async (req) => {
    return {
      units: await tx(req, svc.listUnits), gstRates: s.GST_RATES, attributeKeys: s.ATTRIBUTE_KEYS,
      can: { write: can(req, 'product.write'), seeCost: can(req, 'cost.view'), export: can(req, 'report.export') },
    };
  });

  // ---------------------------------------------------------------- products
  app.get('/products', read, async (req) => {
    const q = s.productListQuery.parse(req.query);
    const after = decodeCursor(q.cursor, z.tuple([z.string(), z.string().uuid()]));
    const page = await tx(req, (t) => svc.listProducts(t, { ...q, after }));
    return { items: page.items, nextCursor: page.last ? encodeCursor(page.last) : null };
  });

  app.post('/products', write, async (req, reply) => {
    const input = s.productInput.parse(req.body);
    const out = await tx(req, (t) => idempotent(t, req.headers['idempotency-key'], req.body, async () =>
      ({ status: 201, body: await svc.createProduct(t, ctxOf(req), input) })));
    return withEtag(reply.code(out.status), out.body);
  });

  app.get('/products/:id', read, async (req, reply) => {
    const { id } = s.idParam.parse(req.params);
    return withEtag(reply, await tx(req, (t) => svc.getProduct(t, id, ctxOf(req))));
  });

  app.patch('/products/:id', write, async (req, reply) => {
    const { id } = s.idParam.parse(req.params);
    const version = ifMatch(req);
    const patch = s.productPatch.parse(req.body);
    return withEtag(reply, await tx(req, (t) => svc.patchProduct(t, ctxOf(req), id, version, patch)));
  });

  for (const [path, archived] of [['archive', true], ['restore', false]] as const) {
    app.post(`/products/:id/${path}`, write, async (req, reply) => {
      const { id } = s.idParam.parse(req.params);
      return withEtag(reply, await tx(req, (t) => svc.setProductArchived(t, ctxOf(req), id, archived)));
    });
    app.post(`/variants/:id/${path}`, write, async (req, reply) => {
      const { id } = s.idParam.parse(req.params);
      return withEtag(reply, await tx(req, (t) => svc.setVariantArchived(t, ctxOf(req), id, archived)));
    });
  }

  // ---------------------------------------------------------------- variants
  app.post('/products/:id/variants', write, async (req, reply) => {
    const { id } = s.idParam.parse(req.params);
    const input = s.variantInput.parse(req.body);
    return withEtag(reply.code(201), await tx(req, (t) => svc.addVariant(t, ctxOf(req), id, input)));
  });

  app.patch('/variants/:id', write, async (req, reply) => {
    const { id } = s.idParam.parse(req.params);
    const version = ifMatch(req);
    const patch = s.variantPatch.parse(req.body);
    return withEtag(reply, await tx(req, (t) => svc.patchVariant(t, ctxOf(req), id, version, patch)));
  });

  // Scanners fire fast, so this route gets a higher limit than the default (conventions.md).
  app.get('/lookup', { ...read, config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (req) => {
    const { code } = z.object({ code: z.string().trim().min(1).max(64) }).parse(req.query);
    return tx(req, (t) => svc.lookup(t, code, ctxOf(req)));
  });

  // ---------------------------------------------------------------- images
  app.post('/products/:id/images', write, async (req, reply) => {
    const { id } = s.idParam.parse(req.params);
    const input = s.imageInput.parse(req.body);
    return reply.code(201).send(await tx(req, (t) => svc.addImage(t, ctxOf(req), id, input)));
  });
  app.put('/products/:id/images/order', write, async (req) => {
    const { id } = s.idParam.parse(req.params);
    const { imageIds, primaryImageId } = s.imageOrder.parse(req.body);
    return { items: await tx(req, (t) => svc.reorderImages(t, id, imageIds, primaryImageId)) };
  });
  app.patch('/products/:id/images/:imageId', write, async (req) => {
    const { id, imageId } = s.imageParam.parse(req.params);
    const input = s.imagePatch.parse(req.body);
    return tx(req, (t) => svc.patchImage(t, id, imageId, input));
  });
  app.delete('/products/:id/images/:imageId', write, async (req, reply) => {
    const { id, imageId } = s.imageParam.parse(req.params);
    await tx(req, (t) => svc.deleteImage(t, id, imageId));
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- barcodes & labels
  app.post('/barcodes/generate', write, async (req) => {
    const { count } = z.object({ count: z.number().int().min(1).max(500) }).strict().parse(req.body);
    return { codes: await tx(req, (t) => svc.generateBarcodes(t, count)) };
  });
  app.post('/labels', read, async (req) => {
    const { items } = s.labelsInput.parse(req.body);
    return { labels: await tx(req, (t) => svc.labels(t, items)) };
  });
}
