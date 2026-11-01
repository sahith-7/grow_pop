import { createHash, randomUUID } from 'node:crypto';
import type { Tx } from '../../db.js';
import { appError } from '../../lib/phase1.js';
import { objects } from '../../lib/objects.js';

export type FileKind = 'product_image' | 'import';

const LIMITS: Record<FileKind, { types: Record<string, string>; maxBytes: number }> = {
  product_image: { types: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }, maxBytes: 5 * 1024 * 1024 },
  import: { types: { 'text/csv': 'csv' }, maxBytes: 10 * 1024 * 1024 },
};
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The declared type is never trusted: the first bytes must match it. SVG and anything else are refused (D8). */
function contentMatches(type: string, b: Buffer): boolean {
  switch (type) {
    case 'image/jpeg': return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png': return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/webp': return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'text/csv':
      if (b.includes(0)) return false;
      try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; } catch { return false; }
    default: return false;
  }
}

export interface StoredFile { id: string; kind: FileKind; contentType: string; byteSize: number; sha256: string }

export async function storeUpload(tx: Tx, a: { tenantId: string; userId: string; kind: FileKind; contentType: string; body: Buffer; name?: string }): Promise<StoredFile> {
  const rule = LIMITS[a.kind];
  const type = a.contentType.split(';')[0].trim().toLowerCase();
  const ext = rule.types[type];
  if (!ext) throw appError(415, 'UNSUPPORTED_FILE_TYPE', a.kind === 'import' ? 'Upload a CSV file' : 'Use a JPEG, PNG or WebP image');
  if (!a.body.length) throw appError(400, 'VALIDATION_ERROR', 'The file is empty');
  if (a.body.length > rule.maxBytes) throw appError(413, 'FILE_TOO_LARGE', `Files of this kind can be at most ${rule.maxBytes / 1024 / 1024} MB`);
  if (!contentMatches(type, a.body)) throw appError(415, 'UNSUPPORTED_FILE_TYPE', a.kind === 'import' ? 'The file is not UTF-8 CSV. In Excel use "Save as → CSV UTF-8".' : 'The file content does not match its image type');

  const id = randomUUID();
  const key = `${a.tenantId}/${a.kind}/${id}.${ext}`;
  const sha256 = createHash('sha256').update(a.body).digest('hex');
  // Upload first: if the insert then fails, an orphan object is harmless; a row without its object would not be.
  await objects.put(key, a.body, type);
  await tx.query(
    `INSERT INTO files (id, tenant_id, kind, object_key, content_type, byte_size, sha256, original_name, created_by)
     VALUES ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4, $5, $6, $7, $8)`,
    [id, a.kind, key, type, a.body.length, sha256, a.name?.slice(0, 200) ?? null, a.userId]);
  return { id, kind: a.kind, contentType: type, byteSize: a.body.length, sha256 };
}

export async function getFile(tx: Tx, id: string, kind: FileKind) {
  const { rows } = await tx.query('SELECT object_key, content_type FROM files WHERE id = $1 AND kind = $2', [id, kind]);
  if (!rows[0]) throw appError(404, 'NOT_FOUND', 'File not found');
  return { key: rows[0].object_key as string, contentType: rows[0].content_type as string };
}

export async function readFile(tx: Tx, id: string, kind: FileKind) {
  const f = await getFile(tx, id, kind);
  return { ...f, body: await objects.get(f.key) };
}

/** Throws a field error unless `id` is a file of `kind` in this tenant. */
export async function assertFile(tx: Tx, id: string, kind: FileKind, field: string) {
  const { rowCount } = await tx.query('SELECT 1 FROM files WHERE id = $1 AND kind = $2', [id, kind]);
  if (!rowCount) throw appError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { [field]: ['File not found; upload it again'] });
}
