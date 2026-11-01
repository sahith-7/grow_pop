import { z } from 'zod';

// Money and quantities travel as decimal strings and are stored as numeric. They never pass through a JS float.
export const money = z.string().trim().regex(/^\d{1,10}(\.\d{1,4})?$/, 'Enter an amount like 1299 or 1299.50');
export const qty = z.string().trim().regex(/^\d{1,11}(\.\d{1,3})?$/, 'Enter a quantity like 5 or 2.5');

/** Postgres numeric text ('1299.5000') -> API string with at least 2 decimals ('1299.50'). */
export function fmtMoney(v: string | null): string | null {
  if (v === null) return null;
  const [i, f = ''] = v.split('.');
  const t = f.replace(/0+$/, '');
  return `${i}.${t.padEnd(2, '0')}`;
}

/** Postgres numeric text ('2.500') -> '2.5'; integers lose the point. */
export function fmtQty(v: string | null): string | null {
  if (v === null) return null;
  if (!v.includes('.')) return v;
  return v.replace(/\.?0+$/, '');
}
