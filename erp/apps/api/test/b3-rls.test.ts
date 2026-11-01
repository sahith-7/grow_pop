import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { owner } from './b2-helpers.js';

const B3_TABLES = ['doc_sequences', 'locations', 'stock_balances', 'stock_ledger', 'adjustments', 'transfers', 'stocktakes',
  'stocktake_lines', 'suppliers', 'purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines',
  'supplier_returns', 'supplier_return_lines'];
const APPEND_ONLY = ['stock_ledger', 'adjustments', 'transfers', 'goods_receipts', 'goods_receipt_lines', 'supplier_returns', 'supplier_return_lines'];

afterAll(async () => { await owner.end(); });

const grants = async (privilege: string) => (await owner.query(
  `SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'erp_rt' AND privilege_type = $1 AND table_name = ANY($2) ORDER BY 1`,
  [privilege, B3_TABLES])).rows.map((r) => r.table_name);

describe('B3 tenant isolation and grants', () => {
  it('every B3 table has RLS enabled and forced', async () => {
    const { rows } = await owner.query('SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)', [B3_TABLES]);
    expect(rows).toHaveLength(B3_TABLES.length);
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
  });

  it('the runtime role sees zero rows without a tenant context', async () => {
    for (const t of [...B3_TABLES, 'v_stock_reconciliation']) expect((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
  });

  it('the ledger and posted documents are append-only; only draft PO lines can be deleted', async () => {
    expect((await grants('UPDATE')).filter((t) => APPEND_ONLY.includes(t))).toEqual([]);
    expect(await grants('DELETE')).toEqual(['purchase_order_lines']);
    expect(await grants('INSERT')).toEqual([...B3_TABLES].sort());
  });

  // The full reviewed list (04-tenancy-and-permissions.md §1.3). B3 added none; B4 added the two woo_* lookups;
  // B7 added the store lifecycle and platform console functions (D70). A new one needs a decision record first.
  it('only the reviewed SECURITY DEFINER functions exist', async () => {
    const { rows } = await owner.query(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef ORDER BY 1`);
    expect(rows.map((r) => r.proname)).toEqual(['auth_session_lookup', 'auth_token_lookup', 'auth_user_by_email', 'claim_jobs',
      'platform_audit_log', 'platform_login_lookup', 'platform_login_result', 'platform_logout', 'platform_record_payment', 'platform_set_plan',
      'platform_set_state', 'platform_set_trial', 'platform_support_view', 'platform_tenant', 'platform_tenants', 'platform_whoami',
      'saas_expired_export_tenants', 'saas_lifecycle_tick', 'saas_live_tenants', 'saas_on_tenant_insert', 'woo_due_tenants', 'woo_endpoint_lookup']);
  });
});
