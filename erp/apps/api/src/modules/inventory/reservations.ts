import type { Tx } from '../../db.js';
import { milli, qtyText } from '../../lib/quantity.js';
import { post } from './ledger.js';

// Web-order reservations (D3, D4, D20). With post(), the only writers of stock_balances.reserved.
// A reservation holds sellable stock at one location for one order line: available = on hand − reserved.
// Balance rows are locked in the same (variant, location) order as post(), so the two cannot deadlock.

export interface ReserveLine { lineId: string; variantId: string; qty: bigint; sku: string }
export interface Shortage { lineId: string; sku: string; needed: string; available: string }

async function lockBalances(tx: Tx, pairs: { variantId: string; locationId: string }[]) {
  const keys = [...new Map(pairs.map((p) => [`${p.variantId}|${p.locationId}`, p])).values()]
    .sort((a, b) => (a.variantId + a.locationId < b.variantId + b.locationId ? -1 : 1));
  if (!keys.length) return new Map<string, { onHand: bigint; reserved: bigint }>();
  const { rows } = await tx.query(
    `SELECT variant_id, location_id, on_hand, reserved FROM stock_balances
      WHERE (variant_id, location_id) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[]))
      ORDER BY variant_id, location_id FOR UPDATE`,
    [keys.map((k) => k.variantId), keys.map((k) => k.locationId)]);
  return new Map(rows.map((r) => [`${r.variant_id}|${r.location_id}`, { onHand: milli(r.on_hand), reserved: milli(r.reserved) }]));
}

async function applyReserved(tx: Tx, locationId: string, deltas: Map<string, bigint>) {
  const vs = [...deltas.keys()];
  if (!vs.length) return;
  await tx.query(
    `UPDATE stock_balances s SET reserved = s.reserved + u.d, updated_at = now()
       FROM unnest($1::uuid[], $2::numeric[]) AS u(v, d) WHERE s.variant_id = u.v AND s.location_id = $3`,
    [vs, vs.map((v) => qtyText(deltas.get(v)!)), locationId]);
}

/**
 * Reserve every line at `locationId`, or nothing (all-or-exception). Returns the shortages when any line cannot be held.
 * The location must be active and sellable.
 */
export async function reserve(tx: Tx, orderId: string, locationId: string, lines: ReserveLine[]): Promise<{ ok: true } | { ok: false; shortages: Shortage[] }> {
  const want = lines.filter((l) => l.qty > 0n);
  if (!want.length) return { ok: true };
  const { rows: [loc] } = await tx.query('SELECT active, is_sellable FROM locations WHERE id = $1', [locationId]);
  const bal = await lockBalances(tx, want.map((l) => ({ variantId: l.variantId, locationId })));
  const need = new Map<string, bigint>();
  for (const l of want) need.set(l.variantId, (need.get(l.variantId) ?? 0n) + l.qty);
  const shortages: Shortage[] = [];
  for (const l of want) {
    const b = bal.get(`${l.variantId}|${locationId}`);
    const avail = loc?.active && loc?.is_sellable && b ? b.onHand - b.reserved : 0n;
    if (avail < need.get(l.variantId)!) shortages.push({ lineId: l.lineId, sku: l.sku, needed: qtyText(l.qty), available: qtyText(avail > 0n ? avail : 0n) });
  }
  if (shortages.length) return { ok: false, shortages };
  await tx.query(
    `INSERT INTO stock_reservations (tenant_id, order_id, order_line_id, variant_id, location_id, qty)
     SELECT current_setting('app.tenant_id')::uuid, $1, u.line, u.v, $2, u.q FROM unnest($3::uuid[], $4::uuid[], $5::numeric[]) AS u(line, v, q)`,
    [orderId, locationId, want.map((l) => l.lineId), want.map((l) => l.variantId), want.map((l) => qtyText(l.qty))]);
  await applyReserved(tx, locationId, need);
  return { ok: true };
}

async function closeActive(tx: Tx, orderId: string, state: 'released' | 'converted') {
  const { rows } = await tx.query(
    "SELECT id, variant_id, location_id, qty FROM stock_reservations WHERE order_id = $1 AND state = 'active'", [orderId]);
  if (!rows.length) return [];
  await lockBalances(tx, rows.map((r) => ({ variantId: r.variant_id, locationId: r.location_id })));
  await tx.query("UPDATE stock_reservations SET state = $2, closed_at = now() WHERE id = ANY($1) AND state = 'active'", [rows.map((r) => r.id), state]);
  const byLoc = new Map<string, Map<string, bigint>>();
  for (const r of rows) {
    const m = byLoc.get(r.location_id) ?? new Map<string, bigint>();
    m.set(r.variant_id, (m.get(r.variant_id) ?? 0n) - milli(r.qty));
    byLoc.set(r.location_id, m);
  }
  for (const [loc, deltas] of byLoc) await applyReserved(tx, loc, deltas);
  return rows.map((r) => ({ lineId: '', variantId: r.variant_id as string, locationId: r.location_id as string, qty: milli(r.qty), id: r.id as string }));
}

/** Give back every active reservation of the order. Idempotent: nothing active, nothing changes. */
export async function release(tx: Tx, orderId: string) {
  return (await closeActive(tx, orderId, 'released')).length;
}

/**
 * The goods left the shop: turn active reservations into stock-out movements in the ledger, exactly once
 * (the state = 'active' guard makes a second call a no-op). `actorId` is null when WooCommerce reported it.
 */
export async function convert(tx: Tx, orderId: string, actorId: string | null, note: string) {
  const closed = await closeActive(tx, orderId, 'converted');
  if (!closed.length) return [];
  const lines = new Map((await tx.query(
    'SELECT r.id, r.order_line_id FROM stock_reservations r WHERE r.id = ANY($1)', [closed.map((c) => c.id)])).rows.map((r) => [r.id, r.order_line_id]));
  return post(tx, actorId, closed.map((c) => ({
    variantId: c.variantId, locationId: c.locationId, bucket: 'sellable' as const, delta: -c.qty, movementType: 'dispatch',
    sourceType: 'sales_order' as const, sourceId: orderId, sourceLineId: lines.get(c.id) ?? null, note,
  })));
}
