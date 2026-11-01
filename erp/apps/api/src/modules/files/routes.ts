import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from '../../db.js';
import { authOf, requires } from '../../lib/phase1.js';
import { MAX_UPLOAD_BYTES, readFile, storeUpload } from './service.js';

/**
 * Uploads go through the API instead of presigned PUTs (D22): the size and magic-byte checks happen before anything
 * is stored, the bucket needs no CORS, and the browser never sees a bucket URL.
 */
export async function fileRoutes(app: FastifyInstance) {
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp', 'text/csv'], { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
    (_req, body, done) => done(null, body));

  const uploadQuery = z.object({ kind: z.enum(['product_image', 'import']), name: z.string().max(200).optional() }).strict();

  // POST /v1/files?kind=product_image  (body = raw file bytes, Content-Type = its type)
  app.post('/', { preHandler: requires('product.write'), bodyLimit: MAX_UPLOAD_BYTES, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = uploadQuery.parse(req.query);
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ code: 'UNSUPPORTED_FILE_TYPE', message: 'Upload a JPEG, PNG, WebP or CSV file', correlationId: req.id, retryable: false });
    const { tenantId, userId } = authOf(req);
    const file = await tenantTx(tenantId, (tx) => storeUpload(tx, { tenantId, userId, kind: q.kind, contentType: req.headers['content-type'] ?? '', body: req.body as Buffer, name: q.name }));
    return reply.code(201).send({ fileId: file.id, contentType: file.contentType, byteSize: file.byteSize });
  });

  // Product images are served through the API so the bucket stays private and the browser needs no S3 host in its CSP.
  app.get('/:id/content', { preHandler: requires('product.read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const f = await tenantTx(authOf(req).tenantId, (tx) => readFile(tx, id, 'product_image'));
    return reply
      .header('content-type', f.contentType)
      .header('cache-control', 'private, max-age=86400, immutable') // files are never modified; replacing an image makes a new file
      .header('content-security-policy', "default-src 'none'")
      .header('content-disposition', 'inline')
      .send(f.body);
  });
}
