import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx } from '../../db.js';
import { csvLine } from '../../lib/csv.js';
import { fmtMoney, fmtQty } from '../../lib/decimal.js';
import { audit, authOf, can, requires } from '../../lib/phase1.js';
import { ATTRIBUTE_KEYS } from '../catalog/schemas.js';
import { exportRows } from '../catalog/service.js';
import { COLUMNS, COLUMN_KEYS, type ColumnKey } from './columns.js';
import * as svc from './service.js';

const tx = <T>(req: FastifyRequest, fn: Parameters<typeof tenantTx<T>>[1]) => tenantTx(authOf(req).tenantId, fn);
const idParam = z.object({ id: z.string().uuid() });

const startBody = z.object({
  kind: z.literal('products').default('products'),
  fileId: z.string().uuid(),
  mapping: z.record(z.enum(COLUMN_KEYS as [ColumnKey, ...ColumnKey[]]), z.string().max(200)).default({}),
}).strict();

const csv = (name: string) => ({
  'content-type': 'text/csv; charset=utf-8',
  'content-disposition': `attachment; filename="${name}"`,
  'cache-control': 'no-store',
});
// Excel only reads UTF-8 (₹, Hindi names) correctly when the file starts with a BOM.
const BOM = '﻿';

export async function importRoutes(app: FastifyInstance) {
  const write = { preHandler: requires('product.write') };

  app.get('/imports/template.csv', write, async (req, reply) => {
    const keys = COLUMNS.map((c) => c.key).filter((k) => k !== 'cost' || can(req, 'cost.view'));
    const example: Partial<Record<ColumnKey, string>>[] = [
      { product_name: 'Cotton T-shirt', sku: 'TS-RED-M', price: '499', mrp: '599', cost: '220', category: 'Apparel > T-shirts', brand: 'Acme', unit: 'pcs', hsn_code: '6109', gst_rate: '5', size: 'M', colour: 'Red', status: 'active' },
      { product_name: 'Cotton T-shirt', sku: 'TS-RED-L', price: '499', mrp: '599', cost: '220', size: 'L', colour: 'Red' },
      { product_name: 'Basmati Rice 5kg', sku: 'RICE-5', price: '650', barcode: '8901234567890', category: 'Grocery', unit: 'pcs', hsn_code: '1006', gst_rate: '5' },
    ];
    return reply.headers(csv('product-import-template.csv'))
      .send(BOM + csvLine(keys) + example.map((e) => csvLine(keys.map((k) => e[k] ?? ''))).join(''));
  });

  app.get('/imports', write, async (req) => ({ items: await tx(req, svc.listImports) }));

  app.post('/imports', write, async (req, reply) => {
    const body = startBody.parse(req.body);
    const job = await tx(req, (t) => svc.startImport(t, {
      userId: authOf(req).userId, canCost: can(req, 'cost.view'), fileId: body.fileId, mapping: body.mapping }));
    return reply.code(202).send(job);
  });

  app.get('/imports/:id', write, async (req) => {
    const { id } = idParam.parse(req.params);
    return tx(req, (t) => svc.getImport(t, id));
  });

  app.post('/imports/:id/commit', write, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    return reply.code(202).send(await tx(req, (t) => svc.commitImport(t, id)));
  });

  app.get('/imports/:id/error-report.csv', write, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const rows = await tx(req, (t) => svc.errorReport(t, id));
    return reply.headers(csv('import-errors.csv')).send(BOM + rows.map(csvLine).join(''));
  });

  // CAT-11. Synchronous: a 5,000-variant catalog is well under a second. Audited with the row count.
  app.get('/exports/products.csv', { preHandler: requires('report.export'), config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const showCost = can(req, 'cost.view');
    const keys = COLUMN_KEYS.filter((k) => k !== 'cost' || showCost);
    const body = await tx(req, async (t) => {
      const rows = await exportRows(t);
      await audit(t, { actorId: authOf(req).userId, action: 'export.products', entityType: 'export', summary: { rows: rows.length, cost: showCost } });
      return BOM + csvLine(keys) + rows.map((r) => {
        const v: Record<string, unknown> = {
          ...r, price: fmtMoney(r.price), mrp: fmtMoney(r.mrp), cost: fmtMoney(r.cost), reorder_level: fmtQty(r.reorder_level),
          gst_rate: r.gst_rate === null ? '' : String(Number(r.gst_rate)),
        };
        for (const a of ATTRIBUTE_KEYS) v[a] = r.attributes[a] ?? '';
        return csvLine(keys.map((k) => v[k]));
      }).join('');
    });
    return reply.headers(csv(`products-${new Date().toISOString().slice(0, 10)}.csv`)).send(body);
  });
}
