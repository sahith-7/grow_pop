import { createHash, randomBytes } from 'node:crypto';
import { tenantTx, type Tx } from '../../db.js';
import { withLockWait } from '../../jobs/lock.js';
import { enqueue } from '../../jobs/queue.js';
import { appError, audit } from '../../lib/phase1.js';
import { open, seal } from '../../lib/secret-box.js';
import { listLocations } from '../inventory/service.js';
import { WooClient, WooError } from './client.js';
import { wooEnv } from './env.js';
import { checkShopUrl, NetError, type NetProblem } from './http.js';

// TEN-04/05 and J9: test, connect, disconnect. Credentials are sealed at rest (T4) and never leave this module
// except inside a WooClient. The API returns only a key hint.

export const TOPICS = ['order.created', 'order.updated', 'order.deleted', 'order.restored', 'product.deleted'] as const;

export interface ConnectInput { siteUrl: string; consumerKey: string; consumerSecret: string }
type Problem = NetProblem | 'unauthorized' | 'not_woocommerce' | 'permissions' | 'currency';

export interface TestResult {
  ok: boolean; problem?: Problem; message?: string;
  wooVersion?: string; currency?: string; canManageWebhooks?: boolean; pricesIncludeTax?: boolean;
  weightUnit?: string; dimensionUnit?: string; siteUrl?: string;
}

export const tokenHash = (token: string) => createHash('sha256').update(token).digest();
export const keyHint = (ck: string) => `ck_…${ck.slice(-4)}`;
const webhookUrl = (token: string) => `${wooEnv.WOO_WEBHOOK_BASE_URL!.replace(/\/+$/, '')}/v1/webhooks/woocommerce/${token}`;

const PROBLEM_TEXT: Record<string, string> = {
  unauthorized: 'WooCommerce refused the key. Check the consumer key and secret. If they are right, your host may be removing the Authorization header; ask them to pass it through to WordPress.',
  permissions: 'This key is read-only. Create a key with Read/Write permission in WooCommerce → Settings → Advanced → REST API.',
  not_woocommerce: 'WooCommerce was not found at this address. Check the address, and that WooCommerce is active and permalinks are not set to “Plain”.',
};

/** TEN-05: everything the connection needs, checked without saving anything. */
export async function testConnection(input: ConnectInput): Promise<TestResult> {
  let url: URL;
  try { url = checkShopUrl(input.siteUrl); } catch (e) { return { ok: false, problem: 'bad_url', message: (e as Error).message }; }
  const client = new WooClient({ siteUrl: url.toString(), consumerKey: input.consumerKey, consumerSecret: input.consumerSecret });
  try {
    const status = await client.get('/system_status', { _fields: 'environment,settings' });
    const env = status?.environment ?? {}, settings = status?.settings ?? {};
    if (!env.version) return { ok: false, problem: 'not_woocommerce', message: PROBLEM_TEXT.not_woocommerce };
    // A read-only key passes every GET; Woo refuses any write with it before looking at the body. An empty batch writes nothing.
    await client.post('/webhooks/batch', {});
    const [weight, dims, inclTax] = await Promise.all([
      client.get('/settings/products/woocommerce_weight_unit').then((s) => s.value as string).catch(() => 'kg'),
      client.get('/settings/products/woocommerce_dimension_unit').then((s) => s.value as string).catch(() => 'cm'),
      client.get('/settings/tax/woocommerce_prices_include_tax').then((s) => s.value === 'yes').catch(() => undefined),
    ]);
    const result: TestResult = {
      ok: true, siteUrl: url.toString(), wooVersion: String(env.version), currency: String(settings.currency ?? ''), canManageWebhooks: true,
      weightUnit: weight, dimensionUnit: dims, pricesIncludeTax: inclTax,
    };
    if (result.currency && result.currency !== 'INR')
      return { ...result, ok: false, problem: 'currency', message: `The shop sells in ${result.currency}. The ERP keeps prices in INR, so it can only connect to an INR shop.` };
    return result;
  } catch (e) {
    if (e instanceof WooError) {
      if (e.kind === 'not_woocommerce') return { ok: false, problem: 'not_woocommerce', message: PROBLEM_TEXT.not_woocommerce };
      if (e.kind === 'auth') {
        const readOnly = /write/i.test(e.message);
        return { ok: false, problem: readOnly ? 'permissions' : 'unauthorized', message: PROBLEM_TEXT[readOnly ? 'permissions' : 'unauthorized'] };
      }
      return { ok: false, problem: 'unreachable', message: e.message };
    }
    if (e instanceof NetError) return { ok: false, problem: e.problem, message: e.message };
    throw e;
  }
}

// ------------------------------------------------------------------ reading the connection

export interface Conn {
  id: string; tenantId: string; siteUrl: string; status: string; onlineLocationId: string; webhookIds: Record<string, number>;
  weightUnit: string | null; dimensionUnit: string | null; connectedBy: string; ordersSyncedTo: Date | null;
}

const connOut = (r: Record<string, any>): Conn => ({
  id: r.id, tenantId: r.tenant_id, siteUrl: r.site_url, status: r.status, onlineLocationId: r.online_location_id,
  webhookIds: r.webhook_ids ?? {}, weightUnit: r.weight_unit, dimensionUnit: r.dimension_unit, connectedBy: r.connected_by,
  ordersSyncedTo: r.orders_synced_to,
});

export async function getConn(tx: Tx): Promise<Conn | null> {
  const { rows: [r] } = await tx.query('SELECT * FROM woo_connections');
  return r ? connOut(r) : null;
}

/** The connection and a client for it, or null when not connected. Decrypts inside the caller's tenant only. */
export async function clientFor(tx: Tx): Promise<{ conn: Conn; client: WooClient } | null> {
  const { rows: [r] } = await tx.query("SELECT * FROM woo_connections WHERE status <> 'disconnected'");
  if (!r) return null;
  const client = new WooClient({
    siteUrl: r.site_url, consumerKey: open(r.key_enc, r.tenant_id, 'woo.key'), consumerSecret: open(r.secret_enc, r.tenant_id, 'woo.secret'),
  });
  return { conn: connOut(r), client };
}

export async function webhookSecret(tx: Tx): Promise<string | null> {
  const { rows: [r] } = await tx.query("SELECT tenant_id, webhook_secret_enc FROM woo_connections WHERE status <> 'disconnected'");
  return r ? open(r.webhook_secret_enc, r.tenant_id, 'woo.webhook_secret') : null;
}

/** Record that a call to the shop worked, or why it did not. A revoked key turns the connection to 'error' for the owner to fix. */
export async function noteResult(tenantId: string, error: unknown) {
  await tenantTx(tenantId, async (tx) => {
    if (!error) {
      await tx.query("UPDATE woo_connections SET last_success_at = now(), status = CASE WHEN status = 'error' THEN 'connected' ELSE status END WHERE status <> 'disconnected'");
      return;
    }
    const auth = error instanceof WooError && error.kind === 'auth';
    await tx.query(
      `UPDATE woo_connections SET last_error = $1, last_error_at = now(), status = CASE WHEN $2 THEN 'error' ELSE status END
        WHERE status <> 'disconnected'`,
      [String((error as Error).message ?? error).slice(0, 500), auth]);
  });
}

// ------------------------------------------------------------------ connect / disconnect

// Connect, disconnect and the 15-minute check-up all replace webhooks and the URL token, so they take turns on one lock.
// Without it a check-up starting mid-connect sees no webhooks yet, makes its own set, and leaves half of ours orphaned.
export const shopLockKey = (tenantId: string) => `woo.shop:${tenantId}`;
const busy = () => appError(409, 'SYNC_BUSY', 'The ERP is busy with the shop right now. Try again in a minute.');
export const connect = (tenantId: string, userId: string, input: ConnectInput) =>
  withLockWait(shopLockKey(tenantId), () => connectLocked(tenantId, userId, input), busy);
export const disconnect = (tenantId: string, userId: string) =>
  withLockWait(shopLockKey(tenantId), () => disconnectLocked(tenantId, userId), busy);

// Marks the webhooks this store on this server created, so cleaning up never touches the webhooks of another server
// (a staging copy of the ERP) or of another store connected to the same shop. It identifies; it doesn't authorise.
const hookTag = (tenantId: string) => createHash('sha256').update(`${wooEnv.WOO_WEBHOOK_BASE_URL ?? ''}|${tenantId}`).digest('hex').slice(0, 8);
export const hookName = (topic: string, tenantId: string, app: string = wooEnv.APP_NAME) => `${app} · ${topic} · ${hookTag(tenantId)}`;
// Webhooks made under an earlier product name carry that default name; cleanup still recognises them.
const LEGACY_APP_NAMES = ['Tarazu ERP', 'TRIDENT ERP'];

export async function removeOurWebhooks(client: WooClient, known: Record<string, number>, tenantId: string) {
  const ids = new Set(Object.values(known).filter(Boolean));
  // Also clear our leftovers from an earlier connection that never got saved (crash between create and save).
  try {
    const hooks = await client.all<{ id: number; name: string }>('/webhooks', { _fields: 'id,name' }, 5);
    const ours = new Set(TOPICS.flatMap((t) => [wooEnv.APP_NAME, ...LEGACY_APP_NAMES].map((a) => hookName(t, tenantId, a))));
    for (const h of hooks) if (ours.has(h.name)) ids.add(h.id);
  } catch { /* best effort */ }
  for (const id of ids) await client.del(`/webhooks/${id}`, { force: true }).catch(() => {});
}

export async function createWebhooks(client: WooClient, token: string, secret: string, tenantId: string) {
  const out: Record<string, number> = {};
  for (const topic of TOPICS) {
    const h = await client.post('/webhooks', { name: hookName(topic, tenantId), topic, delivery_url: webhookUrl(token), secret, status: 'active' });
    out[topic] = h.id;
  }
  return out;
}

/** PUT /integrations/woocommerce: connect, or replace the key. Calls the shop outside any transaction. */
async function connectLocked(tenantId: string, userId: string, input: ConnectInput) {
  if (!wooEnv.WOO_WEBHOOK_BASE_URL) throw appError(503, 'WEBHOOK_URL_NOT_CONFIGURED', 'WOO_WEBHOOK_BASE_URL is not set on this server, so WooCommerce cannot send orders to it');
  const test = await testConnection(input);
  if (!test.ok) throw appError(422, 'WOO_CONNECTION_FAILED', test.message ?? 'Could not connect', { siteUrl: [test.message ?? 'Could not connect'] });

  const token = randomBytes(32).toString('base64url');          // 43 characters (D17)
  const secret = randomBytes(30).toString('base64url');
  const client = new WooClient({ siteUrl: test.siteUrl!, consumerKey: input.consumerKey, consumerSecret: input.consumerSecret });

  // 1. Save first, so the webhook URL already works when Woo first calls it.
  const prev = await tenantTx(tenantId, async (tx) => {
    const old = await getConn(tx);
    const locs = await listLocations(tx);
    const online = old?.onlineLocationId ?? locs.find((l) => l.type === 'shop_floor' && l.active)?.id ?? locs[0]?.id;
    const sameShop = old && sameSite(old.siteUrl, test.siteUrl!);
    if (old && !sameShop) await forgetShop(tx);
    await tx.query(
      `INSERT INTO woo_connections (tenant_id, site_url, key_hint, key_enc, secret_enc, webhook_secret_enc, endpoint_token_hash, status, woo_version,
         currency, weight_unit, dimension_unit, prices_include_tax, online_location_id, connected_by, last_success_at, last_error, reconcile_due_at)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, 'connected', $7, $8, $9, $10, $11, $12, $13, now(), NULL, now())
       ON CONFLICT (tenant_id) DO UPDATE SET site_url = EXCLUDED.site_url, key_hint = EXCLUDED.key_hint, key_enc = EXCLUDED.key_enc,
         secret_enc = EXCLUDED.secret_enc, webhook_secret_enc = EXCLUDED.webhook_secret_enc, endpoint_token_hash = EXCLUDED.endpoint_token_hash,
         status = 'connected', woo_version = EXCLUDED.woo_version, currency = EXCLUDED.currency, weight_unit = EXCLUDED.weight_unit,
         dimension_unit = EXCLUDED.dimension_unit, prices_include_tax = EXCLUDED.prices_include_tax, connected_by = EXCLUDED.connected_by,
         connected_at = now(), last_success_at = now(), last_error = NULL, webhook_ids = '{}', reconcile_due_at = now(),
         orders_synced_to = CASE WHEN $14 THEN woo_connections.orders_synced_to END,
         match_state = CASE WHEN $14 THEN woo_connections.match_state ELSE 'not_started' END,
         match_result = CASE WHEN $14 THEN woo_connections.match_result END,
         updated_at = now()`,
      [test.siteUrl, keyHint(input.consumerKey), seal(input.consumerKey, tenantId, 'woo.key'), seal(input.consumerSecret, tenantId, 'woo.secret'),
        seal(secret, tenantId, 'woo.webhook_secret'), tokenHash(token), test.wooVersion, test.currency, test.weightUnit, test.dimensionUnit,
        test.pricesIncludeTax ?? null, online, userId, !!sameShop]);
    return old;
  });

  // 2. Replace our webhooks in the shop.
  let ids: Record<string, number>;
  try {
    if (prev && sameSite(prev.siteUrl, test.siteUrl!)) await removeOurWebhooks(client, prev.webhookIds, tenantId);
    else await removeOurWebhooks(client, {}, tenantId);
    ids = await createWebhooks(client, token, secret, tenantId);
  } catch (e) {
    await tenantTx(tenantId, (tx) => tx.query("UPDATE woo_connections SET status = 'error', last_error = $1, last_error_at = now()", [`Could not create webhooks: ${(e as Error).message}`.slice(0, 500)]));
    throw appError(502, 'WOO_WEBHOOKS_FAILED', `Connected, but WooCommerce would not create the order webhooks: ${(e as Error).message}`);
  }

  // 3. Record them, then import open orders and start the SKU match.
  return tenantTx(tenantId, async (tx) => {
    const { rows: [c] } = await tx.query("UPDATE woo_connections SET webhook_ids = $1, webhooks_ok = true RETURNING id", [JSON.stringify(ids)]);
    await enqueue(tx, 'woo.reconcile', c.id);
    await enqueue(tx, 'woo.match', c.id);
    await audit(tx, { actorId: userId, action: prev ? 'woo.credentials_replaced' : 'woo.connected', entityType: 'woo_connection', entityId: c.id,
      summary: { siteUrl: test.siteUrl, keyHint: keyHint(input.consumerKey), wooVersion: test.wooVersion, previousSite: prev && !sameSite(prev.siteUrl, test.siteUrl!) ? prev.siteUrl : undefined } });
    return status(tx);
  });
}

const sameSite = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

/** A different shop: its ids mean nothing here. Products are matched again by SKU. */
async function forgetShop(tx: Tx) {
  await tx.query('DELETE FROM woo_variant_map');
  await tx.query('DELETE FROM woo_product_map');
  await tx.query('DELETE FROM woo_category_map');
  await tx.query("UPDATE product_images SET woo_media_id = NULL, woo_file_id = NULL, sync_state = 'pending' WHERE woo_media_id IS NOT NULL");
  await tx.query("UPDATE products SET publish_state = CASE WHEN publish_to_web THEN 'queued' ELSE 'not_published' END, publish_error = NULL WHERE publish_state <> 'not_published'");
}

/** DELETE /integrations/woocommerce: remove our webhooks from the shop, wipe the secrets. Mappings stay for a reconnect. */
async function disconnectLocked(tenantId: string, userId: string) {
  const found = await tenantTx(tenantId, async (tx) => {
    const c = await clientFor(tx).catch(() => null);
    return c;
  });
  if (found) await removeOurWebhooks(found.client, found.conn.webhookIds, tenantId).catch(() => {});
  await tenantTx(tenantId, async (tx) => {
    const { rows: [c] } = await tx.query(
      `UPDATE woo_connections SET status = 'disconnected', key_enc = NULL, secret_enc = NULL, webhook_secret_enc = NULL, endpoint_token_hash = NULL,
         webhook_ids = '{}', webhooks_ok = NULL, updated_at = now() WHERE status <> 'disconnected' RETURNING id, site_url`);
    if (!c) throw appError(404, 'NOT_CONNECTED', 'WooCommerce is not connected');
    await tx.query('DELETE FROM woo_outbox');
    await tx.query("UPDATE sync_jobs SET status = 'failed', last_error = 'WooCommerce was disconnected', locked_by = NULL WHERE kind LIKE 'woo.%' AND kind <> 'woo.inbound' AND status = 'pending'");
    await audit(tx, { actorId: userId, action: 'woo.disconnected', entityType: 'woo_connection', entityId: c.id, summary: { siteUrl: c.site_url } });
  });
}

export async function setOnlineLocation(tx: Tx, userId: string, locationId: string) {
  const { rows: [l] } = await tx.query('SELECT id, name, active, is_sellable FROM locations WHERE id = $1', [locationId]);
  if (!l) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { onlineLocationId: ['Location not found'] });
  if (!l.active || !l.is_sellable) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { onlineLocationId: ['Pick an active location that holds sellable stock'] });
  const { rows: [c] } = await tx.query(
    "UPDATE woo_connections SET online_location_id = $1, updated_at = now() WHERE status <> 'disconnected' RETURNING id, (SELECT online_location_id FROM woo_connections) AS old", [locationId]);
  if (!c) throw appError(404, 'NOT_CONNECTED', 'WooCommerce is not connected');
  // Every website product now shows this location's stock.
  await tx.query(`INSERT INTO woo_outbox (tenant_id, kind, ref_id) SELECT tenant_id, 'stock', variant_id FROM woo_variant_map`);
  await audit(tx, { actorId: userId, action: 'woo.online_location_changed', entityType: 'woo_connection', entityId: c.id, summary: { from: c.old, to: locationId, name: l.name } });
}

// ------------------------------------------------------------------ status (GET /integrations/woocommerce)

export async function status(tx: Tx) {
  const { rows: [r] } = await tx.query(
    `SELECT c.*, l.name AS location_name FROM woo_connections c JOIN locations l ON l.id = c.online_location_id`);
  const { rows: [j] } = await tx.query(
    `SELECT count(*) FILTER (WHERE status IN ('pending', 'running'))::int + (SELECT count(*)::int FROM woo_outbox) AS pending,
            count(*) FILTER (WHERE status IN ('failed', 'dead'))::int AS failed,
            coalesce(extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'pending'))::int, 0) AS oldest
       FROM sync_jobs WHERE kind LIKE 'woo.%' AND (status <> 'done')`);
  const { rows: [o] } = await tx.query(
    `SELECT count(*) FILTER (WHERE status = 'stock_exception')::int AS exceptions, count(*) FILTER (WHERE status = 'needs_review')::int AS review
       FROM sales_orders WHERE channel = 'woocommerce'`);
  if (!r) return { status: 'not_connected' as const, pending: j.pending, failed: j.failed, oldestPendingAgeSec: j.oldest };
  return {
    status: r.status as 'connected' | 'error' | 'disconnected',
    siteUrl: r.site_url as string, keyHint: r.key_hint as string, wooVersion: r.woo_version as string | null,
    currency: r.currency as string | null, pricesIncludeTax: r.prices_include_tax as boolean | null,
    onlineLocation: { id: r.online_location_id as string, name: r.location_name as string },
    connectedAt: r.connected_at as Date, lastSuccessAt: r.last_success_at as Date | null,
    lastError: r.last_error as string | null, lastErrorAt: r.last_error_at as Date | null,
    webhooksHealthy: r.status === 'disconnected' ? false : r.webhooks_ok !== false,
    ordersSyncedTo: r.orders_synced_to as Date | null,
    match: { state: r.match_state as string, summary: r.match_result?.summary ?? null },
    pending: j.pending as number, failed: j.failed as number, oldestPendingAgeSec: j.oldest as number,
    orderExceptions: o.exceptions as number, ordersNeedingReview: o.review as number,
  };
}
