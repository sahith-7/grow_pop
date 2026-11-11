'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { money } from '../../../lib/format';
import { HitRow, searchHits, Suggestions, useSuggest, type SearchHit } from '../../../lib/suggest';
import { dateTime } from '../../../lib/stock-api';
import { api, errorText, type InvoiceSummary } from '../../../lib/sales-api';

// Every invoice and credit note the ERP has issued, counter and web alike. Read-only: they are never edited (GST records).

function InvoicesPage() {
  const router = useRouter();
  const params = useSearchParams();
  const type = params.get('type') === 'credit_note' ? 'credit_note' : 'invoice';
  const [q, setQ] = useState(params.get('q') ?? '');
  const sg = useSuggest<SearchHit>({ q, load: (t) => searchHits(t, ['invoice']) });
  const openHit = (h: SearchHit) => router.push(h.href);
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [items, setItems] = useState<InvoiceSummary[] | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async (cursor?: string) => {
    setError('');
    const qs = new URLSearchParams({ type, limit: '25' });
    for (const k of ['q', 'from', 'to']) if (params.get(k)) qs.set(k, params.get(k)!);
    if (cursor) qs.set('cursor', cursor);
    try {
      const { data } = await api<{ items: InvoiceSummary[]; nextCursor: string | null }>(`/invoices?${qs}`);
      setItems(data.items); setNext(data.nextCursor);
    } catch (e) { setError(errorText(e)); setItems([]); }
  };
  useEffect(() => { setCursors([]); load(); }, [params]);

  const apply = (patch: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    router.replace(`/invoices?${p}`);
  };
  const filtered = !!(params.get('q') || params.get('from') || params.get('to'));

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div><h1 className="ui-h1">Invoices</h1>
          <div className="ui-caption">Tax invoices and credit notes are never changed or deleted. To undo a sale, take a return or void it.</div></div>
      </div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

      <div className="ui-tabs" role="tablist">
        <button className="ui-tab" role="tab" type="button" aria-selected={type === 'invoice'} onClick={() => apply({ type: '' })}>Invoices</button>
        <button className="ui-tab" role="tab" type="button" aria-selected={type === 'credit_note'} onClick={() => apply({ type: 'credit_note' })}>Credit notes</button>
      </div>

      <div className="ui-panel">
        <form className="ui-toolbar" role="search" onSubmit={(e) => { e.preventDefault(); apply({ q: q.trim(), from, to }); }}>
          <div className="gp-suggest">
            <input className="ui-input ui-search" placeholder="Number, customer name or phone" aria-label="Search invoices" value={q} onChange={(e) => setQ(e.target.value)}
              {...sg.inputProps} onKeyDown={(e) => sg.onKeyDown(e, openHit)} />
            <Suggestions s={sg} onPick={openHit} render={(h) => <HitRow hit={h} />} label="Matching invoices" />
          </div>
          <label className="ui-caption">From <input className="ui-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="ui-caption">To <input className="ui-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <button className="ui-btn" type="submit">Search</button>
        </form>
        {items === null ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 160 }} /></div>
          : items.length === 0 ? (
            <div className="ui-empty">
              <p className="ui-h3">{filtered ? 'Nothing matches' : type === 'invoice' ? 'No invoices yet' : 'No credit notes yet'}</p>
              {!filtered && type === 'invoice' && <p className="ui-muted">Each counter sale makes one, and so does each web order once it is completed.</p>}
            </div>
          ) : (
            <div className="ui-table-wrap"><table className="ui-table" data-collapse>
              <thead><tr><th scope="col">Number</th><th scope="col">Customer</th><th scope="col">From</th><th scope="col">Status</th><th scope="col" className="ui-money">Total</th></tr></thead>
              <tbody>{items.map((d) => (
                <tr key={d.id}>
                  <td data-primary><Link className="ui-cell-title" href={`/invoices/${d.id}`}>{d.number}</Link><div className="ui-cell-sub">{dateTime(d.issuedAt)}</div></td>
                  <td data-label="Customer">{d.customer ?? <span className="ui-muted">Walk-in</span>}</td>
                  <td data-label="From">{d.channel === 'pos' ? 'Counter' : `Web #${d.orderNumber}`}
                    {d.invoice && <div className="ui-cell-sub">against <Link href={`/invoices/${d.invoice.id}`}>{d.invoice.number}</Link></div>}</td>
                  <td data-label="Status">{type === 'credit_note'
                    ? <span className="ui-badge">{d.voided ? 'Void' : 'Return'}</span>
                    : d.voided ? <span className="ui-badge ui-badge--danger">Voided</span>
                      : Number(d.credited) > 0 ? <span className="ui-badge ui-badge--warning">Part returned</span>
                        : <span className="ui-badge ui-badge--success">Issued</span>}</td>
                  <td className="ui-money" data-label="Total">{money(d.total)}
                    {type === 'invoice' && Number(d.credited) > 0 && !d.voided && <div className="ui-cell-sub">−{money(d.credited)} credited</div>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        <div className="ui-pager">
          <span>{items?.length ? `${items.length} shown` : ''}</span>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!cursors.length}
              onClick={() => { const prev = cursors.slice(0, -1); setCursors(prev); load(prev.at(-1)); }}>Previous</button>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!next}
              onClick={() => { setCursors([...cursors, next!]); load(next!); }}>Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="ui-content"><div className="ui-skeleton" style={{ height: 240 }} /></div>}><InvoicesPage /></Suspense>;
}
