import { z } from 'zod';
import { money, qty } from '../../lib/decimal.js';

const uuid = z.string().uuid();
const note = z.string().trim().max(500);

/** A non-zero signed quantity, e.g. "-2" or "1.5". */
export const qtyDelta = z.string().trim().regex(/^-?\d{1,11}(\.\d{1,3})?$/, 'Enter a quantity like 5, -2 or 2.5')
  .refine((v) => !/^-?0+(\.0+)?$/.test(v), 'Quantity cannot be zero');
export const positiveQty = qty.refine((v) => !/^0+(\.0+)?$/.test(v), 'Quantity must be more than zero');

export const bucket = z.enum(['sellable', 'non_sellable']);
export const LOCATION_TYPES = ['shop_floor', 'back_room', 'quarantine'] as const;

export const locationInput = z.object({
  name: z.string().trim().min(1).max(60),
  type: z.enum(LOCATION_TYPES),
  isSellable: z.boolean().optional(),
}).strict();
export const locationPatch = z.object({
  name: z.string().trim().min(1).max(60),
  isSellable: z.boolean(),
  active: z.boolean(),
}).partial().strict();

export const WRITEOFF_REASONS = ['damage', 'expiry', 'loss'] as const;
export const adjustmentInput = z.object({
  locationId: uuid,
  reasonCode: z.enum(['damage', 'expiry', 'loss', 'correction', 'opening']),
  note: note.optional(),
  overrideNegative: z.boolean().default(false),
  lines: z.array(z.object({
    variantId: uuid,
    qtyDelta,
    bucket: bucket.default('sellable'),
    unitCost: money.optional(),   // opening only
  }).strict()).min(1).max(200),
}).strict();
export type AdjustmentInput = z.infer<typeof adjustmentInput>;

export const transferInput = z.object({
  fromLocationId: uuid,
  toLocationId: uuid,
  note: note.optional(),
  lines: z.array(z.object({ variantId: uuid, qty: positiveQty }).strict()).min(1).max(200),
}).strict();
export type TransferInput = z.infer<typeof transferInput>;

export const reverseInput = z.object({ note: z.string().trim().min(3).max(500) }).strict();

export const balancesQuery = z.object({
  q: z.string().trim().max(100).optional(),
  locationId: uuid.optional(),
  lowStock: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
}).strict();

export const MOVEMENT_TYPES = ['opening', 'receipt', 'sale', 'dispatch', 'adjustment', 'writeoff', 'transfer_out', 'transfer_in',
  'return_in', 'supplier_return', 'stocktake', 'reversal'] as const;
export const movementsQuery = z.object({
  variantId: uuid.optional(),
  locationId: uuid.optional(),
  movementType: z.enum(MOVEMENT_TYPES).optional(),
  sourceId: uuid.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
}).strict();

export const openingImportInput = z.object({
  fileId: uuid,
  /** Used for rows with an empty location column. */
  locationId: uuid,
  commit: z.boolean().default(false),
}).strict();

export const stocktakeInput = z.object({
  locationId: uuid,
  categoryIds: z.array(uuid).max(50).default([]),
  blind: z.boolean().default(true),
  note: note.optional(),
}).strict();
export const countsInput = z.object({
  counts: z.array(z.union([
    z.object({ variantId: uuid, countedQty: qty }).strict(),   // set (typed count, safe to resend)
    z.object({ variantId: uuid, addQty: positiveQty }).strict(), // add (scanner; two counters can share an aisle)
  ])).min(1).max(500),
}).strict();
export const stocktakeListQuery = z.object({
  status: z.enum(['counting', 'review', 'posted', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
}).strict();

export const idParam = z.object({ id: uuid });
