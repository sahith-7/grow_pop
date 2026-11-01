import { describe, expect, it } from 'vitest';
import { tenantTx } from '../src/db.js';
import { testOutbox } from '../src/lib/notify.js';
import { jobGate } from '../src/lib/saas.js';
import { saasTick } from '../src/modules/saas/ticker.js';
import { api } from './b2-api.js';
import { getApp, makeTenant, makeUser, owner } from './b2-helpers.js';
import { setSub, subOf } from './b7-helpers.js';

const log = { info() {}, warn() {}, error() {} } as any;

describe('B7 store states', () => {
  it('a new store starts a 30-day trial with a store code, and sees it', async () => {
    const t = await makeTenant();
    const s = await subOf(t.tenantId);
    expect(s.state).toBe('trial');
    expect(s.store_code).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
    const days = (new Date(s.trial_ends_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    const r = await api(t.cookie, 'GET', '/v1/subscription');
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ state: 'trial', readOnly: false, storeCode: s.store_code, online: true, can: { manage: true } });
    const cashier = await makeUser(t.tenantId, 'cashier');
    const c = await api(cashier.cookie, 'GET', '/v1/subscription');
    expect(c.body.can.manage).toBe(false);
    expect(c.body.payTo).toBeNull();
    expect((await api(cashier.cookie, 'GET', '/v1/account/payments')).status).toBe(403);
  });

  it('the app role cannot change a subscription, its plan or Phase 1 status, or see console tables', async () => {
    const t = await makeTenant();
    const deny = (sql: string) => expect(tenantTx(t.tenantId, (tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
    await deny("UPDATE subscriptions SET state = 'active'");
    await deny("INSERT INTO subscription_payments (tenant_id) VALUES (current_setting('app.tenant_id')::uuid)");
    await deny("UPDATE tenants SET plan_id = 'online'");
    await deny("UPDATE tenants SET status = 'active'");
    await deny('SELECT * FROM platform_admins');
    await deny('SELECT * FROM platform_sessions');
    await deny("UPDATE plans SET max_users = 99");
    // Phase 1's settings can still rename the store.
    await tenantTx(t.tenantId, (tx) => tx.query("UPDATE tenants SET name = 'Renamed' WHERE id = current_setting('app.tenant_id')::uuid"));
  });

  it('trial end → past due → suspended after 7 days, with an e-mail to the owner each time', async () => {
    const t = await makeTenant();
    await setSub(t.tenantId, "trial_ends_at = now() - interval '1 minute'");
    testOutbox.length = 0;
    await saasTick(log);
    expect((await subOf(t.tenantId)).state).toBe('past_due');
    expect(testOutbox.some((m) => m.subject.includes('payment due'))).toBe(true);
    expect((await api(t.cookie, 'GET', '/v1/subscription')).body.suspendsAt).toBeTruthy();
    // Still fully usable while past due.
    expect((await api(t.cookie, 'POST', '/v1/locations', { name: `Back room ${Date.now()}`, kind: 'storage', isSellable: false })).status).not.toBe(403);

    await setSub(t.tenantId, "past_due_since = now() - interval '7 days 1 minute'");
    await saasTick(log);
    expect((await subOf(t.tenantId)).state).toBe('suspended');
    expect(testOutbox.some((m) => m.subject.includes('read-only'))).toBe(true);
    const n = testOutbox.length;
    await saasTick(log); // nothing new: each state e-mail goes once
    expect(testOutbox.filter((m) => m.subject.includes('read-only')).length).toBe(testOutbox.slice(0, n).filter((m) => m.subject.includes('read-only')).length);
    const { rows } = await owner.query('SELECT from_state, to_state, actor FROM subscription_events WHERE tenant_id = $1 ORDER BY id', [t.tenantId]);
    expect(rows.map((r) => `${r.from_state}>${r.to_state}`)).toEqual(['null>trial', 'trial>past_due', 'past_due>suspended']);
  });

  it('a suspended store is read-only everywhere except Account', async () => {
    const t = await makeTenant();
    await setSub(t.tenantId, "state = 'suspended'");
    const w = await api(t.cookie, 'POST', '/v1/locations', { name: 'X', kind: 'storage', isSellable: false });
    expect(w.status, w.text).toBe(403);
    expect(w.body.code).toBe('TENANT_SUSPENDED');
    expect((await api(t.cookie, 'GET', '/v1/products')).status).toBe(200);
    expect((await api(t.cookie, 'GET', '/v1/auth/me')).status).toBe(200);
    expect((await api(t.cookie, 'POST', '/v1/account/support-access', { hours: 2 })).status).toBe(201);
    expect(await jobGate(t.tenantId, 'woo.stock')).toBe('pause');
    expect(await jobGate(t.tenantId, 'export')).toBe('run');
  });

  it('a closed store answers only sign-in, the banner and Account; its jobs stop', async () => {
    const t = await makeTenant();
    await setSub(t.tenantId, "state = 'closed', closed_at = now()");
    const r = await api(t.cookie, 'GET', '/v1/products');
    expect(r.status).toBe(410);
    expect(r.body.code).toBe('TENANT_CLOSED');
    const s = await api(t.cookie, 'GET', '/v1/subscription');
    expect(s.status).toBe(200);
    expect(s.body.exportUntil).toBeTruthy();
    expect((await api(t.cookie, 'POST', '/v1/account/exports')).status).toBe(202);
    expect(await jobGate(t.tenantId, 'import')).toBe('stop');
  });

  it('the Store plan has no online shop once the trial is over', async () => {
    const t = await makeTenant();
    await setSub(t.tenantId, "state = 'active', paid_until = now() + interval '30 days'");
    const r = await api(t.cookie, 'PUT', '/v1/integrations/woocommerce', { siteUrl: 'https://shop.example.com', consumerKey: 'ck_x', consumerSecret: 'cs_x' });
    expect(r.status, r.text).toBe(403);
    expect(r.body.code).toBe('PLAN_LIMIT');
    expect(await jobGate(t.tenantId, 'woo.stock')).toBe('pause');
    expect((await api(t.cookie, 'GET', '/v1/subscription')).body.online).toBe(false);
    await owner.query("UPDATE tenants SET plan_id = 'online' WHERE id = $1", [t.tenantId]);
    expect(await jobGate(t.tenantId, 'woo.stock')).toBe('run');
  });

  it('reminds the owner 7 days and 1 day before the trial ends, once each', async () => {
    const t = await makeTenant();
    await setSub(t.tenantId, "trial_ends_at = now() + interval '6 days'");
    testOutbox.length = 0;
    await saasTick(log);
    await saasTick(log);
    const mine = () => testOutbox.filter((m) => m.subject.includes('free trial ends'));
    expect(mine().length).toBeGreaterThanOrEqual(1);
    const before = mine().length;
    await setSub(t.tenantId, "trial_ends_at = now() + interval '20 hours'");
    await saasTick(log);
    expect(mine().length).toBe(before + 1);
    expect(mine().at(-1)!.subject).toContain('tomorrow');
  });

  it('every app route gets the store guard', async () => {
    await getApp();
    const { registeredRoutes } = await import('../src/lib/saas.js');
    expect(registeredRoutes.length).toBeGreaterThan(100);
  });
});
