'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { fmtDate, fmtDateTime } from '../../../../../lib/datetime';
import { money } from '../../../../../lib/format';
import {
  api, errorText, type Contact, type ContactDetail, type ContactType, type CustomerHistoryItem, type Page, type SupplierHistoryItem,
} from '../../../../../lib/contacts-api';
import { PAY_METHOD } from '../../../../../lib/sales-api';
import { ContactForm } from '../../_components/contact-form';

// One customer or supplier: their details, totals and every bill or receipt, newest first.

export default function ContactPage() {
  const { kind, id } = useParams<{ kind: string; id: string }>();
  const type: ContactType = kind === 'suppliers' ? 'supplier' : 'customer';
  const [d, setD] = useState<ContactDetail | null>(null);
  const [history, setHistory] = useState<Page<CustomerHistoryItem | SupplierHistoryItem> | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [more, setMore] = useState(false);

  const load = () => api<ContactDetail>(`/contacts/${type}s/${id}`)
    .then((r) => { setD(r.data); setHistory(r.data.history as Page<CustomerHistoryItem | SupplierHistoryItem>); })
    .catch((e) => setError(errorText(e)));
  useEffect(() => { load(); }, [type, id]);

  const loadMore = async () => {
    if (!history?.nextCursor) return;
    setMore(true);
    try {
      const { data } = await api<Page<CustomerHistoryItem | SupplierHistoryItem>>(`/contacts/${type}s/${id}/history?cursor=${history.nextCursor}`);
      setHistory({ items: [...history.items, ...data.items], nextCursor: data.nextCursor });
    } catch (e) { setError(errorText(e)); } finally { setMore(false); }
  };

  // A supplier is archived, never deleted: their receipts and purchase orders stay on record.
  const archive = async () => {
    setError('');
    try { await api(`/suppliers/${id}`, { method: 'PATCH', body: { archived: !d!.contact.archived } }); await load(); } catch (e) { setError(errorText(e)); }
  };

  if (!d || !history) return <div className="ui-content">{error ? <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div> : <div className="ui-skeleton" style={{ height: 240 }} />}</div>;
  const c: Contact = d.contact;

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div>
          <Link className="ui-caption" href={`/contacts${type === 'supplier' ? '?type=supplier' : ''}`}>Contacts /</Link>
          <h1 className="ui-h1">{c.name} {c.archived && <span className="ui-badge">archived</span>}</h1>
          <div className="ui-caption">
            {[c.phone, c.email, c.gstin ? `GSTIN ${c.gstin}` : null, c.stateName].filter(Boolean).join(' · ') || 'No contact details'}
            {c.address && <><br />{c.address}</>}
          </div>
        </div>
        <div className="ui-actions">
          {type === 'supplier' && d.can.edit && !c.archived && <Link className="ui-btn" href={`/purchasing/new?supplierId=${c.id}`}>New purchase order</Link>}
          {type === 'supplier' && d.can.edit && <button className="ui-btn ui-btn--ghost" type="button" onClick={archive}>{c.archived ? 'Restore' : 'Archive'}</button>}
          {d.can.edit && <button className="ui-btn" type="button" onClick={() => setEditing(true)}>Edit</button>}
        </div>
      </div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

      <div className="gp-kpis">
        {c.type === 'customer' ? <>
          <Tile label="Bills" value={String(c.stats.orders)} />
          <Tile label="Bought, after returns" value={money(c.stats.net)} />
          <Tile label="Returned or voided" value={money(c.stats.returned)} />
          <Tile label="Last bill" value={c.stats.lastAt ? fmtDate(c.stats.lastAt) : 'Never'} />
        </> : <>
          <Tile label="Goods receipts" value={String(c.stats.receipts)} />
          <Tile label="Received (at cost)" value={c.stats.purchased === null ? '—' : money(c.stats.purchased)} />
          <Tile label="Open purchase orders" value={String(c.stats.openPurchaseOrders)} />
          <Tile label="Last receipt" value={c.stats.lastAt ? fmtDate(c.stats.lastAt) : 'Never'} />
        </>}
      </div>

      <div className="ui-panel">
        <div className="ui-panel-head"><h2 className="ui-h3">{type === 'customer' ? 'Bills and orders' : 'Receipts and returns'}</h2></div>
        {history.items.length === 0
          ? <div className="ui-empty"><p className="ui-muted">{type === 'customer' ? 'No bills yet.' : 'Nothing received from this supplier yet.'}</p></div>
          : type === 'customer' ? <CustomerTable items={history.items as CustomerHistoryItem[]} /> : <SupplierTable items={history.items as SupplierHistoryItem[]} />}
        {history.nextCursor && (
          <div className="ui-pager"><span>{history.items.length} shown</span>
            <button className="ui-btn ui-btn--sm" type="button" disabled={more} aria-busy={more} onClick={loadMore}>Show more</button></div>
        )}
      </div>

      {editing && <ContactForm type={type} contact={c} states={d.states} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return <div className="ui-panel ui-kpi"><span className="ui-caption">{label}</span><span className="ui-kpi-value" style={{ fontSize: 'var(--text-xl)' }}>{value}</span></div>;
}

function CustomerTable({ items }: { items: CustomerHistoryItem[] }) {
  return (
    <div className="ui-table-wrap"><table className="ui-table" data-collapse>
      <thead><tr><th scope="col">Bill</th><th scope="col">From</th><th scope="col" className="ui-num">Lines</th><th scope="col">Status</th><th scope="col" className="ui-money">Total</th></tr></thead>
      <tbody>{items.map((o) => (
        <tr key={o.id}>
          <td data-primary>
            {o.invoice ? <Link className="ui-cell-title" href={`/invoices/${o.invoice.id}`}>{o.invoice.number}</Link>
              : o.channel === 'woocommerce' ? <Link className="ui-cell-title" href={`/orders/${o.id}`}>Web #{o.number}</Link>
                : <span className="ui-cell-title">{o.number}</span>}
            <div className="ui-cell-sub">{fmtDateTime(o.at)}</div>
          </td>
          <td data-label="From">{o.channel === 'pos' ? 'Counter' : <Link href={`/orders/${o.id}`}>Web #{o.number}</Link>}
            {o.paymentMethod && <div className="ui-cell-sub">{o.paymentMethod.split(' + ').map((m) => PAY_METHOD[m] ?? m).join(' + ')}</div>}</td>
          <td className="ui-num" data-label="Lines">{o.lines}</td>
          <td data-label="Status">{o.voided ? <span className="ui-badge ui-badge--danger">Voided</span>
            : Number(o.credited) >= Number(o.total) && Number(o.total) > 0 ? <span className="ui-badge ui-badge--warning">Returned</span>
            : Number(o.credited) > 0 ? <span className="ui-badge ui-badge--warning">Part returned</span>
              : o.status === 'cancelled' || o.status === 'failed' ? <span className="ui-badge">{o.status === 'cancelled' ? 'Cancelled' : 'Failed'}</span>
                : o.invoice ? <span className="ui-badge ui-badge--success">Billed</span> : <span className="ui-badge ui-badge--info">Not billed yet</span>}</td>
          <td className="ui-money" data-label="Total">{money(o.total)}
            {Number(o.credited) > 0 && !o.voided && <div className="ui-cell-sub">−{money(o.credited)} returned</div>}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function SupplierTable({ items }: { items: SupplierHistoryItem[] }) {
  return (
    <div className="ui-table-wrap"><table className="ui-table" data-collapse>
      <thead><tr><th scope="col">Document</th><th scope="col">Details</th><th scope="col" className="ui-num">Qty</th><th scope="col" className="ui-money">Value at cost</th></tr></thead>
      <tbody>{items.map((h) => (
        <tr key={h.id}>
          <td data-primary>
            {h.kind === 'receipt' ? <Link className="ui-cell-title" href={`/purchasing/receipts/${h.id}`}>{h.number}</Link> : <span className="ui-cell-title">{h.number}</span>}
            <span className={`ui-badge${h.kind === 'return' ? ' ui-badge--warning' : ''}`} style={{ marginLeft: 6 }}>{h.kind === 'receipt' ? 'Received' : 'Returned'}</span>
            <div className="ui-cell-sub">{fmtDateTime(h.at)}</div>
          </td>
          <td data-label="Details">{h.kind === 'receipt'
            ? [h.reference ? `Their bill ${h.reference}` : null, h.purchaseOrder ? `PO ${h.purchaseOrder}` : null].filter(Boolean).join(' · ') || <span className="ui-muted">—</span>
            : h.reference}</td>
          <td className="ui-num" data-label="Qty">{h.qty ?? '—'}</td>
          <td className="ui-money" data-label="Value at cost">{h.value === null ? <span className="ui-muted">—</span> : money(h.value)}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}
