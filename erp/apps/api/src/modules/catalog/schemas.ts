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
}).strict();
export type VariantInput = z.infer<typeof variantInput>;

export const variantPatch = variantInput.partial().strict();
export type VariantPatch = z.infer<typeof variantPatch>;

export const productInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: optionalText(5000).default(''),
  categoryId: uuid.nullable().default(null),
  brandId: uuid.nullable().default(null),
  unitCode: z.string().default('NOS'),
  type: z.enum(['simple', 'variable']),
  status: z.enum(['draft', 'active']).default('draft'),
  hsnCode: hsnCode.nullable().default(null),
  gstRate: gstRate.nullable().default(null),
  publishToWeb: z.boolean().default(false),
  variants: z.array(variantInput).min(1).max(200),
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
}).strict();

export const productListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  categoryId: uuid.optional(),
  brandId: uuid.optional(),
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

export const labelsInput = z.object({
  items: z.array(z.object({ variantId: uuid, copies: z.number().int().min(1).max(200) }).strict()).min(1).max(500),
}).strict();

export const idParam = z.object({ id: uuid });
export const imageParam = z.object({ id: uuid, imageId: uuid });
