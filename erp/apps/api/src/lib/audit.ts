import type { Tx } from '../db.js';

export interface AuditEvent {
  tenantId: string; actorId: string | null; action: string; entity: string; entityId?: string; summary?: object; requestId?: string;
}

/** Appends an audit row in the caller's transaction, so the change and its record commit or fail together. erp_rt can't edit them. */
export async function audit(c: Tx, e: AuditEvent) {
  await c.query(
    `INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, summary, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.tenantId, e.actorId, e.action, e.entity, e.entityId ?? null, JSON.stringify(e.summary ?? {}), e.requestId ?? null],
  );
}
