import type { Tx } from '../../db.js';
import { milli } from '../../lib/quantity.js';
import { lineTax, paise, rateBp, rupees, STATES, stateFromAddress } from '../../lib/gst.js';
import { issueInvoice, type PricedLine } from '../billing/documents.js';
import { loadProfile, outletOfLocation } from '../billing/profile.js';

// GST invoice for a web order, issued when the goods leave (CGST s.31: at or before removal of goods). In B4/B5 that is
// the moment WooCommerce marks the order completed; from B6 it is dispatch.
// Amounts are what the customer paid in WooCommerce (line total + line tax), treated as GST-inclusive at the ERP product's
// rate, so the invoice total always equals the order total. Shipping and fees are one line at the highest item rate
// (composite supply, principal supply = the highest-taxed goods: CGST s.8(a); D47, for the tax adviser to confirm).
// Place of supply is the delivery state (IGST Act s.10(1)(a)); another state means IGST.

export type WebInvoiceResult = { state: 'issued'; invoiceId: string; number: string } | { state: 'pending' | 'not_needed'; note: string };

async function mark(tx: Tx, orderId: string, state: 'issued' | 'pending' | 'not_needed', note: string | null, actorId: string | null, event?: string) {
  await tx.query('UPDATE sales_orders SET invoice_state = $2, invoice_note = $3, updated_at = now() WHERE id = $1', [orderId, state, note?.slice(0, 500) ?? null]);
  if (event) {
    await tx.query(
      `INSERT INTO sales_order_events (tenant_id, order_id, kind, message, actor_id) VALUES (current_setting('app.tenant_id')::uuid, $1, 'invoice', $2, $3)`,
      [orderId, event.slice(0, 1000), actorId]);
  }
}

/**
 * Issue the order's invoice, or record why not (invoice_state 'pending' + a note the order screen shows, with an
 * "Issue invoice" button for after the problem is fixed). Never throws for a business reason, so a webhook is never
 * retried because of billing settings. `placeOfSupply` lets a person choose the state when the address doesn't say.
 */
export async function invoiceWebOrder(tx: Tx, orderId: string, actorId: string | null, opts: { placeOfSupply?: string } = {}): Promise<WebInvoiceResult> {
  const { rows: [o] } = await tx.query(
    `SELECT o.*, (SELECT i.id FROM invoices i WHERE i.order_id = o.id) AS invoice_id FROM sales_orders o WHERE o.id = $1 AND o.channel = 'woocommerce'`, [orderId]);
  if (!o) return { state: 'pending', note: 'Order not found' };
  if (o.invoice_id) { const { rows: [i] } = await tx.query('SELECT number FROM invoices WHERE id = $1', [o.invoice_id]); return { state: 'issued', invoiceId: o.invoice_id, number: i.number }; }

  // The outlet whose stock room ships web orders issues their invoices (v2, D101).
  const p = await loadProfile(tx, await outletOfLocation(tx, o.location_id));
  const pending = async (note: string) => { await mark(tx, orderId, 'pending', note, actorId, `Invoice not issued: ${note}`); return { state: 'pending' as const, note }; };
  if (!p.settings.invoiceWebOrders) {
    const note = 'Web-order invoices are made in WooCommerce (Billing & GST setting)';
    await mark(tx, orderId, 'not_needed', note, actorId);
    return { state: 'not_needed', note };
  }
  if (!p.ready) return pending(p.problems.join(' '));
  if (o.currency !== 'INR') return pending(`The order is in ${o.currency}; only INR orders are invoiced`);

  // Place of supply: delivery address, else billing address.
  const snap = o.customer_snapshot ?? {};
  const addr = snap.shipping?.address1 || snap.shipping?.city ? snap.shipping : snap.billing ?? {};
  if (addr.country && addr.country !== 'IN') return pending(`Delivery is outside India (${addr.country}); exports need your tax adviser`);
  const pos = opts.placeOfSupply ?? stateFromAddress(addr.state);
  if (!pos || !STATES[pos]) return pending(`The delivery state “${addr.state ?? ''}” is not a GST state; choose it and issue the invoice`);
  const supply = pos === p.stateCode ? 'intra' : 'inter';

  const { rows: lines } = await tx.query(
    `SELECT l.id, l.variant_id, l.sku, l.name, l.qty, l.line_total, l.tax_total, p.hsn_code, p.gst_rate, p.unit_code, v.sku AS erp_sku
       FROM sales_order_lines l LEFT JOIN product_variants v ON v.id = l.variant_id LEFT JOIN products p ON p.id = v.product_id
      WHERE l.order_id = $1 AND l.qty > 0 ORDER BY l.position`, [orderId]);
  if (!lines.length) return pending('The order has no items');
  const unmatched = lines.filter((l) => !l.variant_id);
  if (unmatched.length) return pending(`Not in the ERP: ${unmatched.map((l) => l.sku || l.name).join(', ')}`);
  const regular = p.scheme === 'regular';
  const noRate = lines.filter((l) => regular && l.gst_rate === null);
  if (noRate.length) return pending(`Set a GST rate on ${noRate.map((l) => l.erp_sku).join(', ')}`);

  const priced: PricedLine[] = lines.map((l) => {
    const gross = paise(l.line_total) + paise(l.tax_total);
    const q = milli(l.qty);
    const rate = regular ? rateBp(l.gst_rate) : 0n;
    // Unit price shown = what one unit cost the customer, to 4 decimals (rupees × 10000 / thousandths of a unit).
    const unit = (gross * 100n * 1000n) / q;
    const unitPrice = `${unit / 10000n}.${(unit % 10000n).toString().padStart(4, '0')}`;
    return {
      kind: 'item', orderLineId: l.id, variantId: l.variant_id, sku: l.erp_sku ?? l.sku, description: l.name, hsn: l.hsn_code, uqc: l.unit_code ?? 'NOS',
      qty: q, unitPrice, gross, discount: 0n, rate, tax: lineTax(gross, rate, supply, true),
    };
  });
  const itemsGross = priced.reduce((a, l) => a + l.gross, 0n);
  const extra = paise(o.total) - itemsGross;
  if (extra < 0n) return pending(`Item totals (₹${rupees(itemsGross)}) are more than the order total (₹${rupees(paise(o.total))}); check the order in WooCommerce`);
  if (extra > 0n) {
    const top = priced.reduce((a, l) => (l.rate > a.rate ? l : a), priced[0]);
    priced.push({
      kind: 'shipping', orderLineId: null, variantId: null, sku: '', description: 'Shipping and handling', hsn: top.hsn, uqc: 'OTH',
      qty: 1000n, unitPrice: rupees(extra), gross: extra, discount: 0n, rate: top.rate, tax: lineTax(extra, top.rate, supply, true),
    });
  }

  const buyer = {
    name: snap.name || addr.name || undefined, phone: snap.phone || undefined,
    address: [addr.address1, addr.address2, addr.city, addr.postcode].filter(Boolean).join(', ') || undefined,
    stateCode: pos, stateName: STATES[pos],
  };
  const inv = await issueInvoice(tx, p, {
    orderId, lines: priced, buyer, placeOfSupply: pos, supply, inclusive: true, round: false, actorId,
  });
  await mark(tx, orderId, 'issued', null, actorId, `Invoice ${inv.number} issued (${supply === 'inter' ? 'IGST' : 'CGST + SGST'}, ₹${rupees(inv.totals.total)})`);
  return { state: 'issued', invoiceId: inv.id, number: inv.number };
}

/** Called inside the transaction that took the stock out. A failure here must not undo the dispatch, so it runs in a savepoint. */
export async function invoiceAfterDispatch(tx: Tx, orderId: string, actorId: string | null) {
  await tx.query('SAVEPOINT web_invoice');
  try {
    await invoiceWebOrder(tx, orderId, actorId);
    await tx.query('RELEASE SAVEPOINT web_invoice');
  } catch (e) {
    await tx.query('ROLLBACK TO SAVEPOINT web_invoice');
    const msg = e instanceof Error && 'code' in e && typeof (e as { status?: number }).status === 'number' ? e.message : 'unexpected error, try Issue invoice';
    await mark(tx, orderId, 'pending', msg, actorId, `Invoice not issued: ${msg}`);
  }
}
