import { ATTRIBUTE_KEYS } from '../catalog/schemas.js';

/** CSV columns for product import and export. Export writes the same headers, so an export can be edited and re-imported. */
export const COLUMNS = [
  { key: 'product_name', required: true, help: 'Product name. Rows with the same name and a size/colour become variants of one product.' },
  { key: 'sku', required: true, help: 'Unique code for this item, e.g. TS-RED-M' },
  { key: 'price', required: true, help: 'Selling price including tax, e.g. 499 or 499.50' },
  { key: 'mrp', required: false, help: 'Printed MRP; price cannot be above it' },
  { key: 'cost', required: false, help: 'Purchase cost (only owners/managers/inventory can import this)' },
  { key: 'barcode', required: false, help: 'Leave empty to generate one later. Format the column as Text in Excel.' },
  { key: 'category', required: false, help: 'Category, or "Department > Category". Created if missing.' },
  { key: 'brand', required: false, help: 'Created if missing' },
  { key: 'unit', required: false, help: 'pcs (default), kg, g, l, ml, m, box, pack, pair, set, doz…' },
  { key: 'hsn_code', required: false, help: '4 to 8 digits' },
  { key: 'gst_rate', required: false, help: 'e.g. 5, 18 or 40' },
  ...ATTRIBUTE_KEYS.map((k) => ({ key: k, required: false, help: `Variant ${k}` })),
  { key: 'reorder_level', required: false, help: 'Low-stock alert level' },
  { key: 'weight_g', required: false, help: 'Weight in grams (for shipping)' },
  { key: 'status', required: false, help: 'active (default) or draft' },
  { key: 'description', required: false, help: '' },
] as const;

export type ColumnKey = (typeof COLUMNS)[number]['key'];
export const COLUMN_KEYS = COLUMNS.map((c) => c.key) as ColumnKey[];

const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
const SYNONYMS: Record<string, ColumnKey> = {
  name: 'product_name', product: 'product_name', item: 'product_name', item_name: 'product_name',
  selling_price: 'price', sale_price: 'price', rate: 'price',
  ean: 'barcode', upc: 'barcode', gtin: 'barcode',
  hsn: 'hsn_code', gst: 'gst_rate', tax_rate: 'gst_rate', color: 'colour', purchase_price: 'cost', cost_price: 'cost', uom: 'unit',
};

/** Target column -> source header. Explicit choices win; anything left is matched by name. */
export function resolveMapping(headers: string[], explicit: Partial<Record<ColumnKey, string>>): Partial<Record<ColumnKey, string>> {
  const out: Partial<Record<ColumnKey, string>> = {};
  const taken = new Set<string>();
  for (const [k, h] of Object.entries(explicit)) if (h) { out[k as ColumnKey] = h; taken.add(h); }
  for (const h of headers) {
    if (taken.has(h)) continue;
    const n = norm(h);
    const key = (COLUMN_KEYS as string[]).includes(n) ? (n as ColumnKey) : SYNONYMS[n];
    if (key && !(key in explicit) && !out[key]) { out[key] = h; taken.add(h); }
  }
  return out;
}
