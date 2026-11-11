import { z } from 'zod';
import type { Tx } from '../../db.js';
import { appError, audit } from '../../lib/phase1.js';

// Payment methods (v2, D109). Every store starts with Cash, UPI, Card and Other, made on first use. The owner or a
// manager can rename them, switch any of them off for the whole store or at chosen outlets (the card machine at one shop
// is broken), and add their own ("Paytm machine 2"), each of a kind: what the money is. Only cash counts in the drawer.
// A method is never deleted, because payments point at it.

export const KINDS = ['cash', 'upi', 'card', 'other'] as const;
export type Kind = (typeof KINDS)[number];
const BUILTIN: { kind: Kind; name: string; position: number }[] = [
  { kind: 'cash', name: 'Cash', position: 0 }, { kind: 'upi', name: 'UPI', position: 1 }, { kind: 'card', name: 'Card', position: 2 }, { kind: 'other', name: 'Other', position: 3 },
];
const MAX_METHODS = 20;
const KIND_LABEL: Record<Kind, string> = { cash: 'cash', upi: 'UPI', card: 'cards', other: 'other payments' };

const name = z.string().trim().min(1, 'Give it a name').max(40);
export const methodInput = z.object({ name, kind: z.enum(['upi', 'card', 'other']) }).strict();
export const methodPatch = z.object({
  name, active: z.boolean(), position: z.number().int().min(0).max(1000),
  /** Outlets where it is switched off; the rest have it (when it is on at all). */
  offAt: z.array(z.string().uuid()).max(50),
}).partial().strict();

export interface Method { id: string; kind: Kind; name: string; builtin: boolean; active: boolean; position: number; offAt: string[] }

/** The four built-in methods, made the first time anything asks for the list. */
export async function ensureMethods(tx: Tx) {
  await tx.query(
    `INSERT INTO payment_methods (tenant_id, kind, name, builtin, position)
     SELECT current_setting('app.tenant_id')::uuid, b.kind, b.name, true, b.position FROM jsonb_to_recordset($1) AS b(kind text, name text, position int)
      WHERE NOT EXISTS (SELECT 1 FROM payment_methods WHERE builtin) ON CONFLICT DO NOTHING`, [JSON.stringify(BUILTIN)]);
}

export async function listMethods(tx: Tx): Promise<Method[]> {
  await ensureMethods(tx);
  const { rows } = await tx.query(
    `SELECT m.*, coalesce((SELECT array_agg(x.outlet_id::text) FROM payment_method_off x WHERE x.method_id = m.id), '{}') AS off_at
       FROM payment_methods m ORDER BY m.position, m.created_at`);
  return rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, builtin: r.builtin, active: r.active, position: r.position, offAt: r.off_at }));
}

/** What the counter at this outlet offers, in order. */
export async function methodsAt(tx: Tx, outletId: string) {
  return (await listMethods(tx)).filter((m) => m.active && !m.offAt.includes(outletId)).map(({ id, kind, name }) => ({ id, kind, name }));
}

/**
 * The method behind each payment of a sale. The till sends the method's id; an older till (or a test) sends only the kind,
 * which means that kind's built-in method. Either way it must be on at this outlet.
 */
export async function resolvePayments<P extends { method: Kind; methodId?: string }>(tx: Tx, outletId: string, payments: P[]) {
  if (!payments.length) return [];
  const all = await listMethods(tx);
  return payments.map((x, i) => {
    const m = x.methodId ? all.find((a) => a.id === x.methodId) : all.find((a) => a.builtin && a.kind === x.method);
    if (!m) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { [`payments.${i}.methodId`]: ['Unknown payment method'] });
    if (m.kind !== x.method) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { [`payments.${i}.method`]: [`${m.name} takes ${KIND_LABEL[m.kind]}`] });
    if (!m.active || m.offAt.includes(outletId)) {
      throw appError(409, 'METHOD_OFF', `${m.name} is switched off${m.active ? ' at this outlet' : ''}. Take the payment another way.`, { [`payments.${i}.method`]: ['Switched off'] });
    }
    return { ...x, methodId: m.id, methodName: m.name };
  });
}

/** Money given back goes out by kind (cash, UPI, card, other): it is recorded against that kind's built-in method. */
export async function refundMethodId(tx: Tx, kind: string): Promise<string | null> {
  if (!(KINDS as readonly string[]).includes(kind)) return null;
  await ensureMethods(tx);
  const { rows: [m] } = await tx.query('SELECT id FROM payment_methods WHERE builtin AND kind = $1', [kind]);
  return (m?.id as string | undefined) ?? null;
}

export async function createMethod(tx: Tx, actorId: string, input: z.infer<typeof methodInput>) {
  const all = await listMethods(tx);
  if (all.length >= MAX_METHODS) throw appError(409, 'METHOD_LIMIT', `A store can have up to ${MAX_METHODS} payment methods. Switch off one you don't use, or rename it.`);
  if (all.some((m) => m.name.toLowerCase() === input.name.toLowerCase())) throw appError(409, 'NAME_DUPLICATE', 'Another payment method has this name', { name: ['Already used'] });
  const { rows: [m] } = await tx.query(
    `INSERT INTO payment_methods (tenant_id, kind, name, position) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3) RETURNING id`,
    [input.kind, input.name, Math.max(...all.map((a) => a.position), 3) + 1]);
  await audit(tx, { actorId, action: 'payment_method.created', entityType: 'payment_method', entityId: m.id, summary: { name: input.name, kind: input.kind } });
  return (await listMethods(tx)).find((x) => x.id === m.id)!;
}

export async function patchMethod(tx: Tx, actorId: string, id: string, patch: z.infer<typeof methodPatch>) {
  const all = await listMethods(tx);
  const m = all.find((a) => a.id === id);
  if (!m) throw appError(404, 'NOT_FOUND', 'Payment method not found');
  if (patch.name !== undefined && all.some((a) => a.id !== id && a.name.toLowerCase() === patch.name!.toLowerCase())) {
    throw appError(409, 'NAME_DUPLICATE', 'Another payment method has this name', { name: ['Already used'] });
  }
  if (patch.offAt) {
    const { rows } = await tx.query('SELECT id FROM outlets WHERE id = ANY($1::uuid[])', [patch.offAt]);
    if (rows.length !== new Set(patch.offAt).size) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { offAt: ['Unknown outlet'] });
  }
  // At least one method must stay on, or the counter can't take money at all.
  const active = patch.active ?? m.active;
  if (!active && !all.some((a) => a.id !== id && a.active)) throw appError(409, 'LAST_METHOD', 'Keep at least one payment method on.');
  await tx.query(
    'UPDATE payment_methods SET name = coalesce($2, name), active = coalesce($3, active), position = coalesce($4, position) WHERE id = $1',
    [id, patch.name ?? null, patch.active ?? null, patch.position ?? null]);
  if (patch.offAt) {
    await tx.query('DELETE FROM payment_method_off WHERE method_id = $1 AND NOT (outlet_id = ANY($2::uuid[]))', [id, patch.offAt]);
    await tx.query(
      `INSERT INTO payment_method_off (tenant_id, method_id, outlet_id) SELECT current_setting('app.tenant_id')::uuid, $1, o FROM unnest($2::uuid[]) o
       ON CONFLICT DO NOTHING`, [id, patch.offAt]);
  }
  const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((m as unknown as Record<string, unknown>)[k])));
  if (Object.keys(changed).length) await audit(tx, { actorId, action: 'payment_method.updated', entityType: 'payment_method', entityId: id, summary: { method: m.name, ...changed } });
  return (await listMethods(tx)).find((x) => x.id === id)!;
}
