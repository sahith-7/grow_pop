import { describe, expect, it } from 'vitest';
import { owner } from './b2-helpers.js';

// CI checks from 06-security-and-backup.md §1 "Supply chain and CI": the RLS check, run on every push.
describe('B7 row-level security check', () => {
  it('every table with a tenant_id column has RLS on and a tenant policy', async () => {
    const { rows } = await owner.query(`
      SELECT c.relname, c.relrowsecurity, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname <> 'backup_read')::int AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       ORDER BY 1`);
    expect(rows.length).toBeGreaterThan(40);
    // platform_* tables have RLS on and deliberately no policy: the app role sees no rows (and has no grants either).
    expect(rows.filter((r) => !r.relrowsecurity || (r.policies === 0 && !r.relname.startsWith('platform_'))).map((r) => r.relname)).toEqual([]);
  });

  it('the app roles cannot bypass RLS and do not own the tables', async () => {
    const { rows } = await owner.query("SELECT rolname FROM pg_roles WHERE rolname IN ('erp_rt', 'erp_app') AND (rolbypassrls OR rolsuper)");
    expect(rows).toEqual([]);
    const { rows: owned } = await owner.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
        WHERE n.nspname = 'public' AND r.rolname IN ('erp_rt', 'erp_app')`);
    expect(owned).toEqual([]);
  });

  // D79: the nightly pg_dump runs as a member of erp_backup. A table it cannot read makes the backup fail (or, worse,
  // a restore that silently lacks that table), so any migration that adds a table must call erp_backup_grants().
  it('the backup role can read every table and every row, and write nothing', async () => {
    const { rows: unreadable } = await owner.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')
          AND (NOT has_table_privilege('erp_backup', c.oid, 'SELECT')
               OR (c.relrowsecurity AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'backup_read')))
        ORDER BY 1`);
    expect(unreadable.map((r) => r.relname), 'run SELECT erp_backup_grants(); at the end of the migration').toEqual([]);
    const { rows: writable } = await owner.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND (has_table_privilege('erp_backup', c.oid, 'INSERT') OR has_table_privilege('erp_backup', c.oid, 'UPDATE')
               OR has_table_privilege('erp_backup', c.oid, 'DELETE') OR has_table_privilege('erp_backup', c.oid, 'TRUNCATE'))`);
    expect(writable).toEqual([]);
    const { rows: wider } = await owner.query(
      `SELECT p.polname, c.relname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE p.polname = 'backup_read' AND (p.polcmd <> 'r' OR p.polroles <> ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'erp_backup')])`);
    expect(wider).toEqual([]);
    const { rows: members } = await owner.query(
      `SELECT m.rolname FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
        WHERE r.rolname = 'erp_backup' AND m.rolname IN ('erp_rt', 'erp_app')`);
    expect(members).toEqual([]);
  });
});
