import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantTx, type Tx } from '../../db.js';
import { gstinProblem, STATES } from '../../lib/gst.js';
import { national, phoneProblem } from '../../lib/phone.js';
import { appError, audit, authOf, requires, requiresAny } from '../../lib/phase1.js';

// Customers for POS bills (B5). Web-order customers arrive from WooCommerce (B4) and are found by the same search.
// Minimal personal data (T12): name, phone, email, GSTIN and one address line.

const tx = <T>(req: FastifyRequest, fn: (t: Tx) => Promise<T>) => tenantTx(authOf(req).tenantId, fn);

const fields = {
  name: z.string().trim().min(1, 'Enter a name').max(200),
  phone: z.string().trim().regex(/^\+?[0-9]{8,15}$/, 'Digits only, like 9848012345').nullable(),
  email: z.string().trim().email('Enter an email address').max(254).nullable(),
  gstin: z.string().trim().toUpperCase().nullable(),
  stateCode: z.string().refine((v) => !!STATES[v], 'Pick a state').nullable(),
  address: z.string().trim().max(500).nullable(),
};
const createInput = z.object({ ...fields, phone: fields.phone.optional(), email: fields.email.optional(), gstin: fields.gstin.optional(),
  stateCode: fields.stateCode.optional(), address: fields.address.optional() }).strict();
const patchInput = z.object(fields).partial().strict();
const idParam = z.object({ id: z.string().uuid() });

const out = (r: Record<string, any>) => ({
  id: r.id as string, name: r.name as string, phone: r.phone as string | null, email: r.email as string | null, gstin: r.gstin as string | null,
  stateCode: r.state_code as string | null, stateName: r.state_code ? STATES[r.state_code] ?? null : null, address: r.address as string | null,
  fromWooCommerce: r.woo_customer_id !== null,
});

/** GSTIN must pass its check digit; its first two digits are the state, so a different state is a mistake. */
function check(input: { gstin?: string | null; stateCode?: string | null }) {
  const blank = (v: string | null | undefined) => (v === '' ? null : v);
  const gstin = blank(input.gstin);
  if (gstin) {
    const problem = gstinProblem(gstin);
    if (problem) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { gstin: [problem] });
    if (input.stateCode && input.stateCode !== gstin.slice(0, 2)) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { stateCode: [`The GSTIN is registered in ${STATES[gstin.slice(0, 2)] ?? gstin.slice(0, 2)}`] });
    return { gstin, stateCode: gstin.slice(0, 2) };
  }
  return { gstin: gstin ?? null, stateCode: input.stateCode ?? null };
}

/** A made-up number, or the shop's own number typed to get past the "customer's mobile" rule (v2, D104). */
export async function checkPhone(t: Tx, phone: string | null | undefined) {
  if (!phone) return;
  const problem = phoneProblem(phone);
  if (problem) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { phone: [problem] });
  const { rows } = await t.query(`SELECT phone FROM store_settings WHERE phone IS NOT NULL UNION ALL SELECT phone FROM outlets WHERE phone IS NOT NULL`);
  if (rows.some((r) => r.phone && national(r.phone) === national(phone))) {
    throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { phone: ['This is the shop’s own number. Ask for the customer’s number, or bill as Walk-in.'] });
  }
}

async function phoneTaken(t: Tx, phone: string | null | undefined, exceptId?: string) {
  if (!phone) return;
  await checkPhone(t, phone);
  const { rows: [c] } = await t.query('SELECT id, name FROM customers WHERE phone = $1 AND archived_at IS NULL AND id IS DISTINCT FROM $2 LIMIT 1', [phone, exceptId ?? null]);
  if (c) throw appError(409, 'CUSTOMER_EXISTS', `${c.name || 'A customer'} already has this phone number. Search for them instead.`, { phone: ['Already used'] });
}

export async function customerRoutes(app: FastifyInstance) {
  app.get('/customers', { preHandler: requiresAny('order.read', 'pos.sell') }, async (req) => {
    const { q, limit } = z.object({ q: z.string().trim().max(100).default(''), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict().parse(req.query);
    return tx(req, async (t) => {
      const esc = q.replace(/[%_\\]/g, '\\$&');
      const { rows } = await t.query(
        `SELECT * FROM customers WHERE archived_at IS NULL
            AND ($1 = '' OR phone LIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%' OR gstin = upper($1))
          ORDER BY coalesce(phone = $2, false) DESC, lower(name), id LIMIT $3`, [esc, q, limit]);
      return { items: rows.map(out) };
    });
  });

  app.post('/customers', { preHandler: requires('pos.sell') }, async (req, reply) => {
    const input = createInput.parse(req.body);
    const { gstin, stateCode } = check(input);
    const row = await tx(req, async (t) => {
      await phoneTaken(t, input.phone);
      const { rows: [c] } = await t.query(
        `INSERT INTO customers (tenant_id, name, phone, email, gstin, state_code, address, created_by)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [input.name, input.phone || null, input.email || null, gstin, stateCode, input.address || null, authOf(req).userId]);
      return c;
    });
    return reply.code(201).send(out(row));
  });

  app.patch('/customers/:id', { preHandler: requires('pos.sell') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = patchInput.parse(req.body);
    return tx(req, async (t) => {
      const { rows: [cur] } = await t.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [id]);
      if (!cur || cur.archived_at) throw appError(404, 'NOT_FOUND', 'Customer not found');
      const { gstin, stateCode } = check({ gstin: input.gstin !== undefined ? input.gstin : cur.gstin, stateCode: input.stateCode !== undefined ? input.stateCode : cur.state_code });
      if (input.phone !== undefined && (input.phone || null) !== cur.phone) await phoneTaken(t, input.phone, id);
      const { rows: [c] } = await t.query(
        `UPDATE customers SET name = $2, phone = $3, email = $4, gstin = $5, state_code = $6, address = $7, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, input.name ?? cur.name, input.phone !== undefined ? input.phone || null : cur.phone, input.email !== undefined ? input.email || null : cur.email,
          gstin, stateCode, input.address !== undefined ? input.address || null : cur.address]);
      if (gstin !== cur.gstin) await audit(t, { actorId: authOf(req).userId, action: 'customer.gstin_changed', entityType: 'customer', entityId: id, summary: { from: cur.gstin, to: gstin } });
      return out(c);
    });
  });
}
