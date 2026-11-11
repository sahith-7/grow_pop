import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx } from '../../db.js';
import { csvLine } from '../../lib/csv.js';
import { fmtMoney, fmtQty } from '../../lib/decimal.js';
import { appError, audit, authOf, can, requires } from '../../lib/phase1.js';
import { ATTRIBUTE_KEYS } from '../catalog/schemas.js';
import { exportRows } from '../catalog/service.js';
import { COLUMNS, COLUMN_KEYS, type ColumnKey } from './columns.js';
import * as svc from './service.js';

const tx = <T>(req: FastifyRequest, fn: Parameters<typeof tenantTx<T>>[1]) => tenantTx(authOf(req).tenantId, fn);
const idParam = z.object({ id: z.string().uuid() });

// Columns the export can add that the import does not read (D100). A file with them is for reading, not re-importing.
const EXTRA_KEYS = ['stock_on_hand', 'net_weight'] as const;
const exportQuery = z.object({
  status: z.enum(['active', 'draft']).optional(),
  categoryId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  productIds: z.string().max(19_000).optional(),
  columns: z.string().max(1000).optional(),
}).strict();

const startBody = z.object({
  kind: z.literal('products').default('products'),
  fileId: z.string().uuid(),
  mapping: z.partialRecord(z.enum(COLUMN_KEYS as [ColumnKey, ...ColumnKey[]]), z.string().max(200)).default({}),
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
  // The export dialog (v2, D100) chooses which products and which columns. With no options it is the full,
  // import-ready file it always was. product_name and sku always come first so a file can be matched back.
  app.get('/exports/products.csv', { preHandler: requires('report.export'), config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const q = exportQuery.parse(req.query);
    const showCost = can(req, 'cost.view');
    const all = [...COLUMN_KEYS, ...EXTRA_KEYS].filter((k) => k !== 'cost' || showCost) as string[];
    const chosen = q.columns ? q.columns.split(',').map((c) => c.trim()).filter(Boolean) : null;
    const unknown = chosen?.filter((c) => !all.includes(c)) ?? [];
    if (unknown.length) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { columns: [`Unknown column: ${unknown.join(', ')}`] });
    const keys: string[] = chosen
      ? ['product_name', 'sku', ...all.filter((k) => k !== 'product_name' && k !== 'sku' && chosen.includes(k))]
      : COLUMN_KEYS.filter((k) => k !== 'cost' || showCost);
    const productIds = q.productIds ? q.productIds.split(',').filter(Boolean) : undefined;
    if (productIds && (productIds.length > 500 || productIds.some((id) => !z.string().uuid().safeParse(id).success))) {
      throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { productIds: ['Up to 500 product ids'] });
    }
    const body = await tx(req, async (t) => {
      const rows = await exportRows(t, { status: q.status, categoryId: q.categoryId, brandId: q.brandId, q: q.q, productIds });
      await audit(t, { actorId: authOf(req).userId, action: 'export.products', entityType: 'export',
        summary: { rows: rows.length, cost: keys.includes('cost'), columns: chosen ? keys.length : 'all', filtered: !!(q.status || q.categoryId || q.brandId || q.q || productIds) } });
      return BOM + csvLine(keys) + rows.map((r) => {
        const v: Record<string, unknown> = {
          ...r, price: fmtMoney(r.price), mrp: fmtMoney(r.mrp), cost: fmtMoney(r.cost), reorder_level: fmtQty(r.reorder_level),
          gst_rate: r.gst_rate === null ? '' : String(Number(r.gst_rate)),
          stock_on_hand: fmtQty(r.stock_on_hand), net_weight: r.net_weight === null ? '' : `${fmtQty(r.net_weight)} ${r.net_weight_unit}`,
        };
        for (const a of ATTRIBUTE_KEYS) v[a] = r.attributes[a] ?? '';
        return csvLine(keys.map((k) => v[k]));
      }).join('');
    });
    return reply.headers(csv(`products-${new Date().toISOString().slice(0, 10)}.csv`)).send(body);
  });

}
