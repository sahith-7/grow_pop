import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import { config } from '../config.js';
import { tenantTx } from '../db.js';
import { appError } from './phase1.js';

// Store states and plan limits (B7, D67–D68). One place decides what a store in each state may do:
//   trial, active, past_due → everything (past due shows a banner)
//   suspended → read-only: every write is refused with 403 TENANT_SUSPENDED, except signing in and out and the Account
//               page (data export, support access); web orders are still received and wait in the inbox
//   closed    → only signing in, the subscription banner and the Account page (data export) answer; everything else 410
// The guard is added to every route by an onRoute hook, so Phase 1's routes are covered without changing them.

export type StoreState = 'trial' | 'active' | 'past_due' | 'suspended' | 'closed';
export interface StoreInfo { state: StoreState; planId: string; online: boolean }

const TTL_MS = config.NODE_ENV === 'test' ? 0 : 15_000;
const cache = new Map<string, { at: number; info: StoreInfo }>();

export async function storeInfo(tenantId: string): Promise<StoreInfo> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;
  const info = await tenantTx(tenantId, async (tx) => {
    const { rows: [r] } = await tx.query(
      `SELECT coalesce(s.state, 'active') AS state, t.plan_id, p.features
         FROM tenants t JOIN plans p ON p.id = t.plan_id LEFT JOIN subscriptions s ON s.tenant_id = t.id
        WHERE t.id = current_setting('app.tenant_id')::uuid`);
    if (!r) return { state: 'closed' as StoreState, planId: 'starter', online: false };
    // A trial includes everything, so a store can try the online shop before choosing a plan.
    return { state: r.state as StoreState, planId: r.plan_id as string, online: r.state === 'trial' || r.features?.online === true };
  });
  cache.set(tenantId, { at: Date.now(), info });
  return info;
}

/** Routes that still accept writes while suspended, and the only routes that answer once closed. */
const WRITABLE_WHEN_SUSPENDED = ['/v1/auth/', '/v1/account/'];
const OPEN_WHEN_CLOSED = ['/v1/auth/', '/v1/account/', '/v1/subscription'];
/** Routes that need a plan feature. Connecting the shop needs "online"; with no connection nothing else online runs. */
const NEEDS_ONLINE = new Set(['PUT /v1/integrations/woocommerce']);
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function guard(req: FastifyRequest) {
  if (!req.auth) return; // a route without a session (sign-in, webhooks) has nothing to check
  const url = req.routeOptions.url ?? req.url;
  const info = await storeInfo(req.auth.tenantId);
  if (info.state === 'closed' && !OPEN_WHEN_CLOSED.some((p) => url.startsWith(p)))
    throw appError(410, 'TENANT_CLOSED', 'This store is closed. The owner can still download its data from the Account page.');
  if ((info.state === 'suspended' || info.state === 'closed') && !READS.has(req.method) && !WRITABLE_WHEN_SUSPENDED.some((p) => url.startsWith(p)))
    throw appError(403, 'TENANT_SUSPENDED', 'Your store is read-only because payment is overdue. You can look at everything but not make changes until the payment is recorded.');
  if (NEEDS_ONLINE.has(`${req.method} ${url}`) && !info.online)
    throw appError(403, 'PLAN_LIMIT', 'Your plan does not include the online shop. Ask us to move you to Store + Online.');
}

/** Every route registered so far, for the isolation test (AC-01). */
export const registeredRoutes: { method: string; url: string }[] = [];

/** Call before any route is registered. */
export function installStoreGuard(app: FastifyInstance) {
  app.addHook('onRoute', (r: RouteOptions) => {
    for (const m of [r.method].flat()) registeredRoutes.push({ method: String(m), url: r.url });
    if (r.url.startsWith('/health') || r.url.startsWith('/v1/platform') || r.url.startsWith('/v1/webhooks')) return;
    // Appended, so it runs after the route's own session check has set req.auth.
    r.preHandler = r.preHandler ? [...[r.preHandler].flat(), guard] : [guard];
  });
}

/** What the job runner does with a job for this store: run it, put it off (suspended, or no plan for it), or drop it (closed). */
export async function jobGate(tenantId: string, kind: string): Promise<'run' | 'pause' | 'stop'> {
  if (kind === 'export') return 'run'; // an owner's data export always runs
  const info = await storeInfo(tenantId);
  if (info.state === 'closed') return 'stop';
  if (info.state === 'suspended') return 'pause';
  if (kind.startsWith('woo.') && !info.online) return 'pause';
  return 'run';
}
