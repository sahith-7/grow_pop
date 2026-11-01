import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getApp } from './b2-helpers.js';

// A small in-memory WooCommerce REST v3 for CI, covering only the calls B4 makes, with Woo's response shapes
// (checked against a real WooCommerce 11.1.2). Not a substitute for CHECK-B4.md's run against a real shop.

export const RW = { key: `ck_${'a'.repeat(40)}`, secret: `cs_${'b'.repeat(40)}` };
export const RO = { key: `ck_${'c'.repeat(40)}`, secret: `cs_${'d'.repeat(40)}` };

export interface Hook { id: number; name: string; topic: string; delivery_url: string; secret: string; status: string }
interface Prod { id: number; type: string; parent_id: number; name: string; sku: string; regular_price: string; stock_quantity: number | null; status: string; attributes: unknown[]; categories: unknown[]; images: { id: number; src: string }[]; meta_data: { key: string; value: unknown }[]; description: string; date_modified_gmt: string }

export class FakeWoo {
  server!: http.Server;
  url = '';
  hooks = new Map<number, Hook>();
  products = new Map<number, Prod>();
  categories: { id: number; name: string; parent: number }[] = [];
  orders = new Map<number, any>();
  notes: { orderId: number; note: string; customer_note: boolean }[] = [];   // B6
  calls: string[] = [];
  private seq = 100;
  failNext: number | null = null;   // respond with this status once
  failWhen: ((method: string, path: string) => number | null) | null = null;   // B6: fail one particular call
  ownHook: (h: Hook) => boolean = () => true;   // which store's webhooks deliver() uses when several stores connect

  async start() {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
          res.writeHead(status, { 'content-type': 'application/json', ...headers });
          res.end(JSON.stringify(data));
        };
        try { this.handle(req, body ? JSON.parse(body) : undefined, send); } catch (e) { send(500, { code: 'x', message: String(e) }); }
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  stop() { return new Promise((r) => this.server.close(r)); }

  private id() { return ++this.seq; }
  addProduct(p: Partial<Prod>) {
    const id = this.id();
    const full: Prod = { id, type: 'simple', parent_id: 0, name: '', sku: '', regular_price: '', stock_quantity: null, status: 'publish', attributes: [], categories: [], images: [], meta_data: [], description: '', date_modified_gmt: '', ...p };
    this.products.set(id, full);
    return full;
  }

  private handle(req: http.IncomingMessage, body: any, send: (s: number, d: unknown, h?: Record<string, string>) => void) {
    const u = new URL(req.url!, 'http://x');
    const path = u.pathname.replace(/^\/wp-json\/wc\/v3/, '');
    const q = u.searchParams;
    this.calls.push(`${req.method} ${path}`);
    if (this.failNext) { const s = this.failNext; this.failNext = null; return send(s, { code: 'busy', message: 'Busy' }); }
    const forced = this.failWhen?.(req.method!, path);
    if (forced) return send(forced, { code: 'busy', message: 'Busy' });
    const auth = Buffer.from(String(req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    const isRw = auth === `${RW.key}:${RW.secret}`, isRo = auth === `${RO.key}:${RO.secret}`;
    if (!isRw && !isRo) return send(401, { code: 'woocommerce_rest_authentication_error', message: 'Consumer secret is invalid.' });
    if (isRo && req.method !== 'GET') return send(401, { code: 'woocommerce_rest_authentication_error', message: 'The API key provided does not have write permissions.' });
    let m: RegExpExecArray | null;
    const list = (items: unknown[]) => {
      const per = Number(q.get('per_page') ?? 10), page = Number(q.get('page') ?? 1);
      send(200, items.slice((page - 1) * per, page * per), { 'x-wp-totalpages': String(Math.max(1, Math.ceil(items.length / per))) });
    };
    if (path === '/system_status') return send(200, { environment: { version: '11.1.2' }, settings: { currency: 'INR' } });
    if (path === '/settings/products/woocommerce_weight_unit') return send(200, { value: 'kg' });
    if (path === '/settings/products/woocommerce_dimension_unit') return send(200, { value: 'cm' });
    if (path === '/settings/tax/woocommerce_prices_include_tax') return send(200, { value: 'yes' });
    if (path === '/webhooks/batch') return send(200, {});
    if (path === '/webhooks' && req.method === 'GET') return list([...this.hooks.values()]);
    if (path === '/webhooks' && req.method === 'POST') { const h = { id: this.id(), ...body }; this.hooks.set(h.id, h); return send(201, h); }
    if ((m = /^\/webhooks\/(\d+)$/.exec(path))) {
      const h = this.hooks.get(Number(m[1]));
      if (!h) return send(404, { code: 'woocommerce_rest_webhook_invalid_id', message: 'Invalid ID.' });
      if (req.method === 'DELETE') { this.hooks.delete(h.id); return send(200, h); }
      Object.assign(h, body); return send(200, h);
    }
    if (path === '/products/categories' && req.method === 'GET') return list(this.categories.filter((c) => c.name.toLowerCase().includes((q.get('search') ?? '').toLowerCase())));
    if (path === '/products/categories') { const c = { id: this.id(), name: body.name, parent: body.parent ?? 0 }; this.categories.push(c); return send(201, c); }
    if (path === '/products' && req.method === 'GET') {
      let items = [...this.products.values()];
      const skus = q.get('sku')?.toLowerCase().split(',');
      if (skus) items = items.filter((p) => skus.includes(p.sku.toLowerCase()));
      else items = items.filter((p) => p.type !== 'variation');
      if (q.get('include')) { const ids = q.get('include')!.split(',').map(Number); items = items.filter((p) => ids.includes(p.id)); }
      if (q.get('search')) items = items.filter((p) => p.name.toLowerCase().includes(q.get('search')!.toLowerCase()));
      return list(items);
    }
    if (path === '/products' && req.method === 'POST') return send(201, this.save(this.addProduct({}), body));
    if (path === '/products/batch') {
      return send(200, { update: (body.update ?? []).map((b: any) => { const p = this.products.get(b.id); return p ? this.save(p, b) : { id: b.id, error: { code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.' } }; }) });
    }
    if ((m = /^\/products\/(\d+)$/.exec(path))) {
      const p = this.products.get(Number(m[1]));
      if (!p || p.type === 'variation') return send(404, { code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.' });
      if (req.method === 'GET') return send(200, p);
      return send(200, this.save(p, body));
    }
    if ((m = /^\/products\/(\d+)\/variations$/.exec(path))) return list([...this.products.values()].filter((p) => p.parent_id === Number(m![1])));
    if ((m = /^\/products\/(\d+)\/variations\/batch$/.exec(path))) {
      const parent = Number(m[1]);
      return send(200, {
        create: (body.create ?? []).map((b: any) => this.save(this.addProduct({ type: 'variation', parent_id: parent }), b)),
        update: (body.update ?? []).map((b: any) => { const p = this.products.get(b.id); return p ? this.save(p, b) : { id: b.id, error: { code: 'woocommerce_rest_product_variation_invalid_id', message: 'Invalid ID.' } }; }),
      });
    }
    if (path === '/orders') {
      let items = [...this.orders.values()];
      if (q.get('status')) items = items.filter((o) => q.get('status')!.split(',').includes(o.status));
      if (q.get('modified_after')) items = items.filter((o) => o.date_modified_gmt > q.get('modified_after')!);
      return list(items);
    }
    // B6: the dispatch update (tracking note, then "completed").
    if ((m = /^\/orders\/(\d+)\/notes$/.exec(path)) && req.method === 'POST') {
      if (!this.orders.has(Number(m[1]))) return send(404, { code: 'woocommerce_rest_order_invalid_id', message: 'Invalid order ID.' });
      const n = { id: this.id(), orderId: Number(m[1]), note: body.note, customer_note: !!body.customer_note };
      this.notes.push(n);
      return send(201, n);
    }
    if ((m = /^\/orders\/(\d+)$/.exec(path))) {
      const o = this.orders.get(Number(m[1]));
      if (!o) return send(404, { code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.' });
      if (req.method === 'GET') return send(200, o);
      Object.assign(o, body, { date_modified_gmt: new Date(Date.now() + this.seq++ * 1000).toISOString().slice(0, 19) });
      return send(200, o);
    }
    send(404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' });
  }

  private save(p: Prod, b: any) {
    const { images, ...rest } = b;
    Object.assign(p, rest);
    if (b.meta_data) p.meta_data = b.meta_data;
    if (images) p.images = images.map((i: any) => (i.id ? { id: i.id, src: '' } : { id: this.id(), src: i.src }));
    p.date_modified_gmt = new Date().toISOString().slice(0, 19);
    return p;
  }

  // ---------------------------------------------------------------- what Woo sends us

  order(o: Partial<any> & { line_items: any[] }) {
    const id = o.id ?? this.id();
    const now = new Date(Date.now() + this.seq * 1000).toISOString().slice(0, 19);   // strictly increasing modified times
    const full = { id, number: String(id), status: 'processing', currency: 'INR', customer_id: 0, date_created_gmt: now, date_modified_gmt: now,
      date_paid_gmt: null, payment_method: 'cod', payment_method_title: 'Cash on delivery', total: '0', total_tax: '0', shipping_total: '0',
      discount_total: '0', billing: { first_name: 'Asha', phone: '9876543210' }, shipping: {}, refunds: [], ...this.orders.get(id), ...o,
      line_items: o.line_items.map((l, i) => ({ id: l.id ?? id * 100 + i, product_id: 0, variation_id: 0, sku: '', name: 'Item', price: 100, total: '100', total_tax: '0', ...l })) };
    full.date_modified_gmt = o.date_modified_gmt ?? now;
    this.seq++;
    this.orders.set(id, full);
    return full;
  }

  /** POST a webhook to the ERP exactly as Woo does: raw JSON body, base64 HMAC-SHA256 with the webhook's secret. */
  async deliver(topic: string, payload: unknown, opts: { signature?: string; raw?: string } = {}) {
    const hook = [...this.hooks.values()].find((h) => h.topic === topic && this.ownHook(h));
    if (!hook) throw new Error(`no webhook for ${topic}`);
    const raw = opts.raw ?? JSON.stringify(payload);
    const sig = opts.signature ?? createHmac('sha256', hook.secret).update(raw).digest('base64');
    const app = await getApp();
    return app.inject({
      method: 'POST', url: new URL(hook.delivery_url).pathname.replace(/^\/api/, ''), payload: raw,
      headers: { 'content-type': 'application/json', 'x-wc-webhook-topic': topic, 'x-wc-webhook-signature': sig, 'x-wc-webhook-delivery-id': 'abc' },
    });
  }
}
