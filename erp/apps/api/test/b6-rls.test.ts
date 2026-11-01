import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { getApp, owner } from './b2-helpers.js';

const B6_TABLES = ['pick_lists', 'pick_list_lines', 'shipments'];

afterAll(async () => { await owner.end(); });

const grants = async (privilege: string) => (await owner.query(
  `SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'erp_rt' AND privilege_type = $1 AND table_name = ANY($2) ORDER BY 1`,
  [privilege, B6_TABLES])).rows.map((r) => r.table_name);

describe('B6 tenant isolation and grants', () => {
  it('every B6 table has RLS enabled and forced', async () => {
    const { rows } = await owner.query('SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)', [B6_TABLES]);
    expect(rows).toHaveLength(B6_TABLES.length);
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
  });

  it('the runtime role sees zero rows without a tenant context', async () => {
    for (const t of B6_TABLES) expect((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
  });

  it('nothing B6 adds can be deleted; a shipment only changes its WooCommerce update columns', async () => {
    expect(await grants('DELETE')).toEqual([]);
    expect(await grants('TRUNCATE')).toEqual([]);
    expect(await grants('UPDATE')).toEqual(['pick_list_lines', 'pick_lists']);
    const { rows } = await owner.query(
      "SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'erp_rt' AND table_name = 'shipments' AND privilege_type = 'UPDATE' ORDER BY 1");
    expect(rows.map((r) => r.column_name)).toEqual(['woo_error', 'woo_note_id', 'woo_synced_at', 'woo_update_state']);
  });

  it('every B6 route checks a session', async () => {
    const app = await getApp();
    await app.ready();
    for (const path of ['/v1/fulfilment/queue', '/v1/pick-lists', '/v1/reports', '/v1/reports/sales', '/v1/dashboard']) {
      const res = await app.inject({ method: 'GET', url: path });
      expect(res.statusCode, path).toBe(401);
    }
  });
});
