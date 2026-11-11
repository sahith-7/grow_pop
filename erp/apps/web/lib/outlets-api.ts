// Outlets (v2, D101): several shops inside one store account. Calls go through catalog-api's api().
export { api, ApiError, errorText } from './catalog-api';

export interface Takings { bills: number; sales: string; returns: string }
export interface OutletRow {
  id: string; name: string; isMain: boolean; active: boolean; address: string; city: string; stateName: string | null; gstin: string | null;
  stockRooms: number; ready: boolean; problems: string[]; today: Takings;
}
export interface OutletLimit { included: number; extra: number; allowed: number; open: number; pricePerOutletMonthPaise: number | null }
export interface StateOption { code: string; name: string }
export interface OutletList { items: OutletRow[]; limit: OutletLimit; date: string; mainStateCode: string | null; states: StateOption[]; can: { manage: boolean; staff: boolean } }

export interface OutletDetail {
  outlet: {
    id: string; name: string; isMain: boolean; active: boolean; createdAt: string; address: string | null; city: string | null; stateCode: string | null;
    postalCode: string | null; phone: string | null; gstin: string | null; invoicePrefix: string; creditNotePrefix: string; posLocationId: string | null;
  };
  seller: { address: string; city: string; state: string; postalCode: string; phone: string; gstin: string | null; stateName: string | null; legalName: string };
  scheme: 'regular' | 'composition' | 'unregistered' | null;
  ready: boolean; problems: string[]; mainStateCode: string | null;
  nextNumbers: { invoice: string; creditNote: string };
  stockRooms: { id: string; name: string; type: string; isSellable: boolean; active: boolean; onHand: string; items: number }[];
  today: Takings & { date: string }; thisMonth: { bills: number; sales: string };
  staff: { id: string; name: string; role: string; everywhere: boolean; assigned: boolean; elsewhere: boolean }[] | null;
  states: StateOption[]; can: { manage: boolean; staff: boolean };
}

export const ROLE_LABEL: Record<string, string> = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier', inventory: 'Inventory', fulfillment: 'Fulfilment' };
export const ROOM_LABEL: Record<string, string> = { shop_floor: 'Shop floor', back_room: 'Back room', quarantine: 'Quarantine' };
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const perMonth = (paise: number | null) => (paise === null ? null : `${inr.format(paise / 100)} a month`);
