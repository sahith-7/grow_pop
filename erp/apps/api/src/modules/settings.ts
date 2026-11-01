import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx, type Tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { requires } from '../lib/session.js';

// Store profile: name, legal details and address (printed on GST invoices from B5), timezone, locale, currency.

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const ZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'Asia/Kolkata', 'UTC']);

/** '' clears a field (null); undefined leaves it as it is. */
const text = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable().optional();

const patch = z.object({
  name: z.string().trim().min(1, 'Required').max(120).optional(),
  legalName: z.string().trim().min(1, 'Required').max(200).optional(),
  gstin: z.string().trim().toUpperCase().transform((s) => s || null)
    .refine((s) => s === null || GSTIN.test(s), 'Enter a valid 15-character GSTIN').nullable().optional(),
  phone: text(30).refine((s) => !s || /^[+0-9 ()-]{6,30}$/.test(s), 'Enter a valid phone number'),
  email: text(200).refine((s) => !s || z.string().email().safeParse(s).success, 'Enter a valid e-mail'),
  address: text(300), city: text(100), state: text(100),
  postalCode: text(10).refine((s) => !s || /^[0-9]{6}$/.test(s), 'Enter a 6-digit PIN code'),
  timezone: z.string().refine((s) => ZONES.has(s), 'Unknown timezone').optional(),
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'e.g. en-IN').optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'e.g. INR').optional(),
}).strict();

async function read(c: Tx) {
  const { rows: [r] } = await c.query(
    `SELECT t.name, t.legal_name, t.timezone, t.locale, t.currency, t.plan_id, s.gstin, s.phone, s.email, s.address, s.city, s.state, s.postal_code
       FROM tenants t LEFT JOIN store_settings s ON s.tenant_id = t.id`);
  return { name: r.name, legalName: r.legal_name, gstin: r.gstin, phone: r.phone, email: r.email, address: r.address, city: r.city,
    state: r.state, postalCode: r.postal_code, timezone: r.timezone, locale: r.locale, currency: r.currency, plan: r.plan_id };
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requires('settings.read') }, (req) => tenantTx(req.auth!.tenantId, read));

  app.patch('/', { preHandler: requires('settings.manage') }, async (req) => {
    const b = patch.parse(req.body ?? {});
    const a = req.auth!;
    return tenantTx(a.tenantId, async (c) => {
      const before = await read(c);
      await c.query(
        `UPDATE tenants SET name = coalesce($2, name), legal_name = coalesce($3, legal_name), timezone = coalesce($4, timezone),
                locale = coalesce($5, locale), currency = coalesce($6, currency) WHERE id = $1`,
        [a.tenantId, b.name ?? null, b.legalName ?? null, b.timezone ?? null, b.locale ?? null, b.currency ?? null]);
      const store: [string, string | null | undefined][] = [['gstin', b.gstin], ['phone', b.phone], ['email', b.email], ['address', b.address],
        ['city', b.city], ['state', b.state], ['postal_code', b.postalCode]];
      const set = store.filter(([, v]) => v !== undefined);
      if (set.length) await c.query(
        `UPDATE store_settings SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE tenant_id = $1`,
        [a.tenantId, ...set.map(([, v]) => v)]);
      const after = await read(c);
      const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => after[k] !== before[k]);
      await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'settings.updated', entity: 'store_settings', entityId: a.tenantId,
        summary: { changed }, requestId: req.id });
      return after;
    });
  });
}
