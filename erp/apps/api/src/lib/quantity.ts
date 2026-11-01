// Exact quantity arithmetic for stock. Quantities are numeric(14,3) in Postgres and decimal strings in the API;
// here they are whole thousandths in a BigInt, so 0.1 + 0.2 is exactly 0.3 and nothing passes through a float.

const RE = /^(-)?(\d{1,11})(?:\.(\d{1,3}))?$/;

/** '2.5' -> 2500n, '-3' -> -3000n. Accepts what Postgres returns for numeric(14,3) ('2.500'). */
export function milli(v: string): bigint {
  const m = RE.exec(v.trim());
  if (!m) throw new Error(`not a quantity: ${v}`);
  const n = BigInt(m[2]) * 1000n + BigInt((m[3] ?? '').padEnd(3, '0'));
  return m[1] ? -n : n;
}

/** 2500n -> '2.5', -3000n -> '-3'. */
export function qtyText(n: bigint): string {
  const neg = n < 0n;
  const a = neg ? -n : n;
  const frac = (a % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / 1000n}${frac ? `.${frac}` : ''}`;
}

export const isWhole = (n: bigint) => n % 1000n === 0n;

/** quantity × unit price, rounded half-up to paise: (2500n, '220.5') -> '551.25'. Exact; signed. */
export function amount(q: bigint, unit: string): string {
  const [i, f = ''] = unit.split('.');
  const u = BigInt(i) * 10000n + BigInt(f.padEnd(4, '0').slice(0, 4));   // ten-thousandths of a rupee
  const neg = q < 0n;
  const p = ((neg ? -q : q) * u + 50000n) / 100000n;                     // (1/1000 × 1/10000) rupee -> paise
  return `${neg && p ? '-' : ''}${p / 100n}.${(p % 100n).toString().padStart(2, '0')}`;
}
