const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "1299.5" -> "₹1,299.50". Display only; amounts stay strings everywhere else. */
export const money = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : inr.format(Number(v)));

export const priceRange = (r: { min: string; max: string } | null) => (!r ? '—' : r.min === r.max ? money(r.min) : `${money(r.min)} – ${money(r.max)}`);

export const attrLabel = (a: Record<string, string>) => Object.values(a).join(' · ');
