import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// RFC 6238 time-based one-time codes (authenticator apps): HMAC-SHA1, 30-second steps, 6 digits. No package needed.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 encoded (what authenticator apps expect). */
export const newSecret = () => base32Encode(randomBytes(20));

export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS);

export function codeAt(secretB32: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/**
 * The time step the code belongs to (now, or one step either side for clock drift), or null. The caller must refuse a step
 * at or before the last one it accepted, so a code works once.
 */
export function verify(secretB32: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const cur = stepAt(now);
  for (const step of [cur, cur - 1, cur + 1]) {
    if (timingSafeEqual(Buffer.from(codeAt(secretB32, step)), Buffer.from(code))) return step;
  }
  return null;
}

export const otpauthUri = (issuer: string, account: string, secretB32: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
