'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { money } from '../../../lib/format';
import { dateTime } from '../../../lib/stock-api';
import { api, errorText, PAY_METHOD, type ReturnSummary } from '../../../lib/sales-api';

function ReturnsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [items, setItems] = useState<ReturnSummary[] | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async (cursor?: string) => {
    setError('');
    const qs = new URLSearchParams({ limit: '25' });
    if (params.get('q')) qs.set('q', params.get('q')!);
    if (cursor) qs.set('cursor', cursor);
    try {
      const { data } = await api<{ items: ReturnSummary[]; nextCursor: string | null }>(`/returns?${qs}`);
      setItems(data.items); setNext(data.nextCursor);
    } catch (e) { setError(errorText(e)); setItems([]); }
  };
  useEffect(() => { setCursors([]); load(); }, [params]);

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div><h1 className="ui-h1">Returns</h1><div className="ui-caption">Each return issues a credit note against the original invoice.</div></div>
        <div className="ui-actions"><Link className="ui-btn ui-btn--primary" href="/returns/new">New return</Link></div>
      </div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      <div className="ui-panel">
        <form className="ui-toolbar" role="search" onSubmit={(e) => { e.preventDefault(); router.replace(q.trim() ? `/returns?q=${encodeURIComponent(q.trim())}` : '/returns'); }}>
          <input className="ui-input ui-search" placeholder="Return, invoice or credit note number" aria-label="Search returns" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        {items === null ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 160 }} /></div>
          : items.length === 0 ? <div className="ui-empty"><p className="ui-h3">{params.get('q') ? 'Nothing matches' : 'No returns yet'}</p></div>
          : (
            <div className="ui-table-wrap"><table className="ui-table" data-collapse>
              <thead><tr><th scope="col">Return</th><th scope="col">Invoice</th><th scope="col">Reason</th><th scope="col">Refund</th><th scope="col" className="ui-money">Credit</th></tr></thead>
              <tbody>{items.map((r) => (
                <tr key={r.id}>
                  <td data-primary><span className="ui-cell-title">{r.number}</span>{r.kind === 'void' && <> <span className="ui-badge ui-badge--danger">Void</span></>}
                    <div className="ui-cell-sub">{dateTime(r.postedAt)}{r.postedBy ? ` · ${r.postedBy}` : ''}</div></td>
                  <td data-label="Invoice"><Link href={`/invoices/${r.invoice.id}`}>{r.invoice.number}</Link>
                    <div className="ui-cell-sub">CN <Link href={`/invoices/${r.creditNote.id}`}>{r.creditNote.number}</Link>{r.customer ? ` · ${r.customer}` : ''}</div></td>
                  <td data-label="Reason">{r.reason}</td>
                  <td data-label="Refund">{PAY_METHOD[r.refundMethod] ?? r.refundMethod}</td>
                  <td className="ui-money" data-label="Credit">{money(r.refundAmount)}</td>
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
  return <Suspense fallback={<div className="ui-content"><div className="ui-skeleton" style={{ height: 240 }} /></div>}><ReturnsPage /></Suspense>;
}
