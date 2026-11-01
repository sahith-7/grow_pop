import { lookup as dnsLookup } from 'node:dns';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { wooEnv } from './env.js';

// Every request to a shop URL goes through here (06-security-and-backup.md T2: SSRF via the tenant-controlled site URL).
// - https on port 443 only; no redirects followed.
// - We resolve DNS ourselves, refuse private, loopback, link-local, CGNAT and metadata ranges, and connect to the address
//   we checked (no second lookup, so DNS rebinding cannot swap it).
// - 10 s timeout by default, 5 MB response cap.

export type NetProblem = 'dns' | 'tls' | 'unreachable' | 'private_address' | 'too_large' | 'timeout' | 'bad_url';

export class NetError extends Error {
  constructor(public problem: NetProblem, message: string) { super(message); this.name = 'NetError'; }
}

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64],
] as const) blocked.addSubnet(net, bits, 'ipv6');

/** IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) addresses are checked as the IPv4 address inside them. */
function embeddedV4(ip: string): string | null {
  const m = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1];
  const h = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (h) { const a = parseInt(h[1], 16), b = parseInt(h[2], 16); return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
  return null;
}

export function isPrivateAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return blocked.check(ip, 'ipv4');
  if (fam === 6) {
    const v4 = embeddedV4(ip);
    return v4 ? blocked.check(v4, 'ipv4') : blocked.check(ip, 'ipv6');
  }
  return true;
}

const allowPrivate = wooEnv.WOO_DEV_ALLOW_PRIVATE;
const devCa = wooEnv.WOO_DEV_CA_FILE && allowPrivate ? readFileSync(wooEnv.WOO_DEV_CA_FILE) : undefined;

/** Resolves once, refuses blocked addresses, and hands the checked address straight to the socket. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as { address: string; family: number }[];
    if (!list.length) return callback(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }), '', 0);
    if (!allowPrivate && list.some((a) => isPrivateAddress(a.address)))
      return callback(Object.assign(new Error('private address'), { code: 'EPRIVATE' }), '', 0);
    const pick = list[0];
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, [pick]);
    callback(null, pick.address, pick.family);
  });
};

/** Checks a shop URL before anything is sent to it. Returns the normalised origin + path (no trailing slash). */
export function checkShopUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new NetError('bad_url', 'Enter the full address of your shop, like https://shop.example.com'); }
  if (u.username || u.password || u.search || u.hash) throw new NetError('bad_url', 'Enter only the shop address, without a login, ? or #');
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) throw new NetError('bad_url', 'The shop address must start with https://');
  if (u.port && !(allowPrivate)) throw new NetError('bad_url', 'The shop must be on the standard https port (443)');
  if (isIP(u.hostname.replace(/^\[|\]$/g, '')) && !allowPrivate) throw new NetError('bad_url', 'Use the shop’s domain name, not an IP address');
  u.pathname = u.pathname.replace(/\/+$/, '');
  return u;
}

export interface Res { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

export function request(url: URL, opts: { method: string; headers?: Record<string, string>; body?: Buffer; timeoutMs?: number; maxBytes?: number }): Promise<Res> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const isHttps = url.protocol === 'https:';
  if (!isHttps && !allowPrivate) return Promise.reject(new NetError('bad_url', 'Only https is allowed'));
  // Node skips the lookup for IP literals, so check them here.
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) && !allowPrivate && isPrivateAddress(literal)) return Promise.reject(classify(Object.assign(new Error('private'), { code: 'EPRIVATE' })));
  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(url, {
      method: opts.method,
      headers: { 'user-agent': 'ERP-WooCommerce-Sync/1', accept: 'application/json', ...opts.headers, ...(opts.body ? { 'content-length': String(opts.body.length) } : {}) },
      lookup: guardedLookup,
      agent: false,
      ...(isHttps ? { servername: url.hostname, ...(devCa ? { ca: devCa } : {}) } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new NetError('too_large', 'The shop sent a response that is too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new NetError('timeout', 'The shop did not answer in time')));
    req.on('error', (e: NodeJS.ErrnoException) => reject(e instanceof NetError ? e : classify(e)));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function classify(e: NodeJS.ErrnoException): NetError {
  const code = e.code ?? '';
  if (code === 'EPRIVATE') return new NetError('private_address', 'The shop address points to a private network address');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new NetError('dns', 'The shop’s domain name could not be found');
  if (/CERT|SSL|TLS|SELF_SIGNED|ERR_TLS|UNABLE_TO_VERIFY|ALTNAME/i.test(code) || /certificate|ssl|tls/i.test(e.message))
    return new NetError('tls', 'The shop’s HTTPS certificate is not valid');
  return new NetError('unreachable', 'Could not connect to the shop');
}
