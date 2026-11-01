import type { Tx } from '../../db.js';
import { tenantTx } from '../../db.js';
import { withJobLock } from '../../jobs/lock.js';
import { PermanentJobError } from '../../jobs/runner.js';
import { appError, audit } from '../../lib/phase1.js';
import { WooError } from './client.js';
import { clientFor, noteResult } from './connection.js';

// woo.match (J9 "initial product match by SKU"): read every product in the shop and compare SKUs with the ERP.
// Nothing changes in either system until the owner confirms. Confirming ticks "Sell online" on the matched ERP products;
// their publish jobs then adopt the Woo products by SKU and overwrite price and stock with the ERP's (decision 6).

const LIST_CAP = 500;

interface WooItem { wooProductId: number; wooVariationId: number; sku: string; name: string; price: string; stock: number | null }

export async function runMatch(tenantId: string) {
  await withJobLock(`woo.match:${tenantId}`, async () => {
    const c = await tenantTx(tenantId, async (tx) => {
      // Once confirmed, a new comparison is information only: it must not pause product sync by leaving 'confirmed'.
      await tx.query("UPDATE woo_connections SET match_state = CASE WHEN match_state = 'confirmed' THEN 'confirmed' ELSE 'running' END");
      return clientFor(tx);
    });
    if (!c) return;
    try {
      const woo: WooItem[] = [];
      const products = await c.client.all<any>('/products', { status: 'any', _fields: 'id,name,type,sku,regular_price,stock_quantity' }, 100);
      for (const p of products) {
        if (p.type === 'variable') {
          for (const v of await c.client.all<any>(`/products/${p.id}/variations`, { status: 'any', _fields: 'id,sku,regular_price,stock_quantity' }, 5))
            woo.push({ wooProductId: p.id, wooVariationId: v.id, sku: v.sku ?? '', name: p.name, price: v.regular_price ?? '', stock: v.stock_quantity });
        } else if (p.type === 'simple') {
          woo.push({ wooProductId: p.id, wooVariationId: 0, sku: p.sku ?? '', name: p.name, price: p.regular_price ?? '', stock: p.stock_quantity });
        }
      }
      await tenantTx(tenantId, (tx) => saveResult(tx, woo, c.conn.onlineLocationId));
      await noteResult(tenantId, null);
    } catch (e) {
      await noteResult(tenantId, e);
      await tenantTx(tenantId, (tx) => tx.query(
        `UPDATE woo_connections SET match_state = CASE WHEN match_state = 'confirmed' THEN 'confirmed' ELSE 'failed' END,
           match_result = CASE WHEN match_state = 'confirmed' THEN match_result || $1::jsonb ELSE $1::jsonb END`, [JSON.stringify({ error: (e as Error).message })]));
      if (e instanceof WooError && e.kind !== 'retry') throw new PermanentJobError(e.message);
      throw e;
    }
  });
}

async function saveResult(tx: Tx, woo: WooItem[], locationId: string) {
  const { rows: erp } = await tx.query(
    `SELECT v.id, v.sku, v.price, p.id AS product_id, p.name, p.type,
            coalesce((SELECT greatest(0, floor(b.on_hand - b.reserved))::int FROM stock_balances b WHERE b.variant_id = v.id AND b.location_id = $1), 0) AS avail
       FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.status = 'active' AND p.status <> 'archived' ORDER BY p.name, v.position`, [locationId]);
  const erpBySku = new Map(erp.map((e) => [String(e.sku).toLowerCase(), e]));
  const matched: unknown[] = [], wooOnly: unknown[] = [];
  const seen = new Set<string>();
  let withDifferences = 0;
  for (const w of woo) {
    const e = w.sku ? erpBySku.get(w.sku.toLowerCase()) : undefined;
    if (!e) { wooOnly.push({ wooProductId: w.wooProductId, sku: w.sku, name: w.name }); continue; }
    seen.add(e.id);
    const typeOk = (e.type === 'simple') === (w.wooVariationId === 0);
    const diff = {
      price: Number(w.price || 0) !== Number(e.price),
      stock: w.stock !== e.avail,
      name: e.type === 'simple' && w.name.trim().toLowerCase() !== String(e.name).trim().toLowerCase(),
    };
    if (diff.price || diff.stock || diff.name || !typeOk) withDifferences++;
    matched.push({
      sku: e.sku, productId: e.product_id, variantId: e.id, name: e.name, wooName: w.name, price: String(Number(e.price).toFixed(2)),
      wooPrice: w.price, stock: e.avail, wooStock: w.stock, wooProductId: w.wooProductId, wooVariationId: w.wooVariationId,
      differences: Object.entries(diff).filter(([, v]) => v).map(([k]) => k),
      problem: typeOk ? null : (e.type === 'simple' ? 'Simple in the ERP, a variation in WooCommerce' : 'A variant in the ERP, a simple product in WooCommerce'),
    });
  }
  const erpOnly = erp.filter((e) => !seen.has(e.id)).map((e) => ({ sku: e.sku, name: e.name, productId: e.product_id }));
  const summary = { matched: matched.length, withDifferences, erpOnly: erpOnly.length, wooOnly: wooOnly.length, checkedAt: new Date() };
  await tx.query("UPDATE woo_connections SET match_state = CASE WHEN match_state = 'confirmed' THEN 'confirmed' ELSE 'ready' END, match_result = $1", [JSON.stringify({
    summary, matched: matched.slice(0, LIST_CAP), erpOnly: erpOnly.slice(0, LIST_CAP), wooOnly: wooOnly.slice(0, LIST_CAP),
  })]);
}

/** The owner has looked at the differences: put the matched products under ERP control. */
export async function confirmMatch(tx: Tx, userId: string) {
  const { rows: [c] } = await tx.query("SELECT id, match_state, match_result FROM woo_connections WHERE status <> 'disconnected' FOR UPDATE");
  if (!c) throw appError(404, 'NOT_CONNECTED', 'WooCommerce is not connected');
  if (c.match_state !== 'ready') throw appError(409, 'INVALID_STATE', 'There is no product match waiting to be confirmed');
  const ok = (c.match_result.matched as { productId: string; problem: string | null }[]);
  const blocked = new Set(ok.filter((m) => m.problem).map((m) => m.productId));
  const ids = [...new Set(ok.map((m) => m.productId))].filter((id) => !blocked.has(id));
  // The trigger on products queues a publish job for each one.
  const { rowCount } = await tx.query("UPDATE products SET publish_to_web = true, publish_state = 'queued', publish_error = NULL WHERE id = ANY($1) AND NOT publish_to_web", [ids]);
  await tx.query("UPDATE products SET publish_state = 'queued' WHERE id = ANY($1) AND publish_to_web", [ids]);
  // Plus everything already ticked "Sell online" before the shop was connected.
  await tx.query(
    `INSERT INTO woo_outbox (tenant_id, kind, ref_id)
     SELECT current_setting('app.tenant_id')::uuid, 'product', p.id FROM products p WHERE p.publish_to_web AND p.status = 'active' AND NOT (p.id = ANY($1))`, [[...blocked]]);
  await tx.query("UPDATE products SET publish_state = 'queued', publish_error = NULL WHERE publish_to_web AND status = 'active' AND NOT (id = ANY($1))", [[...blocked]]);
  await tx.query("UPDATE woo_connections SET match_state = 'confirmed'");
  await audit(tx, { actorId: userId, action: 'woo.match_confirmed', entityType: 'woo_connection', entityId: c.id,
    summary: { products: ids.length, newlyOnline: rowCount, skippedTypeMismatch: blocked.size } });
  return { products: ids.length, skipped: blocked.size };
}
