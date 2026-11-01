import type { Tx } from '../../db.js';

// Pick-list bookkeeping shared by fulfilment (people) and woo-orders (the shop changing or cancelling an order).
// No stock moves here: picking only moves goods from the shelf to a bag; stock leaves at dispatch.

/** Recompute a list's status from its live lines: none left → cancelled, all picked → picked, some picked → picking. */
export async function refreshPickList(tx: Tx, pickListId: string) {
  await tx.query(
    `UPDATE pick_lists p SET updated_at = now(), status = CASE
        WHEN NOT EXISTS (SELECT 1 FROM pick_list_lines l WHERE l.pick_list_id = p.id AND l.state = 'active') THEN 'cancelled'
        WHEN NOT EXISTS (SELECT 1 FROM pick_list_lines l WHERE l.pick_list_id = p.id AND l.state = 'active' AND l.qty_picked < l.qty_required) THEN 'picked'
        WHEN EXISTS (SELECT 1 FROM pick_list_lines l WHERE l.pick_list_id = p.id AND l.state = 'active' AND l.qty_picked > 0) THEN 'picking'
        ELSE 'open' END
      WHERE p.id = $1 AND p.status <> 'cancelled'`, [pickListId]);
}

/**
 * Take an order off whatever pick list it is on and forget its packing. Returns how many units were already picked,
 * so the caller can tell staff to put them back on the shelf.
 */
export async function dropFromPickLists(tx: Tx, orderId: string) {
  const { rows } = await tx.query(
    `UPDATE pick_list_lines SET state = 'removed' WHERE order_id = $1 AND state = 'active' RETURNING pick_list_id, qty_picked`, [orderId]);
  for (const id of new Set(rows.map((r) => r.pick_list_id as string))) await refreshPickList(tx, id);
  await tx.query('UPDATE sales_orders SET packed_at = NULL, packed_by = NULL WHERE id = $1 AND packed_at IS NOT NULL', [orderId]);
  return rows.reduce((n, r) => n + Number(r.qty_picked), 0);
}
