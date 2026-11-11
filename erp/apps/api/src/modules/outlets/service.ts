import { z } from 'zod';
import type { Tx } from '../../db.js';
import { fmtMoney, fmtQty } from '../../lib/decimal.js';
import { financialYear, gstinProblem, localDate, seriesPrefix, STATES } from '../../lib/gst.js';
import { appError, audit } from '../../lib/phase1.js';
import { mapUniqueViolation } from '../../lib/pg-errors.js';
import type { Role } from '../../lib/permissions.js';
import { loadProfile, mainOutletId, panOf } from '../billing/profile.js';
import { listLocations } from '../inventory/service.js';

// Outlets (v2, D101): several shops inside one store account. One is included in every plan; more are a paid add-on that
// the platform console switches on. The main outlet is the store's own settings; others carry their own address, state,
// GSTIN (in another state), bill prefixes, stock rooms and POS location. Outlets are closed, never deleted.

const invalid = (fieldErrors: Record<string, string[]>) => appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', fieldErrors);
const prefix = z.string().trim().regex(/^[A-Za-z0-9-]{1,6}$/, 'Up to 6 letters, digits or dashes').transform((v) => v.toUpperCase());
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);

export const outletInput = z.object({
  name: z.string().trim().min(1).max(60),
  address: z.string().trim().min(5, 'Enter the shop address').max(300),
  city: optText(80),
  stateCode: z.string().refine((v) => !!STATES[v], 'Choose a state'),
  postalCode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'A PIN code is 6 digits').optional().or(z.literal('').transform(() => undefined)),
  phone: z.string().trim().regex(/^[0-9+ -]{6,20}$/, 'Enter a phone number').optional().or(z.literal('').transform(() => undefined)),
  gstin: z.string().trim().toUpperCase().optional().or(z.literal('').transform(() => undefined)),
  invoicePrefix: prefix,
  creditNotePrefix: prefix,
  backRoom: z.boolean().default(true),
}).strict();
export type OutletInput = z.infer<typeof outletInput>;

export const outletPatch = z.object({
  name: z.string().trim().min(1).max(60),
  address: z.string().trim().min(5, 'Enter the shop address').max(300),
  city: z.string().trim().max(80).nullable(),
  stateCode: z.string().refine((v) => !!STATES[v], 'Choose a state'),
  postalCode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'A PIN code is 6 digits').nullable(),
  phone: z.string().trim().regex(/^[0-9+ -]{6,20}$/, 'Enter a phone number').nullable(),
  gstin: z.string().trim().toUpperCase().nullable(),
  invoicePrefix: prefix,
  creditNotePrefix: prefix,
  posLocationId: z.string().uuid(),
  active: z.boolean(),
}).partial().strict();
export type OutletPatch = z.infer<typeof outletPatch>;

export interface Ctx { userId: string; role: Role }

// ------------------------------------------------------------------ the paid limit

export async function outletLimit(tx: Tx) {
  const { rows: [r] } = await tx.query(
    `SELECT s.extra_outlets, p.outlet_price_month_paise, (SELECT count(*)::int FROM outlets WHERE active) AS open
       FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id JOIN plans p ON p.id = t.plan_id`);
  const extra = (r?.extra_outlets as number | undefined) ?? 0;
  return { included: 1, extra, allowed: 1 + extra, open: (r?.open as number | undefined) ?? 1, pricePerOutletMonthPaise: (r?.outlet_price_month_paise as number | null) ?? null };
}

/** One more open outlet must fit the plan. A per-store lock stops two "create" clicks from both getting through. */
async function checkRoom(tx: Tx) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('outlets:' || current_setting('app.tenant_id'), 11))`);
  const l = await outletLimit(tx);
  if (l.open >= l.allowed) {
    const price = l.pricePerOutletMonthPaise ? ` Each extra outlet is ₹${(l.pricePerOutletMonthPaise / 100).toLocaleString('en-IN')} a month.` : '';
    throw appError(403, 'PLAN_LIMIT', `Your plan has ${l.allowed} outlet${l.allowed === 1 ? '' : 's'} and ${l.open} ${l.open === 1 ? 'is' : 'are'} open. Ask GroPop to add another.${price}`);
  }
}

// ------------------------------------------------------------------ checks shared by create and edit

/** Bill prefixes must differ from every other outlet's and the main outlet's, or two outlets would print the same number. */
async function checkPrefixes(tx: Tx, outletId: string | null, inv: string, cn: string) {
  const { rows: [m] } = await tx.query('SELECT upper(invoice_prefix) AS inv, upper(credit_note_prefix) AS cn FROM sales_settings');
  const errors: Record<string, string[]> = {};
  if (m && inv === m.inv) errors.invoicePrefix = ['The main outlet uses this prefix (Billing & GST)'];
  if (m && cn === m.cn) errors.creditNotePrefix = ['The main outlet uses this prefix (Billing & GST)'];
  const { rows } = await tx.query(
    'SELECT name, upper(invoice_prefix) AS inv, upper(credit_note_prefix) AS cn FROM outlets WHERE NOT is_main AND id IS DISTINCT FROM $1', [outletId]);
  for (const o of rows) {
    if (o.inv === inv) errors.invoicePrefix = [`${o.name} uses this prefix`];
    if (o.cn === cn) errors.creditNotePrefix = [`${o.name} uses this prefix`];
  }
  if (Object.keys(errors).length) throw invalid(errors);
}

/** An outlet's own GSTIN: a real one, in the outlet's state, under the same PAN as the store's. */
async function checkGstin(tx: Tx, gstin: string | null | undefined, stateCode: string) {
  if (!gstin) return;
  const problem = gstinProblem(gstin);
  if (problem) throw invalid({ gstin: [problem] });
  if (gstin.slice(0, 2) !== stateCode) throw invalid({ gstin: [`This GSTIN is for ${STATES[gstin.slice(0, 2)] ?? 'another state'}, not ${STATES[stateCode]}`] });
  const main = await loadProfile(tx);
  if (main.seller.gstin && panOf(main.seller.gstin) !== panOf(gstin)) {
    throw invalid({ gstin: ['This GSTIN belongs to a different business (PAN). A different business needs its own GroPop store.'] });
  }
}

const dup = { outlets_name_uq: () => invalid({ name: ['Another outlet has this name'] }),
  outlets_invoice_prefix_uq: () => invalid({ invoicePrefix: ['Another outlet uses this prefix'] }),
  outlets_cn_prefix_uq: () => invalid({ creditNotePrefix: ['Another outlet uses this prefix'] }),
  locations_name_uq: () => appError(409, 'NAME_DUPLICATE', 'A stock room already has this outlet’s name; rename it first') };

// ------------------------------------------------------------------ create and edit

export async function createOutlet(tx: Tx, ctx: Ctx, input: OutletInput) {
  await mainOutletId(tx);
  await checkRoom(tx);
  await checkPrefixes(tx, null, input.invoicePrefix, input.creditNotePrefix);
  await checkGstin(tx, input.gstin, input.stateCode);
  try {
    const { rows: [o] } = await tx.query(
      `INSERT INTO outlets (tenant_id, name, address, city, state_code, postal_code, phone, gstin, invoice_prefix, credit_note_prefix, created_by)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [input.name, input.address, input.city, input.stateCode, input.postalCode ?? null, input.phone ?? null, input.gstin ?? null,
        input.invoicePrefix, input.creditNotePrefix, ctx.userId]);
    // Its own stock rooms: a shop floor the counter sells from, and a back room unless asked not to.
    const rooms: [string, string][] = [['Shop floor', 'shop_floor'], ...(input.backRoom ? [['Back room', 'back_room'] as [string, string]] : [])];
    const ids: string[] = [];
    for (const [label, type] of rooms) {
      const { rows: [l] } = await tx.query(
        `INSERT INTO locations (tenant_id, outlet_id, name, type, is_sellable) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, true) RETURNING id`,
        [o.id, `${input.name.slice(0, 60 - label.length - 3)} · ${label}`, type]);
      ids.push(l.id);
    }
    await tx.query('UPDATE outlets SET pos_location_id = $2 WHERE id = $1', [o.id, ids[0]]);
    await audit(tx, { actorId: ctx.userId, action: 'outlet.created', entityType: 'outlet', entityId: o.id,
      summary: { name: input.name, state: STATES[input.stateCode], gstin: input.gstin ?? null, invoicePrefix: input.invoicePrefix, creditNotePrefix: input.creditNotePrefix } });
    return o.id as string;
  } catch (e) { mapUniqueViolation(e, dup); }
}

export async function patchOutlet(tx: Tx, ctx: Ctx, id: string, patch: OutletPatch) {
  const { rows: [cur] } = await tx.query('SELECT * FROM outlets WHERE id = $1 FOR UPDATE', [id]);
  if (!cur) throw appError(404, 'NOT_FOUND', 'Outlet not found');
  const keys = Object.keys(patch) as (keyof OutletPatch)[];
  if (cur.is_main && keys.some((k) => k !== 'name')) {
    throw appError(400, 'MAIN_OUTLET', 'The main outlet’s address and GSTIN are in Settings, and its bill prefixes and counter stock room in Billing & GST.');
  }
  if (patch.active === true && !cur.active) await checkRoom(tx);
  const next = { ...cur, ...Object.fromEntries(keys.map((k) => [COLUMN[k], patch[k]])) };
  if (patch.invoicePrefix !== undefined || patch.creditNotePrefix !== undefined) await checkPrefixes(tx, id, next.invoice_prefix, next.credit_note_prefix);
  if (patch.gstin !== undefined || patch.stateCode !== undefined) {
    if (next.gstin && next.gstin.slice(0, 2) !== next.state_code) throw invalid({ gstin: [`This GSTIN is not for ${STATES[next.state_code]}`] });
    await checkGstin(tx, next.gstin, next.state_code);
  }
  if (patch.posLocationId) {
    const loc = (await listLocations(tx)).find((l) => l.id === patch.posLocationId);
    if (!loc || loc.outletId !== id || !loc.active || !loc.isSellable) throw invalid({ posLocationId: ['Pick an open, sellable stock room of this outlet'] });
  }
  if (!keys.length) return;
  try {
    await tx.query(`UPDATE outlets SET ${keys.map((k, i) => `${COLUMN[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
      [id, ...keys.map((k) => patch[k] ?? null)]);
  } catch (e) { mapUniqueViolation(e, dup); }
  const changed = Object.fromEntries(keys.filter((k) => String(cur[COLUMN[k]] ?? null) !== String(patch[k] ?? null)).map((k) => [k, { from: cur[COLUMN[k]] ?? null, to: patch[k] ?? null }]));
  if (Object.keys(changed).length) {
    await audit(tx, { actorId: ctx.userId, action: patch.active === false ? 'outlet.closed' : patch.active === true ? 'outlet.reopened' : 'outlet.changed',
      entityType: 'outlet', entityId: id, summary: { name: cur.name, ...changed } });
  }
}

const COLUMN: Record<keyof OutletPatch, string> = {
  name: 'name', address: 'address', city: 'city', stateCode: 'state_code', postalCode: 'postal_code', phone: 'phone', gstin: 'gstin',
  invoicePrefix: 'invoice_prefix', creditNotePrefix: 'credit_note_prefix', posLocationId: 'pos_location_id', active: 'active',
};

// ------------------------------------------------------------------ who works where

/** Staff who may sell at outlets: owners and managers work everywhere; others where assigned, or everywhere when not assigned anywhere. */
export async function setStaff(tx: Tx, ctx: Ctx, outletId: string, userIds: string[]) {
  const { rows: [o] } = await tx.query('SELECT name FROM outlets WHERE id = $1', [outletId]);
  if (!o) throw appError(404, 'NOT_FOUND', 'Outlet not found');
  const { rows: users } = await tx.query(`SELECT id, role FROM users WHERE id = ANY($1::uuid[]) AND status <> 'disabled'`, [userIds]);
  const unknown = userIds.filter((u) => !users.some((x) => x.id === u));
  if (unknown.length) throw invalid({ userIds: ['Unknown or disabled user'] });
  const ids = users.filter((u) => u.role !== 'owner' && u.role !== 'manager').map((u) => u.id as string);
  const { rows: before } = await tx.query('SELECT user_id FROM user_outlets WHERE outlet_id = $1', [outletId]);
  await tx.query('DELETE FROM user_outlets WHERE outlet_id = $1 AND NOT (user_id = ANY($2::uuid[]))', [outletId, ids]);
  await tx.query(
    `INSERT INTO user_outlets (tenant_id, user_id, outlet_id) SELECT current_setting('app.tenant_id')::uuid, u, $1 FROM unnest($2::uuid[]) u
     ON CONFLICT DO NOTHING`, [outletId, ids]);
  const was = new Set(before.map((r) => r.user_id as string));
  const added = ids.filter((u) => !was.has(u));
  const removed = [...was].filter((u) => !ids.includes(u));
  if (added.length || removed.length) {
    await audit(tx, { actorId: ctx.userId, action: 'outlet.staff_changed', entityType: 'outlet', entityId: outletId, summary: { outlet: o.name, added, removed } });
  }
}

/** The open outlets this person may sell at, main first. */
export async function allowedOutlets(tx: Tx, userId: string, role: Role) {
  await mainOutletId(tx);
  const everywhere = role === 'owner' || role === 'manager';
  const { rows } = await tx.query(
    `SELECT o.id, o.name, o.is_main FROM outlets o
      WHERE o.active AND ($2::boolean OR NOT EXISTS (SELECT 1 FROM user_outlets x WHERE x.user_id = $1)
                          OR EXISTS (SELECT 1 FROM user_outlets x WHERE x.user_id = $1 AND x.outlet_id = o.id))
      ORDER BY NOT o.is_main, o.created_at`, [userId, everywhere]);
  return rows.map((r) => ({ id: r.id as string, name: r.name as string, isMain: r.is_main as boolean }));
}

/**
 * Which outlet a counter request is for. The POS sends the one picked on that till; without one, the person's only
 * outlet, else the main one. Asking for an outlet the person doesn't work at is refused.
 */
export async function resolveOutlet(tx: Tx, userId: string, role: Role, requested: string | undefined) {
  const allowed = await allowedOutlets(tx, userId, role);
  if (requested) {
    const hit = allowed.find((o) => o.id === requested);
    if (!hit) throw appError(403, 'OUTLET_NOT_ALLOWED', 'You can’t bill at this outlet: it is closed, or you are not assigned to it.');
    return { outlet: hit, allowed };
  }
  if (!allowed.length) throw appError(403, 'OUTLET_NOT_ALLOWED', 'The outlets you are assigned to are closed. Ask the owner to assign you to an open one.');
  const pick = allowed.length === 1 ? allowed[0] : allowed.find((o) => o.isMain);
  if (!pick) throw appError(400, 'OUTLET_REQUIRED', 'Choose the outlet this counter is at.');
  return { outlet: pick, allowed };
}

// ------------------------------------------------------------------ reading

/** Bills and returns at each outlet for one store day, by the series that numbered them. */
async function takings(tx: Tx, day: string, tz: string) {
  const { rows } = await tx.query(
    `SELECT s.outlet_id, count(i.id)::int AS bills, coalesce(sum(i.total), 0) AS sales,
            (SELECT coalesce(sum(c.total), 0) FROM credit_notes c JOIN invoice_series cs ON cs.id = c.series_id
              WHERE cs.outlet_id = s.outlet_id AND (c.issued_at AT TIME ZONE $2)::date = $1::date) AS returns
       FROM invoice_series s LEFT JOIN invoices i ON i.series_id = s.id AND (i.issued_at AT TIME ZONE $2)::date = $1::date
      WHERE s.doc_type = 'invoice' GROUP BY s.outlet_id`, [day, tz]);
  return new Map(rows.map((r) => [r.outlet_id as string, { bills: r.bills as number, sales: fmtMoney(r.sales), returns: fmtMoney(r.returns) }]));
}

const none = { bills: 0, sales: '0.00', returns: '0.00' };

export async function listOutlets(tx: Tx) {
  await mainOutletId(tx);
  const main = await loadProfile(tx);
  const day = localDate(new Date(), main.timezone);
  const today = await takings(tx, day, main.timezone);
  const { rows } = await tx.query(
    `SELECT o.*, (SELECT count(*)::int FROM locations l WHERE l.outlet_id = o.id AND l.active) AS rooms FROM outlets o ORDER BY NOT o.is_main, NOT o.active, o.created_at`);
  const items = [];
  for (const o of rows) {
    const p = o.is_main ? main : await loadProfile(tx, o.id);
    items.push({
      id: o.id as string, name: o.name as string, isMain: o.is_main as boolean, active: o.active as boolean,
      address: p.seller.address, city: p.seller.city, stateName: p.seller.stateName ?? STATES[o.state_code] ?? null, gstin: p.seller.gstin,
      stockRooms: o.rooms as number, ready: p.ready, problems: p.problems, today: today.get(o.id) ?? none,
    });
  }
  return { items, limit: await outletLimit(tx), date: day, mainStateCode: main.stateCode };
}

export async function outletDetail(tx: Tx, id: string, canSeeStaff: boolean) {
  const { rows: [o] } = await tx.query('SELECT * FROM outlets WHERE id = $1', [id]);
  if (!o) throw appError(404, 'NOT_FOUND', 'Outlet not found');
  const p = await loadProfile(tx, id);
  const day = localDate(new Date(), p.timezone);
  const fy = financialYear(day);
  const t = (await takings(tx, day, p.timezone)).get(id) ?? none;
  const { rows: [month] } = await tx.query(
    `SELECT count(i.id)::int AS bills, coalesce(sum(i.total), 0) AS sales FROM invoices i JOIN invoice_series s ON s.id = i.series_id
      WHERE s.outlet_id = $1 AND (i.issued_at AT TIME ZONE $2)::date >= date_trunc('month', $3::date)::date`, [id, p.timezone, day]);
  const { rows: rooms } = await tx.query(
    `SELECT l.id, l.name, l.type, l.is_sellable, l.active, coalesce(sum(b.on_hand), 0) AS on_hand, count(b.variant_id) FILTER (WHERE b.on_hand <> 0)::int AS items
       FROM locations l LEFT JOIN stock_balances b ON b.location_id = l.id WHERE l.outlet_id = $1
      GROUP BY l.id ORDER BY NOT l.active, l.created_at, array_position(ARRAY['shop_floor', 'back_room', 'quarantine'], l.type), lower(l.name)`, [id]);
  const { rows: series } = await tx.query(
    `SELECT doc_type, prefix, next_number FROM invoice_series WHERE outlet_id = $1 AND financial_year = $2`, [id, fy]);
  const nextOf = (type: 'invoice' | 'credit_note', base: string) => {
    const s = series.find((x) => x.doc_type === type);
    return s ? `${s.prefix}${s.next_number}` : `${seriesPrefix(base, fy)}1`;
  };
  let staff: { id: string; name: string; role: string; everywhere: boolean; assigned: boolean; elsewhere: boolean }[] | null = null;
  if (canSeeStaff) {
    const { rows } = await tx.query(
      `SELECT u.id, u.name, u.role,
              EXISTS (SELECT 1 FROM user_outlets x WHERE x.user_id = u.id AND x.outlet_id = $1) AS assigned,
              EXISTS (SELECT 1 FROM user_outlets x WHERE x.user_id = u.id AND x.outlet_id <> $1) AS elsewhere
         FROM users u WHERE u.status <> 'disabled' ORDER BY array_position(ARRAY['owner','manager','cashier','inventory','fulfillment'], u.role), lower(u.name)`, [id]);
    staff = rows.map((r) => ({ id: r.id, name: r.name, role: r.role, assigned: r.assigned, elsewhere: r.elsewhere,
      everywhere: r.role === 'owner' || r.role === 'manager' || (!r.assigned && !r.elsewhere) }));
  }
  return {
    outlet: {
      id: o.id as string, name: o.name as string, isMain: o.is_main as boolean, active: o.active as boolean, createdAt: o.created_at as Date,
      address: o.address as string | null, city: o.city as string | null, stateCode: o.state_code as string | null, postalCode: o.postal_code as string | null,
      phone: o.phone as string | null, gstin: o.gstin as string | null, invoicePrefix: (o.invoice_prefix ?? p.settings.invoicePrefix) as string,
      creditNotePrefix: (o.credit_note_prefix ?? p.settings.creditNotePrefix) as string, posLocationId: (o.pos_location_id ?? p.settings.posLocationId) as string | null,
    },
    seller: p.seller, scheme: p.scheme, ready: p.ready, problems: p.problems, mainStateCode: o.is_main ? p.stateCode : (await loadProfile(tx)).stateCode,
    nextNumbers: { invoice: nextOf('invoice', p.settings.invoicePrefix), creditNote: nextOf('credit_note', p.settings.creditNotePrefix) },
    stockRooms: rooms.map((r) => ({ id: r.id as string, name: r.name as string, type: r.type as string, isSellable: r.is_sellable as boolean,
      active: r.active as boolean, onHand: fmtQty(String(r.on_hand)), items: r.items as number })),
    today: { date: day, ...t }, thisMonth: { bills: month.bills as number, sales: fmtMoney(month.sales) },
    staff,
  };
}
