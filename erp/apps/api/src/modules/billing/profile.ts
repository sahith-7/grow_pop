import type { Tx } from '../../db.js';
import { gstinProblem, STATES, stateTaxLabel } from '../../lib/gst.js';
import { appError } from '../../lib/phase1.js';
import { listLocations } from '../inventory/service.js';

// Who is selling, and under which GST rules. The seller's legal name, GSTIN and address are Phase 1 settings
// (tenants, store_settings); B5's own choices are in sales_settings. Every invoice copies this profile as it is at that moment.

export type Scheme = 'regular' | 'composition' | 'unregistered';

export interface Seller {
  name: string; legalName: string; gstin: string | null; address: string; city: string; state: string; postalCode: string;
  phone: string; email: string; stateCode: string | null; stateName: string | null;
}

export interface Profile {
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
  };
}

const pct = (v: string) => v.replace(/\.?0+$/, '') || '0';

export async function loadProfile(tx: Tx): Promise<Profile> {
  await tx.query(`INSERT INTO sales_settings (tenant_id) VALUES (current_setting('app.tenant_id')::uuid) ON CONFLICT DO NOTHING`);
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
  return {
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
      invoiceWebOrders: r.invoice_web_orders, receiptFooter: r.receipt_footer,
    },
  };
}

/** The profile, or 409 BILLING_NOT_SET_UP listing what is missing. */
export async function readyProfile(tx: Tx) {
  const p = await loadProfile(tx);
  if (!p.ready) throw appError(409, 'BILLING_NOT_SET_UP', `Billing is not set up yet: ${p.problems.join(' ')}`);
  return p;
}

/** Where POS sales take stock from: the chosen location, else Shop floor. Must be active and sellable. */
export async function posLocation(tx: Tx, p: Profile) {
  const all = await listLocations(tx);
  const loc = p.settings.posLocationId ? all.find((l) => l.id === p.settings.posLocationId) : all.find((l) => l.type === 'shop_floor' && l.active);
  if (!loc || !loc.active || !loc.isSellable) throw appError(409, 'POS_LOCATION_UNAVAILABLE', 'The POS stock location is inactive or not sellable. Pick another in Billing & GST.');
  return { id: loc.id as string, name: loc.name as string };
}

/** The seller block printed on a document (snapshot). */
export function sellerSnapshot(p: Profile) {
  return { ...p.seller, scheme: p.scheme, stateTaxLabel: p.stateCode ? stateTaxLabel(p.stateCode) : 'SGST' };
}
