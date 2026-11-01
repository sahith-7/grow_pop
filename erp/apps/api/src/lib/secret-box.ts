import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { wooEnv } from '../modules/woocommerce/env.js';
import { appError } from './phase1.js';

// AES-256-GCM for secrets stored in the database (Woo credentials, T4). The ciphertext is bound to its tenant and field
// (additional authenticated data), so a value copied into another tenant's row or another column will not decrypt.
// Format: 1 byte version | 8 bytes key id | 12 bytes IV | 16 bytes tag | ciphertext.
// Swapping the env key for AWS KMS (envelope encryption) at staging changes only this file.

const VERSION = 1;

interface Key { id: Buffer; key: Buffer }

function parseKey(b64: string | undefined): Key | null {
  if (!b64) return null;
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('WOO_ENC_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)');
  return { id: createHash('sha256').update(key).digest().subarray(0, 8), key };
}

const testKey = { id: Buffer.alloc(8, 1), key: Buffer.alloc(32, 7) };
const current = parseKey(wooEnv.WOO_ENC_KEY) ?? (wooEnv.NODE_ENV === 'test' ? testKey : null);
const previous = parseKey(wooEnv.WOO_ENC_KEY_PREVIOUS);

function need(): Key {
  if (!current) throw appError(503, 'ENCRYPTION_NOT_CONFIGURED', 'WOO_ENC_KEY is not set on this server, so WooCommerce cannot be connected');
  return current;
}

const aad = (tenantId: string, field: string) => Buffer.from(`${tenantId}:${field}`);

export function seal(plain: string, tenantId: string, field: string): Buffer {
  const k = need();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.key, iv);
  c.setAAD(aad(tenantId, field));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), k.id, iv, c.getAuthTag(), ct]);
}

export function open(box: Buffer, tenantId: string, field: string): string {
  if (box[0] !== VERSION) throw new Error('unknown secret format');
  const id = box.subarray(1, 9);
  const k = [current, previous].find((x) => x && x.id.equals(id));
  if (!k) throw new Error('secret was encrypted with a key this server does not have');
  const d = createDecipheriv('aes-256-gcm', k.key, box.subarray(9, 21));
  d.setAAD(aad(tenantId, field));
  d.setAuthTag(box.subarray(21, 37));
  return Buffer.concat([d.update(box.subarray(37)), d.final()]).toString('utf8');
}

/** True when the value was sealed with the previous key and should be re-sealed (key rotation). */
export const needsReseal = (box: Buffer) => !!current && !box.subarray(1, 9).equals(current.id);

/** A key for signing short-lived URLs, derived from the encryption key so there is one secret to manage. */
export function signingKey(purpose: string): Buffer {
  return createHash('sha256').update(need().key).update(`:${purpose}`).digest();
}
