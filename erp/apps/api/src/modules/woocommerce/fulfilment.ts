import { tenantTx } from '../../db.js';
import { PermanentJobError } from '../../jobs/runner.js';
import { WooError } from './client.js';
import { clientFor, noteResult } from './connection.js';

// woo.fulfilment (B6): after the ERP dispatches a web order, tell the shop. Two calls, in this order:
//   1. a customer note with the courier and tracking number (Woo emails it to the customer), recorded so a retry never
//      posts it twice;
//   2. status "completed" (Woo emails "order complete"). Its webhook comes back and B4 sees the order already dispatched.
// Network trouble retries with backoff; a refusal from the shop is kept on the shipment for a person to see and retry.

const setState = (tenantId: string, id: string, state: string, error: string | null) =>
  tenantTx(tenantId, (tx) => tx.query(
    `UPDATE shipments SET woo_update_state = $2, woo_error = $3, woo_synced_at = CASE WHEN $2 = 'synced' THEN now() ELSE woo_synced_at END
      WHERE id = $1`, [id, state, error?.slice(0, 1000) ?? null]));

export function trackingNote(s: { carrier: string; service: string | null; tracking_no: string | null }) {
  const via = s.service ? `${s.carrier} (${s.service})` : s.carrier;
  return s.tracking_no ? `Your order has been dispatched via ${via}. Tracking number: ${s.tracking_no}` : `Your order has been dispatched via ${via}.`;
}

export async function pushFulfilment(tenantId: string, shipmentId: string) {
  const work = await tenantTx(tenantId, async (tx) => {
    const { rows: [s] } = await tx.query(
      `SELECT s.id, s.carrier, s.service, s.tracking_no, s.woo_update_state, s.woo_note_id, o.external_id
         FROM shipments s JOIN sales_orders o ON o.id = s.order_id WHERE s.id = $1`, [shipmentId]);
    if (!s || s.woo_update_state === 'synced' || s.woo_update_state === 'not_needed') return null;
    const c = await clientFor(tx);
    if (!c) {
      await tx.query("UPDATE shipments SET woo_update_state = 'not_needed', woo_error = 'WooCommerce was disconnected; update the order in the shop by hand' WHERE id = $1", [s.id]);
      return null;
    }
    return { s, client: c.client };
  });
  if (!work) return;
  const { s, client } = work;
  const path = `/orders/${encodeURIComponent(s.external_id)}`;
  try {
    if (!s.woo_note_id) {
      const note = await client.post(`${path}/notes`, { note: trackingNote(s), customer_note: true });
      await tenantTx(tenantId, (tx) => tx.query('UPDATE shipments SET woo_note_id = $2 WHERE id = $1', [s.id, Number(note?.id) || 0]));
    }
    await client.put(path, { status: 'completed' });
    await setState(tenantId, s.id, 'synced', null);
    await noteResult(tenantId, null);
  } catch (e) {
    await noteResult(tenantId, e);
    if (e instanceof WooError && e.kind !== 'retry') {
      const why = e.kind === 'not_found' ? 'The order no longer exists in WooCommerce'
        : e.kind === 'auth' ? 'WooCommerce refused the key; reconnect the shop, then retry' : `WooCommerce refused the update: ${e.message}`;
      await setState(tenantId, s.id, 'failed', why);
      throw new PermanentJobError(why);
    }
    // Still pending: the job retries with backoff. Show the last problem meanwhile.
    await setState(tenantId, s.id, 'pending', `Not sent yet, will retry: ${(e as Error).message}`);
    throw e;
  }
}
