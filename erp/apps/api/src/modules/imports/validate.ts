import { barcodeProblem } from '../../lib/barcode.js';
import { ATTRIBUTE_KEYS, GST_RATES } from '../catalog/schemas.js';
import type { ColumnKey } from './columns.js';

export const MAX_ROWS = 20_000;
export const MAX_ERRORS = 5_000;

export interface RowError { row: number; column: string; message: string }

export interface VariantPlan {
  row: number; sku: string; barcode: string | null; price: string; mrp: string | null; cost: string | null;
  attributes: Record<string, string>; reorderLevel: string | null; weightG: number | null;
}
export interface ProductPlan {
  name: string; type: 'simple' | 'variable'; category: string[] | null; brand: string | null; unitCode: string;
  hsnCode: string | null; gstRate: string | null; status: 'active' | 'draft'; description: string; variants: VariantPlan[];
}

export interface Refs {
  /** lower(sku) already in the catalog */
  skus: Set<string>;
  barcodes: Set<string>;
  /** lower(code | abbr | name) -> unit code */
  units: Map<string, string>;
}

export class FileProblem extends Error {}

const MONEY = /^\d{1,10}(\.\d{1,4})?$/;
const QTY = /^\d{1,11}(\.\d{1,3})?$/;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const PRODUCT_FIELDS = ['category', 'brand', 'unit', 'hsn_code', 'gst_rate', 'status', 'description'] as const;

/** "₹1,299.00" -> "1299.00". Indian digit grouping and the rupee sign are common in shop spreadsheets. */
const cleanAmount = (v: string) => v.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');

/**
 * Validate a parsed CSV against the column mapping. Pure: all database facts arrive in `refs`.
 * A product is all-or-nothing: if any row of a variable product is invalid, none of its rows are imported.
 */
export function validateRows(table: string[][], mapping: Partial<Record<ColumnKey, string>>, refs: Refs) {
  const [header, ...rows] = table;
  if (!header) throw new FileProblem('The file is empty');
  if (new Set(header.map((h) => h.trim())).size !== header.length) throw new FileProblem('Two columns have the same heading; rename one');
  if (!rows.length) throw new FileProblem('The file has a heading row but no products');
  if (rows.length > MAX_ROWS) throw new FileProblem(`The file has ${rows.length} rows; split it into files of at most ${MAX_ROWS}`);
  const idx: Partial<Record<ColumnKey, number>> = {};
  for (const [key, h] of Object.entries(mapping) as [ColumnKey, string][]) {
    const i = header.findIndex((x) => x.trim() === h.trim());
    if (i < 0) throw new FileProblem(`Column "${h}" is not in the file`);
    idx[key] = i;
  }
  for (const req of ['product_name', 'sku', 'price'] as const) if (idx[req] === undefined) throw new FileProblem(`Map a column to ${req}`);

  const errors: RowError[] = [];
  const bad = new Set<number>();
  const fail = (row: number, column: string, message: string) => { errors.push({ row, column, message }); bad.add(row); };
  const get = (r: string[], k: ColumnKey) => (idx[k] === undefined ? '' : (r[idx[k]!] ?? '').trim());

  const seenSku = new Map<string, number>();
  const seenCode = new Map<string, number>();
  const groups = new Map<string, { plan: ProductPlan; rows: number[]; raw: Record<string, string> }>();

  rows.forEach((r, i) => {
    const row = i + 2; // spreadsheet row number; row 1 is the heading
    const name = get(r, 'product_name');
    const sku = get(r, 'sku');
    const price = cleanAmount(get(r, 'price'));
    const mrp = cleanAmount(get(r, 'mrp')) || null;
    const cost = cleanAmount(get(r, 'cost')) || null;
    const barcode = get(r, 'barcode') || null;

    if (!name) fail(row, 'product_name', 'Required');
    else if (name.length > 200) fail(row, 'product_name', 'At most 200 characters');
    if (!sku) fail(row, 'sku', 'Required');
    else if (!SKU.test(sku)) fail(row, 'sku', 'Use letters, digits, or . _ / - (no spaces)');
    else if (refs.skus.has(sku.toLowerCase())) fail(row, 'sku', 'Already in your catalog');
    else if (seenSku.has(sku.toLowerCase())) fail(row, 'sku', `Same SKU as row ${seenSku.get(sku.toLowerCase())}`);
    if (sku) seenSku.set(sku.toLowerCase(), seenSku.get(sku.toLowerCase()) ?? row);
    if (!price) fail(row, 'price', 'Required');
    else if (!MONEY.test(price)) fail(row, 'price', 'Enter an amount like 499 or 499.50');
    if (mrp && !MONEY.test(mrp)) fail(row, 'mrp', 'Enter an amount like 599');
    else if (mrp && MONEY.test(price) && Number(price) > Number(mrp)) fail(row, 'price', 'Price is above MRP');
    if (cost && !MONEY.test(cost)) fail(row, 'cost', 'Enter an amount like 250');
    if (barcode) {
      const p = /^\d(\.\d+)?E\+\d+$/i.test(barcode)
        ? 'Excel changed this barcode to scientific notation. Format the column as Text and re-type it.'
        : barcodeProblem(barcode);
      if (p) fail(row, 'barcode', p);
      else if (refs.barcodes.has(barcode)) fail(row, 'barcode', 'Already used by a product in your catalog');
      else if (seenCode.has(barcode)) fail(row, 'barcode', `Same barcode as row ${seenCode.get(barcode)}`);
      else seenCode.set(barcode, row);
    }

    const attributes: Record<string, string> = {};
    for (const k of ATTRIBUTE_KEYS) {
      const v = get(r, k);
      if (!v) continue;
      if (v.length > 40) fail(row, k, 'At most 40 characters');
      attributes[k] = v;
    }
    const reorder = get(r, 'reorder_level');
    if (reorder && !QTY.test(reorder)) fail(row, 'reorder_level', 'Enter a number like 5');
    const weight = get(r, 'weight_g');
    if (weight && !/^\d{1,8}$/.test(weight)) fail(row, 'weight_g', 'Whole grams, e.g. 250');

    // Product-level fields
    const raw = Object.fromEntries(PRODUCT_FIELDS.map((f) => [f, get(r, f)])) as Record<(typeof PRODUCT_FIELDS)[number], string>;
    const category = raw.category ? raw.category.split('>').map((s) => s.trim()) : null;
    if (category && (category.length > 2 || category.some((c) => !c || c.length > 80))) fail(row, 'category', 'Use "Category" or "Department > Category" (80 characters each)');
    if (raw.brand.length > 80) fail(row, 'brand', 'At most 80 characters');
    const unitCode = raw.unit ? refs.units.get(raw.unit.toLowerCase()) : 'NOS';
    if (!unitCode) fail(row, 'unit', 'Unknown unit; use pcs, kg, g, l, ml, m, box, pack, pair, set or doz');
    if (raw.hsn_code && !/^\d{4,8}$/.test(raw.hsn_code)) fail(row, 'hsn_code', 'HSN code is 4 to 8 digits');
    let gstRate: string | null = null;
    if (raw.gst_rate) {
      const n = Number(raw.gst_rate.replace('%', '').trim());
      gstRate = Number.isFinite(n) ? String(n) : raw.gst_rate;
      if (!(GST_RATES as readonly string[]).includes(gstRate)) fail(row, 'gst_rate', `Use one of ${GST_RATES.join(', ')}`);
    }
    const status = (raw.status || 'active').toLowerCase();
    if (status !== 'active' && status !== 'draft') fail(row, 'status', 'Use active or draft');
    if (raw.description.length > 5000) fail(row, 'description', 'At most 5000 characters');
    if (!name) return;

    const variable = Object.keys(attributes).length > 0;
    const groupKey = `${variable ? 'v' : 's'}:${name.toLowerCase()}`;
    const variant: VariantPlan = { row, sku, barcode, price, mrp, cost, attributes, reorderLevel: reorder || null, weightG: weight ? Number(weight) : null };
    const g = groups.get(groupKey);
    if (!g) {
      if (groups.has(`${variable ? 's' : 'v'}:${name.toLowerCase()}`))
        fail(row, variable ? 'size' : 'product_name', 'Other rows of this product have size/colour; fill them in on this row too');
      groups.set(groupKey, {
        rows: [row], raw,
        plan: { name, type: variable ? 'variable' : 'simple', category, brand: raw.brand || null, unitCode: unitCode ?? 'NOS',
          hsnCode: raw.hsn_code || null, gstRate, status: status as 'active' | 'draft', description: raw.description, variants: [variant] },
      });
      return;
    }
    if (!variable) { fail(row, 'product_name', `Same name as row ${g.rows[0]}. Give it a size/colour, or rename it.`); return; }
    const first = g.plan.variants[0];
    if (Object.keys(attributes).sort().join() !== Object.keys(first.attributes).sort().join())
      fail(row, 'size', `Use the same attribute columns as row ${first.row} (${Object.keys(first.attributes).join(', ')})`);
    const dup = g.plan.variants.find((v) => JSON.stringify(Object.entries(v.attributes).sort()) === JSON.stringify(Object.entries(attributes).sort()));
    if (dup) fail(row, 'size', `Same size/colour as row ${dup.row}`);
    for (const f of PRODUCT_FIELDS) {
      if (raw[f] && g.raw[f] && raw[f] !== g.raw[f]) fail(row, f, `Differs from row ${g.rows[0]} of the same product ("${g.raw[f]}")`);
    }
    g.rows.push(row);
    g.plan.variants.push(variant);
  });

  // All-or-nothing per product.
  const products: ProductPlan[] = [];
  for (const g of groups.values()) {
    const badRow = g.rows.find((r) => bad.has(r));
    if (badRow === undefined) { products.push(g.plan); continue; }
    for (const r of g.rows) if (!bad.has(r)) fail(r, 'product_name', `Not imported because row ${badRow} of the same product has an error`);
  }
  if (errors.length > MAX_ERRORS) throw new FileProblem(`More than ${MAX_ERRORS} errors. Check that the columns are mapped correctly.`);
  errors.sort((a, b) => a.row - b.row);
  return { products, errors, totalRows: rows.length, errorRows: bad.size, validRows: rows.length - bad.size };
}
