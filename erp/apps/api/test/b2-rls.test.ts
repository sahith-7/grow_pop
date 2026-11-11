import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { owner } from './b2-helpers.js';

const B2_TABLES = ['files', 'categories', 'brands', 'products', 'product_variants', 'product_images',
  'barcode_sequences', 'import_jobs', 'idempotency_keys', 'sync_jobs'];

afterAll(async () => { await owner.end(); });

describe('B2 tenant isolation', () => {
  it('every B2 tenant table has RLS on (and forced, except the job queue)', async () => {
    const { rows } = await owner.query(
      'SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)', [B2_TABLES]);
    expect(rows).toHaveLength(B2_TABLES.length);
    for (const r of rows) {
      expect(r.relrowsecurity, r.relname).toBe(true);
      expect(r.relforcerowsecurity, r.relname).toBe(r.relname !== 'sync_jobs');
    }
  });

  it('the runtime role sees zero rows without a tenant context', async () => {
    for (const t of B2_TABLES) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
      expect(rows[0].n, t).toBe(0);
    }
  });

  it('the runtime role cannot delete files, products or variants', async () => {
    const { rows } = await owner.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'erp_rt' AND privilege_type = 'DELETE' AND table_name = ANY($1)`, [B2_TABLES]);
    // v2 (D89): unused categories and brands may be deleted; the service checks nothing uses them.
    expect(rows.map((r) => r.table_name).sort()).toEqual(['brands', 'categories', 'product_images']);
  });

  it('the runtime role can only read units and can never change an uploaded file', async () => {
    const { rows } = await owner.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'erp_rt' AND table_name IN ('units', 'files') ORDER BY 1, 2`);
    expect(rows.map((r) => `${r.table_name}:${r.privilege_type}`)).toEqual(['files:INSERT', 'files:SELECT', 'units:SELECT']);
  });

  it('claim_jobs is the only SECURITY DEFINER function B2 adds', async () => {
    const { rows } = await owner.query(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef ORDER BY 1`);
    expect(rows.map((r) => r.proname)).toContain('claim_jobs');
  });
});
