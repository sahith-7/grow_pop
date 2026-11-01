import type { InjectOptions } from 'fastify';
import { getApp } from './b2-helpers.js';

/** Calls the API as a browser would through the web proxy: session cookie + our Origin. */
export async function api(cookie: string, method: InjectOptions['method'], url: string, body?: unknown, headers: Record<string, string> = {}) {
  const app = await getApp();
  const isBuf = Buffer.isBuffer(body);
  const res = await app.inject({
    method, url,
    headers: { cookie, origin: 'http://localhost:3000', ...(body !== undefined && !isBuf ? { 'content-type': 'application/json' } : {}), ...headers },
    payload: body === undefined ? undefined : isBuf ? (body as Buffer) : JSON.stringify(body),
  });
  let json: any = undefined;
  try { json = res.json(); } catch { /* not JSON */ }
  return { status: res.statusCode, body: json, text: res.body, headers: res.headers };
}
