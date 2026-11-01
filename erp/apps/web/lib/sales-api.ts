// Shapes and labels for the B5 screens: POS, invoices, returns and Billing & GST. Calls go through catalog-api's api().
export { api, ApiError, errorText } from './catalog-api';

export interface PosContext {
  ready: boolean; problems: string[]; scheme: 'regular' | 'composition' | 'unregistered' | null; location: { id: string; name: string } | null;
  seller: { name: string; legalName: string; gstin: string | null }; pricesIncludeTax: boolean; receiptFooter: string | null;
  discount: { allowed: boolean; limitPct: string; reasonAbovePct: string }; canOverridePrice: boolean; states: { code: string; name: string }[];
}
export interface LookupItem {
  variantId: string; sku: string; barcode: string | null; name: string; attributes: Record<string, string>; price: string; mrp: string | null;
  gstRate: string | null; hsnCode: string | null; unitCode: string; allowFraction: boolean; available: string; exact: boolean;
}
export interface QuoteLine {
  variantId: string; sku: string; name: string; attributes: Record<string, string>; qty: string; unitPrice: string; listPrice: string; mrp: string | null;
  overridden: boolean; gross: string; discount: string; discountPct: string; taxableValue: string; gstRate: string; tax: string; lineTotal: string; available: string;
}
export interface Quote {
  location: { id: string; name: string }; docKind: string; docTitle: string; lines: QuoteLine[]; subtotal: string; discountTotal: string; taxableTotal: string;
  taxBreakdown: { cgst: string; sgst: string; igst: string }; roundOff: string; total: string; pricesIncludeTax: boolean;
  shortages: { variantId: string; sku: string; available: string }[];
}
export interface Customer {
  id: string; name: string; phone: string | null; email: string | null; gstin: string | null; stateCode: string | null; stateName: string | null;
  address: string | null; fromWooCommerce: boolean;
}

export interface Party { name?: string; legalName?: string; gstin?: string | null; address?: string; city?: string; state?: string; postalCode?: string; phone?: string; email?: string; stateCode?: string | null; stateName?: string | null; scheme?: string }
export interface DocLine {
  id: string; kind: 'item' | 'shipping'; sku: string; description: string; hsnCode: string | null; uqc: string; qty: string; unitPrice?: string; gross?: string;
  discount?: string; taxableValue: string; gstRate: string; cgst: string; sgst: string; igst: string; lineTotal: string;
  creditedQty?: string; returnableQty?: string; allowFraction?: boolean;
}
export interface TaxDocument {
  id: string; type: 'invoice' | 'credit_note'; number: string; title: string; docKind: string; gstScheme: string; issuedAt: string; issuedDate: string;
  financialYear: string; seller: Party; buyer: Party; placeOfSupply?: { code: string; name: string }; supplyType?: 'intra' | 'inter';
  stateTaxLabel: string; pricesIncludeTax?: boolean; taxableTotal: string; cgst: string; sgst: string; igst: string; cess: string; roundOff: string;
  total: string; totalInWords: string; issuedBy: string | null; lines: DocLine[]; receiptFooter?: string | null;
  // invoice only
  order?: { id: string; number: string; channel: 'pos' | 'woocommerce'; externalId: string | null }; voided?: boolean;
  creditNotes?: { id: string; number: string; kind: 'return' | 'void'; total: string; issuedAt: string; returnNumber: string }[];
  payments?: { kind: 'payment' | 'refund'; method: string; amount: string; tendered: string | null; change: string | null; reference: string | null; at: string }[];
  // credit note only
  kind?: 'return' | 'void'; reason?: string; originalInvoice?: { id: string; number: string; date: string }; return?: { id: string; number: string; refundMethod: string };
  can?: { void: boolean; return: boolean };
}
export interface SaleResult { orderId: string; orderNumber: string; invoiceId: string; invoiceNumber: string; total: string; change: string; invoice: TaxDocument }

export interface BillingSettings {
  ready: boolean; problems: string[]; gstScheme: 'regular' | 'composition' | 'unregistered' | null; stateCode: string | null; timezone: string;
  seller: Party; pricesIncludeTax: boolean; roundOff: boolean; posLocationId: string | null; discountReasonThresholdPct: string;
  cashierDiscountLimitPct: string; managerDiscountLimitPct: string; invoicePrefix: string; creditNotePrefix: string; invoiceWebOrders: boolean;
  receiptFooter: string | null; locations: { id: string; name: string }[]; states: { code: string; name: string }[]; can: { manage: boolean };
}
export interface Series { id: string; docType: 'invoice' | 'credit_note'; financialYear: string; prefix: string; startNumber: number; nextNumber: number; nextDocument: string; used: boolean }

export const PAY_METHOD: Record<string, string> = { cash: 'Cash', card: 'Card', upi: 'UPI', other: 'Other', original: 'Original payment', none: 'No refund' };
export const SCHEME: Record<string, string> = {
  regular: 'Registered (regular GST)', composition: 'Registered (composition scheme)', unregistered: 'Not registered for GST',
};
export const CONDITION: Record<string, string> = { resellable: 'Back to stock', damaged: 'Damaged (not sellable)', not_returned: 'Not returned (refund only)' };

/** Today's date in the browser, as the API's YYYY-MM-DD. */
export const today = () => new Date().toLocaleDateString('en-CA');

export interface InvoiceSummary {
  id: string; type: 'invoice' | 'credit_note'; number: string; issuedAt: string; docKind: string; total: string; customer: string | null;
  channel: 'pos' | 'woocommerce'; orderNumber: string; voided: boolean; credited: string | null; invoice?: { id: string; number: string };
}
export interface ReturnSummary {
  id: string; number: string; postedAt: string; reason: string; refundMethod: string; kind: 'return' | 'void';
  invoice: { id: string; number: string }; creditNote: { id: string; number: string }; refundAmount: string; customer: string | null; postedBy: string | null;
}
export interface DaySummary {
  date: string; sales: number; salesTotal: string; methods: { method: string; received: string; refunded: string; net: string; payments: number }[];
}

/** What B5 adds to a web order's detail (GET /orders/:id). */
export interface OrderInvoicing {
  invoiceState: 'issued' | 'pending' | 'not_needed' | null; invoiceNote: string | null;
  documents: { id: string; number: string; type: 'invoice' | 'credit_note'; total: string; issuedAt: string }[];
  payments: { kind: 'payment' | 'refund'; method: string; amount: string; reference: string | null; at: string }[];
}
