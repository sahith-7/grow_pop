// k6 load test (B7b): 20 stores, 5 people each working at once, p95 under 500 ms.
// Run against STAGING only, never production: it signs up 20 test stores.
//
//   k6 run -e BASE_URL=http://web:3000 -e ORIGIN=https://staging.example.com pos-load.js   (on the staging server)
//
// What each person does in a loop, roughly what a till and a back office do: barcode lookup, product search, stock
// list, a stock adjustment (a write with ledger locks), the dashboard, and the web orders list.
// Everything goes through the web app's /api proxy, as a browser would.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const API = `${BASE}/api/v1`;
// The API accepts writes only from its own web origin (CSRF check). Straight at web on the server, say which one it is.
const ORIGIN = __ENV.ORIGIN || BASE;
const STORES = Number(__ENV.STORES || 20);
const PEOPLE = Number(__ENV.PEOPLE || 5);
const PRODUCTS = 20;
// Idempotency keys must be UUIDs.
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.floor(Math.random() * 16);
  return (c === 'x' ? r : (r & 3) | 8).toString(16);
});

export const options = {
  setupTimeout: '10m',
  scenarios: {
    shops: { executor: 'constant-vus', vus: STORES * PEOPLE, duration: __ENV.DURATION || '5m' },
  },
  thresholds: {
    'http_req_duration{kind:read}': ['p(95)<500'],
    'http_req_duration{kind:write}': ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

// Each store's people share one address, as tills behind a shop's router do. The API limits requests per address
// (1,200 a minute), so the stores need distinct addresses, sent as X-Forwarded-For. Through Cloudflare your real
// address is appended and wins, so every store would share one budget and you would measure the rate limit, not the
// app. Run this on the staging server itself, straight at web (docs/runbooks/testing.md).
const addressOf = (store) => `10.77.${Math.floor(store / 250)}.${(store % 250) + 1}`;
const json = (cookie, extra = {}, store = 0) => ({
  headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': addressOf(store), ...(cookie ? { cookie } : {}), ...extra },
});

function cookieFrom(res) {
  const set = res.headers['Set-Cookie'] || '';
  const first = set.split(';')[0];
  if (!first.includes('=')) throw new Error(`sign-up gave no session cookie: ${res.status} ${res.body}`);
  return first;
}

export function setup() {
  const run = Date.now().toString(36);
  const stores = [];
  for (let s = 0; s < STORES; s++) {
    const reg = http.post(`${API}/auth/register`, JSON.stringify({
      businessName: `Load ${run} ${s}`, name: 'Load Owner', email: `load-${run}-${s}@example.com`, password: `load test password ${run}`,
    }), json(undefined, {}, s));
    check(reg, { 'signed up': (r) => r.status === 201 });
    const cookie = cookieFrom(reg);
    const locs = http.get(`${API}/locations`, json(cookie, {}, s)).json('items');
    const shop = locs.find((l) => l.type === 'shop_floor').id;
    const items = [];
    for (let p = 0; p < PRODUCTS; p++) {
      const sku = `L${run}-${s}-${p}`;
      const r = http.post(`${API}/products`, JSON.stringify({
        name: `Load item ${p}`, type: 'simple', status: 'active', unitCode: 'NOS', variants: [{ sku, price: '100', barcode: `${s}${p}${run}`.slice(0, 13) }],
      }), json(cookie, {}, s));
      if (r.status !== 201) throw new Error(`product: ${r.status} ${r.body}`);
      items.push({ sku, variantId: r.json('variants.0.id') });
    }
    const open = http.post(`${API}/stock/adjustments`, JSON.stringify({
      locationId: shop, reasonCode: 'correction', note: 'load test opening stock',
      lines: items.map((i) => ({ variantId: i.variantId, qtyDelta: '1000' })),
    }), json(cookie, { 'idempotency-key': uuid() }, s));
    if (open.status !== 201) throw new Error(`opening stock: ${open.status} ${open.body}`);
    stores.push({ index: s, cookie, shop, items });
  }
  return { stores };
}

export default function (data) {
  const store = data.stores[(__VU - 1) % data.stores.length];
  const item = store.items[Math.floor(Math.random() * store.items.length)];
  const read = { ...json(store.cookie, {}, store.index), tags: { kind: 'read' } };

  check(http.get(`${API}/pos/lookup?q=${encodeURIComponent(item.sku)}`, read), { lookup: (r) => r.status === 200 });
  check(http.get(`${API}/products?q=Load`, read), { search: (r) => r.status === 200 });
  check(http.get(`${API}/stock/balances`, read), { stock: (r) => r.status === 200 });
  sleep(0.5);
  const w = http.post(`${API}/stock/adjustments`, JSON.stringify({
    locationId: store.shop, reasonCode: 'correction', note: 'load', lines: [{ variantId: item.variantId, qtyDelta: Math.random() < 0.5 ? '1' : '-1' }],
  }), { ...json(store.cookie, { 'idempotency-key': uuid() }, store.index), tags: { kind: 'write' } });
  check(w, { adjust: (r) => r.status === 201 });
  check(http.get(`${API}/dashboard`, read), { dashboard: (r) => r.status === 200 });
  check(http.get(`${API}/orders`, read), { orders: (r) => r.status === 200 });
  sleep(1 + Math.random());
}
