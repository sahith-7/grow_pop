// Shapes and labels for the B4 screens: the WooCommerce connection and web orders. Calls go through catalog-api's api().
export { api, ApiError, errorText } from './catalog-api';

export interface WooStatus {
  status: 'not_connected' | 'connected' | 'error' | 'disconnected';
  siteUrl?: string; keyHint?: string; wooVersion?: string | null; currency?: string | null; pricesIncludeTax?: boolean | null;
  onlineLocation?: { id: string; name: string };
  connectedAt?: string; lastSuccessAt?: string | null; lastError?: string | null; lastErrorAt?: string | null;
  webhooksHealthy?: boolean; ordersSyncedTo?: string | null;
  match?: { state: MatchState; summary: MatchSummary | null };
  pending: number; failed: number; oldestPendingAgeSec: number;
  orderExceptions?: number; ordersNeedingReview?: number;
  can: { connect: boolean };
}
export type MatchState = 'not_started' | 'running' | 'ready' | 'confirmed' | 'failed';
export interface MatchSummary { matched: number; withDifferences: number; erpOnly: number; wooOnly: number; checkedAt: string }
export interface MatchResult {
  state: MatchState; summary?: MatchSummary;
  matched?: { sku: string; productId: string; name: string; wooName: string; price: string; wooPrice: string; stock: number; wooStock: number | null; differences: string[]; problem: string | null }[];
  erpOnly?: { sku: string; name: string; productId: string }[];
  wooOnly?: { wooProductId: number; sku: string; name: string }[];
}
export interface TestResult {
  ok: boolean; problem?: string; message?: string; wooVersion?: string; currency?: string;
  weightUnit?: string; dimensionUnit?: string; pricesIncludeTax?: boolean;
}
export interface SyncJob {
  id: string; kind: string; status: 'pending' | 'running' | 'failed' | 'dead' | 'done'; attempts: number; maxAttempts: number;
  nextAttemptAt: string | null; lastError: string | null; createdAt: string; doneAt: string | null;
  resource: { type: 'product' | 'order' | 'shop'; id: string; label: string };
}

export interface OrderSummary {
  id: string; number: string; channel: 'pos' | 'woocommerce'; externalId: string | null; wooStatus: string | null; status: string;
  paymentState: string; paymentMethod: string | null; exceptionReason: string | null; customerName: string | null;
  itemCount: number; total: string; currency: string; placedAt: string;
}
export interface OrderLine {
  id: string; variantId: string | null; sku: string; name: string;
  erp: { sku: string; name: string; attributes: Record<string, string> } | null;
  qty: string; unitPrice: string; lineTotal: string; reservation: 'active' | 'released' | 'converted' | null; location: string | null;
}
export interface Address { name: string; company: string; address1: string; address2: string; city: string; state: string; postcode: string; country: string; phone: string }
export interface Order extends OrderSummary {
  customer: { name: string; phone: string; email: string; billing: Address; shipping: Address } | null;
  totals: { subtotal: string; discount: string; shipping: string; tax: string; total: string };
  lines: OrderLine[];
  events: { kind: string; message: string; at: string; actor: string | null }[];
  // B6
  packedAt: string | null;
  pickList: { id: string; number: string } | null;
  shipment: Shipment | null;
  can: { fulfil: boolean; mapLines: boolean };
}

export interface Shipment {
  carrier: string; service: string | null; trackingNo: string | null; shippedAt: string; dispatchedBy: string | null;
  webUpdate: 'pending' | 'synced' | 'failed' | 'not_needed'; webError: string | null; webSyncedAt: string | null;
}

/** [badge tone, label] for each ERP order status. */
export const ORDER_STATUS: Record<string, [string, string]> = {
  awaiting_payment: ['', 'Awaiting payment'], on_hold: ['info', 'On hold'], stock_exception: ['danger', 'Short of stock'],
  ready_to_pick: ['success', 'Ready to pick'], picking: ['info', 'Picking'], packed: ['info', 'Packed'], dispatched: ['brand', 'Dispatched'], completed: ['', 'Completed'], cancelled: ['', 'Cancelled'], failed: ['', 'Payment failed'],
  refunded: ['', 'Refunded'], needs_review: ['warning', 'Needs review'],
};
export const RESERVATION: Record<string, [string, string]> = {
  active: ['success', 'Held'], released: ['', 'Released'], converted: ['info', 'Taken from stock'],
};
export const JOB_KIND: Record<string, string> = {
  'woo.product': 'Product to shop', 'woo.stock': 'Stock to shop', 'woo.inbound': 'From shop', 'woo.reconcile': 'Check-up', 'woo.match': 'Product match', 'woo.fulfilment': 'Dispatch to shop',
};
export const JOB_STATUS: Record<string, [string, string]> = {
  pending: ['', 'Waiting'], running: ['info', 'Running'], failed: ['warning', 'Will retry'], dead: ['danger', 'Failed'], done: ['success', 'Done'],
};

/** "3 min ago" style ages for sync health. */
export function ago(iso: string | null | undefined) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
