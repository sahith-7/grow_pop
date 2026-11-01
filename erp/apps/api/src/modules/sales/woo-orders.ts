import type { Tx } from '../../db.js';
import { milli, qtyText } from '../../lib/quantity.js';
import { dropFromPickLists } from '../fulfilment/pick-lists.js';
import { convert, release, reserve, type ReserveLine } from '../inventory/reservations.js';
import { invoiceAfterDispatch } from './web-invoice.js';

// Turns a WooCommerce order (webhook payload or REST read) into the ERP's order, and holds or releases stock for it
// (01-architecture.md §4 "Woo paid order"). Safe to call any number of times with the same or older data:
// older payloads are ignored, the same payload changes nothing.

export interface WooLine { id: number; product_id: number; variation_id: number; sku: string | null; name: string; quantity: number; price: number | string; total: string; total_tax: string; subtotal?: string }
export interface WooOrder {
  id: number; number: string; status: string; currency: string; customer_id: number;
  date_created_gmt: string | null; date_modified_gmt: string | null; date_paid_gmt: string | null; payment_method: string;
  payment_method_title?: string; total: string; total_tax: string; shipping_total: string; discount_total: string;
  billing?: Record<string, string>; shipping?: Record<string, string>; line_items: WooLine[]; refunds?: unknown[];
}

/** Woo statuses that hold stock. Woo itself deducts its stock for these, so the ERP must too or its next push undoes it. */
const HOLD = new Set(['processing', 'on-hold']);
const RELEASE = new Set(['cancelled', 'failed', 'refunded', 'trash', 'deleted', 'pending', 'checkout-draft']);
/** B6: ERP-only stages between "ready to pick" and dispatch. WooCommerce still says "processing" throughout. */
const IN_FULFILMENT = new Set(['picking', 'packed']);

const STATUS: Record<string, string> = {
  pending: 'awaiting_payment', 'on-hold': 'on_hold', processing: 'ready_to_pick', completed: 'completed',
  cancelled: 'cancelled', failed: 'failed', refunded: 'refunded', trash: 'cancelled', deleted: 'cancelled',
};

const gmt = (s: string | null | undefined) => (s ? new Date(`${s.replace(/Z$/, '')}Z`) : null);
const money = (s: string | number | null | undefined) => {
  const n = String(s ?? '0').trim();
  return /^-?\d+(\.\d+)?$/.test(n) ? n : '0';
};

function paymentState(o: WooOrder) {
  if (o.status === 'refunded') return 'refunded';
  if (o.status === 'failed') return 'failed';
  if (o.refunds && o.refunds.length) return 'partially_refunded';
  return o.date_paid_gmt ? 'paid' : 'awaiting';
}

/** Only what fulfilment and GST invoices need (T12: minimal PII). Never payment details. */
function snapshot(o: WooOrder) {
  const b = o.billing ?? {}, s = o.shipping ?? {};
  const name = `${b.first_name ?? ''} ${b.last_name ?? ''}`.trim() || `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim();
  const addr = (a: Record<string, string>) => ({
    name: `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim(), company: a.company ?? '', address1: a.address_1 ?? '', address2: a.address_2 ?? '',
    city: a.city ?? '', state: a.state ?? '', postcode: a.postcode ?? '', country: a.country ?? '', phone: a.phone ?? '',
  });
  return { name, email: b.email ?? '', phone: b.phone ?? s.phone ?? '', billing: addr(b), shipping: addr(s) };
}

async function event(tx: Tx, orderId: string, kind: string, message: string, actorId: string | null = null) {
  await tx.query(
    "INSERT INTO sales_order_events (tenant_id, order_id, kind, message, actor_id) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4)",
    [orderId, kind, message.slice(0, 1000), actorId]);
}

export interface ApplyResult { orderId: string | null; outcome: 'applied' | 'stale' | 'ignored' }

export async function applyWooOrder(tx: Tx, onlineLocationId: string, o: WooOrder): Promise<ApplyResult> {
  if (o.status === 'checkout-draft') return { orderId: null, outcome: 'ignored' };   // a cart, not an order yet
  const externalId = String(o.id);
  // One order is applied by one transaction at a time; the second waits and then sees the first one's result.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7))', [`woo-order:${externalId}`]);
  const { rows: [existing] } = await tx.query(
    "SELECT id, status, woo_status, woo_modified_at FROM sales_orders WHERE channel = 'woocommerce' AND external_id = $1 FOR UPDATE", [externalId]);
  const modified = gmt(o.date_modified_gmt);
  if (existing?.woo_modified_at && modified && modified < existing.woo_modified_at) return { orderId: existing.id, outcome: 'stale' };

  let customerId: string | null = null;
  if (o.customer_id > 0) {
    const snap = snapshot(o);
    const { rows: [c] } = await tx.query(
      `INSERT INTO customers (tenant_id, name, phone, email, woo_customer_id, billing_address, shipping_address)
       VALUES (current_setting('app.tenant_id')::uuid, $1, nullif($2, ''), nullif($3, ''), $4, $5, $6)
       ON CONFLICT (tenant_id, woo_customer_id) WHERE woo_customer_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, email = EXCLUDED.email,
                     billing_address = EXCLUDED.billing_address, shipping_address = EXCLUDED.shipping_address, updated_at = now()
       RETURNING id`,
      [snap.name.slice(0, 200), snap.phone.slice(0, 30), snap.email.slice(0, 254), o.customer_id, JSON.stringify(snap.billing), JSON.stringify(snap.shipping)]);
    customerId = c.id;
  }

  const subtotal = o.line_items.reduce((s, l) => s + Number(money(l.subtotal ?? l.total)), 0).toFixed(2);
  const header = [String(o.number ?? o.id).slice(0, 40), o.status, modified, paymentState(o), (o.payment_method_title || o.payment_method || '').slice(0, 100),
    customerId, JSON.stringify(snapshot(o)), subtotal, money(o.discount_total), money(o.shipping_total), money(o.total_tax), money(o.total),
    (o.currency || 'INR').slice(0, 3), gmt(o.date_created_gmt) ?? new Date()];
  let orderId: string;
  if (existing) {
    orderId = existing.id;
    await tx.query(
      `UPDATE sales_orders SET number = $2, woo_status = $3, woo_modified_at = $4, payment_state = $5, payment_method = $6, customer_id = $7,
         customer_snapshot = $8, subtotal = $9, discount_total = $10, shipping_total = $11, tax_total = $12, total = $13, currency = $14,
         placed_at = $15, updated_at = now() WHERE id = $1`, [orderId, ...header]);
    if (existing.woo_status !== o.status) await event(tx, orderId, 'woo_status', `WooCommerce status: ${existing.woo_status} → ${o.status}`);
  } else {
    const { rows: [n] } = await tx.query(
      `INSERT INTO sales_orders (tenant_id, channel, external_id, status, number, woo_status, woo_modified_at, payment_state, payment_method,
         customer_id, customer_snapshot, subtotal, discount_total, shipping_total, tax_total, total, currency, placed_at)
       VALUES (current_setting('app.tenant_id')::uuid, 'woocommerce', $1, 'awaiting_payment', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`, [externalId, ...header]);
    orderId = n.id;
    await event(tx, orderId, 'imported', `Order #${o.number} received from WooCommerce (${o.status})`);
  }

  await upsertLines(tx, orderId, o.line_items);
  await settleStock(tx, orderId, onlineLocationId, o.status, existing?.status ?? null);
  return { orderId, outcome: 'applied' };
}

async function upsertLines(tx: Tx, orderId: string, items: WooLine[]) {
  const { rows: current } = await tx.query('SELECT id, woo_line_id, variant_id FROM sales_order_lines WHERE order_id = $1', [orderId]);
  const byWoo = new Map(current.map((r) => [String(r.woo_line_id), r]));
  // Match: the variant this Woo product/variation is mapped to, else the SKU (case-insensitive, like the ERP's SKU index).
  const { rows: matches } = await tx.query(
    `SELECT i.ord, coalesce(m.variant_id, v.id) AS variant_id
       FROM unnest($1::bigint[], $2::bigint[], $3::text[]) WITH ORDINALITY AS i(pid, vid, sku, ord)
       LEFT JOIN woo_variant_map m ON m.woo_product_id = i.pid AND m.woo_variation_id = i.vid
       LEFT JOIN product_variants v ON i.sku <> '' AND lower(v.sku) = lower(i.sku)`,
    [items.map((l) => l.product_id), items.map((l) => l.variation_id || 0), items.map((l) => (l.sku ?? '').trim())]);
  const matched = new Map(matches.map((m) => [Number(m.ord) - 1, m.variant_id as string | null]));
  for (const [i, l] of items.entries()) {
    const prev = byWoo.get(String(l.id));
    // A line someone mapped by hand keeps its variant.
    const variantId = prev?.variant_id ?? matched.get(i) ?? null;
    const qty = Math.max(0, Math.trunc(Number(l.quantity) || 0));
    const vals = [variantId, l.product_id, l.variation_id || 0, (l.sku ?? '').slice(0, 64), (l.name ?? '').slice(0, 300), String(qty),
      money(l.price), money(l.total), money(l.total_tax), i];
    if (prev) {
      await tx.query(
        `UPDATE sales_order_lines SET variant_id = $2, woo_product_id = $3, woo_variation_id = $4, sku = $5, name = $6, qty = $7,
           unit_price = $8, line_total = $9, tax_total = $10, position = $11 WHERE id = $1`, [prev.id, ...vals]);
      byWoo.delete(String(l.id));
    } else {
      await tx.query(
        `INSERT INTO sales_order_lines (tenant_id, order_id, woo_line_id, variant_id, woo_product_id, woo_variation_id, sku, name, qty,
           unit_price, line_total, tax_total, position)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [orderId, l.id, ...vals]);
    }
  }
  // Lines removed from the order in Woo stay, with nothing to hold.
  for (const gone of byWoo.values()) await tx.query('UPDATE sales_order_lines SET qty = 0 WHERE id = $1', [gone.id]);
}

/** Bring the order's reservations in line with its Woo status, then set the ERP status. */
export async function settleStock(tx: Tx, orderId: string, locationId: string, wooStatus: string, prevStatus: string | null, actorId: string | null = null) {
  const { rows: lines } = await tx.query(
    `SELECT l.id, l.variant_id, l.qty, l.sku, l.name FROM sales_order_lines l WHERE l.order_id = $1 AND l.qty > 0 ORDER BY l.position`, [orderId]);
  const { rows: res } = await tx.query('SELECT order_line_id, qty, location_id, state FROM stock_reservations WHERE order_id = $1', [orderId]);
  const active = res.filter((r) => r.state === 'active');
  const converted = res.some((r) => r.state === 'converted');
  const setStatus = async (status: string, reason: string | null) => {
    await tx.query('UPDATE sales_orders SET status = $2, exception_reason = $3, updated_at = now() WHERE id = $1', [orderId, status, reason]);
    if (status !== prevStatus) await event(tx, orderId, 'status', reason ? `${label(status)}: ${reason}` : label(status), actorId);
  };

  // B6: the order is on a pick list or packed, and the shop changed it. The goods in the bag go back to the shelf.
  const stopFulfilment = async (why: string) => {
    if (!IN_FULFILMENT.has(prevStatus ?? '')) return;
    const picked = await dropFromPickLists(tx, orderId);
    await event(tx, orderId, 'fulfilment_stopped', `${why}${picked ? ': put the picked items back on the shelf' : ''}`, actorId);
  };

  if (converted) {
    // Stock already left the shop for this order. Anything but "completed" afterwards needs a person (B5: record a return).
    if (wooStatus === 'completed') return setStatus('completed', null);
    // B6: dispatched in the ERP; the shop hasn't heard yet (its update is queued). Nothing is wrong.
    if (prevStatus === 'dispatched' && HOLD.has(wooStatus)) return setStatus('dispatched', null);
    if (wooStatus === 'refunded') return setStatus('refunded', 'Stock was already deducted; record the return when the goods come back');
    return setStatus('needs_review', `Stock was already deducted, then WooCommerce changed the order to “${wooStatus}”`);
  }

  if (RELEASE.has(wooStatus)) {
    await stopFulfilment(`${STATUS[wooStatus] === 'refunded' ? 'Refunded' : 'Cancelled'} in WooCommerce during picking`);
    const n = await release(tx, orderId);
    if (n) await event(tx, orderId, 'released', 'Reserved stock released', actorId);
    return setStatus(STATUS[wooStatus] ?? 'cancelled', null);
  }

  const unmatched = lines.filter((l) => !l.variant_id);
  const target: ReserveLine[] = lines.filter((l) => l.variant_id).map((l) => ({ lineId: l.id, variantId: l.variant_id, qty: milli(l.qty), sku: l.sku || l.name }));

  if (HOLD.has(wooStatus) || wooStatus === 'completed') {
    // Already holding exactly this? Then leave it: no churn, no pointless stock push.
    const same = !unmatched.length && active.length === target.length && active.every((a) => {
      const t = target.find((x) => x.lineId === a.order_line_id);
      return t && a.location_id === locationId && milli(a.qty) === t.qty;
    });
    if (!same) {
      await stopFulfilment('Changed in WooCommerce during picking; pick it again');
      const had = await release(tx, orderId);
      if (unmatched.length) {
        if (had) await event(tx, orderId, 'released', 'Reserved stock released', actorId);
        const skus = unmatched.map((l) => l.sku || l.name).join(', ');
        return setStatus(wooStatus === 'completed' ? 'needs_review' : 'stock_exception', `Not in the ERP: ${skus}. Map the line to a product.`);
      }
      const r = await reserve(tx, orderId, locationId, target);
      if (!r.ok) {
        if (had) await event(tx, orderId, 'released', 'Reserved stock released', actorId);
        const why = r.shortages.map((s) => `${s.sku} needs ${s.needed}, ${s.available} available`).join('; ');
        return setStatus(wooStatus === 'completed' ? 'needs_review' : 'stock_exception', why);
      }
      await event(tx, orderId, 'reserved', `Reserved ${target.map((t) => `${qtyText(t.qty)} × ${t.sku}`).join(', ')}`, actorId);
    }
    if (wooStatus === 'completed') {
      if (same) await stopFulfilment('Completed in WooCommerce before the ERP dispatched it');
      const { rows: [o] } = await tx.query('SELECT number FROM sales_orders WHERE id = $1', [orderId]);
      await convert(tx, orderId, actorId, `Web order #${o.number} completed in WooCommerce`);
      await event(tx, orderId, 'dispatched', 'Completed in WooCommerce: reserved stock deducted', actorId);
      await setStatus('completed', null);
      return invoiceAfterDispatch(tx, orderId, actorId);   // B5: the GST invoice, when the goods leave
    }
    // B6: still "processing" in the shop while it is picked and packed here: keep the ERP stage.
    if (same && wooStatus === 'processing' && IN_FULFILMENT.has(prevStatus ?? '')) return setStatus(prevStatus!, null);
    if (same) await stopFulfilment(`Put on hold in WooCommerce during picking`);
    return setStatus(STATUS[wooStatus], null);
  }

  // A status the ERP does not know (a plugin's own, like "shipped"): hold what is held and ask a person.
  return setStatus('needs_review', `Unknown WooCommerce status “${wooStatus}”`);
}

function label(s: string) {
  return ({
    awaiting_payment: 'Awaiting payment', on_hold: 'On hold, stock reserved', ready_to_pick: 'Ready to pick, stock reserved',
    stock_exception: 'Stock exception', completed: 'Completed', cancelled: 'Cancelled', failed: 'Payment failed', refunded: 'Refunded',
    needs_review: 'Needs review',
  } as Record<string, string>)[s] ?? s;
}
