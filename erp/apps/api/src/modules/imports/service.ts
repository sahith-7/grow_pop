import type { Tx } from '../../db.js';
import { audit } from '../../lib/phase1.js';
import { parseCsv } from '../../lib/csv.js';
import { appError } from '../../lib/phase1.js';
import { enqueue } from '../../jobs/queue.js';
import { importRefs, insertImportedProducts } from '../catalog/service.js';
import { assertFile, readFile } from '../files/service.js';
import { type ColumnKey, resolveMapping } from './columns.js';
import { FileProblem, MAX_ROWS, validateRows } from './validate.js';

const ERROR_PREVIEW = 50;

export function jobOut(r: Record<string, any>) {
  return {
    id: r.id, kind: r.kind, status: r.status, totalRows: r.total_rows, validRows: r.valid_rows, errorRows: r.error_rows,
    createdCount: r.created_count, failure: r.failure, mapping: r.mapping,
    errors: (r.errors as unknown[]).slice(0, ERROR_PREVIEW),
    errorReportUrl: r.error_rows > 0 ? `/api/v1/imports/${r.id}/error-report.csv` : null,
    createdAt: r.created_at, updatedAt: r.updated_at,
    // True when no worker has claimed the job for 30 s: the worker process is down, so the page can say so instead of spinning.
    waitingForWorker: Boolean(r.waiting_for_worker),
  };
}

async function jobRow(tx: Tx, id: string, lock = false) {
  const { rows } = await tx.query(
    `SELECT j.*, EXISTS (SELECT 1 FROM sync_jobs s WHERE s.kind = 'import' AND s.resource_id = j.id AND s.status = 'pending'
                          AND s.next_attempt_at < now() - interval '30 seconds') AS waiting_for_worker
     FROM import_jobs j WHERE j.id = $1${lock ? ' FOR UPDATE OF j' : ''}`, [id]);
  if (!rows[0]) throw appError(404, 'NOT_FOUND', 'Import not found');
  return rows[0];
}

export const getImport = async (tx: Tx, id: string) => jobOut(await jobRow(tx, id));

export async function listImports(tx: Tx) {
  const { rows } = await tx.query('SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT 20');
  return rows.map(jobOut);
}

export async function startImport(tx: Tx, a: { userId: string; canCost: boolean; fileId: string; mapping: Partial<Record<ColumnKey, string>> }) {
  if (!a.canCost && a.mapping.cost) throw appError(403, 'FORBIDDEN', 'You do not have permission to import cost. Unmap the cost column.');
  await assertFile(tx, a.fileId, 'import', 'fileId');
  const { rows } = await tx.query(
    `INSERT INTO import_jobs (tenant_id, kind, file_id, mapping, created_by)
     VALUES (current_setting('app.tenant_id')::uuid, 'products', $1, $2, $3) RETURNING *`,
    [a.fileId, JSON.stringify(a.mapping), a.userId]);
  await enqueue(tx, 'import', rows[0].id, { maxAttempts: 1 });
  return jobOut(rows[0]);
}

export async function commitImport(tx: Tx, id: string) {
  const r = await jobRow(tx, id, true);
  if (r.status !== 'validated') throw appError(409, 'INVALID_STATE', 'This import is not ready to commit');
  if (r.valid_rows === 0) throw appError(409, 'INVALID_STATE', 'There are no valid rows to import');
  await tx.query("UPDATE import_jobs SET status = 'importing', updated_at = now() WHERE id = $1", [id]);
  await enqueue(tx, 'import', id, { maxAttempts: 1 });
  return jobOut({ ...r, status: 'importing' });
}

async function load(tx: Tx, r: Record<string, any>) {
  const { body } = await readFile(tx, r.file_id, 'import');
  const table = parseCsv(body.toString('utf8'));
  const header = (table[0] ?? []).map((h) => h.trim());
  const mapping = resolveMapping(header, r.mapping);
  const col = (k: ColumnKey) => header.indexOf(mapping[k] ?? '\u0000');
  const sku = col('sku'), bc = col('barcode');
  const data = table.slice(1, MAX_ROWS + 1);
  const refs = await importRefs(tx,
    sku < 0 ? [] : data.map((x) => (x[sku] ?? '').trim()).filter(Boolean),
    bc < 0 ? [] : data.map((x) => (x[bc] ?? '').trim()).filter(Boolean));
  return { table, mapping, refs };
}

/**
 * Background step. 'validating': check every row, store errors, write nothing.
 * 'importing': re-validate against the catalog as it is now, then insert all valid products in this one transaction.
 */
export async function runImport(tx: Tx, id: string) {
  const r = await jobRow(tx, id, true);
  if (r.status !== 'validating' && r.status !== 'importing') return;
  try {
    const { table, mapping, refs } = await load(tx, r);
    const result = validateRows(table, mapping, refs);
    let created = 0;
    if (r.status === 'importing' && result.products.length) {
      created = (await insertImportedProducts(tx, r.created_by, result.products)).products;
      await audit(tx, { actorId: r.created_by, action: 'import.commit', entityType: 'import', entityId: id,
        summary: { products: created, rows: result.validRows, errorRows: result.errorRows } });
    }
    await tx.query(
      `UPDATE import_jobs SET status = $2, mapping = $3, total_rows = $4, valid_rows = $5, error_rows = $6, errors = $7,
              created_count = $8, failure = NULL, updated_at = now() WHERE id = $1`,
      [id, r.status === 'importing' ? 'done' : 'validated', JSON.stringify(mapping), result.totalRows, result.validRows,
        result.errorRows, JSON.stringify(result.errors), created]);
  } catch (e) {
    if (!(e instanceof FileProblem) && !(e instanceof Error && /quoted value/.test(e.message))) throw e;
    await tx.query("UPDATE import_jobs SET status = 'failed', failure = $2, updated_at = now() WHERE id = $1", [id, e.message]);
  }
}

export async function markFailed(tx: Tx, id: string, message: string) {
  await tx.query("UPDATE import_jobs SET status = 'failed', failure = $2, updated_at = now() WHERE id = $1 AND status IN ('validating', 'importing')", [id, message]);
}

/** The original rows that had errors, with an "errors" column, so the user can fix them and upload just those. */
export async function errorReport(tx: Tx, id: string) {
  const r = await jobRow(tx, id);
  const { body } = await readFile(tx, r.file_id, 'import');
  const table = parseCsv(body.toString('utf8'));
  const byRow = new Map<number, string[]>();
  for (const e of r.errors as { row: number; column: string; message: string }[])
    byRow.set(e.row, [...(byRow.get(e.row) ?? []), `${e.column}: ${e.message}`]);
  const out: unknown[][] = [[...table[0], 'row', 'errors']];
  for (const [row, msgs] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) out.push([...(table[row - 1] ?? []), row, msgs.join('; ')]);
  return out;
}
