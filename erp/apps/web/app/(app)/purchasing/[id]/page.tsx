'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { money } from '../../../../lib/format';
import { api, dateTime, errorText, PO_STATUS, type PurchaseOrder, type StockMeta } from '../../../../lib/stock-api';
import { ItemCell } from '../../stock/_components/item-picker';
import { PoForm } from '../_components/po-form';

export default function PurchaseOrderPage() {
  const { id } = useParams<{ id: string }>();
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [meta, setMeta] = useState<StockMeta | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<PurchaseOrder>(`/purchase-orders/${id}`).then((r) => { setPo(r.data); setEtag(r.etag); }).catch((e) => setError(errorText(e)));
    api<StockMeta>('/stock/meta').then((r) => setMeta(r.data)).catch(() => {});
  }, [id]);

  const act = async (action: 'submit' | 'cancel' | 'close', confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setError('');
    try { const r = await api<PurchaseOrder>(`/purchase-orders/${id}/${action}`, { method: 'POST' }); setPo(r.data); setEtag(r.etag); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  if (!po) return <div className="ui-content">{error ? <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div> : <div className="ui-skeleton" style={{ height: 240 }} />}</div>;

  const [tone, label] = PO_STATUS[po.status];
  const manage = !!meta?.can.purchaseManage;
  const receivable = (po.status === 'submitted' || po.status === 'partial') && meta?.can.purchaseReceive;
  const seeCost = po.total !== undefined;

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div>
          <Link className="ui-caption" href="/purchasing">Purchasing /</Link>
          <h1 className="ui-h1">{po.number} <span className={`ui-badge${tone ? ` ui-badge--${tone}` : ''}`}>{label}</span></h1>
          <div className="ui-caption">{po.supplier.name} · created {dateTime(po.createdAt)}{po.expectedDate ? ` · expected ${po.expectedDate}` : ''}</div>
        </div>
        <div className="ui-actions">
          {po.status === 'draft' && manage && <button className="ui-btn ui-btn--primary" type="button" disabled={busy} onClick={() => act('submit', `Mark ${po.number} as sent to ${po.supplier.name}? It can't be edited after this.`)}>Mark as sent</button>}
          {receivable && <Link className="ui-btn ui-btn--primary" href={`/purchasing/receive?po=${po.id}`}>Receive goods</Link>}
          {po.status === 'partial' && manage && <button className="ui-btn" type="button" disabled={busy} onClick={() => act('close', `Close ${po.number}? Anything still outstanding will no longer be expected.`)}>Close (nothing more coming)</button>}
          {(po.status === 'draft' || po.status === 'submitted') && manage && <button className="ui-btn ui-btn--ghost" type="button" disabled={busy} onClick={() => act('cancel', `Cancel ${po.number}?`)}>Cancel order</button>}
        </div>
      </div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

      {po.status === 'draft' && manage ? (
        <PoForm po={po} etag={etag} onSaved={(p, e) => { setPo(p); setEtag(e); }} />
      ) : (
        <>
          {po.notes && <p className="ui-muted">{po.notes}</p>}
          <div className="ui-panel">
            <div className="ui-table-wrap"><table className="ui-table" data-collapse>
              <thead><tr>
                <th scope="col">Item</th><th scope="col" className="ui-num">Ordered</th><th scope="col" className="ui-num">Arrived</th>
                <th scope="col" className="ui-num">Accepted</th><th scope="col" className="ui-num">Still to come</th>
                {seeCost && <th scope="col" className="ui-money">Unit cost</th>}{seeCost && <th scope="col" className="ui-money">Total</th>}
              </tr></thead>
              <tbody>{po.lines.map((l) => (
                <tr key={l.id}>
                  <td data-primary><ItemCell item={l} /></td>
                  <td className="ui-num" data-label="Ordered">{l.orderedQty}</td>
                  <td className="ui-num" data-label="Arrived">{l.receivedQty}</td>
                  <td className="ui-num" data-label="Accepted">{l.acceptedQty}</td>
                  <td className="ui-num" data-label="Still to come">{l.outstandingQty === '0' ? <span className="ui-muted">0</span> : <strong>{l.outstandingQty}</strong>}</td>
                  {seeCost && <td className="ui-money" data-label="Unit cost">{money(l.unitCost)}</td>}
                  {seeCost && <td className="ui-money" data-label="Total">{money(l.lineTotal)}</td>}
                </tr>
              ))}</tbody>
              {seeCost && <tfoot><tr><th scope="row" colSpan={6} style={{ textAlign: 'right' }}>Total before GST</th><td className="ui-money"><strong>{money(po.total)}</strong></td></tr></tfoot>}
            </table></div>
          </div>
        </>
      )}

      <div className="ui-panel">
        <div className="ui-panel-head"><span className="ui-h3">Receipts</span></div>
        {po.receipts.length === 0 ? <div className="ui-panel-body ui-muted">Nothing received yet.</div> : (
          <div className="ui-table-wrap"><table className="ui-table">
            <thead><tr><th scope="col">Receipt</th><th scope="col">When</th><th scope="col">Supplier invoice</th></tr></thead>
            <tbody>{po.receipts.map((r) => (
              <tr key={r.id}><td><Link className="ui-code" href={`/purchasing/receipts/${r.id}`}>{r.number}</Link></td><td className="ui-cell-sub">{dateTime(r.postedAt)}</td><td>{r.supplierInvoiceNo ?? <span className="ui-muted">—</span>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
