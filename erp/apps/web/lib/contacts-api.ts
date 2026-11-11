// Contacts (v2 batch 2, D96): customers and suppliers on one page, each with what they bought or supplied.
export { api, ApiError, errorText } from './catalog-api';

export type ContactType = 'customer' | 'supplier';
export interface State { code: string; name: string }

interface Base {
  id: string; name: string; phone: string | null; email: string | null; gstin: string | null; stateCode: string | null; stateName: string | null;
  address: string | null; archived: boolean; createdAt: string;
}
export interface CustomerContact extends Base {
  type: 'customer'; fromWooCommerce: boolean;
  stats: { orders: number; spent: string; returned: string; net: string; lastAt: string | null };
}
export interface SupplierContact extends Base {
  type: 'supplier';
  stats: { receipts: number; purchased: string | null; openPurchaseOrders: number; returns: number; lastAt: string | null };
}
export type Contact = CustomerContact | SupplierContact;

export interface CustomerHistoryItem {
  id: string; number: string; channel: 'pos' | 'woocommerce'; status: string; paymentMethod: string | null; total: string; at: string; lines: number;
  invoice: { id: string; number: string } | null; credited: string; voided: boolean;
}
export interface SupplierHistoryItem {
  kind: 'receipt' | 'return'; id: string; number: string; at: string; reference: string | null; purchaseOrder: string | null; qty: string | null; value: string | null;
}
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface ContactDetail<C extends Contact = Contact> {
  contact: C; history: Page<C extends CustomerContact ? CustomerHistoryItem : SupplierHistoryItem>; states: State[]; can: { edit: boolean };
}
