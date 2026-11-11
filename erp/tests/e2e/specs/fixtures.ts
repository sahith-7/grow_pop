import { createHmac, randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

// Test stores are signed up through Phase 1's real API (the same calls the app's own tests use), then set up for
// billing, so each test starts from a store that can sell. Cookies land in the page's browser context.

export const PASSWORD = 'e2e correct horse battery';

export async function newStore(page: Page) {
  const run = randomUUID().slice(0, 8);
  const origin = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3000').origin;
  const req = page.request;
  const headers = { origin };
  const name = `E2E ${run}`;
  const email = `e2e-${run}@example.com`;
  const reg = await req.post('/api/v1/auth/register', { headers, data: { businessName: name, name: 'E2E Owner', email, password: PASSWORD } });
  expect(reg.status(), await reg.text()).toBe(201);
  const s = await req.patch('/api/v1/settings', { headers, data: { address: '12 MG Road', city: 'Pune', state: 'Maharashtra', postalCode: '411001' } });
  expect(s.status(), `PATCH /v1/settings: ${await s.text()}`).toBe(200);
  const b = await req.patch('/api/v1/billing/settings', { headers, data: { gstScheme: 'unregistered', stateCode: '27' } });
  expect(b.status(), await b.text()).toBe(200);
  const sku = `E2E-${run}`;
  // v2 (D88): every new product needs a category.
  const cat = await req.post('/api/v1/categories', { headers, data: { name: 'General' } });
  expect(cat.status(), await cat.text()).toBe(201);
  const categoryId = (await cat.json()).id as string;
  const p = await req.post('/api/v1/products', { headers, data: { name: `Cotton kurta ${run}`, categoryId, type: 'simple', status: 'active', unitCode: 'NOS', variants: [{ sku, price: '499' }] } });
  expect(p.status(), await p.text()).toBe(201);
  const variantId = (await p.json()).variants[0].id;
  const locs = (await (await req.get('/api/v1/locations')).json()).items as { id: string; type: string }[];
  const shop = locs.find((l) => l.type === 'shop_floor')!.id;
  const adj = await req.post('/api/v1/stock/adjustments', { headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { locationId: shop, reasonCode: 'correction', note: 'e2e stock', lines: [{ variantId, qtyDelta: '10' }] } });
  expect(adj.status(), await adj.text()).toBe(201);
  return { name, email, sku, variantId, origin };
}

/** RFC 6238 code for the console sign-in. */
export function totp(secretB32: string, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0; const bytes: number[] = [];
  for (const ch of secretB32.toUpperCase().replace(/[\s=]/g, '')) {
    value = (value << 5) | alphabet.indexOf(ch); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, '0');
}
