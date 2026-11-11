import { z } from 'zod';
import { barcodeProblem } from '../../lib/barcode.js';
import { money, qty } from '../../lib/decimal.js';

/** CAT-03. Adding a key here also adds it as a CSV import/export column. */
export const ATTRIBUTE_KEYS = ['size', 'colour', 'model', 'material'] as const;

/**
 * GST rates accepted on products. Kept in code, not a CHECK, because slabs change by notification
 * (the Sept 2025 rationalisation moved most goods to 5/18/40). Confirm with the tax adviser before B5 (D7).
 */
export const GST_RATES = ['0', '0.1', '0.25', '1', '1.5', '3', '5', '12', '18', '28', '40'] as const;

const uuid = z.string().uuid();
const optionalText = (max: number) => z.string().trim().max(max);

export const sku = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/, 'Use up to 64 letters, digits, or . _ / -, starting with a letter or digit');
export const barcode = z.string().trim().superRefine((v, ctx) => { const p = barcodeProblem(v); if (p) ctx.addIssue({ code: 'custom', message: p }); });
export const hsnCode = z.string().trim().regex(/^\d{4,8}$/, 'HSN code is 4 to 8 digits');
export const gstRate = z.string().trim().refine((v) => (GST_RATES as readonly string[]).includes(v), `Use one of ${GST_RATES.join(', ')}`);
export const attributes = z.object(Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, z.string().trim().min(1).max(40).optional()])) as Record<(typeof ATTRIBUTE_KEYS)[number], z.ZodOptional<z.ZodString>>).strict();

const dims = z.object({ l: z.number().int().min(0).max(100000), w: z.number().int().min(0).max(100000), h: z.number().int().min(0).max(100000) }).strict();

export const variantInput = z.object({
  sku,
  barcode: barcode.nullable().optional(),
  attributes: attributes.default({}),
  price: money,
  mrp: money.nullable().optional(),
  cost: money.nullable().optional(),
  weightG: z.number().int().min(0).max(10_000_000).nullable().optional(),
  dimensionsMm: dims.nullable().optional(),
  reorderLevel: qty.nullable().optional(),
  // v2 (D88): net content as printed on the pack. Both or neither.
  netWeight: qty.nullable().optional(),
  netWeightUnit: z.enum(['g', 'kg', 'ml', 'l']).nullable().optional(),
}).strict();
export type VariantInput = z.infer<typeof variantInput>;

export const variantPatch = variantInput.partial().strict();

/** v2 (D88): opening stock typed on the New product form, posted with the product in one transaction. */
export const newVariantInput = variantInput.extend({ openingQty: qty.optional() }).strict();
export type VariantPatch = z.infer<typeof variantPatch>;

export const productInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: optionalText(5000).default(''),
  // v2 (D88): every new product needs a category. CSV and shop imports may still leave it empty.
  categoryId: uuid,
  brandId: uuid.nullable().default(null),
  unitCode: z.string().default('NOS'),
  type: z.enum(['simple', 'variable']),
  status: z.enum(['draft', 'active']).default('draft'),
  hsnCode: hsnCode.nullable().default(null),
  gstRate: gstRate.nullable().default(null),
  publishToWeb: z.boolean().default(false),
  variants: z.array(newVariantInput).min(1).max(200),
  // Where the opening quantities go; required when any variant has an opening quantity above zero.
  openingLocationId: uuid.optional(),
}).strict();
export type ProductInput = z.infer<typeof productInput>;

export const productPatch = z.object({
  name: z.string().trim().min(1).max(200),
  description: optionalText(5000),
  categoryId: uuid.nullable(),
  brandId: uuid.nullable(),
  unitCode: z.string(),
  status: z.enum(['draft', 'active']),
  hsnCode: hsnCode.nullable(),
  gstRate: gstRate.nullable(),
  publishToWeb: z.boolean(),
}).partial().strict();
export type ProductPatch = z.infer<typeof productPatch>;

export const refInput = z.object({
  name: z.string().trim().min(1).max(80),
  parentId: uuid.nullable().optional(),
  archived: z.boolean().optional(),
  /** Categories only (v2, D113): items in it (and its sub-categories) can't be returned, except by the owner. */
  noReturns: z.boolean().optional(),
}).strict();

export const productListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  categoryId: uuid.optional(),
  brandId: uuid.optional(),
  stock: z.enum(['in_stock', 'out_of_stock', 'low']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
}).strict();

export const imageInput = z.object({
  fileId: uuid,
  thumbFileId: uuid.nullable().optional(),
  variantId: uuid.nullable().optional(),
  altText: optionalText(200).default(''),
  isPrimary: z.boolean().optional(),
}).strict();

export const imagePatch = z.object({ fileId: uuid, thumbFileId: uuid.nullable(), altText: optionalText(200) }).partial().strict();
export const imageOrder = z.object({ imageIds: z.array(uuid).min(1).max(20), primaryImageId: uuid }).strict();

// Labels (v2, D98): for chosen variants, for whole products (ticked on the Products list), or for what a goods receipt
// brought in (one label per unit received).
export const labelsInput = z.object({
  items: z.array(z.object({ variantId: uuid, copies: z.number().int().min(1).max(200) }).strict()).min(1).max(500).optional(),
  productIds: z.array(uuid).min(1).max(500).optional(),
  receiptId: uuid.optional(),
}).strict().refine((v) => [v.items, v.productIds, v.receiptId].filter((x) => x !== undefined).length === 1,
  { message: 'Send one of items, productIds or receiptId', path: ['items'] });

const mm = (min: number, max: number) => z.number().min(min).max(max).multipleOf(0.05);
const PAPER_W = { roll: 120, a4: 210, a5: 148 } as const;
const PAPER_H = { roll: 300, a4: 297, a5: 210 } as const;
export const labelLayout = z.object({
  id: z.string().regex(/^custom-[a-z0-9-]{1,32}$/, 'Ids look like custom-1'),
  name: z.string().trim().min(1).max(40),
  paper: z.enum(['roll', 'a4', 'a5']),
  widthMm: mm(10, 210), heightMm: mm(10, 297), columns: z.number().int().min(1).max(8),
  gapXMm: mm(0, 20), gapYMm: mm(0, 20), marginTopMm: mm(0, 30), marginLeftMm: mm(0, 30),
}).strict().superRefine((l, ctx) => {
  const w = l.columns * l.widthMm + (l.columns - 1) * l.gapXMm + 2 * l.marginLeftMm;
  if (w > PAPER_W[l.paper] + 0.01) ctx.addIssue({ code: 'custom', path: ['columns'], message: `${l.columns} across is ${w.toFixed(1)} mm wide; the paper is ${PAPER_W[l.paper]} mm` });
  if (l.heightMm + 2 * l.marginTopMm > PAPER_H[l.paper] + 0.01) ctx.addIssue({ code: 'custom', path: ['heightMm'], message: 'Taller than the paper' });
});
/** The label screen's saved defaults (sales_settings.label_settings). Presets live in the web app; custom sizes are saved here. */
export const labelSettings = z.object({
  layout: z.string().regex(/^[a-z0-9-]{1,40}$/),
  design: z.enum(['standard', 'mrp', 'compact']),
  show: z.object({
    store: z.boolean(), name: z.boolean(), variant: z.boolean(), sku: z.boolean(), price: z.boolean(), mrp: z.boolean(),
    netWeight: z.boolean(), codeText: z.boolean(),
  }).strict(),
  custom: z.array(labelLayout).max(10).refine((a) => new Set(a.map((l) => l.id)).size === a.length, 'Two layouts have the same id'),
}).strict();
export type LabelSettings = z.infer<typeof labelSettings>;
export const LABEL_DEFAULTS: LabelSettings = {
  layout: 'roll-50x25', design: 'standard',
  show: { store: false, name: true, variant: true, sku: false, price: true, mrp: true, netWeight: false, codeText: true },
  custom: [],
};

export const idParam = z.object({ id: uuid });
export const imageParam = z.object({ id: uuid, imageId: uuid });
