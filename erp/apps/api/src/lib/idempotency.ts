import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Tx } from '../db.js';
import { appError } from './phase1.js';

const keyHeader = z.string().uuid();

/**
 * Run `fn` at most once per Idempotency-Key (conventions.md). Must be called inside the same tenantTx as the write,
 * so the key and the write commit or roll back together. A concurrent duplicate blocks on the primary key until the
 * first request commits, then replays its response.
 */
export async function idempotent<T>(tx: Tx, rawKey: unknown, body: unknown, fn: () => Promise<{ status: number; body: T }>) {
  if (rawKey === undefined) return fn();
  const parsed = keyHeader.safeParse(rawKey);
  if (!parsed.success) throw appError(400, 'VALIDATION_ERROR', 'Idempotency-Key must be a UUID');
  const hash = createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
  const ins = await tx.query(
    `INSERT INTO idempotency_keys (tenant_id, key, request_hash)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2) ON CONFLICT DO NOTHING RETURNING key`, [parsed.data, hash]);
  if (!ins.rowCount) {
    const { rows } = await tx.query('SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1', [parsed.data]);
    const prev = rows[0];
    if (prev.request_hash !== hash) throw appError(422, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different request');
    return { status: prev.status_code as number, body: prev.response as T };
  }
  const out = await fn();
  await tx.query('UPDATE idempotency_keys SET status_code = $2, response = $3 WHERE key = $1', [parsed.data, out.status, JSON.stringify(out.body)]);
  return out;
}
