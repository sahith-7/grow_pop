import { NetError, request } from './http.js';

// WooCommerce REST API v3 over https with the shop's consumer key and secret (Basic auth; Woo only accepts it over https).
// Errors are sorted into the three things a caller does about them: retry later, stop and tell the user, or fix the data.

export type WooErrorKind =
  | 'retry'          // network trouble, 5xx, 429: try again later
  | 'auth'           // 401/403: the key was revoked, lost write access, or the shop blocks the Authorization header
  | 'not_found'      // 404 on a specific object: it was deleted in Woo
  | 'invalid'        // 400/409/422: Woo refused the data; a retry will not help
  | 'not_woocommerce';

export class WooError extends Error {
  constructor(public kind: WooErrorKind, message: string, public status = 0, public wooCode?: string, public retryAfterSec?: number) {
    super(message);
    this.name = 'WooError';
  }
}

export interface WooCreds { siteUrl: string; consumerKey: string; consumerSecret: string }

type Query = Record<string, string | number | boolean | undefined>;

export class WooClient {
  private base: URL;
  private auth: string;
  constructor(creds: WooCreds) {
    this.base = new URL(creds.siteUrl);
    this.auth = `Basic ${Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64')}`;
  }

  url(path: string, query: Query = {}) {
    const u = new URL(this.base.toString());
    u.pathname = `${this.base.pathname.replace(/\/+$/, '')}/wp-json/wc/v3${path}`;
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u;
  }

  async call<T = any>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: { query?: Query; body?: unknown; timeoutMs?: number } = {}): Promise<{ data: T; headers: Record<string, string | string[] | undefined> }> {
    let res;
    try {
      res = await request(this.url(path, opts.query), {
        method,
        headers: { authorization: this.auth, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : undefined,
        timeoutMs: opts.timeoutMs,
      });
    } catch (e) {
      // A private or malformed address is a setup problem the caller reports as it is; anything else on the network is worth a retry.
      if (e instanceof NetError && e.problem !== 'private_address' && e.problem !== 'bad_url') throw new WooError('retry', e.message);
      throw e;
    }
    let data: any;
    const text = res.body.toString('utf8');
    try { data = text ? JSON.parse(text) : null; } catch { data = undefined; }
    if (res.status >= 200 && res.status < 300) {
      if (data === undefined) throw new WooError('not_woocommerce', 'The shop answered, but not with WooCommerce data', res.status);
      return { data, headers: res.headers };
    }
    const code = typeof data?.code === 'string' ? data.code : undefined;
    // Woo's own message, trimmed; never the request (which carries credentials in a header, not the URL).
    const msg = (typeof data?.message === 'string' ? data.message : `HTTP ${res.status}`).replace(/<[^>]*>/g, '').slice(0, 300);
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers['retry-after']);
      throw new WooError('retry', `WooCommerce is busy or failing (${res.status}): ${msg}`, res.status, code, Number.isFinite(ra) ? ra : undefined);
    }
    if (res.status === 401 || res.status === 403) throw new WooError('auth', msg, res.status, code);
    if (res.status === 404 && (code === 'rest_no_route' || data === undefined)) throw new WooError('not_woocommerce', 'WooCommerce was not found at this address', res.status, code);
    if (res.status === 404) throw new WooError('not_found', msg, res.status, code);
    throw new WooError('invalid', msg, res.status, code);
  }

  get<T = any>(path: string, query?: Query) { return this.call<T>('GET', path, { query }).then((r) => r.data); }
  post<T = any>(path: string, body: unknown, timeoutMs?: number) { return this.call<T>('POST', path, { body, timeoutMs }).then((r) => r.data); }
  put<T = any>(path: string, body: unknown, timeoutMs?: number) { return this.call<T>('PUT', path, { body, timeoutMs }).then((r) => r.data); }
  del<T = any>(path: string, query?: Query) { return this.call<T>('DELETE', path, { query }).then((r) => r.data); }

  /** Every page of a list endpoint. `_fields` keeps responses small. Stops at `maxPages` as a safety net. */
  async all<T = any>(path: string, query: Query = {}, maxPages = 200): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data, headers } = await this.call<T[]>('GET', path, { query: { per_page: 100, ...query, page } });
      out.push(...data);
      const total = Number(headers['x-wp-totalpages'] ?? 1);
      if (page >= total || data.length === 0) break;
    }
    return out;
  }
}
