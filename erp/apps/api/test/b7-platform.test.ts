import { describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { startRunner } from '../src/jobs/runner.js';
import { objects, type MemoryStore } from '../src/lib/objects.js';
import { purgeExpiredExports } from '../src/modules/account/export-job.js';
import { api } from './b2-api.js';
import { getApp, makeTenant, owner } from './b2-helpers.js';
import { adminLogin, adminSession, makeAdmin, PASSWORD, subOf } from './b7-helpers.js';

const call = (cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) => api(cookie, method, `/v1/platform${url}`, body);

describe('B7 platform console sign-in', () => {
  it('needs password and a fresh authenticator code; a code works once', async () => {
    const a = await makeAdmin();
    expect((await adminLogin({ email: a.email, password: PASSWORD, code: '000000' })).status).toBe(401);
    expect((await adminLogin({ email: a.email, password: 'wrong password', code: a.code() })).status).toBe(401);
    expect((await adminLogin({ email: 'nobody@platform.test', password: PASSWORD, code: a.code() })).status).toBe(401);
    const code = a.code();
    const ok = await adminLogin({ email: a.email, password: PASSWORD, code });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.cookie).toMatch(/^tz_admin=/);
    expect((await adminLogin({ email: a.email, password: PASSWORD, code })).status).toBe(401); // replayed
    expect((await call(ok.cookie, 'GET', '/me')).body.email).toBe(a.email);
  });

  it('locks the account after 5 wrong attempts', async () => {
    const a = await makeAdmin();
    for (let i = 0; i < 5; i++) await adminLogin({ email: a.email, password: 'wrong password', code: a.code() });
    const r = await adminLogin({ email: a.email, password: PASSWORD, code: a.code() });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('LOCKED');
  });

  it('a session ends after 30 idle minutes, and on sign-out', async () => {
    const s = await adminSession();
    await owner.query("UPDATE platform_sessions SET last_seen_at = now() - interval '31 minutes' WHERE admin_id = $1", [s.id]);
    expect((await call(s.cookie, 'GET', '/tenants')).status).toBe(401);
    const s2 = await adminSession();
    expect((await call(s2.cookie, 'GET', '/tenants')).status).toBe(200);
    await call(s2.cookie, 'POST', '/logout');
    expect((await call(s2.cookie, 'GET', '/tenants')).status).toBe(401);
  });

  it('a store session or no session gets nothing, and the functions refuse a made-up session', async () => {
    const t = await makeTenant();
    expect((await call(t.cookie, 'GET', '/tenants')).status).toBe(401);
    expect((await call('', 'GET', '/tenants')).status).toBe(401);
    await expect(pool.query('SELECT * FROM platform_tenants($1)', [Buffer.alloc(32)])).rejects.toThrow(/platform session invalid/);
    await expect(pool.query("SELECT platform_set_state($1, $2, 'active', 'testing', NULL)", [Buffer.alloc(32), t.tenantId])).rejects.toThrow(/platform session invalid/);
  });
});

describe('B7 platform console: payments, states, support access', () => {
  it('records a UPI payment: store becomes active, paid period starts, receipt numbered, logged', async () => {
    const s = await adminSession();
    const t = await makeTenant();
    const list = await call(s.cookie, 'GET', '/tenants');
    expect(list.body.items.some((x: any) => x.id === t.tenantId && x.state === 'trial')).toBe(true);
    const ref = `UTR${Date.now()}`;
    const p = await call(s.cookie, 'POST', `/tenants/${t.tenantId}/payments`,
      { amountPaise: 199900, method: 'upi', reference: ref, paidOn: '2026-10-20', planId: 'online', months: 1 });
    expect(p.status, p.text).toBe(201);
    expect(p.body.receiptNo).toMatch(/^R-\d{6}$/);
    const sub = await subOf(t.tenantId);
    expect(sub.state).toBe('active');
    expect(new Date(sub.paid_until).getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000);
    expect((await call(s.cookie, 'POST', `/tenants/${t.tenantId}/payments`,
      { amountPaise: 199900, method: 'upi', reference: ref, paidOn: '2026-10-20', planId: 'online', months: 1 })).status).toBe(409);
    // The owner sees it on the Account page.
    const mine = await api(t.cookie, 'GET', '/v1/account/payments');
    expect(mine.body.payments[0]).toMatchObject({ receiptNo: p.body.receiptNo, amountPaise: 199900, reference: ref });
    expect(JSON.stringify(mine.body)).not.toContain(s.email); // who recorded it stays in the console
    const detail = await call(s.cookie, 'GET', `/tenants/${t.tenantId}`);
    expect(detail.body.planId).toBe('online');
    const log = await call(s.cookie, 'GET', '/audit');
    expect(log.body.items.some((x: any) => x.action === 'platform.payment_recorded' && x.tenantId === t.tenantId)).toBe(true);
  });

  it('suspends, reactivates, closes and extends trials, each with a reason', async () => {
    const s = await adminSession();
    const t = await makeTenant();
    expect((await call(s.cookie, 'POST', `/tenants/${t.tenantId}/state`, { state: 'suspended', reason: '' })).status).toBe(400);
    expect((await call(s.cookie, 'POST', `/tenants/${t.tenantId}/state`, { state: 'suspended', reason: 'testing suspend' })).status).toBe(200);
    // Reactivating needs paid time left; a store that never paid gets a trial date or a payment instead.
    const noPaid = await call(s.cookie, 'POST', `/tenants/${t.tenantId}/state`, { state: 'active', reason: 'goodwill' });
    expect([noPaid.status, noPaid.text]).toEqual([409, expect.stringContaining('no paid time left')]);
    expect((await subOf(t.tenantId)).state).toBe('suspended');
    expect((await call(s.cookie, 'POST', `/tenants/${t.tenantId}/trial`, { until: '2027-03-31', reason: 'pilot store' })).status).toBe(200);
    const sub = await subOf(t.tenantId);
    expect(sub.state).toBe('trial');
    expect(sub.trial_ends_at.toISOString()).toBe('2027-03-31T18:30:00.000Z');
    expect((await call(s.cookie, 'POST', `/tenants/${t.tenantId}/state`, { state: 'closed', reason: 'owner asked to close' })).status).toBe(200);
    expect((await call(s.cookie, 'POST', `/tenants/${t.tenantId}/payments`,
      { amountPaise: 99900, method: 'upi', reference: `UTR${Date.now()}x`, paidOn: '2026-10-20', planId: 'starter', months: 1 })).status).toBe(409);
    expect((await call(s.cookie, 'POST', `/tenants/${t.tenantId}/plan`, { planId: 'nope', reason: 'typo test' })).status).toBe(400);
  });

  it('support view only while the owner allows it; every look shows in the store audit log', async () => {
    const s = await adminSession();
    const t = await makeTenant();
    const before = await call(s.cookie, 'GET', `/tenants/${t.tenantId}/support`);
    expect(before.status).toBe(403);
    expect(before.body.code).toBe('NO_SUPPORT_ACCESS');
    expect((await api(t.cookie, 'POST', '/v1/account/support-access', { hours: 73 })).status).toBe(400);
    const g = await api(t.cookie, 'POST', '/v1/account/support-access', { hours: 2, reason: 'sync looks stuck' });
    expect(g.status, g.text).toBe(201);
    const v = await call(s.cookie, 'GET', `/tenants/${t.tenantId}/support`);
    expect(v.status, v.text).toBe(200);
    expect(v.body.counts).toMatchObject({ users: 1 });
    const mine = await api(t.cookie, 'GET', '/v1/account/support-access');
    expect(mine.body.views[0].by).toBe(s.email);
    expect(mine.body.items[0].active).toBe(true);
    expect((await api(t.cookie, 'POST', '/v1/account/support-access/revoke')).body.revoked).toBe(1);
    expect((await call(s.cookie, 'GET', `/tenants/${t.tenantId}/support`)).status).toBe(403);
    // Expired grants do nothing either.
    await api(t.cookie, 'POST', '/v1/account/support-access', { hours: 1 });
    await owner.query("UPDATE support_grants SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE tenant_id = $1 AND revoked_at IS NULL", [t.tenantId]);
    expect((await call(s.cookie, 'GET', `/tenants/${t.tenantId}/support`)).status).toBe(403);
  });
});

describe('B7 owner data export', () => {
  it('zips every store table as CSV, never secrets or other stores, and logs the download', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const marker = `Marker ${Date.now()}`;
    await api(b.cookie, 'POST', '/v1/categories', { name: marker });
    const req = await api(a.cookie, 'POST', '/v1/account/exports');
    expect(req.status, req.text).toBe(202);
    expect((await api(a.cookie, 'POST', '/v1/account/exports')).body.code).toBe('EXPORT_RUNNING');
    const runner = startRunner((await getApp()).log, 'b7-export');
    let e: any;
    for (let i = 0; i < 50; i++) {
      e = (await api(a.cookie, 'GET', '/v1/account/exports')).body.items[0];
      if (e.status === 'ready' || e.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await runner.stop();
    expect(e.status, JSON.stringify(e)).toBe('ready');
    expect(e.rowCounts.users).toBe(1);
    const dl = await (await getApp()).inject({ method: 'GET', url: `/v1/account/exports/${e.id}/download`, headers: { cookie: a.cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    const zipBytes = dl.rawPayload;
    expect(zipBytes.subarray(0, 4).toString('hex')).toBe('504b0304');
    // Unzip with the system tool and look inside.
    const { mkdtempSync, writeFileSync, readdirSync, readFileSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const dir = mkdtempSync('/tmp/b7-export-');
    writeFileSync(`${dir}/x.zip`, zipBytes);
    execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', `${dir}/x.zip`, `${dir}/out`]);
    const files = readdirSync(`${dir}/out`);
    expect(files).toEqual(expect.arrayContaining(['README.txt', 'tenants.csv', 'users.csv', 'products.csv', 'invoices.csv', 'subscriptions.csv']));
    expect(files).not.toContain('sessions.csv');
    const all = files.map((f) => readFileSync(`${dir}/out/${f}`, 'utf8')).join('\n');
    expect(all).not.toContain('password_hash');
    expect(all).not.toContain('key_enc');
    expect(all).not.toContain(marker);
    expect(all).not.toContain(b.tenantId);
    expect((objects as MemoryStore).data.has(`${a.tenantId}/exports/${e.id}.zip`)).toBe(true);
    const audit = await owner.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND action LIKE 'account.export%' ORDER BY id", [a.tenantId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['account.export_requested', 'account.export_downloaded']);
    // Another store cannot download it.
    expect((await api(b.cookie, 'GET', `/v1/account/exports/${e.id}/download`)).status).toBe(404);

    // After 7 days the ticker deletes the file; the row stays, marked expired, and can no longer be downloaded.
    await owner.query("UPDATE data_exports SET expires_at = now() - interval '1 minute' WHERE id = $1", [e.id]);
    expect((await pool.query('SELECT tenant_id FROM saas_expired_export_tenants()')).rows.map((r) => r.tenant_id)).toContain(a.tenantId);
    await purgeExpiredExports(a.tenantId);   // what the ticker does for each of those stores
    expect((objects as MemoryStore).data.has(`${a.tenantId}/exports/${e.id}.zip`)).toBe(false);
    expect((await owner.query('SELECT status, object_key FROM data_exports WHERE id = $1', [e.id])).rows[0]).toEqual({ status: 'expired', object_key: null });
    expect((await api(a.cookie, 'GET', `/v1/account/exports/${e.id}/download`)).status).not.toBe(200);
  });
});
