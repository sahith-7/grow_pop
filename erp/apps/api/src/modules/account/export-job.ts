import { tenantTx, type Tx } from '../../db.js';
import { PermanentJobError, register } from '../../jobs/runner.js';
import { csvLine } from '../../lib/csv.js';
import { objects } from '../../lib/objects.js';
import { zip } from '../../lib/zip.js';

// The owner's full data export (D72): one CSV per table that holds the store's rows, zipped, kept 7 days.
// Runs inside tenantTx, so row-level security decides what is read; the table list is not trusted for isolation.
// Left out: sign-in secrets and internal plumbing, listed in EXCLUDED_* below and in README.txt inside the zip.

export const EXCLUDED_TABLES = new Set(['sessions', 'user_tokens', 'idempotency_keys', 'sync_jobs', 'woo_outbox', 'webhook_events',
  'alert_log', 'data_exports', 'barcode_sequences', 'doc_sequences']);
export const EXCLUDED_COLUMN = /(password|token|secret|_enc$|_hash$)/;
const MAX_ROWS = 1_000_000;

const cell = (v: unknown) => v instanceof Date ? v.toISOString() : v !== null && typeof v === 'object' ? JSON.stringify(v) : v;

/** Tables and columns the export includes, from the catalog. Bytea columns are never exported. */
export async function exportPlan(tx: Tx) {
  const { rows } = await tx.query(
    `SELECT c.table_name, array_agg(c.column_name::text ORDER BY c.ordinal_position) AS cols
       FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.data_type <> 'bytea'
        AND c.table_name IN (SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id')
      GROUP BY c.table_name ORDER BY c.table_name`);
  const plan = rows
    .filter((r) => !EXCLUDED_TABLES.has(r.table_name))
    .map((r) => ({ table: r.table_name as string, cols: (r.cols as string[]).filter((c) => !EXCLUDED_COLUMN.test(c)) }));
  plan.unshift({ table: 'tenants', cols: ['id', 'name', 'legal_name', 'timezone', 'locale', 'currency', 'plan_id', 'created_at'] });
  return plan;
}

const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;

register('export', async (job) => {
  const tenantId = job.tenantId;
  try {
    const { files, counts } = await tenantTx(tenantId, async (tx) => {
      await tx.query("UPDATE data_exports SET status = 'running' WHERE id = $1 AND status = 'pending'", [job.resourceId]);
      const files: { name: string; data: Buffer }[] = [];
      const counts: Record<string, number> = {};
      for (const { table, cols } of await exportPlan(tx)) {
        const where = table === 'tenants' ? "id = current_setting('app.tenant_id')::uuid" : "tenant_id = current_setting('app.tenant_id')::uuid";
        const { rows } = await tx.query({ text: `SELECT ${cols.map(quote).join(', ')} FROM ${quote(table)} WHERE ${where} LIMIT ${MAX_ROWS + 1}`, rowMode: 'array' });
        counts[table] = Math.min(rows.length, MAX_ROWS);
        const body = [csvLine(cols), ...rows.slice(0, MAX_ROWS).map((r: unknown[]) => csvLine(r.map(cell)))].join('');
        files.push({ name: `${table}.csv`, data: Buffer.from('﻿' + body, 'utf8') });
      }
      const readme = [
        'Data export',
        `Created: ${new Date().toISOString()}`,
        '',
        'One CSV file per table, UTF-8 with a byte order mark so Excel shows ₹ and Indian scripts correctly.',
        'Ids (uuid) link the files: e.g. invoice_lines.invoice_id = invoices.id.',
        'Text that starts with = + - @ has a leading apostrophe so spreadsheets do not run it as a formula.',
        `Each table is capped at ${MAX_ROWS.toLocaleString('en-IN')} rows.`,
        '',
        'Not included: passwords, sign-in sessions and tokens, WooCommerce keys, and internal queues.',
        '',
        'Rows per table:',
        ...Object.entries(counts).map(([t, n]) => `  ${t}: ${n}`),
      ].join('\r\n');
      files.unshift({ name: 'README.txt', data: Buffer.from(readme, 'utf8') });
      return { files, counts };
    });
    const body = zip(files);
    const key = `${tenantId}/exports/${job.resourceId}.zip`;
    await objects.put(key, body, 'application/zip');
    await tenantTx(tenantId, (tx) => tx.query(
      "UPDATE data_exports SET status = 'ready', object_key = $2, size_bytes = $3, row_counts = $4, finished_at = now() WHERE id = $1",
      [job.resourceId, key, body.length, counts]));
  } catch (e) {
    await tenantTx(tenantId, (tx) => tx.query("UPDATE data_exports SET status = 'failed', error = $2, finished_at = now() WHERE id = $1",
      [job.resourceId, String((e as Error).message ?? e).slice(0, 300)])).catch(() => {});
    throw new PermanentJobError(String((e as Error).message ?? e));
  }
});

/** Deletes the files of a store's exports that are past their 7 days (run by the SaaS ticker). A full copy of a store's
 *  data must not outlive the download window; the row stays, marked expired, so the Account page still lists it. */
export async function purgeExpiredExports(tenantId: string) {
  await tenantTx(tenantId, async (tx) => {
    const { rows } = await tx.query(
      "SELECT id, object_key FROM data_exports WHERE status = 'ready' AND expires_at < now() FOR UPDATE SKIP LOCKED");
    for (const e of rows) {
      if (e.object_key) await objects.delete(e.object_key);
      await tx.query("UPDATE data_exports SET status = 'expired', object_key = NULL WHERE id = $1", [e.id]);
    }
  });
}
