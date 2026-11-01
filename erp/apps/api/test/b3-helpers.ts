import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { api } from './b2-api.js';

/** A simple active product; returns its variant id. `unitCode: 'KGS'` makes a fractional item. */
export async function makeItem(cookie: string, sku = `B3-${randomUUID().slice(0, 8)}`, extra: Record<string, unknown> = {}, unitCode = 'NOS') {
  const res = await api(cookie, 'POST', '/v1/products', { name: `Item ${sku}`, type: 'simple', status: 'active', unitCode, variants: [{ sku, price: '100', ...extra }] });
  expect(res.status, res.text).toBe(201);
  return res.body.variants[0].id as string;
}

export async function locations(cookie: string) {
  const res = await api(cookie, 'GET', '/v1/locations');
  expect(res.status, res.text).toBe(200);
  const items = res.body.items as { id: string; name: string; type: string }[];
  return { shop: items.find((l) => l.type === 'shop_floor')!.id, back: items.find((l) => l.type === 'back_room')!.id, all: items };
}

export async function adjust(cookie: string, locationId: string, reasonCode: string, lines: { variantId: string; qtyDelta: string; bucket?: string; unitCost?: string }[], extra: Record<string, unknown> = {}) {
  return api(cookie, 'POST', '/v1/stock/adjustments', { locationId, reasonCode, lines, ...extra });
}

/** Sellable on hand for one variant at one location (or across all). */
export async function onHand(cookie: string, variantId: string, locationId?: string) {
  const res = await api(cookie, 'GET', `/v1/stock/balances?limit=100${locationId ? `&locationId=${locationId}` : ''}`);
  expect(res.status, res.text).toBe(200);
  const row = (res.body.items as { variantId: string; onHand: string; nonSellable: string; available: string }[]).find((r) => r.variantId === variantId);
  return row ?? { onHand: '0', nonSellable: '0', available: '0' };
}

export const key = () => ({ 'idempotency-key': randomUUID() });
