const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "1299.5" -> "₹1,299.50". Display only; amounts stay strings everywhere else. */
export const money = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : inr.format(Number(v)));

export const priceRange = (r: { min: string; max: string } | null) => (!r ? '—' : r.min === r.max ? money(r.min) : `${money(r.min)} – ${money(r.max)}`);

export const attrLabel = (a: Record<string, string>) => Object.values(a).join(' · ');

/** Short names for the GST unit codes (the fixed national list in the units table). */
export const UNIT_ABBR: Record<string, string> = {
  NOS: 'pcs', BOX: 'box', PAC: 'pack', PRS: 'pair', SET: 'set', DOZ: 'doz', BTL: 'btl', ROL: 'roll',
  KGS: 'kg', GMS: 'g', LTR: 'l', MLT: 'ml', MTR: 'm', CMS: 'cm',
};

/** Quantities added up per unit, in the order the units first appear: "7 pcs, 2.5 kg". */
export function qtyTotal(lines: { qty: string; unit: string }[], label: (unit: string) => string = (u) => UNIT_ABBR[u] ?? u) {
  const sums = new Map<string, number>();
  for (const l of lines) {
    const n = Number(l.qty);
    if (!Number.isFinite(n) || !l.qty) continue;
    sums.set(l.unit, Math.round(((sums.get(l.unit) ?? 0) + n) * 1000) / 1000);
  }
  return [...sums].map(([u, n]) => `${n} ${label(u)}`).join(', ');
}
