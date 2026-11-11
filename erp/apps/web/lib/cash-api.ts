// Shapes for cash control (v2 phase 3, D109–D113): payment methods, tills, registers, drawer movements, the cash book and
// the owner's notifications. Calls go through catalog-api's api().
export { api, ApiError, errorText } from './catalog-api';

export type MethodKind = 'cash' | 'upi' | 'card' | 'other';
export interface PaymentMethod { id: string; kind: MethodKind; name: string; builtin: boolean; active: boolean; position: number; offAt: string[] }
/** What the counter offers at one outlet. */
export interface CounterMethod { id: string; kind: MethodKind; name: string }
export const KIND_LABEL: Record<MethodKind, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', other: 'Other' };

export interface Till {
  id: string; name: string; active: boolean; outletId: string; outlet: string; lastKept: string | null;
  open: { id: string; openedAt: string; openedBy: string; mine: boolean } | null;
}

/** The drawer's numbers. Live for an open register; frozen in the summary when it closed. */
export interface RegisterTotals {
  bills: number; sales: string; opening: string; cashSales: string; cashRefunds: string; cashIn: string; cashOut: string; expenses: string;
  pendingExpenses: string; expected: string;
  methods: { name: string; kind: string; received: string; refunded: string; payments: number }[];
  // closed registers only
  counted?: string; difference?: string; kept?: string; takenOut?: string; lapsedExpenses?: number; closedBy?: string;
}
export type Counts = Partial<Record<Denomination, number>> & { other?: string };
export interface Movement {
  id: string; sessionId: string; kind: 'cash_in' | 'cash_out' | 'expense'; category: string; amount: string; reason: string;
  status: 'posted' | 'pending' | 'rejected' | 'cancelled'; recordedBy: string; recordedAt: string; decidedBy: string | null;
  decidedVia: 'pin' | 'remote' | null; note: string | null; till: string; outlet: string; needsApproval?: string | null;
}
export interface Register {
  id: string; status: 'open' | 'closed'; till: { id: string; name: string }; outlet: { id: string; name: string };
  openedBy: string; openedAt: string; openingCash: string; openingCounts: Counts | null; expectedOpening: string | null; openingNote: string | null;
  closedBy: string | null; closedAt: string | null; countedCash: string | null; closingCounts: Counts | null; expectedCash: string | null;
  difference: string | null; keptCash: string | null; closeNote: string | null;
  totals: RegisterTotals; mine: boolean; canManage: boolean; movements: Movement[];
}
export interface RegisterRow {
  id: string; status: 'open' | 'closed'; till: string; outlet: string; outletId: string; openedBy: string; openedAt: string;
  closedBy: string | null; closedAt: string | null; bills: number; sales: string; expected: string; counted: string | null; difference: string | null;
}
export interface CashBook {
  date: string;
  registers: (Omit<RegisterRow, 'outletId'> & { opening: string; cashSales: string; cashRefunds: string; cashIn: string; cashOut: string; expenses: string; closeNote: string | null })[];
  movements: Movement[];
  totals: Record<'opening' | 'cashSales' | 'cashRefunds' | 'cashIn' | 'cashOut' | 'expenses' | 'expected' | 'counted' | 'difference', string>;
}
export interface Notification { id: string; kind: string; title: string; body: string; link: string | null; createdAt: string; read: boolean }

/** Notes and coins, as the drawer is counted. ₹20 and ₹10 notes and coins count together. */
export const DENOMINATIONS = ['500', '200', '100', '50', '20', '10', '5', '2', '1'] as const;
export type Denomination = (typeof DENOMINATIONS)[number];
export const CATEGORIES = {
  expense: ['Tea and snacks', 'Transport', 'Repairs', 'Cleaning', 'Stationery', 'Staff advance', 'Other'],
  cash_in: ['Float added', 'Owner added', 'Other'],
  cash_out: ['Bank deposit', 'Owner took', 'Other'],
} as const;
export const MOVEMENT_LABEL: Record<Movement['kind'], string> = { cash_in: 'Cash added', cash_out: 'Cash taken out', expense: 'Expense' };
export const MOVEMENT_STATUS: Record<Movement['status'], { label: string; tone: string }> = {
  posted: { label: 'Paid', tone: 'success' }, pending: { label: 'Waiting for approval', tone: 'warning' },
  rejected: { label: 'Not approved', tone: 'danger' }, cancelled: { label: 'Cancelled', tone: 'info' },
};

/** Paise of what the counts add up to (the server works it out again). */
export function countTotal(c: Counts): number {
  return DENOMINATIONS.reduce((a, d) => a + (c[d] ?? 0) * Number(d) * 100, 0) + Math.round(Number(c.other || '0') * 100);
}
