import { locIn, pusher, type Scope } from '../outlets/scope.js';
import type { Tx } from '../../db.js';
import { nextNumber } from '../../lib/doc-numbers.js';
import { appError, audit } from '../../lib/phase1.js';
import { amount, milli, qtyText } from '../../lib/quantity.js';
import { type Move, post } from './ledger.js';
import { activeLocation, type Ctx } from './service.js';

// Stocktakes (INV-05, AC-06, journey J7). Expected quantities are snapshotted at the start. A line's variance is
//   counted − (expected + moved between the snapshot and the moment that line was counted),
// so sales during the count do not show up as false variances, and sales after an item was counted still count.
// Lines nobody counted are left alone when posting (B3 default), never set to zero.

const invalid = (fieldErrors: Record<string, string[]>) => appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', fieldErrors);
const notFound = () => appError(404, 'NOT_FOUND', 'Stocktake not found');

async function header(tx: Tx, id: string, lock = false) {
  const { rows } = await tx.query(
    `SELECT s.*, l.name AS location_name FROM stocktakes s JOIN locations l ON l.id = s.location_id WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`, [id]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

function requireStatus(h: { status: string; number: string }, ...allowed: string[]) {
  if (!allowed.includes(h.status)) throw appError(409, 'INVALID_STATE', `${h.number} is ${h.status === 'review' ? 'in review' : h.status}`);
}

export async function createStocktake(tx: Tx, ctx: Ctx, input: { locationId: string; categoryIds: string[]; blind: boolean; note?: string }) {
  const location = await activeLocation(tx, input.locationId, 'locationId', ctx.userId);
  if (input.categoryIds.length) {
    const { rows } = await tx.query('SELECT id FROM categories WHERE id = ANY($1)', [input.categoryIds]);
    if (rows.length !== new Set(input.categoryIds).size) throw invalid({ categoryIds: ['Category not found'] });
  }
  const number = await nextNumber(tx, 'ST');
  let id: string;
  try {
    const { rows } = await tx.query(
      `INSERT INTO stocktakes (tenant_id, number, location_id, category_ids, blind, note, created_by)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6) RETURNING id`,
      [number, location.id, input.categoryIds, input.blind, input.note || null, ctx.userId]);
    id = rows[0].id;
  } catch (e) {
    if ((e as { constraint?: string }).constraint === 'stocktakes_open_uq')
      throw appError(409, 'STOCKTAKE_OPEN', `A stocktake is already open at ${location.name}. Finish or cancel it first.`);
    throw e;
  }
  // Wait for stock postings already in flight at this location, so the snapshot matches the ledger.
  await tx.query('SELECT 1 FROM stock_balances WHERE location_id = $1 FOR SHARE', [location.id]);
  // Scope: active products (optionally in the chosen categories or their sub-categories), plus anything with stock here.
  const { rowCount } = await tx.query(
    `INSERT INTO stocktake_lines (tenant_id, stocktake_id, variant_id, expected_qty)
     SELECT current_setting('app.tenant_id')::uuid, $1, v.id, coalesce(b.on_hand, 0)
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN stock_balances b ON b.variant_id = v.id AND b.location_id = $2
      WHERE (v.status = 'active' AND p.status <> 'archived'
             AND (cardinality($3::uuid[]) = 0 OR p.category_id = ANY($3) OR c.parent_id = ANY($3)))
         OR coalesce(b.on_hand, 0) <> 0`, [id, location.id, input.categoryIds]);
  if (!rowCount) throw invalid({ categoryIds: ['There are no products to count here'] });
  await audit(tx, { actorId: ctx.userId, action: 'stocktake.started', entityType: 'stocktake', entityId: id,
    summary: { number, location: location.name, lines: rowCount, blind: input.blind } });
  return getStocktake(tx, ctx, id);
}

/** Per line: movements between the snapshot and when the line was counted (or now, if not counted yet). */
async function movedDuringCount(tx: Tx, h: Record<string, any>) {
  const { rows } = await tx.query(
    `SELECT sl.variant_id, sum(m.qty_delta) AS moved
       FROM stocktake_lines sl
       JOIN stock_ledger m ON m.variant_id = sl.variant_id AND m.location_id = $2 AND m.bucket = 'sellable'
                          AND m.posted_at > $3 AND m.posted_at <= coalesce(sl.counted_at, now())
                          AND NOT (m.source_type = 'stocktake' AND m.source_id = $1)
      WHERE sl.stocktake_id = $1
      GROUP BY sl.variant_id`, [h.id, h.location_id, h.snapshot_at]);
  return new Map(rows.map((r) => [r.variant_id as string, milli(r.moved)]));
}

function lineOut(r: Record<string, any>, moved: bigint, seeExpected: boolean, showCost: boolean) {
  const counted = r.counted_qty === null ? null : milli(r.counted_qty);
  const expected = milli(r.expected_qty);
  const variance = counted === null ? null : counted - (expected + moved);
  return {
    variantId: r.variant_id as string, sku: r.sku as string, barcode: r.barcode as string | null, name: r.product_name as string,
    attributes: r.attributes as Record<string, string>,
    countedQty: counted === null ? null : qtyText(counted), countedAt: r.counted_at as Date | null,
    ...(seeExpected ? {
      expectedQty: qtyText(expected), movedDuringCount: qtyText(moved), variance: variance === null ? null : qtyText(variance),
      ...(showCost ? { varianceValue: variance === null || r.cost === null ? null : amount(variance, r.cost) } : {}),
    } : {}),
  };
}

export async function getStocktake(tx: Tx, ctx: Ctx, id: string) {
  const h = await header(tx, id);
  // Blind counts: people who only count do not see expected quantities until the stocktake is closed.
  const seeExpected = !h.blind || ctx.can('stocktake.approve') || h.status === 'posted' || h.status === 'cancelled';
  const { rows } = await tx.query(
    `SELECT sl.*, v.sku, v.barcode, v.attributes, v.cost, p.name AS product_name
       FROM stocktake_lines sl JOIN product_variants v ON v.id = sl.variant_id JOIN products p ON p.id = v.product_id
      WHERE sl.stocktake_id = $1 ORDER BY lower(p.name), lower(v.sku)`, [id]);
  const live = seeExpected && h.status !== 'posted' ? await movedDuringCount(tx, h) : new Map<string, bigint>();
  const lines = rows.map((r) => lineOut(r,
    h.status === 'posted' ? (r.moved_during_count === null ? 0n : milli(r.moved_during_count)) : (live.get(r.variant_id) ?? 0n),
    seeExpected, ctx.showCost));
  return {
    id: h.id as string, number: h.number as string, status: h.status as string, locationId: h.location_id as string,
    locationName: h.location_name as string, blind: h.blind as boolean, note: h.note as string | null, snapshotAt: h.snapshot_at as Date,
    categoryIds: h.category_ids as string[], version: h.version as number,
    progress: { counted: rows.filter((r) => r.counted_qty !== null).length, total: rows.length },
    canSeeExpected: seeExpected,
    lines,
  };
}

export async function listStocktakes(tx: Tx, f: { status?: string; limit: number; after: [string, string] | null; scope?: Scope }) {
  const params: unknown[] = [f.status ?? null];
  let where = '($1::text IS NULL OR s.status = $1)';
  if (f.after) { params.push(f.after[0], f.after[1]); where += ` AND (s.snapshot_at, s.id) < ($2::timestamptz, $3::uuid)`; }
  if (f.scope) where += ` AND ${locIn(f.scope, 's.location_id', pusher(params))}`;
  params.push(f.limit + 1);
  const { rows } = await tx.query(
    `SELECT s.id, s.number, s.status, s.snapshot_at, s.blind, l.name AS location_name,
            (SELECT count(*) FROM stocktake_lines x WHERE x.stocktake_id = s.id)::int AS total,
            (SELECT count(*) FROM stocktake_lines x WHERE x.stocktake_id = s.id AND x.counted_qty IS NOT NULL)::int AS counted
       FROM stocktakes s JOIN locations l ON l.id = s.location_id
      WHERE ${where} ORDER BY s.snapshot_at DESC, s.id DESC LIMIT $${params.length}`, params);
  const more = rows.length > f.limit;
  const page = rows.slice(0, f.limit);
  return {
    items: page.map((r) => ({ id: r.id, number: r.number, status: r.status, locationName: r.location_name, snapshotAt: r.snapshot_at,
      blind: r.blind, progress: { counted: r.counted, total: r.total } })),
    last: more ? [page[page.length - 1].snapshot_at.toISOString(), page[page.length - 1].id] as [string, string] : null,
  };
}

type Count = { variantId: string; countedQty: string } | { variantId: string; addQty: string };

/** Save counts. "countedQty" sets the count (safe to resend); "addQty" adds to it (each scan is +1). */
export async function saveCounts(tx: Tx, ctx: Ctx, id: string, counts: Count[]) {
  const h = await header(tx, id, true);
  requireStatus(h, 'counting');
  const ids = [...new Set(counts.map((c) => c.variantId))];
  const { rows } = await tx.query(
    `SELECT sl.variant_id, u.allow_fraction, v.sku FROM stocktake_lines sl JOIN product_variants v ON v.id = sl.variant_id
       JOIN products p ON p.id = v.product_id JOIN units u ON u.code = p.unit_code
      WHERE sl.stocktake_id = $1 AND sl.variant_id = ANY($2)`, [id, ids]);
  const known = new Map(rows.map((r) => [r.variant_id, r]));
  const errors: Record<string, string[]> = {};
  counts.forEach((c, i) => {
    const k = known.get(c.variantId);
    const q = 'countedQty' in c ? c.countedQty : c.addQty;
    if (!k) errors[`counts.${i}.variantId`] = ['This item is not part of this stocktake'];
    else if (!k.allow_fraction && milli(q) % 1000n !== 0n) errors[`counts.${i}.countedQty`] = [`${k.sku} is counted in whole units`];
  });
  if (Object.keys(errors).length) throw invalid(errors);
  for (const c of counts) {
    if ('countedQty' in c)
      await tx.query(`UPDATE stocktake_lines SET counted_qty = $3, counted_by = $4, counted_at = now() WHERE stocktake_id = $1 AND variant_id = $2`,
        [id, c.variantId, c.countedQty, ctx.userId]);
    else
      await tx.query(`UPDATE stocktake_lines SET counted_qty = coalesce(counted_qty, 0) + $3, counted_by = $4, counted_at = now() WHERE stocktake_id = $1 AND variant_id = $2`,
        [id, c.variantId, c.addQty, ctx.userId]);
  }
  await tx.query('UPDATE stocktakes SET version = version + 1 WHERE id = $1', [id]);
  const { rows: saved } = await tx.query(
    `SELECT sl.variant_id, sl.counted_qty, (SELECT count(*) FROM stocktake_lines x WHERE x.stocktake_id = $1 AND x.counted_qty IS NOT NULL)::int AS counted,
            (SELECT count(*) FROM stocktake_lines x WHERE x.stocktake_id = $1)::int AS total
       FROM stocktake_lines sl WHERE sl.stocktake_id = $1 AND sl.variant_id = ANY($2)`, [id, ids]);
  return {
    progress: { counted: saved[0]?.counted ?? 0, total: saved[0]?.total ?? 0 },
    lines: saved.map((r) => ({ variantId: r.variant_id as string, countedQty: qtyText(milli(r.counted_qty)) })),
  };
}

export async function submitStocktake(tx: Tx, ctx: Ctx, id: string) {
  const h = await header(tx, id, true);
  requireStatus(h, 'counting');
  const { rowCount } = await tx.query('SELECT 1 FROM stocktake_lines WHERE stocktake_id = $1 AND counted_qty IS NOT NULL LIMIT 1', [id]);
  if (!rowCount) throw appError(409, 'INVALID_STATE', 'Count at least one item before sending it for review');
  await tx.query("UPDATE stocktakes SET status = 'review', submitted_by = $2, submitted_at = now(), version = version + 1 WHERE id = $1", [id, ctx.userId]);
  await audit(tx, { actorId: ctx.userId, action: 'stocktake.submitted', entityType: 'stocktake', entityId: id, summary: { number: h.number } });
  return getStocktake(tx, ctx, id);
}

/** Send a stocktake in review back for more counting. */
export async function reopenStocktake(tx: Tx, ctx: Ctx, id: string) {
  const h = await header(tx, id, true);
  requireStatus(h, 'review');
  await tx.query("UPDATE stocktakes SET status = 'counting', version = version + 1 WHERE id = $1", [id]);
  await audit(tx, { actorId: ctx.userId, action: 'stocktake.reopened', entityType: 'stocktake', entityId: id, summary: { number: h.number } });
  return getStocktake(tx, ctx, id);
}

export async function cancelStocktake(tx: Tx, ctx: Ctx, id: string) {
  const h = await header(tx, id, true);
  requireStatus(h, 'counting', 'review');
  await tx.query("UPDATE stocktakes SET status = 'cancelled', closed_by = $2, closed_at = now(), version = version + 1 WHERE id = $1", [id, ctx.userId]);
  await audit(tx, { actorId: ctx.userId, action: 'stocktake.cancelled', entityType: 'stocktake', entityId: id, summary: { number: h.number } });
  return getStocktake(tx, ctx, id);
}

/** Approve and post the variances as stocktake movements (AC-06). Earlier ledger rows are untouched. */
export async function postStocktake(tx: Tx, ctx: Ctx, id: string) {
  const h = await header(tx, id, true);
  requireStatus(h, 'review');
  const moved = await movedDuringCount(tx, h);
  const { rows } = await tx.query(
    `SELECT sl.variant_id, sl.expected_qty, sl.counted_qty, v.sku FROM stocktake_lines sl JOIN product_variants v ON v.id = sl.variant_id
      WHERE sl.stocktake_id = $1 AND sl.counted_qty IS NOT NULL ORDER BY v.sku`, [id]);
  const moves: Move[] = [];
  const variances: { sku: string; expected: string; moved: string; counted: string; variance: string }[] = [];
  for (const r of rows) {
    const m = moved.get(r.variant_id) ?? 0n;
    const v = milli(r.counted_qty) - (milli(r.expected_qty) + m);
    if (v !== 0n) {
      moves.push({ variantId: r.variant_id, locationId: h.location_id, bucket: 'sellable', delta: v, movementType: 'stocktake',
        sourceType: 'stocktake', sourceId: id, reasonCode: 'stocktake', note: `Stocktake ${h.number}` });
      variances.push({ sku: r.sku, expected: qtyText(milli(r.expected_qty)), moved: qtyText(m), counted: qtyText(milli(r.counted_qty)), variance: qtyText(v) });
    }
  }
  await tx.query(
    `UPDATE stocktake_lines sl SET moved_during_count = coalesce(u.moved, 0)
       FROM (SELECT x.variant_id, m.moved FROM stocktake_lines x
               LEFT JOIN unnest($2::uuid[], $3::numeric[]) AS m(variant_id, moved) ON m.variant_id = x.variant_id
              WHERE x.stocktake_id = $1 AND x.counted_qty IS NOT NULL) u
      WHERE sl.stocktake_id = $1 AND sl.variant_id = u.variant_id`,
    [id, [...moved.keys()], [...moved.values()].map(qtyText)]);
  await post(tx, ctx.userId, moves);
  await tx.query("UPDATE stocktakes SET status = 'posted', closed_by = $2, closed_at = now(), version = version + 1 WHERE id = $1", [id, ctx.userId]);
  await audit(tx, { actorId: ctx.userId, action: 'stocktake.posted', entityType: 'stocktake', entityId: id,
    summary: { number: h.number, location: h.location_name, counted: rows.length, variances: variances.slice(0, 200), varianceLines: variances.length } });
  return getStocktake(tx, ctx, id);
}
