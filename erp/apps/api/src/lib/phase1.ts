/**
 * B2–B7's bridge to Phase 1. The only file that imports Phase 1's session, permissions, audit and error code.
 * Matches Phase 1 as of 2026-10-15: requires() in lib/session.ts, can() in lib/permissions.ts, audit() in lib/audit.ts.
 */
import type { FastifyRequest } from 'fastify';
import type { Tx } from '../db.js';
import { audit as phase1Audit } from './audit.js';
import { AppError } from './errors.js';
import { can as roleCan, type Permission } from './permissions.js';
import { requires as phase1Requires } from './session.js';

/** Permissions B2–B6 check. If one is missing from Phase 1's Permission type, typecheck fails here. */
type B2Permission = Extract<Permission, 'product.read' | 'product.write' | 'cost.view' | 'report.export'
  | 'stock.read' | 'stock.adjust' | 'stock.writeoff' | 'stock.transfer' | 'stock.override_negative'
  | 'stocktake.count' | 'stocktake.approve' | 'purchase.manage' | 'purchase.receive' | 'settings.manage'
  | 'order.read' | 'order.fulfil' | 'sync.manage' | 'woo.connect'
  | 'settings.read' | 'pos.sell' | 'pos.discount' | 'pos.price_override' | 'return.manage' | 'invoice.read' | 'invoice.void'
  | 'report.view' | 'account.manage' | 'contacts.view' | 'price.bulk' | 'users.manage' | 'pos.discount_approve' | 'cash.manage'>;

/** Route guard: valid session plus the permission, checked by Phase 1. */
export const requires = (perm: B2Permission) => phase1Requires(perm);

/** Route guard for screens every signed-in user sees (the dashboard): a valid session, no particular permission. */
export const signedIn = () => phase1Requires();

/** Route guard for screens two roles share (e.g. purchase.manage or purchase.receive): valid session plus any one of them. */
export const requiresAny = (...perms: B2Permission[]) => [
  phase1Requires(),
  async (req: FastifyRequest) => {
    if (!perms.some((p) => roleCan(authOf(req).role, p))) throw appError(403, 'FORBIDDEN', 'You do not have permission to do this');
  },
];

/** The signed-in user. Set by requires(), which runs before every B2 handler. */
export const authOf = (req: FastifyRequest) => req.auth!;

export const can = (req: FastifyRequest, perm: B2Permission) => roleCan(authOf(req).role, perm);

/** Audit row in the caller's transaction. The tenant is the one tenantTx() set, so callers cannot pass the wrong one. */
export async function audit(tx: Tx, e: { actorId: string | null; action: string; entityType: string; entityId?: string; summary?: object }) {
  const { rows } = await tx.query("SELECT current_setting('app.tenant_id') AS tenant_id");
  await phase1Audit(tx, { tenantId: rows[0].tenant_id, actorId: e.actorId, action: e.action, entity: e.entityType, entityId: e.entityId, summary: e.summary });
}

/**
 * Phase 1's AppError carrying B2's status/code/message/fieldErrors. Built from the prototype so it does not depend on
 * AppError's constructor signature; Phase 1's error handler only reads these four fields and checks instanceof.
 */
export function appError(status: number, code: string, message: string, fieldErrors?: Record<string, string[]>): AppError {
  const e = Object.create(AppError.prototype) as AppError & { status: number; code: string; fieldErrors?: Record<string, string[]> };
  Object.assign(e, { name: 'AppError', message, status, code, fieldErrors, stack: new Error(message).stack });
  return e;
}
