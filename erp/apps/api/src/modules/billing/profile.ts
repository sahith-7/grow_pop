import { fmtMoney } from '../../lib/decimal.js';
import type { Tx } from '../../db.js';
import { gstinProblem, STATES, stateTaxLabel } from '../../lib/gst.js';
import { appError } from '../../lib/phase1.js';
import { listLocations } from '../inventory/service.js';

// Who is selling, and under which GST rules. The seller's legal name, GSTIN and address are Phase 1 settings
// (tenants, store_settings); B5's own choices are in sales_settings. Every invoice copies this profile as it is at that moment.
// With outlets (v2, D101) a profile is for one outlet: the main outlet is exactly the store's settings; any other outlet
// brings its own address, state, GSTIN (when it is in another state), bill prefixes and POS stock location.

export type Scheme = 'regular' | 'composition' | 'unregistered';
export const BILL_FORMATS = ['57mm', '80mm', 'a4', 'a5'] as const;
export type BillFormat = (typeof BILL_FORMATS)[number];

export interface Seller {
  name: string; legalName: string; gstin: string | null; address: string; city: string; state: string; postalCode: string;
  phone: string; email: string; stateCode: string | null; stateName: string | null;
}

export interface OutletRef { id: string; name: string; isMain: boolean; active: boolean }

export interface Profile {
  outlet: OutletRef;
  ready: boolean;
  problems: string[];
  scheme: Scheme | null;
  stateCode: string | null;        // the seller's GST state: from the GSTIN when registered
  seller: Seller;
  timezone: string;
  settings: {
    pricesIncludeTax: boolean; roundOff: boolean; posLocationId: string | null; discountReasonThresholdPct: string;
    cashierDiscountLimitPct: string; managerDiscountLimitPct: string; invoicePrefix: string; creditNotePrefix: string;
    invoiceWebOrders: boolean; receiptFooter: string | null;
    /** What the POS prints after a sale and what an invoice page opens with (v2, D99). */
    billFormat: BillFormat;
    /** Every counter bill names its customer (name and mobile) or is marked Walk-in (v2, D104). */
    requireCustomer: boolean;
    /** Cash control (v2, D110–D113): a register must be open to bill; till expense limits; return and exchange rules. */
    requireRegister: boolean; expenseLimitEach: string; expenseLimitDay: string; returnDays: number | null; returnMoneyBack: boolean;
  };
}

const pct = (v: string) => v.replace(/\.?0+$/, '') || '0';

/** The store's main outlet, made on first use. */
export async function mainOutletId(tx: Tx): Promise<string> {
  const { rows: [r] } = await tx.query(`SELECT main_outlet_id(current_setting('app.tenant_id')::uuid) AS id`);
  return r.id;
}

/** The outlet a stock location belongs to (the main one when there is no location). */
export async function outletOfLocation(tx: Tx, locationId: string | null | undefined): Promise<string> {
  if (locationId) {
    const { rows: [r] } = await tx.query('SELECT outlet_id FROM locations WHERE id = $1', [locationId]);
    if (r) return r.outlet_id;
  }
  return mainOutletId(tx);
}

/** The PAN inside a GSTIN (characters 3 to 12): one legal business. */
export const panOf = (gstin: string) => gstin.slice(2, 12);

export async function loadProfile(tx: Tx, outletId?: string | null): Promise<Profile> {
  await tx.query(`INSERT INTO sales_settings (tenant_id) VALUES (current_setting('app.tenant_id')::uuid) ON CONFLICT DO NOTHING`);
  const { rows: [o] } = await tx.query('SELECT * FROM outlets WHERE id = $1', [outletId ?? await mainOutletId(tx)]);
  if (!o) throw appError(404, 'NOT_FOUND', 'Outlet not found');
  const { rows: [r] } = await tx.query(
    `SELECT t.name, t.legal_name, t.timezone, ss.address, ss.city, ss.state, ss.postal_code, ss.phone, ss.email, ss.gstin, s.*
       FROM tenants t
       JOIN sales_settings s ON s.tenant_id = t.id
       LEFT JOIN store_settings ss ON ss.tenant_id = t.id`);
  const scheme = r.gst_scheme as Scheme | null;
  const gstin = (r.gstin as string | null) || null;
  const registered = scheme === 'regular' || scheme === 'composition';
  const stateCode = registered ? (gstin ? gstin.slice(0, 2) : null) : (r.state_code as string | null);
  const problems: string[] = [];
  if (!scheme) problems.push('Choose your GST registration in Billing & GST.');
  if (registered && !gstin) problems.push('Add your GSTIN in Settings.');
  if (registered && gstin) { const p = gstinProblem(gstin); if (p) problems.push(`Your GSTIN in Settings: ${p}.`); }
  if (scheme === 'unregistered' && !stateCode) problems.push('Choose your state in Billing & GST.');
  if (!(r.legal_name ?? '').trim()) problems.push('Add your legal business name in Settings.');
  if (!(r.address ?? '').trim()) problems.push('Add your shop address in Settings.');
  const outlet: OutletRef = { id: o.id, name: o.name, isMain: o.is_main, active: o.active };
  const base: Profile = {
    outlet,
    ready: problems.length === 0,
    problems,
    scheme,
    stateCode,
    timezone: r.timezone ?? 'Asia/Kolkata',
    seller: {
      name: r.name ?? '', legalName: r.legal_name ?? '', gstin: registered ? gstin : null, address: r.address ?? '', city: r.city ?? '',
      state: r.state ?? '', postalCode: r.postal_code ?? '', phone: r.phone ?? '', email: r.email ?? '',
      stateCode, stateName: stateCode ? STATES[stateCode] ?? null : null,
    },
    settings: {
      pricesIncludeTax: r.prices_include_tax, roundOff: r.round_off, posLocationId: r.pos_location_id,
      discountReasonThresholdPct: pct(r.discount_reason_threshold_pct), cashierDiscountLimitPct: pct(r.cashier_discount_limit_pct),
      managerDiscountLimitPct: pct(r.manager_discount_limit_pct), invoicePrefix: r.invoice_prefix, creditNotePrefix: r.credit_note_prefix,
      invoiceWebOrders: r.invoice_web_orders, receiptFooter: r.receipt_footer, billFormat: (r.bill_format ?? '80mm') as BillFormat,
      requireCustomer: r.require_customer !== false,
      requireRegister: r.require_register !== false, expenseLimitEach: fmtMoney(r.expense_limit_each ?? '500')!, expenseLimitDay: fmtMoney(r.expense_limit_day ?? '1000')!,
      returnDays: (r.return_days as number | null) ?? null, returnMoneyBack: r.return_money_back !== false,
    },
  };
  return o.is_main ? base : outletProfile(base, o, registered, gstin);
}

/**
 * Another outlet: same business and GST scheme, its own place of business. In the main outlet's state it uses the store's
 * GSTIN; in another state it needs its own registration (same PAN), or nothing can be billed there.
 */
function outletProfile(base: Profile, o: Record<string, any>, registered: boolean, mainGstin: string | null): Profile {
  const problems = base.problems.filter((x) => !x.startsWith('Add your shop address'));
  const sameState = o.state_code === base.stateCode;
  let gstin: string | null = null;
  if (registered) {
    gstin = o.gstin ?? (sameState ? mainGstin : null);
    if (!gstin) problems.push(`Add the GSTIN for ${o.name}: it is in ${STATES[o.state_code] ?? 'another state'}, and each state needs its own GST registration.`);
    else if (o.gstin && mainGstin && panOf(o.gstin) !== panOf(mainGstin)) problems.push(`${o.name}'s GSTIN belongs to a different business (PAN). Each business needs its own GroPop store.`);
  }
  if (!o.active) problems.push(`${o.name} is closed. Reopen it on the Account page to bill there.`);
  const stateCode = gstin ? gstin.slice(0, 2) : o.state_code;
  return {
    ...base,
    problems,
    ready: problems.length === 0,
    stateCode,
    seller: {
      ...base.seller, gstin, address: o.address ?? '', city: o.city ?? '', state: STATES[o.state_code] ?? '', postalCode: o.postal_code ?? '',
      phone: o.phone || base.seller.phone, stateCode, stateName: stateCode ? STATES[stateCode] ?? null : null,
    },
    settings: { ...base.settings, posLocationId: o.pos_location_id, invoicePrefix: o.invoice_prefix, creditNotePrefix: o.credit_note_prefix },
  };
}

/** The profile, or 409 BILLING_NOT_SET_UP listing what is missing. */
export async function readyProfile(tx: Tx, outletId?: string | null) {
  const p = await loadProfile(tx, outletId);
  if (!p.ready) throw appError(409, 'BILLING_NOT_SET_UP', `Billing is not set up yet: ${p.problems.join(' ')}`);
  return p;
}

/** Where POS sales take stock from: the outlet's chosen location, else its Shop floor. Must be active and sellable. */
export async function posLocation(tx: Tx, p: Profile) {
  const all = (await listLocations(tx)).filter((l) => l.outletId === p.outlet.id);
  const loc = p.settings.posLocationId ? all.find((l) => l.id === p.settings.posLocationId) : all.find((l) => l.type === 'shop_floor' && l.active);
  if (!loc || !loc.active || !loc.isSellable) throw appError(409, 'POS_LOCATION_UNAVAILABLE', 'The POS stock location is inactive or not sellable. Pick another in Billing & GST.');
  return { id: loc.id as string, name: loc.name as string, outletId: loc.outletId };
}

/** The seller block printed on a document (snapshot). */
export function sellerSnapshot(p: Profile) {
  return { ...p.seller, scheme: p.scheme, stateTaxLabel: p.stateCode ? stateTaxLabel(p.stateCode) : 'SGST' };
}
