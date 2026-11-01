import { tenantTx } from '../../db.js';
import { withJobLock } from '../../jobs/lock.js';
import { PermanentJobError } from '../../jobs/runner.js';
import { WooError } from './client.js';
import { clientFor, noteResult } from './connection.js';

// woo.stock (AC-07, NFR "stock on the website within 10 s"): tell Woo what is available at the online location for every
// variant the outbox says changed. One job per shop; variants go 100 at a time through Woo's batch endpoints.
// Woo stock is whole units, so a fractional quantity (kg) is rounded down.

const BATCH = 100;
const MAX_PER_RUN = 2000;

export async function pushStock(tenantId: string) {
  await withJobLock(`woo.stock:${tenantId}`, async () => {
    for (let round = 0; round * BATCH < MAX_PER_RUN; round++) {
      const work = await tenantTx(tenantId, async (tx) => {
        const c = await clientFor(tx);
        if (!c) { await tx.query("DELETE FROM woo_outbox WHERE kind = 'stock'"); return null; }
        const { rows: ids } = await tx.query("SELECT id, ref_id FROM woo_outbox WHERE kind = 'stock' ORDER BY id LIMIT 1000");
        if (!ids.length) return null;
        const variants = [...new Set(ids.map((r) => r.ref_id as string))].slice(0, BATCH);
        const { rows } = await tx.query(
          `SELECT m.variant_id, m.woo_product_id, m.woo_variation_id, m.last_pushed_stock,
                  coalesce((SELECT greatest(0, floor(b.on_hand - b.reserved))::int FROM stock_balances b
                             WHERE b.variant_id = m.variant_id AND b.location_id = $2), 0) AS avail
             FROM woo_variant_map m WHERE m.variant_id = ANY($1)`, [variants, c.conn.onlineLocationId]);
        // Outbox rows this run covers. Rows added while we push stay for the next run.
        const covered = ids.filter((r) => variants.includes(r.ref_id)).map((r) => r.id);
        return { ...c, rows, covered, more: ids.length > covered.length || new Set(ids.map((r) => r.ref_id)).size > BATCH };
      });
      if (!work) return;
      const changed = work.rows.filter((r) => r.last_pushed_stock !== r.avail);
      try {
        const simple = changed.filter((r) => Number(r.woo_variation_id) === 0);
        const byParent = new Map<number, typeof changed>();
        for (const r of changed.filter((x) => Number(x.woo_variation_id) !== 0)) {
          const k = Number(r.woo_product_id);
          byParent.set(k, [...(byParent.get(k) ?? []), r]);
        }
        const failures: string[] = [];
        const check = (res: any) => (res.update ?? []).forEach((u: any) => { if (u.error) failures.push(`#${u.id}: ${u.error.message}`); });
        if (simple.length) check(await work.client.post('/products/batch', { update: simple.map((r) => ({ id: Number(r.woo_product_id), manage_stock: true, stock_quantity: r.avail })) }, 30_000));
        for (const [parent, rs] of byParent)
          check(await work.client.post(`/products/${parent}/variations/batch`, { update: rs.map((r) => ({ id: Number(r.woo_variation_id), manage_stock: true, stock_quantity: r.avail })) }, 30_000));
        await tenantTx(tenantId, async (tx) => {
          if (changed.length)
            await tx.query(
              `UPDATE woo_variant_map m SET last_pushed_stock = u.s, last_pushed_at = now() FROM unnest($1::uuid[], $2::int[]) AS u(v, s) WHERE m.variant_id = u.v`,
              [changed.map((r) => r.variant_id), changed.map((r) => r.avail)]);
          await tx.query('DELETE FROM woo_outbox WHERE id = ANY($1)', [work.covered]);
        });
        await noteResult(tenantId, null);
        // A product deleted in Woo answers "invalid id" per item; the reconcile run relinks or reports it. Everything else went through.
        if (failures.length) throw new PermanentJobError(`WooCommerce refused some stock updates: ${failures.join('; ').slice(0, 400)}`);
      } catch (e) {
        if (e instanceof PermanentJobError) throw e;
        await noteResult(tenantId, e);
        if (e instanceof WooError && e.kind !== 'retry') throw new PermanentJobError(e.message);
        throw e;
      }
      if (!work.more) return;
    }
  });
}
