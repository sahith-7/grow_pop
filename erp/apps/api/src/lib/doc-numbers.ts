import type { Tx } from '../db.js';

export type DocType = 'PO' | 'GRN' | 'ADJ' | 'TRF' | 'ST' | 'SR' | 'RET' | 'PK';

/** Next number for a stock, purchasing, return or pick-list document: PO-00001, GRN-00001, RET-00001, PK-00001 … Gap-free per tenant because it rolls back with the document. */
export async function nextNumber(tx: Tx, type: DocType): Promise<string> {
  const { rows } = await tx.query(
    `INSERT INTO doc_sequences (tenant_id, doc_type, next_value) VALUES (current_setting('app.tenant_id')::uuid, $1, 2)
     ON CONFLICT (tenant_id, doc_type) DO UPDATE SET next_value = doc_sequences.next_value + 1
     RETURNING next_value - 1 AS n`, [type]);
  return `${type}-${String(rows[0].n).padStart(5, '0')}`;
}
