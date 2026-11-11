import type { InjectOptions } from 'fastify';
import { getApp } from './b2-helpers.js';

// v2 (D88): new products need a category. Tests written before that rule get one called "General" per store, added here
// so each test does not have to; a test that passes categoryId (even null) is left alone.
const generalCategory = new Map<string, string>();
async function withCategory(cookie: string, body: Record<string, unknown>) {
  if ('categoryId' in body) return body;
  let id = generalCategory.get(cookie);
  if (!id) {
    const made = await api(cookie, 'POST', '/v1/categories', { name: 'General' });
    id = made.status === 201 ? made.body.id as string
      : (await api(cookie, 'GET', '/v1/categories')).body.items.find((c: { name: string }) => c.name === 'General')?.id as string;
    if (id) generalCategory.set(cookie, id);
  }
  return id ? { ...body, categoryId: id } : body;
}

/** Calls the API as a browser would through the web proxy: session cookie + our Origin. */
export async function api(cookie: string, method: InjectOptions['method'], url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; text: string; headers: Record<string, unknown> }> {
  if (method === 'POST' && url === '/v1/products' && body && typeof body === 'object' && !Buffer.isBuffer(body)) body = await withCategory(cookie, body as Record<string, unknown>);
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
