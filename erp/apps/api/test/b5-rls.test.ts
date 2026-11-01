import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { getApp, owner } from './b2-helpers.js';

const B5_TABLES = ['sales_settings', 'invoice_series', 'invoices', 'invoice_lines', 'customer_returns', 'customer_return_lines',
  'credit_notes', 'credit_note_lines', 'payments'];
const APPEND_ONLY = ['invoices', 'invoice_lines', 'customer_returns', 'customer_return_lines', 'credit_notes', 'credit_note_lines', 'payments'];

afterAll(async () => { await owner.end(); });

const grants = async (privilege: string) => (await owner.query(
  `SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'erp_rt' AND privilege_type = $1 AND table_name = ANY($2) ORDER BY 1`,
  [privilege, B5_TABLES])).rows.map((r) => r.table_name);

describe('B5 tenant isolation and grants', () => {
  it('every B5 table has RLS enabled and forced', async () => {
    const { rows } = await owner.query('SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)', [B5_TABLES]);
    expect(rows).toHaveLength(B5_TABLES.length);
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
  });

  it('the runtime role sees zero rows without a tenant context', async () => {
    for (const t of B5_TABLES) expect((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
  });

  it('tax documents, payments and returns are append-only; nothing B5 adds can be deleted', async () => {
    expect(await grants('UPDATE')).toEqual(['invoice_series', 'sales_settings']);
    expect(await grants('DELETE')).toEqual([]);
    expect(await grants('TRUNCATE')).toEqual([]);
    expect((await grants('INSERT')).sort()).toEqual([...B5_TABLES].sort());
    expect(APPEND_ONLY.every((t) => B5_TABLES.includes(t))).toBe(true);
  });

  it('every B5 route checks a permission', async () => {
    const app = await getApp();
    await app.ready();
    const routes = app.printRoutes({ commonPrefix: false });
    for (const path of ['/v1/pos/sales', '/v1/pos/quote', '/v1/pos/lookup', '/v1/invoices', '/v1/returns', '/v1/billing/settings', '/v1/customers']) {
      expect(routes).toContain(path.split('/').pop());
      const res = await app.inject({ method: 'GET', url: path });
      expect([401, 404], path).toContain(res.statusCode);
    }
  });
});
