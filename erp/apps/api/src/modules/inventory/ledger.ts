import type { Tx } from '../../db.js';
import { fmtMoney } from '../../lib/decimal.js';
import { appError } from '../../lib/phase1.js';
import { isWhole, milli, qtyText } from '../../lib/quantity.js';

// The only writer of stock_balances and stock_ledger (01-architecture.md §3). Every stock change in B3–B6 goes through post().

export type Bucket = 'sellable' | 'non_sellable';
export type SourceType = 'adjustment' | 'transfer' | 'stocktake' | 'goods_receipt' | 'supplier_return' | 'sales_order' | 'customer_return';

export interface Move {
  variantId: string;
  locationId: string;
  bucket: Bucket;
  delta: bigint;                 // thousandths, signed
  movementType: string;
  sourceType: SourceType;
  sourceId: string;
  sourceLineId?: string | null;
  reversalOfId?: string | null;
  reasonCode?: string | null;
  note?: string | null;
  unitCost?: string | null;
  /** Request field the move came from, so errors point at the right line ('lines.2.qtyDelta'). */
  field?: string;
}

export interface Posted { id: string; variantId: string; locationId: string; bucket: Bucket; delta: bigint; before: bigint; after: bigint }

const keyOf = (v: string, l: string) => `${v}|${l}`;

/**
 * Write ledger rows and their balance changes in the caller's transaction (INV-03/10).
 * Balance rows are locked in a fixed order (variant, location) so multi-line documents cannot deadlock each other.
 * Sellable stock may not drop below active reservations unless `allowNegative` (owner override, INV-08).
 * Non-sellable stock can never go below zero.
 * `actorId` is null only for system postings against a web order (B4: an order completed in WooCommerce).
 * B5 adds POS sales ('sale' against the sales order) and customer returns ('return_in' against the return).
 */
export async function post(tx: Tx, actorId: string | null, moves: Move[], opts: { allowNegative?: boolean } = {}): Promise<Posted[]> {
  if (!moves.length) return [];
  const variantIds = [...new Set(moves.map((m) => m.variantId))];
  const info = new Map<string, { sku: string; allowFraction: boolean }>(
    (await tx.query(
      `SELECT v.id, v.sku, u.allow_fraction FROM product_variants v
         JOIN products p ON p.id = v.product_id JOIN units u ON u.code = p.unit_code WHERE v.id = ANY($1)`, [variantIds]))
      .rows.map((r) => [r.id, { sku: r.sku, allowFraction: r.allow_fraction }]));
  const errors: Record<string, string[]> = {};
  for (const m of moves) {
    const v = info.get(m.variantId);
    if (!v) errors[m.field ?? 'variantId'] = ['Product not found'];
    else if (!v.allowFraction && !isWhole(m.delta)) errors[m.field ?? 'qty'] = [`${v.sku} is counted in whole units`];
  }
  if (Object.keys(errors).length) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', errors);

  const keys = [...new Map(moves.map((m) => [keyOf(m.variantId, m.locationId), m])).values()]
    .map((m) => [m.variantId, m.locationId] as const)
    .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
  const vs = keys.map((k) => k[0]), ls = keys.map((k) => k[1]);
  await tx.query(
    `INSERT INTO stock_balances (tenant_id, variant_id, location_id)
     SELECT current_setting('app.tenant_id')::uuid, k.v, k.l FROM unnest($1::uuid[], $2::uuid[]) AS k(v, l) ORDER BY k.v, k.l
     ON CONFLICT DO NOTHING`, [vs, ls]);
  const { rows } = await tx.query(
    `SELECT b.variant_id, b.location_id, b.on_hand, b.reserved, b.non_sellable, l.name AS location_name
       FROM stock_balances b JOIN locations l ON l.id = b.location_id
      WHERE (b.variant_id, b.location_id) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[]))
      ORDER BY b.variant_id, b.location_id FOR UPDATE OF b`, [vs, ls]);
  const bal = new Map(rows.map((r) => [keyOf(r.variant_id, r.location_id), {
    onHand: milli(r.on_hand), reserved: milli(r.reserved), nonSellable: milli(r.non_sellable), locationName: r.location_name as string,
  }]));

  const out: Omit<Posted, 'id'>[] = [];
  for (const m of moves) {
    const b = bal.get(keyOf(m.variantId, m.locationId))!;
    const sku = info.get(m.variantId)!.sku;
    if (m.bucket === 'sellable') {
      const before = b.onHand;
      b.onHand += m.delta;
      if (m.delta < 0n && b.onHand - b.reserved < 0n && !opts.allowNegative) {
        const avail = before - b.reserved;
        throw appError(409, 'INSUFFICIENT_STOCK', `Only ${qtyText(avail > 0n ? avail : 0n)} of ${sku} available at ${b.locationName}`,
          { [m.field ?? 'qty']: [`Only ${qtyText(avail > 0n ? avail : 0n)} available`] });
      }
      out.push({ variantId: m.variantId, locationId: m.locationId, bucket: m.bucket, delta: m.delta, before, after: b.onHand });
    } else {
      const before = b.nonSellable;
      b.nonSellable += m.delta;
      if (b.nonSellable < 0n) {
        throw appError(409, 'INSUFFICIENT_STOCK', `Only ${qtyText(before)} damaged ${sku} at ${b.locationName}`,
          { [m.field ?? 'qty']: [`Only ${qtyText(before)} in non-sellable stock`] });
      }
      out.push({ variantId: m.variantId, locationId: m.locationId, bucket: m.bucket, delta: m.delta, before, after: b.nonSellable });
    }
  }

  const ins = await tx.query(
    `INSERT INTO stock_ledger (tenant_id, variant_id, location_id, bucket, qty_delta, balance_after, movement_type, source_type,
                               source_id, source_line_id, reversal_of_id, reason_code, note, unit_cost, posted_by)
     SELECT current_setting('app.tenant_id')::uuid, r.variant_id, r.location_id, r.bucket, r.qty_delta, r.balance_after,
            r.movement_type, r.source_type, r.source_id, r.source_line_id, r.reversal_of_id, r.reason_code, r.note, r.unit_cost, $2
       FROM jsonb_to_recordset($1) AS r(ord int, variant_id uuid, location_id uuid, bucket text, qty_delta numeric, balance_after numeric,
            movement_type text, source_type text, source_id uuid, source_line_id uuid, reversal_of_id uuid, reason_code text,
            note text, unit_cost numeric)
      ORDER BY r.ord
     RETURNING id`,
    [JSON.stringify(moves.map((m, i) => ({
      ord: i, variant_id: m.variantId, location_id: m.locationId, bucket: m.bucket, qty_delta: qtyText(m.delta),
      balance_after: qtyText(out[i].after), movement_type: m.movementType, source_type: m.sourceType, source_id: m.sourceId,
      source_line_id: m.sourceLineId ?? null, reversal_of_id: m.reversalOfId ?? null, reason_code: m.reasonCode ?? null,
      note: m.note ?? null, unit_cost: m.unitCost ?? null,
    }))), actorId]);

  const final = [...bal.entries()].map(([k, b]) => ({ k: k.split('|'), b }));
  await tx.query(
    `UPDATE stock_balances s SET on_hand = u.on_hand, non_sellable = u.non_sellable, updated_at = now()
       FROM unnest($1::uuid[], $2::uuid[], $3::numeric[], $4::numeric[]) AS u(v, l, on_hand, non_sellable)
      WHERE s.variant_id = u.v AND s.location_id = u.l`,
    [final.map((f) => f.k[0]), final.map((f) => f.k[1]), final.map((f) => qtyText(f.b.onHand)), final.map((f) => qtyText(f.b.nonSellable))]);

  return out.map((o, i) => ({ ...o, id: ins.rows[i].id }));
}

/**
 * Moving weighted-average cost (B3 default): new cost = (stock on hand × old cost + received × unit cost) / (on hand + received).
 * Call before post() so "on hand" is the stock before this receipt. Negative or zero stock, or no cost yet, takes the new cost.
 */
export async function applyCost(tx: Tx, variantId: string, received: bigint, unitCost: string) {
  if (received <= 0n) return;
  await tx.query(
    `WITH s AS (SELECT coalesce(sum(on_hand), 0) AS oh FROM stock_balances WHERE variant_id = $1),
          n AS (SELECT round(CASE WHEN v.cost IS NULL OR s.oh <= 0 THEN $3::numeric
                                  ELSE (s.oh * v.cost + $2::numeric * $3::numeric) / (s.oh + $2::numeric) END, 4) AS cost
                  FROM product_variants v, s WHERE v.id = $1)
     UPDATE product_variants v SET cost = n.cost, version = v.version + 1, updated_at = now()
       FROM n WHERE v.id = $1 AND v.cost IS DISTINCT FROM n.cost`,
    [variantId, qtyText(received), unitCost]);
}

// ------------------------------------------------------------------ reading the ledger

const MOVEMENT_SQL = `
  SELECT m.id, m.seq, m.posted_at, m.variant_id, v.sku, p.name AS product_name, v.attributes, m.location_id, l.name AS location_name,
         m.bucket, m.qty_delta, m.balance_after, m.movement_type, m.source_type, m.source_id, m.reason_code, m.note, m.unit_cost,
         m.reversal_of_id, r.id AS reversed_by_id, m.posted_by, u.name AS posted_by_name,
         coalesce(a.number, t.number, s.number, g.number, sr.number, so.number, cr.number) AS source_number
    FROM stock_ledger m
    JOIN product_variants v ON v.id = m.variant_id
    JOIN products p ON p.id = v.product_id
    JOIN locations l ON l.id = m.location_id
    LEFT JOIN users u ON u.id = m.posted_by
    LEFT JOIN stock_ledger r ON r.reversal_of_id = m.id
    LEFT JOIN adjustments a ON m.source_type = 'adjustment' AND a.id = m.source_id
    LEFT JOIN transfers t ON m.source_type = 'transfer' AND t.id = m.source_id
    LEFT JOIN stocktakes s ON m.source_type = 'stocktake' AND s.id = m.source_id
    LEFT JOIN goods_receipts g ON m.source_type = 'goods_receipt' AND g.id = m.source_id
    LEFT JOIN supplier_returns sr ON m.source_type = 'supplier_return' AND sr.id = m.source_id
    LEFT JOIN sales_orders so ON m.source_type = 'sales_order' AND so.id = m.source_id
    LEFT JOIN customer_returns cr ON m.source_type = 'customer_return' AND cr.id = m.source_id`;

export function movementOut(r: Record<string, any>, showCost: boolean) {
  const delta = milli(r.qty_delta), after = milli(r.balance_after);
  return {
    id: r.id as string,
    postedAt: r.posted_at as Date,
    variantId: r.variant_id as string,
    sku: r.sku as string,
    name: r.product_name as string,
    attributes: r.attributes as Record<string, string>,
    locationId: r.location_id as string,
    locationName: r.location_name as string,
    bucket: r.bucket as Bucket,
    qtyDelta: qtyText(delta),
    balanceBefore: qtyText(after - delta),
    balanceAfter: qtyText(after),
    movementType: r.movement_type as string,
    source: { type: r.source_type as SourceType, id: r.source_id as string, number: r.source_number as string },
    reasonCode: r.reason_code as string | null,
    note: r.note as string | null,
    reversalOfId: r.reversal_of_id as string | null,
    reversedById: r.reversed_by_id as string | null,
    actor: { id: r.posted_by as string | null, name: (r.posted_by_name as string | null) ?? (r.posted_by ? '' : 'WooCommerce') },
    ...(showCost ? { unitCost: fmtMoney(r.unit_cost) } : {}),
  };
}

export async function movementsByIds(tx: Tx, ids: string[], showCost: boolean) {
  const { rows } = await tx.query(`${MOVEMENT_SQL} WHERE m.id = ANY($1) ORDER BY m.seq`, [ids]);
  return rows.map((r) => movementOut(r, showCost));
}

export async function listMovements(tx: Tx, f: {
  variantId?: string; locationId?: string; movementType?: string; sourceId?: string; from?: string; to?: string;
  limit: number; afterSeq: number | null;
}, showCost: boolean) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.variantId) add('m.variant_id = ?', f.variantId);
  if (f.locationId) add('m.location_id = ?', f.locationId);
  if (f.movementType) add('m.movement_type = ?', f.movementType);
  if (f.sourceId) add('m.source_id = ?', f.sourceId);
  if (f.from) add('m.posted_at >= ?', f.from);
  if (f.to) add('m.posted_at < ?', f.to);
  if (f.afterSeq !== null) add('m.seq < ?', f.afterSeq);
  params.push(f.limit + 1);
  const { rows } = await tx.query(
    `${MOVEMENT_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.seq DESC LIMIT $${params.length}`, params);
  const more = rows.length > f.limit;
  const page = rows.slice(0, f.limit);
  return { items: page.map((r) => movementOut(r, showCost)), last: more ? Number(page[page.length - 1].seq) : null };
}
