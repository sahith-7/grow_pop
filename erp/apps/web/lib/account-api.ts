// Shapes for the B7 screens: the subscription banner, the Account page and Getting started. Calls go through catalog-api's api().
import { fmtDate } from './datetime';
export { api, ApiError, errorText } from './catalog-api';

export type StoreState = 'trial' | 'active' | 'past_due' | 'suspended' | 'closed';
export interface Plan { id: string; name: string; maxUsers: number; online: boolean; priceMonthPaise: number | null; priceYearPaise: number | null }
export interface Subscription {
  state: StoreState; readOnly: boolean; storeCode: string;
  trialEndsAt: string | null; paidUntil: string | null; pastDueSince: string | null; suspendsAt: string | null;
  closedAt: string | null; exportUntil: string | null;
  plan: Plan; online: boolean;
  payTo: { upiId: string; payee: string | null; note: string } | null;
  support: { email: string | null; whatsapp: string | null };
  can: { manage: boolean };
}
export interface Payment { receiptNo: string; amountPaise: number; method: string; reference: string; paidOn: string; planId: string; months: number; periodFrom: string; periodTo: string }
export interface StateEvent { from: StoreState | null; to: StoreState; reason: string | null; at: string; automatic: boolean }
export interface Grant { id: string; reason: string | null; createdAt: string; expiresAt: string; revokedAt: string | null; active: boolean }
export interface Export { id: string; status: 'pending' | 'running' | 'ready' | 'failed' | 'expired'; sizeBytes: number | null; rowCounts: Record<string, number> | null; error: string | null; createdAt: string; finishedAt: string | null; expiresAt: string; downloadable: boolean }
export interface Step { key: string; title: string; href: string; done: boolean }

export const STATE_LABEL: Record<StoreState, [tone: string, label: string]> = {
  trial: ['info', 'Free trial'], active: ['success', 'Active'], past_due: ['warning', 'Payment due'], suspended: ['danger', 'Read-only'], closed: ['danger', 'Closed'],
};

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const rupees = (paise: number | null) => (paise === null ? '—' : inr.format(paise / 100));
export const day = (iso: string | null) => fmtDate(iso);
export const daysLeft = (iso: string | null) => (iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)) : 0);
export const contact = (s: Subscription['support']) =>
  [s.whatsapp && `WhatsApp ${s.whatsapp}`, s.email].filter(Boolean).join(' or ') || 'us';
