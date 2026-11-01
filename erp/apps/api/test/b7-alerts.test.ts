import { describe, expect, it } from 'vitest';
import { testOutbox } from '../src/lib/notify.js';
import { storeAlerts } from '../src/modules/saas/ticker.js';
import { makeTenant, owner } from './b2-helpers.js';
import { makeItem } from './b3-helpers.js';
import { applyOrder, nextWooId, skuOf, wooOrder } from './b6-helpers.js';

const log = { info() {}, warn() {}, error() {} } as any;
const at = (iso: string) => new Date(iso);
const sentTo = (email: string, subject: RegExp) => testOutbox.filter((m) => m.to.includes(email) && subject.test(m.subject));
const ownerEmail = async (tenantId: string) => (await owner.query("SELECT email FROM users WHERE tenant_id = $1 AND role = 'owner'", [tenantId])).rows[0].email as string;

describe('B7 alert e-mails', () => {
  it('low-stock digest once a store day, after 8 am store time', async () => {
    const t = await makeTenant();
    const email = await ownerEmail(t.tenantId);
    const v = await makeItem(t.cookie);
    await owner.query('UPDATE product_variants SET reorder_level = 5 WHERE id = $1', [v]);
    await storeAlerts(t.tenantId, log, at('2026-11-02T01:00:00Z')); // 6:30 am in India
    expect(sentTo(email, /low on stock/)).toHaveLength(0);
    await storeAlerts(t.tenantId, log, at('2026-11-02T03:00:00Z')); // 8:30 am
    const m = sentTo(email, /low on stock/);
    expect(m).toHaveLength(1);
    expect(m[0].text).toContain(await skuOf(v));
    await storeAlerts(t.tenantId, log, at('2026-11-02T10:00:00Z'));
    expect(sentTo(email, /low on stock/)).toHaveLength(1);
    await storeAlerts(t.tenantId, log, at('2026-11-03T03:00:00Z'));
    expect(sentTo(email, /low on stock/)).toHaveLength(2);
  });

  it('a web order short of stock is reported once', async () => {
    const t = await makeTenant();
    const email = await ownerEmail(t.tenantId);
    const sku = await skuOf(await makeItem(t.cookie));
    const id = nextWooId();
    const r = await applyOrder(t, wooOrder({ id, status: 'processing', lines: [[sku, 2, '200.00']] }));
    expect((await owner.query('SELECT status FROM sales_orders WHERE id = $1', [r.orderId])).rows[0].status).toBe('stock_exception');
    await storeAlerts(t.tenantId, log);
    await storeAlerts(t.tenantId, log);
    const m = sentTo(email, /short of stock/);
    expect(m).toHaveLength(1);
    expect(m[0].text).toContain(`#${id}`);
  });

  it('sync failing: at most once a store day', async () => {
    const t = await makeTenant();
    const email = await ownerEmail(t.tenantId);
    await owner.query("INSERT INTO sync_jobs (tenant_id, kind, resource_id, status, priority, last_error) VALUES ($1, 'woo.product', gen_random_uuid(), 'dead', 5, 'boom')", [t.tenantId]);
    await storeAlerts(t.tenantId, log, at('2026-11-02T05:00:00Z'));
    await storeAlerts(t.tenantId, log, at('2026-11-02T09:00:00Z'));
    expect(sentTo(email, /sync needs attention/)).toHaveLength(1);
    expect(sentTo(email, /sync needs attention/)[0].text).toContain('1 sync job has failed');
  });
});
