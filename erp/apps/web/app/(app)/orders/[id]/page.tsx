'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { attrLabel, money } from '../../../../lib/format';
import { dateTime } from '../../../../lib/stock-api';
import { useCan } from '@/lib/me';
import { type OrderInvoicing } from '../../../../lib/sales-api';
import { WEB_UPDATE } from '../../../../lib/fulfil-api';
import { api, errorText, ORDER_STATUS, RESERVATION, type Address, type Order as WooOrder, type OrderLine } from '../../../../lib/woo-api';
import { ItemPicker } from '../../stock/_components/item-picker';

type Order = WooOrder & OrderInvoicing & { can: WooOrder['can'] & { issueInvoice?: boolean } };

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const [o, setO] = useState<Order | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mapping, setMapping] = useState<OrderLine | null>(null);

  useEffect(() => { api<Order>(`/orders/${id}`).then((r) => setO(r.data)).catch((e) => setError(errorText(e))); }, [id]);

  const run = async (fn: () => Promise<{ data: Omit<Order, 'can'> }>) => {
    setBusy(true); setError('');
    try { const { data } = await fn(); setO((prev) => ({ ...data, can: prev!.can })); setMapping(null); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const retry = () => run(() => api(`/orders/${id}/retry-reservation`, { method: 'POST' }));
  const mapLine = (lineId: string, variantId: string) => run(() => api(`/orders/${id}/map-line`, { method: 'POST', body: { lineId, variantId } }));
  const unpick = (reason: string) => run(() => api(`/orders/${id}/unpick`, { method: 'POST', body: { reason } }));
  const retryWeb = () => run(() => api(`/orders/${id}/web-update/retry`, { method: 'POST' }));

  if (!o) return <div className="ui-content">{error ? <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div> : <div className="ui-skeleton" style={{ height: 240 }} />}</div>;

  const [tone, label] = ORDER_STATUS[o.status] ?? ['', o.status];
  const unmatched = o.lines.filter((l) => !l.variantId && Number(l.qty) > 0);
  const waiting = o.status === 'stock_exception' || o.status === 'needs_review';

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div>
          <Link className="ui-caption" href="/orders">Online orders /</Link>
          <h1 className="ui-h1">#{o.number} <span className={`ui-badge${tone ? ` ui-badge--${tone}` : ''}`}>{label}</span></h1>
          <div className="ui-caption">WooCommerce · placed {dateTime(o.placedAt)} · shop status “{o.wooStatus}” · {o.paymentMethod || 'no payment method'}</div>
        </div>
        <div className="ui-actions">
          {waiting && o.can.fulfil && unmatched.length === 0 && <button className="ui-btn ui-btn--primary" type="button" disabled={busy} aria-busy={busy} onClick={retry}>Try to hold stock again</button>}
        </div>
      </div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

      {o.status === 'stock_exception' && (
        <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">
          {unmatched.length > 0
            ? <><strong>Some items are not in the ERP.</strong> Use “Match to a product” on each one; the ERP then holds stock for the whole order.</>
            : <><strong>Not enough stock to hold this order.</strong> {o.exceptionReason}. Receive or move stock to the online location, then try again. Nothing is held until every line can be.</>}
        </div></div>
      )}
      {o.status === 'needs_review' && (
        <div className="ui-alert ui-alert--warning" role="alert"><div className="ui-alert-body">
          <strong>Check this order.</strong> {o.exceptionReason ?? 'The shop changed it in a way the ERP does not handle by itself.'} Read the timeline below, and settle it in WooCommerce if needed.
        </div></div>
      )}

      <div className="ui-panel">
        <div className="ui-table-wrap"><table className="ui-table" data-collapse>
          <thead><tr><th scope="col">Item</th><th scope="col" className="ui-num">Qty</th><th scope="col" className="ui-money">Price</th><th scope="col" className="ui-money">Total</th><th scope="col">Stock</th></tr></thead>
          <tbody>{o.lines.map((l) => {
            const [rt, rl] = l.reservation ? RESERVATION[l.reservation] ?? ['', l.reservation] : ['', ''];
            const removed = Number(l.qty) === 0;
            return (
              <tr key={l.id} style={removed ? { opacity: 0.6 } : undefined}>
                <td data-primary>
                  {l.erp ? (
                    <><div className="ui-cell-title">{l.erp.name}{Object.keys(l.erp.attributes ?? {}).length > 0 && <span className="ui-muted"> · {attrLabel(l.erp.attributes)}</span>}</div><div className="ui-cell-sub ui-code">{l.erp.sku}</div>
                      {l.sku.toLowerCase() !== l.erp.sku.toLowerCase() && <div className="ui-cell-sub">Sold in the shop as {l.name} ({l.sku || 'no SKU'})</div>}</>
                  ) : (
                    <><div className="ui-cell-title">{l.name}</div><div className="ui-cell-sub"><span className="ui-code">{l.sku || '(no SKU)'}</span> · <span style={{ color: 'var(--danger)' }}>not in the ERP</span></div></>
                  )}
                  {removed && <div className="ui-cell-sub">Removed from the order in the shop</div>}
                </td>
                <td className="ui-num" data-label="Qty">{l.qty}</td>
                <td className="ui-money" data-label="Price">{money(l.unitPrice)}</td>
                <td className="ui-money" data-label="Total">{money(l.lineTotal)}</td>
                <td data-label="Stock">
                  {rl ? <><span className={`ui-badge${rt ? ` ui-badge--${rt}` : ''}`}>{rl}</span>{l.location && <div className="ui-cell-sub">{l.location}</div>}</> : <span className="ui-muted">—</span>}
                  {!l.variantId && !removed && o.can.mapLines && <div><button className="ui-btn ui-btn--sm" type="button" disabled={busy} onClick={() => setMapping(l)}>Match to a product</button></div>}
                </td>
              </tr>
            );
          })}</tbody>
          <tfoot>
            <TotalRow label="Items" value={o.totals.subtotal} />
            {Number(o.totals.discount) > 0 && <TotalRow label="Discount" value={`-${o.totals.discount}`} />}
            {Number(o.totals.shipping) > 0 && <TotalRow label="Shipping" value={o.totals.shipping} />}
            <TotalRow label="Tax" value={o.totals.tax} />
            <TotalRow label="Total" value={o.totals.total} strong />
          </tfoot>
        </table></div>
      </div>

      <FulfilmentPanel o={o} busy={busy} onUnpick={unpick} onRetryWeb={retryWeb} />

      <InvoicePanel o={o} busy={busy} onIssue={(placeOfSupply) => run(() => api(`/orders/${id}/invoice`, { method: 'POST', body: placeOfSupply ? { placeOfSupply } : {} }))} />

      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <div className="ui-panel">
          <div className="ui-panel-head"><span className="ui-h3">Customer</span></div>
          <div className="ui-panel-body">
            {o.customer ? (
              <>
                <div className="ui-cell-title">{o.customer.name || 'Guest'}</div>
                {o.customer.phone && <div><a href={`tel:${o.customer.phone}`}>{o.customer.phone}</a></div>}
                {o.customer.email && <div className="ui-muted">{o.customer.email}</div>}
                <AddressBlock title="Ship to" a={hasAddress(o.customer.shipping) ? o.customer.shipping : o.customer.billing} />
              </>
            ) : <span className="ui-muted">No customer details.</span>}
          </div>
        </div>
        <div className="ui-panel">
          <div className="ui-panel-head"><span className="ui-h3">Timeline</span></div>
          <div>{o.events.map((e, i) => (
            <div className="ui-list-row" key={i} style={{ alignItems: 'flex-start' }}>
              <span style={{ flex: 1 }}>{e.message}{e.actor && <span className="ui-muted"> · {e.actor}</span>}</span>
              <span className="ui-caption" style={{ whiteSpace: 'nowrap' }}>{dateTime(e.at)}</span>
            </div>
          ))}</div>
        </div>
      </div>

      {mapping && (
        <div className="ui-backdrop" role="presentation" onClick={() => setMapping(null)}>
          <div className="ui-dialog" role="dialog" aria-modal aria-labelledby="map-title" onClick={(e) => e.stopPropagation()}>
            <div className="ui-dialog-head"><h2 className="ui-h3" id="map-title">Which product is “{mapping.name}”?</h2></div>
            <div className="ui-dialog-body">
              <p className="ui-muted" style={{ marginTop: 0 }}>The shop sent SKU <span className="ui-code">{mapping.sku || '(none)'}</span>, which no ERP item has. Pick the ERP item for this line; the ERP then tries to hold stock for the whole order. To stop this happening again, give the product the same SKU in both places.</p>
              <ItemPicker autoFocus onPick={(item) => mapLine(mapping.id, item.variantId)} />
            </div>
            <div className="ui-dialog-foot"><button className="ui-btn" type="button" onClick={() => setMapping(null)}>Cancel</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

/** GST documents for this order (B5): the invoice issued when it was completed, credit notes for returns, or why it waits. */
function InvoicePanel({ o, busy, onIssue }: { o: Order; busy: boolean; onIssue: (placeOfSupply: string) => void }) {
  const [states, setStates] = useState<{ code: string; name: string }[]>([]);
  const [pos, setPos] = useState('');
  const canReturn = useCan('return.manage');
  const pending = o.invoiceState === 'pending' || (!o.invoiceState && o.status === 'completed' && !o.documents?.length);
  useEffect(() => {
    if (pending && o.can.issueInvoice) api<{ states: { code: string; name: string }[] }>('/billing/settings').then((r) => setStates(r.data.states)).catch(() => {});
  }, [pending, o.can.issueInvoice]);
  if (!o.documents?.length && !pending) return null;
  return (
    <div className="ui-panel">
      <div className="ui-panel-head"><span className="ui-h3">GST invoice</span></div>
      {pending && (
        <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <div className="ui-alert ui-alert--warning" role="alert"><div className="ui-alert-body">
            <strong>No invoice yet.</strong> {o.invoiceNote ?? 'This order was completed before the ERP issued GST invoices.'}
          </div></div>
          {o.can.issueInvoice && (
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              {states.length > 0 && (
                <label className="ui-field" style={{ minWidth: 220 }}><span className="ui-label">Delivered to (place of supply)</span>
                  <select className="ui-select" value={pos} onChange={(e) => setPos(e.target.value)}>
                    <option value="">From the shipping address</option>{states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
                  </select></label>
              )}
              <button className="ui-btn ui-btn--primary" type="button" disabled={busy} aria-busy={busy} onClick={() => onIssue(pos)}>Issue invoice</button>
            </div>
          )}
        </div>
      )}
      {o.invoiceState === 'not_needed' && <div className="ui-panel-body ui-muted">Web invoices are turned off in Billing &amp; GST.</div>}
      {(o.documents?.length ?? 0) > 0 && <div>{o.documents.map((d) => (
        <div className="ui-list-row" key={d.id}>
          <span><Link href={`/invoices/${d.id}`}>{d.number}</Link> · {d.type === 'invoice' ? 'Invoice' : 'Credit note'} · {dateTime(d.issuedAt)}</span>
          <span className="ui-money">{money(d.total)}</span>
        </div>
      ))}</div>}
      {canReturn && o.documents?.some((d) => d.type === 'invoice') && ['dispatched', 'completed', 'refunded', 'needs_review'].includes(o.status) && (
        <div className="ui-panel-body"><Link className="ui-btn ui-btn--sm" href={`/returns/new?invoice=${o.documents.find((d) => d.type === 'invoice')!.id}`}>Return items</Link></div>
      )}
    </div>
  );
}

/** B6: where the order is in picking and packing, and the parcel once it has left. */
function FulfilmentPanel({ o, busy, onUnpick, onRetryWeb }: { o: Order; busy: boolean; onUnpick: (reason: string) => void; onRetryWeb: () => void }) {
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const inProgress = o.status === 'picking' || o.status === 'packed';
  if (!inProgress && !o.shipment) return null;
  const s = o.shipment;
  const [tone, label] = s ? WEB_UPDATE[s.webUpdate] ?? ['', s.webUpdate] : ['', ''];
  return (
    <div className="ui-panel">
      <div className="ui-panel-head"><span className="ui-h3">{s ? 'Shipment' : 'Fulfilment'}</span></div>
      <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
        {inProgress && (
          <div>
            {o.status === 'picking' && o.pickList && <>On pick list <Link href={`/pick/${o.pickList.id}`}>{o.pickList.number}</Link>. </>}
            {o.status === 'packed' && o.packedAt && <>Packed {dateTime(o.packedAt)}. <Link href="/fulfilment?stage=packed">Dispatch it from Fulfilment</Link>. </>}
            {o.can.fulfil && !asking && <button className="ui-btn ui-btn--sm" type="button" onClick={() => setAsking(true)}>Take off {o.status === 'packed' ? 'packing' : 'picking'}</button>}
            {asking && (
              <form style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 'var(--space-2)' }} onSubmit={(e) => { e.preventDefault(); onUnpick(reason.trim()); }}>
                <label className="ui-field" style={{ flex: 1, minWidth: 220 }}><span className="ui-label">Why (stock stays held; picked items go back on the shelf)</span>
                  <input className="ui-input" autoFocus minLength={3} maxLength={200} required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
                <button className="ui-btn" type="button" onClick={() => setAsking(false)}>Keep</button>
                <button className="ui-btn ui-btn--primary" type="submit" disabled={busy || reason.trim().length < 3}>Back to ready to pick</button>
              </form>
            )}
          </div>
        )}
        {s && (
          <>
            <div><strong>{s.carrier}</strong>{s.service && ` · ${s.service}`}{s.trackingNo ? <> · tracking <span className="ui-code">{s.trackingNo}</span></> : <span className="ui-muted"> · no tracking number</span>}</div>
            <div className="ui-caption">Dispatched {dateTime(s.shippedAt)}{s.dispatchedBy && ` by ${s.dispatchedBy}`}</div>
            <div><span className={`ui-badge${tone ? ` ui-badge--${tone}` : ''}`}>{label}</span>{s.webSyncedAt && <span className="ui-caption"> {dateTime(s.webSyncedAt)}</span>}
              {s.webError && s.webUpdate !== 'synced' && <div className="ui-caption">{s.webError}</div>}
              {s.webUpdate === 'failed' && o.can.fulfil && <div style={{ marginTop: 'var(--space-2)' }}><button className="ui-btn ui-btn--sm" type="button" disabled={busy} onClick={onRetryWeb}>Send to the shop again</button></div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <tr><th scope="row" colSpan={3} style={{ textAlign: 'right' }}>{label}</th><td className="ui-money">{strong ? <strong>{money(value)}</strong> : money(value)}</td><td /></tr>;
}

const hasAddress = (a?: Address) => !!a && !!(a.address1 || a.city);

function AddressBlock({ title, a }: { title: string; a?: Address }) {
  if (!hasAddress(a)) return null;
  return (
    <div style={{ marginTop: 'var(--space-3)' }}>
      <div className="ui-label">{title}</div>
      <div>{[a!.name, a!.company, a!.address1, a!.address2, [a!.city, a!.state, a!.postcode].filter(Boolean).join(' '), a!.phone].filter(Boolean).map((x, i) => <div key={i}>{x}</div>)}</div>
    </div>
  );
}
