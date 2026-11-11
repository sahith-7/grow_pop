import { locIn, pusher, type Scope } from '../outlets/scope.js';
import type { Tx } from '../../db.js';
import { parseCsv } from '../../lib/csv.js';
import { fmtMoney, fmtQty } from '../../lib/decimal.js';
import { nextNumber } from '../../lib/doc-numbers.js';
import { appError, audit } from '../../lib/phase1.js';
import { mapUniqueViolation } from '../../lib/pg-errors.js';
import { amount, milli, qtyText } from '../../lib/quantity.js';
import { loadProfile } from '../billing/profile.js';
import { readFile } from '../files/service.js';
import { applyCost, type Bucket, type Move, movementsByIds, post } from './ledger.js';
import { type AdjustmentInput, type TransferInput, WRITEOFF_REASONS } from './schemas.js';

export interface Ctx { userId: string; showCost: boolean; can: (perm: string) => boolean }

const invalid = (fieldErrors: Record<string, string[]>) => appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', fieldErrors);
const forbidden = (message: string) => appError(403, 'FORBIDDEN', message);

// ------------------------------------------------------------------ locations (INV-06)

const DEFAULT_LOCATIONS = [['Shop floor', 'shop_floor'], ['Back room', 'back_room']] as const;

/** A new store gets the two default locations the first time anything asks for its locations. */
async function ensureLocations(tx: Tx) {
  await tx.query(
    `INSERT INTO locations (tenant_id, name, type, is_sellable)
     SELECT current_setting('app.tenant_id')::uuid, d.name, d.type, true FROM unnest($1::text[], $2::text[]) AS d(name, type)
      WHERE NOT EXISTS (SELECT 1 FROM locations)
     ON CONFLICT DO NOTHING`, [DEFAULT_LOCATIONS.map((d) => d[0]), DEFAULT_LOCATIONS.map((d) => d[1])]);
}

const locationOut = (r: Record<string, any>) => ({
  id: r.id as string, name: r.name as string, type: r.type as string, isSellable: r.is_sellable as boolean, active: r.active as boolean,
  outletId: r.outlet_id as string, outletName: (r.outlet_name ?? null) as string | null,
});

export async function listLocations(tx: Tx) {
  await ensureLocations(tx);
  const { rows } = await tx.query(
    `SELECT l.*, o.name AS outlet_name FROM locations l JOIN outlets o ON o.id = l.outlet_id
      ORDER BY NOT l.active, NOT o.is_main, o.created_at, l.created_at, array_position(ARRAY['shop_floor', 'back_room', 'quarantine'], l.type), lower(l.name)`);
  return rows.map(locationOut);
}

/**
 * The location, which must exist and be active. `field` names the input for the error. With `userId`, it must also be at
 * an outlet that person works at (v2, D115): staff assigned to outlets post stock only there; owners, managers and staff
 * assigned nowhere work everywhere.
 */
export async function activeLocation(tx: Tx, id: string, field: string, userId?: string) {
  const { rows } = await tx.query('SELECT * FROM locations WHERE id = $1', [id]);
  if (!rows[0] || !rows[0].active) throw invalid({ [field]: ['Location not found or not active'] });
  if (userId) {
    const { rows: [u] } = await tx.query(
      `SELECT u.role IN ('owner', 'manager') OR NOT EXISTS (SELECT 1 FROM user_outlets x WHERE x.user_id = u.id)
              OR EXISTS (SELECT 1 FROM user_outlets x WHERE x.user_id = u.id AND x.outlet_id = $2) AS ok
         FROM users u WHERE u.id = $1`, [userId, rows[0].outlet_id]);
    if (!u?.ok) throw invalid({ [field]: ['This stock room is at an outlet you are not assigned to'] });
  }
  return locationOut(rows[0]);
}

const dupLocation = () => appError(409, 'NAME_DUPLICATE', 'Another location already has this name');

export async function createLocation(tx: Tx, ctx: Ctx, input: { name: string; type: string; isSellable?: boolean; outletId?: string }) {
  const sellable = input.type === 'quarantine' ? false : (input.isSellable ?? true);
  if (input.outletId) {
    const { rows: [o] } = await tx.query('SELECT active FROM outlets WHERE id = $1', [input.outletId]);
    if (!o || !o.active) throw invalid({ outletId: ['Outlet not found or closed'] });
  }
  try {
    // Without an outlet, the location belongs to the main one (a database default, D101).
    const { rows } = await tx.query(
      `INSERT INTO locations (tenant_id, name, type, is_sellable, outlet_id) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4) RETURNING *`,
      [input.name, input.type, sellable, input.outletId ?? null]);
    await audit(tx, { actorId: ctx.userId, action: 'location.created', entityType: 'location', entityId: rows[0].id, summary: { name: input.name, type: input.type, sellable, outletId: rows[0].outlet_id } });
    return locationOut(rows[0]);
  } catch (e) { mapUniqueViolation(e, { locations_name_uq: dupLocation }); }
}

export async function patchLocation(tx: Tx, ctx: Ctx, id: string, patch: { name?: string; isSellable?: boolean; active?: boolean }) {
  const { rows } = await tx.query('SELECT * FROM locations WHERE id = $1 FOR UPDATE', [id]);
  const cur = rows[0];
  if (!cur) throw appError(404, 'NOT_FOUND', 'Location not found');
  if (patch.isSellable && cur.type === 'quarantine') throw invalid({ isSellable: ['A quarantine location is never sellable'] });
  if (patch.active === false && cur.active) {
    const held = await tx.query('SELECT 1 FROM stock_balances WHERE location_id = $1 AND (on_hand <> 0 OR non_sellable <> 0 OR reserved <> 0) LIMIT 1', [id]);
    if (held.rowCount) throw appError(409, 'LOCATION_HAS_STOCK', 'Move or write off the stock at this location before deactivating it');
    const others = await tx.query('SELECT 1 FROM locations WHERE active AND id <> $1 LIMIT 1', [id]);
    if (!others.rowCount) throw appError(409, 'LAST_LOCATION', 'Your store needs at least one active location');
  }
  try {
    const upd = await tx.query(
      `UPDATE locations SET name = coalesce($2, name), is_sellable = coalesce($3, is_sellable), active = coalesce($4, active), updated_at = now()
        WHERE id = $1 RETURNING *`, [id, patch.name ?? null, patch.isSellable ?? null, patch.active ?? null]);
    await audit(tx, { actorId: ctx.userId, action: 'location.updated', entityType: 'location', entityId: id, summary: patch });
    return locationOut(upd.rows[0]);
  } catch (e) { mapUniqueViolation(e, { locations_name_uq: dupLocation }); }
}

// ------------------------------------------------------------------ balances (INV-01/02)

export async function listBalances(tx: Tx, f: { q?: string; locationId?: string; lowStock?: boolean; limit: number; after: [string, string, string] | null; scope?: Scope }, showCost: boolean) {
  const params: unknown[] = [f.locationId ?? null];
  // v2 (D115): only the stock rooms of the outlet in view.
  const rooms = f.scope ? locIn(f.scope, 'b.location_id', pusher(params)) : 'true';
  const where = ["v.status = 'active'", "p.status <> 'archived'"];
  if (f.q) {
    params.push(`%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`, f.q);
    where.push(`(lower(p.name) LIKE $${params.length - 1} OR lower(v.sku) LIKE $${params.length - 1} OR v.barcode = $${params.length})`);
  }
  if (f.after) { params.push(...f.after); where.push(`(lower(p.name), lower(v.sku), v.id) > ($${params.length - 2}, $${params.length - 1}, $${params.length}::uuid)`); }
  params.push(f.limit + 1);
  const { rows } = await tx.query(
    `SELECT v.id, v.sku, v.barcode, v.attributes, v.reorder_level, v.cost, p.id AS product_id, p.name, p.unit_code,
            coalesce(sum(b.on_hand), 0) AS on_hand, coalesce(sum(b.reserved), 0) AS reserved, coalesce(sum(b.non_sellable), 0) AS non_sellable,
            coalesce(sum(b.on_hand - b.reserved) FILTER (WHERE l.is_sellable AND l.active), 0) AS available,
            coalesce(json_agg(json_build_object('locationId', b.location_id, 'name', l.name, 'onHand', b.on_hand::text, 'nonSellable', b.non_sellable::text)
                       ORDER BY l.created_at) FILTER (WHERE b.on_hand <> 0 OR b.non_sellable <> 0), '[]') AS at
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN stock_balances b ON b.variant_id = v.id AND ($1::uuid IS NULL OR b.location_id = $1) AND ${rooms}
       LEFT JOIN locations l ON l.id = b.location_id
      WHERE ${where.join(' AND ')}
      GROUP BY v.id, p.id
     ${f.lowStock ? 'HAVING v.reorder_level IS NOT NULL AND coalesce(sum(b.on_hand - b.reserved) FILTER (WHERE l.is_sellable AND l.active), 0) <= v.reorder_level' : ''}
      ORDER BY lower(p.name), lower(v.sku), v.id
      LIMIT $${params.length}`, params);
  const more = rows.length > f.limit;
  const page = rows.slice(0, f.limit);
  return {
    items: page.map((r) => ({
      variantId: r.id, productId: r.product_id, sku: r.sku, barcode: r.barcode, name: r.name, attributes: r.attributes, unitCode: r.unit_code,
      onHand: fmtQty(r.on_hand), reserved: fmtQty(r.reserved), available: fmtQty(r.available), nonSellable: fmtQty(r.non_sellable),
      reorderLevel: fmtQty(r.reorder_level),
      low: r.reorder_level !== null && milli(r.available) <= milli(r.reorder_level),
      locations: (r.at as { locationId: string; name: string; onHand: string; nonSellable: string }[])
        .map((a) => ({ locationId: a.locationId, name: a.name, onHand: fmtQty(a.onHand), nonSellable: fmtQty(a.nonSellable) })),
      ...(showCost ? { cost: fmtMoney(r.cost), value: valueOf(r.on_hand, r.cost) } : {}),
    })),
    last: more ? [page[page.length - 1].name.toLowerCase(), page[page.length - 1].sku.toLowerCase(), page[page.length - 1].id] as [string, string, string] : null,
  };
}

/** on hand × cost. Negative stock has no value. */
const valueOf = (onHand: string, cost: string | null) => (cost === null ? null : milli(onHand) <= 0n ? '0.00' : amount(milli(onHand), cost));

// ------------------------------------------------------------------ shared checks

interface VariantInfo { id: string; sku: string; status: string; productStatus: string; cost: string | null }

/** Active variants of non-archived products, keyed by id. Unknown ids become field errors at `field(i)`. */
export async function activeVariants(tx: Tx, ids: string[], field: (i: number) => string) {
  const { rows } = await tx.query(
    `SELECT v.id, v.sku, v.status, p.status AS product_status, v.cost FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.id = ANY($1)`, [ids]);
  const map = new Map<string, VariantInfo>(rows.map((r) => [r.id, { id: r.id, sku: r.sku, status: r.status, productStatus: r.product_status, cost: r.cost }]));
  const errors: Record<string, string[]> = {};
  ids.forEach((id, i) => {
    const v = map.get(id);
    if (!v) errors[field(i)] = ['Product not found'];
    else if (v.status !== 'active' || v.productStatus === 'archived') errors[field(i)] = [`${v.sku} is archived`];
  });
  if (Object.keys(errors).length) throw invalid(errors);
  return map;
}

function noDuplicates(keys: string[], field: (i: number) => string) {
  const seen = new Set<string>();
  const errors: Record<string, string[]> = {};
  keys.forEach((k, i) => { if (seen.has(k)) errors[field(i)] = ['This item is listed twice']; seen.add(k); });
  if (Object.keys(errors).length) throw invalid(errors);
}

/** Before/after per line for the audit summary (AC-16). */
const auditLines = (posted: { variantId: string; bucket: Bucket; delta: bigint; before: bigint; after: bigint }[], skus: Map<string, { sku: string }>) =>
  posted.map((p) => ({ sku: skus.get(p.variantId)?.sku, bucket: p.bucket, delta: qtyText(p.delta), before: qtyText(p.before), after: qtyText(p.after) }));

// ------------------------------------------------------------------ adjustments and write-offs (INV-04/08)

export async function postAdjustment(tx: Tx, ctx: Ctx, input: AdjustmentInput) {
  const writeoff = (WRITEOFF_REASONS as readonly string[]).includes(input.reasonCode);
  if (writeoff && !ctx.can('stock.writeoff')) throw forbidden('You do not have permission to write off stock');
  if (!writeoff && !ctx.can('stock.adjust')) throw forbidden('You do not have permission to adjust stock');
  if (input.overrideNegative) {
    if (!ctx.can('stock.override_negative')) throw forbidden('Only the owner can take stock below zero');
    if (!input.note || input.note.length < 3) throw invalid({ note: ['Say why stock may go below zero'] });
  }
  const errors: Record<string, string[]> = {};
  input.lines.forEach((l, i) => {
    const neg = l.qtyDelta.startsWith('-');
    if (writeoff && !neg) errors[`lines.${i}.qtyDelta`] = ['A write-off removes stock; enter a negative quantity'];
    if (input.reasonCode === 'opening' && (neg || l.bucket !== 'sellable')) errors[`lines.${i}.qtyDelta`] = ['Opening stock must be a positive sellable quantity'];
    if (l.unitCost !== undefined && input.reasonCode !== 'opening') errors[`lines.${i}.unitCost`] = ['Cost can only be set with opening stock'];
  });
  if (Object.keys(errors).length) throw invalid(errors);
  if (input.lines.some((l) => l.unitCost !== undefined) && !ctx.showCost) throw forbidden('You do not have permission to set cost');
  noDuplicates(input.lines.map((l) => `${l.variantId}|${l.bucket}`), (i) => `lines.${i}.variantId`);

  const location = await activeLocation(tx, input.locationId, 'locationId', ctx.userId);
  const variants = await activeVariants(tx, input.lines.map((l) => l.variantId), (i) => `lines.${i}.variantId`);
  const number = await nextNumber(tx, 'ADJ');
  const { rows } = await tx.query(
    `INSERT INTO adjustments (tenant_id, number, location_id, reason_code, note, override_negative, posted_by)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6) RETURNING id, posted_at`,
    [number, location.id, input.reasonCode, input.note || null, input.overrideNegative, ctx.userId]);
  const doc = rows[0];
  for (const l of input.lines) if (l.unitCost !== undefined) await applyCost(tx, l.variantId, milli(l.qtyDelta), l.unitCost);
  const movementType = writeoff ? 'writeoff' : input.reasonCode === 'opening' ? 'opening' : 'adjustment';
  const posted = await post(tx, ctx.userId, input.lines.map((l, i): Move => ({
    variantId: l.variantId, locationId: location.id, bucket: l.bucket, delta: milli(l.qtyDelta), movementType,
    sourceType: 'adjustment', sourceId: doc.id, reasonCode: input.reasonCode, note: input.note || null,
    unitCost: l.unitCost ?? null, field: `lines.${i}.qtyDelta`,
  })), { allowNegative: input.overrideNegative });

  const wentNegative = posted.filter((p) => p.bucket === 'sellable' && p.after < 0n);
  await audit(tx, { actorId: ctx.userId, action: writeoff ? 'stock.written_off' : 'stock.adjusted', entityType: 'adjustment', entityId: doc.id,
    summary: { number, location: location.name, reason: input.reasonCode, note: input.note ?? null, lines: auditLines(posted, variants) } });
  if (wentNegative.length)
    await audit(tx, { actorId: ctx.userId, action: 'stock.negative_override', entityType: 'adjustment', entityId: doc.id,
      summary: { number, note: input.note, lines: auditLines(wentNegative, variants) } });
  return { id: doc.id as string, number, postedAt: doc.posted_at as Date, movements: await movementsByIds(tx, posted.map((p) => p.id), ctx.showCost) };
}

// ------------------------------------------------------------------ transfers (INV-06)

export async function postTransfer(tx: Tx, ctx: Ctx, input: TransferInput) {
  if (input.fromLocationId === input.toLocationId) throw invalid({ toLocationId: ['Choose a different location'] });
  noDuplicates(input.lines.map((l) => l.variantId), (i) => `lines.${i}.variantId`);
  // Stock leaves from where this person works; it may go to any outlet (D115).
  const from = await activeLocation(tx, input.fromLocationId, 'fromLocationId', ctx.userId);
  const to = await activeLocation(tx, input.toLocationId, 'toLocationId');
  await checkOutletTransfer(tx, from.outletId, to.outletId);
  const variants = await activeVariants(tx, input.lines.map((l) => l.variantId), (i) => `lines.${i}.variantId`);
  const number = await nextNumber(tx, 'TRF');
  const { rows } = await tx.query(
    `INSERT INTO transfers (tenant_id, number, from_location_id, to_location_id, note, posted_by)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5) RETURNING id, posted_at`,
    [number, from.id, to.id, input.note || null, ctx.userId]);
  const doc = rows[0];
  const posted = await post(tx, ctx.userId, input.lines.flatMap((l, i): Move[] => {
    const q = milli(l.qty);
    const base = { variantId: l.variantId, bucket: 'sellable' as const, sourceType: 'transfer' as const, sourceId: doc.id, note: input.note || null, field: `lines.${i}.qty` };
    return [
      { ...base, locationId: from.id, delta: -q, movementType: 'transfer_out' },
      { ...base, locationId: to.id, delta: q, movementType: 'transfer_in' },
    ];
  }));
  await audit(tx, { actorId: ctx.userId, action: 'stock.transferred', entityType: 'transfer', entityId: doc.id,
    summary: { number, from: from.name, to: to.name, lines: auditLines(posted, variants) } });
  return { id: doc.id as string, number, postedAt: doc.posted_at as Date, movements: await movementsByIds(tx, posted.map((p) => p.id), ctx.showCost) };
}

/**
 * Stock moving between outlets under different GSTINs (another state) is a supply between registrations: it needs a tax
 * invoice and usually an e-way bill, which GroPop doesn't make. Same GSTIN (or no GST registration) is a plain transfer.
 */
async function checkOutletTransfer(tx: Tx, fromOutlet: string, toOutlet: string) {
  if (fromOutlet === toOutlet) return;
  const [a, b] = [await loadProfile(tx, fromOutlet), await loadProfile(tx, toOutlet)];
  if (a.seller.gstin !== b.seller.gstin && (a.seller.gstin || b.seller.gstin)) {
    throw appError(409, 'TRANSFER_NEEDS_INVOICE',
      `${a.outlet.name} and ${b.outlet.name} have different GSTINs, so moving stock between them is a sale that needs a tax invoice and an e-way bill. GroPop doesn't make those yet; ask your tax adviser.`);
  }
}

// ------------------------------------------------------------------ reversal (INV-09)

/** Reverse the whole adjustment or transfer that `movementId` belongs to, with linked compensating rows. */
export async function reverseDocument(tx: Tx, ctx: Ctx, movementId: string, note: string) {
  const { rows: [m] } = await tx.query('SELECT source_type, source_id, movement_type FROM stock_ledger WHERE id = $1', [movementId]);
  if (!m) throw appError(404, 'NOT_FOUND', 'Movement not found');
  if (m.source_type !== 'adjustment' && m.source_type !== 'transfer')
    throw appError(409, 'INVALID_STATE', 'Only adjustments and transfers can be reversed. Correct receipts with a supplier return or an adjustment.');
  if (m.movement_type === 'reversal') throw appError(409, 'INVALID_STATE', 'A reversal cannot itself be reversed; post a new adjustment instead');
  // Posted documents have no UPDATE grant, so they cannot be row-locked: serialise reversals of one document with an
  // advisory lock instead. The unique index on reversal_of_id backs this up.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`reverse:${m.source_id}`]);
  const table = m.source_type === 'adjustment' ? 'adjustments' : 'transfers';
  const { rows: [doc] } = await tx.query(`SELECT id, number FROM ${table} WHERE id = $1`, [m.source_id]);
  const { rows: orig } = await tx.query(
    `SELECT o.id, o.variant_id, o.location_id, o.bucket, o.qty_delta, o.unit_cost, EXISTS (SELECT 1 FROM stock_ledger r WHERE r.reversal_of_id = o.id) AS reversed
       FROM stock_ledger o WHERE o.source_id = $1 AND o.reversal_of_id IS NULL ORDER BY o.seq`, [m.source_id]);
  if (orig.some((o) => o.reversed)) throw appError(409, 'ALREADY_REVERSED', `${doc.number} has already been reversed`);
  const posted = await post(tx, ctx.userId, orig.map((o): Move => ({
    variantId: o.variant_id, locationId: o.location_id, bucket: o.bucket, delta: -milli(o.qty_delta), movementType: 'reversal',
    sourceType: m.source_type, sourceId: m.source_id, reversalOfId: o.id, reasonCode: 'reversal', note, field: 'note',
  })));
  const skus = new Map((await tx.query('SELECT id, sku FROM product_variants WHERE id = ANY($1)', [orig.map((o) => o.variant_id)])).rows.map((r) => [r.id, r]));
  await audit(tx, { actorId: ctx.userId, action: 'stock.reversed', entityType: m.source_type, entityId: m.source_id,
    summary: { number: doc.number, note, lines: auditLines(posted, skus) } });
  return { id: m.source_id as string, number: doc.number as string, postedAt: new Date(), movements: await movementsByIds(tx, posted.map((p) => p.id), ctx.showCost) };
}

// ------------------------------------------------------------------ reconciliation (INV-09)

export async function reconciliation(tx: Tx, scope?: Scope) {
  const params: unknown[] = [];
  const { rows } = await tx.query(
    `SELECT r.*, v.sku, l.name AS location_name FROM v_stock_reconciliation r
       JOIN product_variants v ON v.id = r.variant_id JOIN locations l ON l.id = r.location_id
      WHERE ${scope ? locIn(scope, 'r.location_id', pusher(params)) : 'true'} ORDER BY v.sku LIMIT 200`, params);
  return rows.map((r) => ({
    variantId: r.variant_id, sku: r.sku, locationId: r.location_id, locationName: r.location_name,
    onHand: fmtQty(r.on_hand), ledgerSellable: fmtQty(r.ledger_sellable), nonSellable: fmtQty(r.non_sellable), ledgerNonSellable: fmtQty(r.ledger_non_sellable),
  }));
}

// ------------------------------------------------------------------ opening stock CSV (J4)

export const OPENING_MAX_ROWS = 5_000;
const OPENING_COLUMNS = { sku: ['sku', 'barcode', 'code', 'item_code'], qty: ['qty', 'quantity', 'stock', 'opening_stock', 'on_hand'],
  location: ['location'], unit_cost: ['unit_cost', 'cost', 'cost_price', 'purchase_price'] } as const;

const normHeader = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
const cleanAmount = (v: string) => v.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');

/**
 * Opening stock from a CSV of sku, qty and optionally location and unit_cost. All or nothing: any error, nothing posts.
 * Posts one opening adjustment per location. A variant that already has movements at a location must be adjusted instead,
 * so re-uploading the same file cannot double the stock.
 */
export async function openingImport(tx: Tx, ctx: Ctx, a: { fileId: string; locationId: string; commit: boolean }) {
  if (!ctx.can('stock.adjust')) throw forbidden('You do not have permission to set opening stock');
  const fallback = await activeLocation(tx, a.locationId, 'locationId', ctx.userId);
  const { body } = await readFile(tx, a.fileId, 'import');
  let table: string[][];
  try { table = parseCsv(body.toString('utf8')); } catch (e) { throw invalid({ fileId: [(e as Error).message] }); }
  const [header = [], ...rows] = table;
  const col = Object.fromEntries(Object.entries(OPENING_COLUMNS).map(([k, names]) =>
    [k, header.findIndex((h) => (names as readonly string[]).includes(normHeader(h)))])) as Record<keyof typeof OPENING_COLUMNS, number>;
  if (col.sku < 0 || col.qty < 0) throw invalid({ fileId: ['The file needs a "sku" column and a "qty" column'] });
  if (!rows.length) throw invalid({ fileId: ['The file has no rows'] });
  if (rows.length > OPENING_MAX_ROWS) throw invalid({ fileId: [`The file has ${rows.length} rows; split it into files of at most ${OPENING_MAX_ROWS}`] });
  if (col.unit_cost >= 0 && !ctx.showCost) throw forbidden('You do not have permission to import cost. Remove the unit_cost column.');

  const cell = (r: string[], i: number) => (i < 0 ? '' : (r[i] ?? '').trim());
  const codes = rows.map((r) => cell(r, col.sku)).filter(Boolean);
  const { rows: found } = await tx.query(
    `SELECT v.id, v.sku, v.barcode, u.allow_fraction FROM product_variants v JOIN products p ON p.id = v.product_id JOIN units u ON u.code = p.unit_code
      WHERE (lower(v.sku) = ANY($1) OR v.barcode = ANY($2)) AND v.status = 'active' AND p.status <> 'archived'`, [codes.map((c) => c.toLowerCase()), codes]);
  const bySku = new Map(found.map((v) => [v.sku.toLowerCase(), v]));
  const byBarcode = new Map(found.filter((v) => v.barcode).map((v) => [v.barcode, v]));
  const locs = new Map((await listLocations(tx)).filter((l) => l.active).map((l) => [l.name.toLowerCase(), l]));
  const { rows: moved } = await tx.query('SELECT DISTINCT variant_id, location_id FROM stock_ledger WHERE variant_id = ANY($1)', [found.map((v) => v.id)]);
  const hasHistory = new Set(moved.map((m) => `${m.variant_id}|${m.location_id}`));

  const errors: { row: number; column: string; message: string }[] = [];
  const plan: { row: number; variantId: string; locationId: string; qty: bigint; unitCost: string | null }[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const row = i + 2;  // 1-based, after the heading row, as Excel shows it
    if (r.every((c) => c.trim() === '')) return;
    const fail = (column: string, message: string) => errors.push({ row, column, message });
    const code = cell(r, col.sku);
    const v = bySku.get(code.toLowerCase()) ?? byBarcode.get(code);
    if (!v) return fail('sku', code ? `No active product has SKU or barcode "${code}"` : 'SKU is empty');
    const locName = cell(r, col.location);
    const loc = locName ? locs.get(locName.toLowerCase()) : fallback;
    if (!loc) return fail('location', `No active location is called "${locName}"`);
    const rawQty = cleanAmount(cell(r, col.qty));
    if (!/^\d{1,11}(\.\d{1,3})?$/.test(rawQty) || /^0+(\.0+)?$/.test(rawQty)) return fail('qty', 'Enter a quantity above zero, like 12 or 2.5');
    const q = milli(rawQty);
    if (!v.allow_fraction && q % 1000n !== 0n) return fail('qty', `${v.sku} is counted in whole units`);
    const rawCost = cleanAmount(cell(r, col.unit_cost));
    if (rawCost && !/^\d{1,10}(\.\d{1,4})?$/.test(rawCost)) return fail('unit_cost', 'Enter a cost like 220 or 220.50');
    const key = `${v.id}|${loc.id}`;
    if (seen.has(key)) return fail('sku', `${v.sku} is listed twice for ${loc.name}`);
    if (hasHistory.has(key)) return fail('sku', `${v.sku} already has stock history at ${loc.name}; use an adjustment instead`);
    seen.add(key);
    plan.push({ row, variantId: v.id, locationId: loc.id, qty: q, unitCost: rawCost || null });
  });
  const result = { totalRows: plan.length + new Set(errors.map((e) => e.row)).size, validRows: plan.length, errors: errors.slice(0, 200), errorCount: errors.length };
  if (!a.commit || errors.length || !plan.length) return { ...result, posted: [] as { id: string; number: string; location: string }[] };

  const posted: { id: string; number: string; location: string }[] = [];
  for (const locId of [...new Set(plan.map((p) => p.locationId))]) {
    const lines = plan.filter((p) => p.locationId === locId);
    for (let i = 0; i < lines.length; i += 200) {   // adjustments hold at most 200 lines, like the form
      const doc = await postAdjustment(tx, ctx, {
        locationId: locId, reasonCode: 'opening', note: 'Opening stock import', overrideNegative: false,
        lines: lines.slice(i, i + 200).map((p) => ({ variantId: p.variantId, qtyDelta: qtyText(p.qty), bucket: 'sellable', ...(p.unitCost ? { unitCost: p.unitCost } : {}) })),
      });
      posted.push({ id: doc.id, number: doc.number, location: [...locs.values()].find((l) => l.id === locId)?.name ?? '' });
    }
  }
  return { ...result, posted };
}
