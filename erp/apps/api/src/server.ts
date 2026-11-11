import './lib/zod-config.js'; // first: friendly validation messages for every schema (D95)
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';
import { AppError } from './lib/errors.js';
import { installAuthLimits } from './lib/auth-limits.js';
import { installStoreGuard } from './lib/saas.js';
import { accountRoutes } from './modules/account/routes.js';
import { auditRoutes } from './modules/audit.js';
import { authRoutes } from './modules/auth.js';
import { billingRoutes } from './modules/billing/routes.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { contactRoutes } from './modules/contacts/routes.js';
import { fileRoutes } from './modules/files/routes.js';
import { fulfilmentRoutes } from './modules/fulfilment/routes.js';
import { importRoutes } from './modules/imports/routes.js';
import { inventoryRoutes } from './modules/inventory/routes.js';
import { posRoutes } from './modules/pos/routes.js';
import { cashRoutes } from './modules/cash/routes.js';
import { outletRoutes } from './modules/outlets/routes.js';
import { pricingRoutes } from './modules/pricing/routes.js';
import { purchasingRoutes } from './modules/purchasing/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { searchRoutes } from './modules/search/routes.js';
import { platformRoutes } from './modules/platform/routes.js';
import { returnRoutes } from './modules/returns/routes.js';
import { customerRoutes } from './modules/sales/customers.js';
import { salesRoutes } from './modules/sales/routes.js';
import { settingsRoutes } from './modules/settings.js';
import { userRoutes } from './modules/users.js';
import { wooRoutes } from './modules/woocommerce/routes.js';
import { wooWebhookRoutes } from './modules/woocommerce/webhooks.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      // B4: the webhook URL token and signed image links are secrets; keep them out of request logs.
      serializers: {
        req: (r: { method: string; url: string; hostname?: string; ip?: string }) => ({
          method: r.method, url: r.url.replace(/(\/webhooks\/woocommerce\/(?:media\/)?)[^/?]+/, '$1[redacted]'), hostname: r.hostname, remoteAddress: r.ip,
        }),
      },
    },
    genReqId: () => randomUUID(),
    // A hop count trusts exactly that many proxies in front (D76).
    trustProxy: typeof config.TRUST_PROXY === 'number' ? ((hops: number) => (_addr: string, i: number) => i < hops)(config.TRUST_PROXY) : config.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  });

  await app.register(helmet);
  await app.register(cookie);
  // Per client address. A store's tills and back office usually share one public address, so this is a store's budget,
  // not a person's (B7 load test, D75). Sign-in routes get stricter limits (installAuthLimits, added first so it runs
  // before the plugin reads each route's config); B2–B7 routes that scan or upload set their own.
  installAuthLimits(app);
  await app.register(rateLimit, { max: 1200, timeWindow: '1 minute' });

  // CSRF defence on top of SameSite=Lax cookies: state-changing requests must come from our own web origin.
  app.addHook('onRequest', async (req) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    // B4: WooCommerce's server posts here; it is authenticated by the HMAC signature instead (webhooks.ts).
    if (req.url.startsWith('/v1/webhooks/')) return;
    if (req.headers.origin !== config.WEB_ORIGIN) throw new AppError(403, 'CSRF_REJECTED', 'Request origin not allowed');
  });

  app.setErrorHandler((err: any, req, reply) => {
    let status = 500, code = 'INTERNAL_ERROR', message = 'Something went wrong', fieldErrors: Record<string, string[]> | undefined;
    if (err instanceof ZodError) {
      status = 400; code = 'VALIDATION_ERROR'; message = 'Check the highlighted fields';
      fieldErrors = err.flatten().fieldErrors as Record<string, string[]>;
    } else if (err instanceof AppError) {
      ({ status, code, message, fieldErrors } = err);
    } else if (err.statusCode === 429) {
      status = 429; code = 'RATE_LIMITED'; message = 'Too many requests. Try again shortly.';
    } else if (err.statusCode >= 400 && err.statusCode < 500) {
      status = err.statusCode; code = 'BAD_REQUEST'; message = 'Invalid request';
    } else req.log.error({ err }, 'unhandled error');
    reply.code(status).send({ code, message, fieldErrors, correlationId: req.id, retryable: status >= 500 || status === 429 });
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    try { await pool.query('SELECT 1'); return { status: 'ok' }; } catch { return reply.code(503).send({ status: 'unavailable' }); }
  });

  // B7: store states (read-only when suspended, closed) and plan limits, on every route registered below.
  installStoreGuard(app);

  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.register(userRoutes, { prefix: '/v1/users' });
  await app.register(settingsRoutes, { prefix: '/v1/settings' });
  await app.register(auditRoutes, { prefix: '/v1/audit' });
  await app.register(fileRoutes, { prefix: '/v1/files' });
  await app.register(catalogRoutes, { prefix: '/v1' });
  await app.register(importRoutes, { prefix: '/v1' });
  await app.register(inventoryRoutes, { prefix: '/v1' });
  await app.register(purchasingRoutes, { prefix: '/v1' });
  await app.register(salesRoutes, { prefix: '/v1' });
  await app.register(wooRoutes, { prefix: '/v1' });
  await app.register(customerRoutes, { prefix: '/v1' });
  await app.register(contactRoutes, { prefix: '/v1' });
  await app.register(pricingRoutes, { prefix: '/v1' });
  await app.register(outletRoutes, { prefix: '/v1' });
  await app.register(posRoutes, { prefix: '/v1' });
  await app.register(cashRoutes, { prefix: '/v1' });
  await app.register(billingRoutes, { prefix: '/v1' });
  await app.register(returnRoutes, { prefix: '/v1' });
  await app.register(fulfilmentRoutes, { prefix: '/v1' });
  await app.register(reportRoutes, { prefix: '/v1' });
  await app.register(searchRoutes, { prefix: '/v1' });
  await app.register(accountRoutes, { prefix: '/v1' });
  await app.register(platformRoutes, { prefix: '/v1/platform' });
  await app.register(wooWebhookRoutes, { prefix: '/v1/webhooks' });
  return app;
}
