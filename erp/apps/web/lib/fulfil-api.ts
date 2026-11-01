// Shapes and labels for the B6 screens: fulfilment, pick lists, reports and the dashboard tiles. Calls go through catalog-api's api().
export { api, ApiError, errorText } from './catalog-api';

export type Stage = 'ready_to_pick' | 'picking' | 'packed' | 'dispatched_pending_web' | 'stock_exception';
export const STAGES: { key: Stage; label: string }[] = [
  { key: 'ready_to_pick', label: 'Ready to pick' }, { key: 'picking', label: 'Picking' }, { key: 'packed', label: 'Packed' },
  { key: 'dispatched_pending_web', label: 'Shop not updated' }, { key: 'stock_exception', label: 'Short of stock' },
];

export interface QueueItem {
  id: string; number: string; status: string; customerName: string | null; city: string | null; itemCount: number; total: string;
  paymentMethod: string | null; queuedAt: string; exceptionReason: string | null;
  pickList: { id: string; number: string; allPicked: boolean } | null;
  shipment: { carrier: string; trackingNo: string | null; webUpdate: string; webError: string | null } | null;
}
export interface Queue { items: QueueItem[]; counts: Record<Stage, number>; nextCursor: string | null }

export interface PickLine {
  id: string; orderId: string; orderNumber: string; variantId: string; sku: string; barcode: string | null; name: string;
  attributes: Record<string, string>; unitCode: string; allowFraction: boolean; location: string; qtyRequired: string; qtyPicked: string; removed: boolean;
}
export interface PickList {
  id: string; number: string; status: 'open' | 'picking' | 'picked' | 'cancelled'; createdAt: string; createdBy: string | null;
  progress: { picked: string; required: string };
  orders: { id: string; number: string; status: string; removed: boolean; picked: boolean }[];
  lines: PickLine[];
  scanned?: { sku: string; into: { orderNumber: string; qty: string }[] };
}

/** [badge tone, label] for the WooCommerce update after a dispatch. */
export const WEB_UPDATE: Record<string, [string, string]> = {
  pending: ['', 'Sending to shop'], synced: ['success', 'Shop updated'], failed: ['danger', 'Shop not updated'], not_needed: ['', 'Shop not connected'],
};

/** Couriers offered as suggestions; any name can be typed. */
export const CARRIERS = ['Delhivery', 'Blue Dart', 'DTDC', 'India Post', 'Ekart', 'Xpressbees', 'Shadowfax', 'Shiprocket', 'Hand delivery'];

export interface ReportInfo { key: string; title: string; description: string; dated: boolean; location: boolean }
export interface ReportColumn { key: string; label: string; type: 'text' | 'qty' | 'money' | 'int'; total: boolean }
export interface ReportResult {
  report: string; title: string; description: string; from: string | null; to: string | null; columns: ReportColumn[];
  rows: Record<string, string | number | null>[]; truncated: boolean; rowCount: number; totals: Record<string, string | number | null>;
}

export interface Dashboard {
  today: string;
  sales?: { today: string; yesterday: string; invoicesToday: number };
  stock?: { itemCount: number; lowStockCount: number; value?: string };
  attention?: Partial<Record<'ordersNeedingAttention' | 'readyToPick' | 'beingPicked' | 'dispatchUpdatesStuck' | 'failedSyncJobs' | 'stocktakesInReview', number>>;
  recentSales?: { id: string; number: string; channel: 'pos' | 'woocommerce'; status: string; total: string; placedAt: string; customerName: string | null }[];
  bestSellers?: { name: string; sku: string | null; qty: string }[];
}

/** A short beep for the scanner: high for a good scan, low for a wrong one. Silent where audio is blocked. */
let audio: AudioContext | null = null;
export function beep(ok: boolean) {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = ok ? 1200 : 220;
    o.type = ok ? 'sine' : 'square';
    g.gain.value = 0.08;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + (ok ? 0.08 : 0.35));
  } catch { /* no audio: the screen still shows it */ }
}
