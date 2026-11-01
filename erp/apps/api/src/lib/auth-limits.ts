import type { FastifyInstance, RouteOptions } from 'fastify';
import { config } from '../config.js';

// Stricter per-address limits on Phase 1's sign-in routes (B7, D75). Raising the global limit to 1,200 a minute (a whole
// store shares one address) must not raise the password-guessing budget with it. Applied from outside, by an onRoute
// hook that runs before @fastify/rate-limit's own, so Phase 1's auth module is unchanged; a route that already sets its
// own limit keeps it. Off in tests, which sign up hundreds of stores from one address.
const LIMITS: Record<string, { max: number; timeWindow: string }> = {
  '/v1/auth/login': { max: 20, timeWindow: '15 minutes' },
  '/v1/auth/register': { max: 10, timeWindow: '1 hour' },
  '/v1/auth/forgot-password': { max: 10, timeWindow: '1 hour' },
};
const OTHER_AUTH_POST = { max: 30, timeWindow: '15 minutes' };   // reset-password, invitations and the like

export function installAuthLimits(app: FastifyInstance) {
  if (config.NODE_ENV === 'test') return;
  app.addHook('onRoute', (r: RouteOptions) => {
    if (!r.url.startsWith('/v1/auth/') || ![r.method].flat().includes('POST') || r.url === '/v1/auth/logout') return;
    const routeConfig = (r.config ?? {}) as { rateLimit?: unknown };
    if (routeConfig.rateLimit != null) return;
    r.config = { ...routeConfig, rateLimit: LIMITS[r.url] ?? OTHER_AUTH_POST } as RouteOptions['config'];
  });
}
