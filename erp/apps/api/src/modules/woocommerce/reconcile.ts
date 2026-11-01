import { randomBytes } from 'node:crypto';
import { tenantTx } from '../../db.js';
import { withJobLock } from '../../jobs/lock.js';
import { PermanentJobError, RetryLaterError } from '../../jobs/runner.js';
import { seal } from '../../lib/secret-box.js';
import { applyWooOrder, settleStock, type WooOrder } from '../sales/woo-orders.js';
import { WooClient, WooError } from './client.js';
import { clientFor, createWebhooks, noteResult, removeOurWebhooks, shopLockKey, tokenHash, TOPICS } from './connection.js';

// woo.reconcile (J10, AC-11/12): the safety net under webhooks. Runs on connect, every 15 minutes, and on "Reconcile now".
//   1. Webhooks: Woo disables one after repeated failed deliveries; reactivate it, or replace the set if one is gone.
//   2. Orders: pull everything modified since the last run (10 minutes of overlap), through the same path as webhooks.
//      The first run after connecting imports only open orders (Processing, On hold): no history (D5 = 0 days).
//   3. Orders stuck on a stock exception: try to reserve again (stock may have arrived).
//   4. Stock: compare Woo's stock with what the ERP says is available; queue a push for every difference.
//   5. Housekeeping: webhook payloads older than 90 days are emptied (T12).

export const RECONCILE_EVERY_MIN = 15;
const OVERLAP_MS = 10 * 60_000;

export async function reconcile(tenantId: string) {
  await withJobLock(shopLockKey(tenantId), async () => {
    const c = await tenantTx(tenantId, async (tx) => {
      const { rows: [t] } = await tx.query('SELECT status FROM tenants');
      if (t?.status === 'suspended') throw new RetryLaterError(3600, 'store suspended');
      return clientFor(tx);
    });
    if (!c) return;
    const startedAt = new Date();
    const report: Record<string, unknown> = { startedAt };
    try {
      report.webhooks = await checkWebhooks(tenantId, c.client, c.conn.webhookIds);
      report.orders = await pullOrders(tenantId, c.client, c.conn.onlineLocationId, c.conn.ordersSyncedTo, startedAt);
      report.exceptionsRetried = await retryExceptions(tenantId, c.conn.onlineLocationId);
      report.stockDifferences = await compareStock(tenantId, c.client, c.conn.onlineLocationId);
      await noteResult(tenantId, null);
    } catch (e) {
      await noteResult(tenantId, e);
      report.error = (e as Error).message;
      await save(tenantId, report);
      if (e instanceof WooError && e.kind !== 'retry') throw new PermanentJobError(e.message);
      throw e;
    }
    report.finishedAt = new Date();
    await save(tenantId, report);
  });
}

async function save(tenantId: string, report: Record<string, unknown>) {
  await tenantTx(tenantId, async (tx) => {
    await tx.query('UPDATE woo_connections SET last_reconcile = $1', [JSON.stringify(report)]);
    await tx.query("UPDATE webhook_events SET payload = NULL WHERE payload IS NOT NULL AND received_at < now() - interval '90 days'");
  });
}

async function checkWebhooks(tenantId: string, client: WooClient, known: Record<string, number>) {
  const hooks = await client.all<{ id: number; status: string; topic: string }>('/webhooks', { _fields: 'id,status,topic' }, 5);
  const byId = new Map(hooks.map((h) => [h.id, h]));
  const missing = TOPICS.filter((t) => !known[t] || !byId.has(known[t]));
  let reactivated = 0;
  if (missing.length) {
    // We only keep a hash of the URL token, so a lost webhook means a fresh token and secret for the whole set.
    const token = randomBytes(32).toString('base64url');
    const secret = randomBytes(30).toString('base64url');
    await tenantTx(tenantId, (tx) => tx.query(
      "UPDATE woo_connections SET endpoint_token_hash = $1, webhook_secret_enc = $2 WHERE status <> 'disconnected'",
      [tokenHash(token), seal(secret, tenantId, 'woo.webhook_secret')]));
    await removeOurWebhooks(client, known, tenantId);
    const ids = await createWebhooks(client, token, secret, tenantId);
    await tenantTx(tenantId, (tx) => tx.query('UPDATE woo_connections SET webhook_ids = $1, webhooks_ok = true', [JSON.stringify(ids)]));
    return { recreated: missing };
  }
  for (const t of TOPICS) {
    const h = byId.get(known[t])!;
    if (h.status !== 'active') { await client.put(`/webhooks/${h.id}`, { status: 'active' }); reactivated++; }
  }
  await tenantTx(tenantId, (tx) => tx.query('UPDATE woo_connections SET webhooks_ok = true'));
  return { reactivated };
}

async function pullOrders(tenantId: string, client: WooClient, locationId: string, since: Date | null, startedAt: Date) {
  const query = since
    ? { modified_after: new Date(since.getTime() - OVERLAP_MS).toISOString().slice(0, 19), dates_are_gmt: true, orderby: 'modified', order: 'asc' }
    : { status: 'processing,on-hold', orderby: 'date', order: 'asc' };
  const orders = await client.all<WooOrder>('/orders', query, 20);
  let applied = 0, stale = 0;
  for (const o of orders) {
    const r = await tenantTx(tenantId, (tx) => applyWooOrder(tx, locationId, o));
    if (r.outcome === 'applied') applied++; else if (r.outcome === 'stale') stale++;
  }
  // Pages are capped; if there was more, the next run carries on from the last order we saw.
  const last = orders.length ? orders[orders.length - 1].date_modified_gmt : null;
  const syncedTo = orders.length >= 2000 && last ? new Date(`${last}Z`) : startedAt;
  await tenantTx(tenantId, (tx) => tx.query('UPDATE woo_connections SET orders_synced_to = $1', [syncedTo]));
  return { fetched: orders.length, applied, unchanged: stale, firstImport: !since };
}

async function retryExceptions(tenantId: string, locationId: string) {
  const ids = await tenantTx(tenantId, (tx) => tx.query("SELECT id FROM sales_orders WHERE channel = 'woocommerce' AND status = 'stock_exception' ORDER BY placed_at LIMIT 200"));
  let reserved = 0;
  for (const { id } of ids.rows) {
    const now = await tenantTx(tenantId, async (tx) => {
      const { rows: [o] } = await tx.query('SELECT external_id, woo_status, status FROM sales_orders WHERE id = $1', [id]);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7))', [`woo-order:${o.external_id}`]);
      await settleStock(tx, id, locationId, o.woo_status, o.status);
      return (await tx.query('SELECT status FROM sales_orders WHERE id = $1', [id])).rows[0].status;
    });
    if (now !== 'stock_exception') reserved++;
  }
  return { checked: ids.rows.length, nowReserved: reserved };
}

async function compareStock(tenantId: string, client: WooClient, locationId: string) {
  const maps = await tenantTx(tenantId, (tx) => tx.query(
    `SELECT m.variant_id, m.woo_product_id, m.woo_variation_id,
            coalesce((SELECT greatest(0, floor(b.on_hand - b.reserved))::int FROM stock_balances b
                       WHERE b.variant_id = m.variant_id AND b.location_id = $1), 0) AS avail
       FROM woo_variant_map m`, [locationId]));
  const woo = new Map<string, number | null>();
  const simple = maps.rows.filter((r) => Number(r.woo_variation_id) === 0);
  for (let i = 0; i < simple.length; i += 100) {
    const ids = simple.slice(i, i + 100).map((r) => r.woo_product_id).join(',');
    for (const p of await client.get<{ id: number; stock_quantity: number | null }[]>('/products', { include: ids, per_page: 100, status: 'any', _fields: 'id,stock_quantity' }))
      woo.set(`${p.id}:0`, p.stock_quantity);
  }
  const parents = [...new Set(maps.rows.filter((r) => Number(r.woo_variation_id) !== 0).map((r) => String(r.woo_product_id)))];
  for (const parent of parents) {
    try {
      for (const v of await client.all<{ id: number; stock_quantity: number | null }>(`/products/${parent}/variations`, { _fields: 'id,stock_quantity', status: 'any' }, 5))
        woo.set(`${parent}:${v.id}`, v.stock_quantity);
    } catch (e) { if (!(e instanceof WooError && e.kind === 'not_found')) throw e; }
  }
  const differ = maps.rows.filter((r) => woo.get(`${r.woo_product_id}:${r.woo_variation_id}`) !== r.avail);
  const missing = maps.rows.filter((r) => !woo.has(`${r.woo_product_id}:${r.woo_variation_id}`));
  if (differ.length) {
    await tenantTx(tenantId, async (tx) => {
      await tx.query('UPDATE woo_variant_map SET last_pushed_stock = NULL WHERE variant_id = ANY($1)', [differ.map((r) => r.variant_id)]);
      await tx.query(
        "INSERT INTO woo_outbox (tenant_id, kind, ref_id) SELECT current_setting('app.tenant_id')::uuid, 'stock', v FROM unnest($1::uuid[]) AS v",
        [differ.filter((r) => woo.has(`${r.woo_product_id}:${r.woo_variation_id}`)).map((r) => r.variant_id)]);
    });
  }
  return { checked: maps.rows.length, corrected: differ.length - missing.length, missingInWoo: missing.length };
}
