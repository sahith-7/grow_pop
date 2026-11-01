'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { money } from '../../../../lib/format';
import { dateTime, idemKey } from '../../../../lib/stock-api';
import { api, errorText, PAY_METHOD, type TaxDocument } from '../../../../lib/sales-api';
import { PRINT_CSS, TaxDocumentView, type Paper } from '../_components/tax-document';

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const [doc, setDoc] = useState<TaxDocument | null>(null);
  const [error, setError] = useState('');
  const [paper, setPaper] = useState<Paper>('a4');
  const [voiding, setVoiding] = useState(false);

  const load = () => api<TaxDocument>(`/invoices/${id}`).then((r) => setDoc(r.data)).catch((e) => setError(errorText(e)));
  useEffect(() => { load(); }, [id]);

  const print = (p: Paper) => { setPaper(p); setTimeout(() => window.print(), 50); };

  if (!doc) return <div className="ui-content">{error ? <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div> : <div className="ui-skeleton" style={{ height: 320 }} />}</div>;

  const isInvoice = doc.type === 'invoice';
  const returnable = isInvoice && !doc.voided && doc.lines.some((l) => Number(l.returnableQty) > 0);

  return (
    <div className="ui-content">
      <style>{PRINT_CSS(paper)}</style>
      <div className="ui-page-header">
        <div>
          <Link className="ui-caption" href={`/invoices${isInvoice ? '' : '?type=credit_note'}`}>{isInvoice ? 'Invoices' : 'Credit notes'} /</Link>
          <h1 className="ui-h1">{doc.title} {doc.number}{' '}
            {doc.voided ? <span className="ui-badge ui-badge--danger">Voided</span> : doc.creditNotes?.length ? <span className="ui-badge ui-badge--warning">Part returned</span> : <span className="ui-badge ui-badge--success">Issued</span>}
          </h1>
          <div className="ui-caption">
            {dateTime(doc.issuedAt)}{doc.issuedBy ? ` · by ${doc.issuedBy}` : doc.order?.channel === 'woocommerce' ? ' · issued when the web order was completed' : ''}
            {doc.order && <> · {doc.order.channel === 'pos' ? 'Counter sale' : <Link href={`/orders/${doc.order.id}`}>Web order #{doc.order.number}</Link>}</>}
            {doc.originalInvoice && <> · against <Link href={`/invoices/${doc.originalInvoice.id}`}>{doc.originalInvoice.number}</Link></>}
            {doc.return && <> · return {doc.return.number} · {doc.return.refundMethod === 'none' ? 'no refund' : `${money(doc.total)} back by ${PAY_METHOD[doc.return.refundMethod]?.toLowerCase() ?? doc.return.refundMethod}`}</>}
          </div>
        </div>
        <div className="ui-actions">
          <button className="ui-btn" type="button" onClick={() => print('a4')}>Print A4</button>
          <button className="ui-btn" type="button" onClick={() => print('receipt')}>Print receipt</button>
          {returnable && doc.can?.return && <Link className="ui-btn ui-btn--primary" href={`/returns/new?invoice=${doc.id}`}>Return items</Link>}
          {returnable && doc.can?.void && <button className="ui-btn ui-btn--danger" type="button" onClick={() => setVoiding(true)}>Void</button>}
        </div>
      </div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

      {isInvoice && ((doc.creditNotes?.length ?? 0) > 0 || (doc.payments?.length ?? 0) > 0) && (
        <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          {(doc.payments?.length ?? 0) > 0 && (
            <div className="ui-panel">
              <div className="ui-panel-head"><span className="ui-h3">Money</span></div>
              <div>{doc.payments!.map((p, i) => (
                <div className="ui-list-row" key={i}>
                  <span>{p.kind === 'refund' ? 'Refund' : 'Paid'} · {PAY_METHOD[p.method] ?? p.method}{p.reference ? ` · ${p.reference}` : ''}{p.change && Number(p.change) > 0 ? ` · change ${money(p.change)}` : ''}</span>
                  <span className="ui-money">{p.kind === 'refund' ? `−${money(p.amount)}` : money(p.amount)}</span>
                </div>
              ))}</div>
            </div>
          )}
          {(doc.creditNotes?.length ?? 0) > 0 && (
            <div className="ui-panel">
              <div className="ui-panel-head"><span className="ui-h3">Credit notes</span></div>
              <div>{doc.creditNotes!.map((c) => (
                <div className="ui-list-row" key={c.id}>
                  <span><Link href={`/invoices/${c.id}`}>{c.number}</Link> · {c.kind === 'void' ? 'void' : `return ${c.returnNumber}`} · {dateTime(c.issuedAt)}</span>
                  <span className="ui-money">{money(c.total)}</span>
                </div>
              ))}</div>
            </div>
          )}
        </div>
      )}

      <div className="ui-segmented" role="group" aria-label="Paper">
        <button type="button" aria-pressed={paper === 'a4'} onClick={() => setPaper('a4')}>A4</button>
        <button type="button" aria-pressed={paper === 'receipt'} onClick={() => setPaper('receipt')}>Receipt</button>
      </div>
      <div style={{ overflowX: 'auto' }}><TaxDocumentView doc={doc} paper={paper} /></div>

      {voiding && <VoidDialog doc={doc} onClose={() => setVoiding(false)} onDone={() => { setVoiding(false); load(); }} />}
    </div>
  );
}

function VoidDialog({ doc, onClose, onDone }: { doc: TaxDocument; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const [refund, setRefund] = useState(doc.order?.channel === 'pos' ? 'cash' : 'original');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [key] = useState(idemKey);
  const left = doc.lines.filter((l) => Number(l.returnableQty) > 0);

  const submit = async () => {
    setBusy(true); setError('');
    try { await api(`/invoices/${doc.id}/void`, { method: 'POST', body: { reason, restock, refundMethod: refund }, headers: key }); onDone(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="ui-backdrop" role="presentation" onClick={onClose}>
      <div className="ui-dialog" role="dialog" aria-modal aria-labelledby="void-title" onClick={(e) => e.stopPropagation()}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="void-title">Void {doc.number}?</h2></div>
        <div className="ui-dialog-body">
          <p className="ui-muted" style={{ margin: 0 }}>
            The invoice stays as it is (GST law does not allow deleting it). A credit note is issued for everything not already returned:
            {' '}{left.map((l) => `${l.returnableQty} × ${l.description}`).join(', ')}. This cannot be undone.
          </p>
          <label className="ui-field"><span className="ui-label">Reason</span>
            <input className="ui-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. billed to the wrong customer" autoFocus />
          </label>
          <label className="ui-check"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> The goods are in the shop: put them back in stock</label>
          <label className="ui-field"><span className="ui-label">Money back</span>
            <select className="ui-select" value={refund} onChange={(e) => setRefund(e.target.value)}>
              {['cash', 'upi', 'card', 'other', 'original', 'none'].map((m) => <option key={m} value={m}>{PAY_METHOD[m]}</option>)}
            </select>
          </label>
          {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
        </div>
        <div className="ui-dialog-foot">
          <button className="ui-btn" type="button" onClick={onClose}>Cancel</button>
          <button className="ui-btn ui-btn--danger" type="button" disabled={busy || reason.trim().length < 3} aria-busy={busy} onClick={submit}>Void and issue credit note</button>
        </div>
      </div>
    </div>
  );
}
