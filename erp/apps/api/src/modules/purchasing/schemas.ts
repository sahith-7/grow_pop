import { z } from 'zod';
import { money, qty } from '../../lib/decimal.js';
import { bucket, positiveQty } from '../inventory/schemas.js';

const uuid = z.string().uuid();
const blank = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable();

export const supplierInput = z.object({
  name: z.string().trim().min(1).max(120),
  phone: blank(20).optional(),
  email: z.union([z.literal(''), z.string().trim().email().max(200)]).transform((v) => v || null).nullable().optional(),
  gstin: z.union([z.literal(''), z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid 15-character GSTIN')])
    .transform((v) => v || null).nullable().optional(),
  stateCode: z.union([z.literal(''), z.string().regex(/^\d{2}$/, 'Two digits, e.g. 27')]).transform((v) => v || null).nullable().optional(),
  address: blank(500).optional(),
}).strict();
export type SupplierInput = z.infer<typeof supplierInput>;
export const supplierPatch = supplierInput.partial().extend({ archived: z.boolean().optional() }).strict();
export type SupplierPatch = z.infer<typeof supplierPatch>;

export const supplierListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
}).strict();

export const poInput = z.object({
  supplierId: uuid,
  expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
  lines: z.array(z.object({ variantId: uuid, orderedQty: positiveQty, unitCost: money }).strict()).min(1).max(300),
}).strict();
export type PoInput = z.infer<typeof poInput>;

export const PO_STATUSES = ['draft', 'submitted', 'partial', 'closed', 'cancelled'] as const;
export const poListQuery = z.object({
  status: z.enum(PO_STATUSES).optional(),
  supplierId: uuid.optional(),
  q: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
}).strict();
export const poAction = z.object({ id: uuid, action: z.enum(['submit', 'cancel', 'close']) });

export const receiptInput = z.object({
  purchaseOrderId: uuid.nullable().optional(),
  supplierId: uuid,
  supplierInvoiceNo: z.string().trim().max(40).optional(),
  note: z.string().trim().max(500).optional(),
  lines: z.array(z.object({
    poLineId: uuid.nullable().optional(),
    variantId: uuid,
    locationId: uuid,
    receivedQty: positiveQty,
    acceptedQty: qty,
    unitCost: money.optional(),
  }).strict()).min(1).max(300),
}).strict();
export type ReceiptInput = z.infer<typeof receiptInput>;

export const supplierReturnInput = z.object({
  supplierId: uuid,
  receiptId: uuid.nullable().optional(),
  reason: z.string().trim().min(3).max(500),
  lines: z.array(z.object({ variantId: uuid, locationId: uuid, bucket, qty: positiveQty }).strict()).min(1).max(300),
}).strict();
export type SupplierReturnInput = z.infer<typeof supplierReturnInput>;

export const docListQuery = z.object({
  supplierId: uuid.optional(),
  purchaseOrderId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
}).strict();

export const idParam = z.object({ id: uuid });
