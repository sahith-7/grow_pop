// Browser calls for the platform console (B7). Separate from catalog-api: a console session that ends goes to the
// console's own sign-in, never to the store sign-in.
import { ApiError } from './catalog-api';
export { ApiError } from './catalog-api';

export async function papi<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/v1/platform${path}`, {
    method: opts.method ?? 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (res.status === 401 && path !== '/login') { window.location.href = '/platform/login'; throw new ApiError(401, 'PLATFORM_AUTH', 'Sign in again'); }
  if (!res.ok) throw new ApiError(res.status, json?.code ?? 'ERROR', json?.message ?? 'Something went wrong', json?.fieldErrors ?? {}, json?.correlationId);
  return json as T;
}

export const perr = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Check your connection and try again.');

export interface StoreRow {
  id: string; name: string; createdAt: string; state: string; storeCode: string; planId: string; planName: string;
  trialEndsAt: string | null; paidUntil: string | null; ownerEmail: string | null; users: number; lastSeenAt: string | null;
}
export interface StoreDetail {
  id: string; name: string; legalName: string; createdAt: string; timezone: string; planId: string; state: string; storeCode: string;
  trialEndsAt: string | null; paidUntil: string | null; pastDueSince: string | null; closedAt: string | null; stateChangedAt: string;
  owner: { name: string; email: string } | null; users: number;
  payments: { receiptNo: string; amountPaise: number; method: string; reference: string; paidOn: string; planId: string; months: number; periodTo: string; recordedBy: string; createdAt: string }[];
  events: { from: string | null; to: string; actor: string; reason: string | null; at: string }[];
  supportGrant: { expiresAt: string; reason: string | null } | null;
  /** v2, D101: extra outlets switched on for this store, and its outlets (names only). */
  outlets: { extraOutlets: number; outlets: { name: string; main: boolean; active: boolean; createdAt: string }[] };
}
export interface PlanRow { id: string; name: string; maxUsers: number; online: boolean; priceMonthPaise: number | null; priceYearPaise: number | null }
