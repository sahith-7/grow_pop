// Shapes and helpers for the B3 stock, stocktake and purchasing screens. Calls go through catalog-api's api().
import { fmtDateTime } from './datetime';
export { api, ApiError, errorText } from './catalog-api';

export interface Location { id: string; name: string; type: 'shop_floor' | 'back_room' | 'quarantine'; isSellable: boolean; active: boolean; outletId?: string; outletName?: string | null }
export interface StockMeta {
  locations: Location[];
  can: { adjust: boolean; writeoff: boolean; transfer: boolean; overrideNegative: boolean; count: boolean; approve: boolean;
    purchaseManage: boolean; purchaseReceive: boolean; manageLocations: boolean; seeCost: boolean };
}
export interface Balance {
  variantId: string; productId: string; sku: string; barcode: string | null; name: string; attributes: Record<string, string>; unitCode: string;
  onHand: string; reserved: string; available: string; nonSellable: string; reorderLevel: string | null; low: boolean;
  locations: { locationId: string; name: string; onHand: string; nonSellable: string }[]; cost?: string | null; value?: string | null;
}
export interface Movement {
  id: string; postedAt: string; variantId: string; sku: string; name: string; attributes: Record<string, string>;
  locationId: string; locationName: string; bucket: 'sellable' | 'non_sellable'; qtyDelta: string; balanceBefore: string; balanceAfter: string;
  movementType: string; source: { type: string; id: string; number: string }; reasonCode: string | null; note: string | null;
  reversalOfId: string | null; reversedById: string | null; actor: { id: string; name: string }; unitCost?: string | null;
}
export interface PostedDocument { id: string; number: string; postedAt: string; movements: Movement[] }
export interface Supplier { id: string; name: string; phone: string | null; email: string | null; gstin: string | null; stateCode: string | null; address: string | null; archived: boolean }
export interface PoLine {
  id: string; variantId: string; sku: string; barcode: string | null; name: string; attributes: Record<string, string>;
  orderedQty: string; receivedQty: string; acceptedQty: string; outstandingQty: string; unitCost?: string; lineTotal?: string;
}
export interface PurchaseOrder {
  id: string; number: string; status: 'draft' | 'submitted' | 'partial' | 'closed' | 'cancelled'; version: number;
  supplier: { id: string; name: string }; expectedDate: string | null; notes: string | null; createdAt: string;
  lines: PoLine[]; total?: string; receipts: { id: string; number: string; postedAt: string; supplierInvoiceNo: string | null }[];
}

/** A picked item on a form line. */
export interface Picked { variantId: string; sku: string; name: string; attributes: Record<string, string>; barcode: string | null; onHand?: string; cost?: string | null }

export const MOVEMENT_LABEL: Record<string, string> = {
  opening: 'Opening stock', receipt: 'Received', sale: 'Sale', dispatch: 'Dispatched', adjustment: 'Adjustment', writeoff: 'Write-off',
  transfer_out: 'Transfer out', transfer_in: 'Transfer in', return_in: 'Customer return', supplier_return: 'Returned to supplier',
  stocktake: 'Stocktake', reversal: 'Reversal',
};
export const PO_STATUS: Record<string, [string, string]> = {
  draft: ['', 'Draft'], submitted: ['info', 'Sent'], partial: ['warning', 'Part received'], closed: ['success', 'Closed'], cancelled: ['danger', 'Cancelled'],
};

/** A fresh key per user action, so a double click or a retry after a dropped connection posts once. */
export const idemKey = () => ({ 'idempotency-key': crypto.randomUUID() });

/** "-2" -> "−2", "3" -> "+3" for movement columns. */
export const signed = (q: string) => (q.startsWith('-') ? `−${q.slice(1)}` : `+${q}`);

export const dateTime = (iso: string) => fmtDateTime(iso);
export const fieldError = (errors: Record<string, string[]>, key: string) => errors[key]?.[0];

export interface StocktakeLine {
  variantId: string; sku: string; barcode: string | null; name: string; attributes: Record<string, string>;
  countedQty: string | null; countedAt: string | null;
  // Only when the viewer may see expected quantities (not blind, an approver, or closed).
  expectedQty?: string; movedDuringCount?: string; variance?: string | null; varianceValue?: string | null;
}
export interface Stocktake {
  id: string; number: string; status: 'counting' | 'review' | 'posted' | 'cancelled'; locationId: string; locationName: string;
  blind: boolean; note: string | null; snapshotAt: string; categoryIds: string[]; version: number;
  progress: { counted: number; total: number }; canSeeExpected: boolean; lines: StocktakeLine[];
}
export const STOCKTAKE_STATUS: Record<Stocktake['status'], [string, string]> = {
  counting: ['info', 'Counting'], review: ['warning', 'Waiting for approval'], posted: ['success', 'Posted'], cancelled: ['', 'Cancelled'],
};

export interface ReceiptLine {
  id: string; poLineId: string | null; variantId: string; sku: string; name: string; attributes: Record<string, string>;
  locationId: string; locationName: string; receivedQty: string; acceptedQty: string; damagedQty: string; unitCost?: string | null;
}
export interface Receipt {
  id: string; number: string; postedAt: string; postedBy: string | null; supplier: { id: string; name: string };
  purchaseOrder: { id: string; number: string } | null; supplierInvoiceNo: string | null; note: string | null; lines: ReceiptLine[];
}

const scaled = (v: string, places: number) => {
  const [i, f = ''] = v.trim().split('.');
  return BigInt(i || '0') * 10n ** BigInt(places) + BigInt((f + '0'.repeat(places)).slice(0, places) || '0');
};
const valid = (v: string, places: number) => new RegExp(`^\\d{1,11}(\\.\\d{1,${places}})?$`).test(v.trim());
/** Exact quantity × unit cost in rupees ("2.5" × "10.25" -> "25.63"), or null while either is not a valid number. Display only; the server totals. */
export function lineTotal(qty: string, cost: string): string | null {
  if (!valid(qty, 3) || !valid(cost, 4)) return null;
  const paise = (scaled(qty, 3) * scaled(cost, 4) + 50000n) / 100000n;
  return `${paise / 100n}.${(paise % 100n).toString().padStart(2, '0')}`;
}
export function sumMoney(values: (string | null)[]): string {
  const paise = values.reduce((s, v) => s + (v ? scaled(v, 2) : 0n), 0n);
  return `${paise / 100n}.${(paise % 100n).toString().padStart(2, '0')}`;
}

/**
 * On forms that post stock, Enter in a field must not post the document: a scanner ends every scan with Enter, and
 * a scan that lands in a quantity box would otherwise post a half-finished receipt. Posting needs the button.
 */
export const noEnterSubmit = (e: React.KeyboardEvent<HTMLFormElement>) => {
  if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') e.preventDefault();
};
