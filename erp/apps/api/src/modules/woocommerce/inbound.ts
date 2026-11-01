import { tenantTx } from '../../db.js';
import { PermanentJobError, RetryLaterError } from '../../jobs/runner.js';
import { applyWooOrder, settleStock, type WooOrder } from '../sales/woo-orders.js';

// woo.inbound: one stored webhook → the ERP. Runs in one transaction, so the order, its reservations and the event's
// status commit together; a crash means the job runs again and finds the order as it left it.

export async function processWebhook(tenantId: string, eventId: string) {
  await tenantTx(tenantId, async (tx) => {
    const { rows: [t] } = await tx.query('SELECT status FROM tenants');
    // A suspended shop keeps receiving (nothing is lost) but nothing is acted on until it is reactivated (04 §1.4).
    if (t?.status === 'suspended') throw new RetryLaterError(3600, 'store suspended');
    const { rows: [ev] } = await tx.query('SELECT id, topic, resource_id, payload, status FROM webhook_events WHERE id = $1 FOR UPDATE', [eventId]);
    if (!ev) throw new PermanentJobError('webhook event not found');
    if (ev.status !== 'received' && ev.status !== 'failed') return;
    const { rows: [c] } = await tx.query("SELECT online_location_id FROM woo_connections WHERE status <> 'disconnected'");
    if (!c) {
      await tx.query("UPDATE webhook_events SET status = 'ignored', last_error = 'not connected', processed_at = now() WHERE id = $1", [eventId]);
      return;
    }
    let outcome = 'processed';
    const p = ev.payload as Record<string, any>;
    switch (ev.topic) {
      case 'order.created':
      case 'order.updated':
      case 'order.restored': {
        const r = await applyWooOrder(tx, c.online_location_id, p as unknown as WooOrder);
        if (r.outcome === 'stale') outcome = 'ignored_stale';
        if (r.outcome === 'ignored') outcome = 'ignored';
        break;
      }
      case 'order.deleted': {
        // The payload is only { id }. Treat it as cancelled: release what it held.
        const { rows: [o] } = await tx.query("SELECT woo_modified_at FROM sales_orders WHERE channel = 'woocommerce' AND external_id = $1", [String(ev.resource_id)]);
        if (!o) { outcome = 'ignored'; break; }
        await applyDeleted(tx, String(ev.resource_id), c.online_location_id);
        break;
      }
      case 'product.deleted':
        await productDeleted(tx, Number(ev.resource_id));
        break;
      default:
        outcome = 'ignored';
    }
    await tx.query('UPDATE webhook_events SET status = $2, last_error = NULL, processed_at = now() WHERE id = $1', [eventId, outcome]);
  });
}

async function applyDeleted(tx: Parameters<Parameters<typeof tenantTx>[1]>[0], externalId: string, locationId: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7))', [`woo-order:${externalId}`]);
  const { rows: [o] } = await tx.query(
    "UPDATE sales_orders SET woo_status = 'deleted', updated_at = now() WHERE channel = 'woocommerce' AND external_id = $1 RETURNING id, status", [externalId]);
  await settleStock(tx, o.id, locationId, 'deleted', o.status);
}

/** Deleted (or trashed) in Woo: unlink it, and tell the owner rather than silently creating it again. */
async function productDeleted(tx: Parameters<Parameters<typeof tenantTx>[1]>[0], wooProductId: number) {
  const { rows: [m] } = await tx.query('SELECT product_id FROM woo_product_map WHERE woo_product_id = $1', [wooProductId]);
  if (!m) {
    await tx.query('DELETE FROM woo_variant_map WHERE woo_product_id = $1', [wooProductId]);
    return;
  }
  await tx.query('DELETE FROM woo_variant_map WHERE woo_product_id = $1', [wooProductId]);
  await tx.query("UPDATE woo_product_map SET state = 'deleted_in_woo' WHERE product_id = $1", [m.product_id]);
  await tx.query("UPDATE product_images SET woo_media_id = NULL, woo_file_id = NULL, sync_state = 'pending' WHERE product_id = $1", [m.product_id]);
  await tx.query(
    `UPDATE products SET publish_state = 'needs_review',
       publish_error = 'Deleted in WooCommerce. Use Publish to put it back on the website, or untick “Sell online”.' WHERE id = $1`, [m.product_id]);
}
