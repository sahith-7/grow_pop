import { createHmac, timingSafeEqual } from 'node:crypto';
import { tenantTx } from '../../db.js';
import { signingKey } from '../../lib/secret-box.js';
import { readFile } from '../files/service.js';
import { wooEnv } from './env.js';

// WooCommerce adds a product image by downloading it from a URL. The bucket is private (D22), so the worker hands Woo a
// signed link to the API that works for 15 minutes and for one file only. It goes through the same public base URL as
// the webhooks, which Woo can already reach. WordPress decides the file type from the URL, so it ends in .jpg/.png/.webp.
// Token = tenant id + file id + expiry (36 bytes) and a 16-byte HMAC, base64url: short enough for one path segment.

const TTL_SEC = 15 * 60;
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const mac = (data: Buffer) => createHmac('sha256', signingKey('woo-media')).update(data).digest().subarray(0, 16);
const uuidBytes = (u: string) => Buffer.from(u.replace(/-/g, ''), 'hex');
const uuidText = (b: Buffer) => b.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

export function imageUrl(tenantId: string, fileId: string, contentType: string, now = Date.now()) {
  const ext = EXT[contentType];
  if (!ext) throw new Error(`not an image type: ${contentType}`);
  const exp = Buffer.alloc(4);
  exp.writeUInt32BE(Math.floor(now / 1000) + TTL_SEC);
  const data = Buffer.concat([uuidBytes(tenantId), uuidBytes(fileId), exp]);
  const token = Buffer.concat([data, mac(data)]).toString('base64url');
  return `${wooEnv.WOO_WEBHOOK_BASE_URL!.replace(/\/+$/, '')}/v1/webhooks/woocommerce/media/${token}.${ext}`;
}

export async function readImage(name: string) {
  const m = /^([A-Za-z0-9_-]{70})\.(jpg|png|webp)$/.exec(name);
  if (!m) return null;
  const raw = Buffer.from(m[1], 'base64url');
  if (raw.length !== 52) return null;
  const data = raw.subarray(0, 36), given = raw.subarray(36);
  if (!timingSafeEqual(given, mac(data))) return null;
  if (data.readUInt32BE(32) < Date.now() / 1000) return null;
  const tenantId = uuidText(data.subarray(0, 16)), fileId = uuidText(data.subarray(16, 32));
  const f = await tenantTx(tenantId, (tx) => readFile(tx, fileId, 'product_image')).catch(() => null);
  if (!f || EXT[f.contentType] !== m[2]) return null;
  return f;
}
