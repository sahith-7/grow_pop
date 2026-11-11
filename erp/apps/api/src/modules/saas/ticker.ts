import { ALL_OUTLETS } from '../outlets/scope.js';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { pool, tenantTx, type Tx } from '../../db.js';
import { sendMail } from '../../lib/notify.js';
import { saasEnv } from '../../lib/saas-env.js';
import { purgeExpiredExports } from '../account/export-job.js';
import { REPORTS } from '../reports/definitions.js';
import { wooEnv } from '../woocommerce/env.js';

// The worker's SaaS tick (B7), every 10 minutes:
//   1. move stores along trial → past due → suspended (saas_lifecycle_tick, in the database) and tell their owners;
//   2. remind owners 7 days and 1 day before a trial or paid period ends;
//   3. e-mail store alerts (B6 item 5, D73): low-stock digest once a day after 8 am store time, new stock exceptions,
//      sync failing (at most once a store day).
// Each e-mail is recorded in alert_log in the same transaction as the send, so it goes once; a failed send is retried
// on the next tick.

const EVERY_MS = 10 * 60_000;
const DIGEST_HOUR = 8;
const MAX_LINES = 30;

const APP = wooEnv.APP_NAME;
const link = (path: string) => `${config.WEB_ORIGIN}${path}`;
const day = (d: Date | string, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
const nice = (d: Date | string, tz: string) => new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(d));
const hourIn = (d: Date, tz: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d));
const support = () => [saasEnv.SUPPORT_WHATSAPP && `WhatsApp ${saasEnv.SUPPORT_WHATSAPP}`, saasEnv.SUPPORT_EMAIL].filter(Boolean).join(' or ') || 'reply to this e-mail';

/** Claims an alert key; false when it was sent before. Must run in the transaction that sends the e-mail. */
async function once(tx: Tx, kind: string, key: string) {
  const { rowCount } = await tx.query(
    "INSERT INTO alert_log (tenant_id, kind, key) VALUES (current_setting('app.tenant_id')::uuid, $1, $2) ON CONFLICT DO NOTHING", [kind, key]);
  return rowCount === 1;
}

async function storeOf(tx: Tx) {
  const { rows: [t] } = await tx.query(
    `SELECT t.name, t.timezone, s.state, s.trial_ends_at, s.paid_until, s.past_due_since, s.store_code
       FROM tenants t JOIN subscriptions s ON s.tenant_id = t.id WHERE t.id = current_setting('app.tenant_id')::uuid`);
  const { rows: people } = await tx.query("SELECT email, role FROM users WHERE status = 'active' AND role IN ('owner', 'manager')");
  return { ...t, owner: people.filter((p) => p.role === 'owner').map((p) => p.email as string), staff: people.map((p) => p.email as string) };
}

const STATE_MAIL: Record<string, (s: Record<string, any>) => { subject: string; text: string }> = {
  past_due: (s) => ({
    subject: `${APP}: payment due for ${s.name}`,
    text: `Your ${s.trial_ends_at && !s.paid_until ? 'free trial' : 'paid period'} has ended. Everything keeps working for 7 more days. `
      + `After that the store becomes read-only until a payment is recorded.\n\nHow to pay: ${link('/account')}\nPut your store code ${s.store_code} in the payment note.\n\nQuestions: ${support()}`,
  }),
  suspended: (s) => ({
    subject: `${APP}: ${s.name} is now read-only`,
    text: `Payment for ${s.name} is 7 days overdue, so the store is now read-only: you and your staff can see everything but cannot sell, `
      + `receive stock or make changes. Website orders are still received and will be processed once a payment is recorded.\n\n`
      + `How to pay: ${link('/account')} (store code ${s.store_code})\n\nQuestions: ${support()}`,
  }),
};

async function lifecycle(log: FastifyBaseLogger) {
  const { rows: moved } = await pool.query('SELECT * FROM saas_lifecycle_tick()');
  for (const m of moved) {
    log.info({ tenantId: m.tenant_id, from: m.from_state, to: m.to_state }, 'store state changed');
    const mail = STATE_MAIL[m.to_state];
    if (!mail) continue;
    await tenantTx(m.tenant_id, async (tx) => {
      const s = await storeOf(tx);
      if (await once(tx, 'state', `${m.to_state}:${day(new Date(), s.timezone)}`)) await sendMail({ to: s.owner, ...mail(s) }, log);
    }).catch((e) => log.error({ err: e, tenantId: m.tenant_id }, 'state e-mail failed'));
  }
  if (moved.length && saasEnv.PLATFORM_ALERT_EMAIL) {
    await sendMail({
      to: [saasEnv.PLATFORM_ALERT_EMAIL], subject: `${APP}: ${moved.length} store state change(s)`,
      text: moved.map((m) => `${m.tenant_id}: ${m.from_state} → ${m.to_state}`).join('\n') + `\n\nConsole: ${link('/platform')}`,
    }, log);
  }
}

async function reminders(tx: Tx, s: Record<string, any>, log: FastifyBaseLogger) {
  const ends = s.state === 'trial' ? s.trial_ends_at : s.state === 'active' ? s.paid_until : null;
  if (!ends) return;
  const left = (new Date(ends).getTime() - Date.now()) / 86_400_000;
  const which = left <= 1 ? 1 : left <= 7 ? 7 : null;
  if (which === null || left <= 0) return;
  const what = s.state === 'trial' ? 'free trial' : 'paid period';
  if (!(await once(tx, 'reminder', `${s.state}-${which}:${day(ends, s.timezone)}`))) return;
  await sendMail({
    to: s.owner,
    subject: `${APP}: your ${what} ends ${which === 1 ? 'tomorrow' : `on ${nice(ends, s.timezone)}`}`,
    text: `The ${what} for ${s.name} ends on ${nice(ends, s.timezone)}. To keep using ${APP} without interruption, pay before then.\n\n`
      + `How to pay: ${link('/account')} (store code ${s.store_code})\n\nQuestions: ${support()}`,
  }, log);
}

async function lowStockDigest(tx: Tx, s: Record<string, any>, now: Date, log: FastifyBaseLogger) {
  if (hourIn(now, s.timezone) < DIGEST_HOUR) return;
  if (!(await once(tx, 'low-stock', day(now, s.timezone)))) return;
  const def = REPORTS['low-stock'];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const { rows } = await tx.query(`SELECT * FROM (${def.sql({ from: '', to: '', tz: s.timezone, locationId: null, scope: ALL_OUTLETS }, p)}) r ORDER BY ${def.order}`, params);
  if (!rows.length) return;
  const lines = rows.slice(0, MAX_LINES).map((r) => `- ${r.product} (${r.sku}): ${Number(r.available)} left, reorder at ${Number(r.reorder_level)}`
    + (Number(r.on_order) > 0 ? `, ${Number(r.on_order)} on order` : ''));
  await sendMail({
    to: s.staff, subject: `${APP}: ${rows.length} item${rows.length === 1 ? '' : 's'} low on stock at ${s.name}`,
    text: `These items are at or below their reorder level:\n\n${lines.join('\n')}${rows.length > MAX_LINES ? `\n…and ${rows.length - MAX_LINES} more.` : ''}`
      + `\n\nFull list: ${link('/reports?r=low-stock')}`,
  }, log);
}

async function stockExceptions(tx: Tx, s: Record<string, any>, log: FastifyBaseLogger) {
  const { rows } = await tx.query(
    "SELECT id, number, exception_reason FROM sales_orders WHERE status = 'stock_exception' ORDER BY placed_at LIMIT 200");
  const fresh = [];
  for (const o of rows) if (await once(tx, 'stock-exception', o.id)) fresh.push(o);
  if (!fresh.length) return;
  await sendMail({
    to: s.staff, subject: `${APP}: ${fresh.length} web order${fresh.length === 1 ? '' : 's'} short of stock at ${s.name}`,
    text: `These website orders could not hold stock, so they cannot be picked yet:\n\n`
      + fresh.slice(0, MAX_LINES).map((o) => `- #${o.number}${o.exception_reason ? `: ${o.exception_reason}` : ''} ${link(`/orders/${o.id}`)}`).join('\n')
      + `\n\nReceive or adjust the stock, or change the order in WooCommerce.`,
  }, log);
}

async function syncFailing(tx: Tx, s: Record<string, any>, now: Date, log: FastifyBaseLogger) {
  const { rows: [r] } = await tx.query(`SELECT
      (SELECT count(*)::int FROM sync_jobs WHERE status IN ('failed', 'dead') AND kind LIKE 'woo.%') AS failed,
      (SELECT count(*)::int FROM sync_jobs WHERE status = 'pending' AND kind = 'woo.stock' AND created_at < now() - interval '15 minutes') AS stuck,
      (SELECT status FROM woo_connections) AS conn, (SELECT webhooks_ok FROM woo_connections) AS hooks,
      (SELECT last_error FROM woo_connections) AS last_error`);
  const problems = [
    r.conn === 'error' && `The shop connection has an error${r.last_error ? `: ${r.last_error}` : ''}.`,
    r.hooks === false && 'WooCommerce has switched off one or more webhooks, so new orders may not arrive.',
    r.failed > 0 && `${r.failed} sync job${r.failed === 1 ? ' has' : 's have'} failed.`,
    r.stuck > 0 && `${r.stuck} stock update${r.stuck === 1 ? ' has' : 's have'} been waiting more than 15 minutes.`,
  ].filter(Boolean) as string[];
  if (!problems.length) return;
  if (!(await once(tx, 'sync-failing', day(now, s.timezone)))) return;
  await sendMail({
    to: s.staff, subject: `${APP}: website sync needs attention at ${s.name}`,
    text: `${problems.join('\n')}\n\nOpen: ${link('/integrations/woocommerce')}\n\nYou get this at most once a day.`,
  }, log);
}

/** Reminders and alerts for one store. One transaction per kind, so one failing e-mail does not hold back the others. */
export async function storeAlerts(tenantId: string, log: FastifyBaseLogger, now = new Date()) {
  for (const step of [
    (tx: Tx, s: Record<string, any>) => reminders(tx, s, log),
    (tx: Tx, s: Record<string, any>) => s.state === 'suspended' ? Promise.resolve() : lowStockDigest(tx, s, now, log),
    (tx: Tx, s: Record<string, any>) => stockExceptions(tx, s, log),
    (tx: Tx, s: Record<string, any>) => syncFailing(tx, s, now, log),
  ]) {
    await tenantTx(tenantId, async (tx) => step(tx, await storeOf(tx)))
      .catch((e) => log.error({ err: e, tenantId }, 'store alert failed'));
  }
}

/** One full tick: lifecycle for every store, then each live store's reminders and alerts, then expired export files. */
export async function saasTick(log: FastifyBaseLogger, now = new Date()) {
  await lifecycle(log);
  const { rows } = await pool.query('SELECT tenant_id FROM saas_live_tenants()');
  for (const { tenant_id: tenantId } of rows) await storeAlerts(tenantId, log, now);
  const { rows: expired } = await pool.query('SELECT tenant_id FROM saas_expired_export_tenants()');
  for (const { tenant_id: tenantId } of expired) {
    await purgeExpiredExports(tenantId).catch((e) => log.error({ err: e, tenantId }, 'export purge failed'));
  }
}

export function startSaasTicker(log: FastifyBaseLogger) {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    saasTick(log).catch((e) => log.error({ err: e }, 'saas tick failed')).finally(() => { running = false; });
  };
  const first = setTimeout(run, 30_000);
  const t = setInterval(run, EVERY_MS);
  return { stop() { clearTimeout(first); clearInterval(t); } };
}
