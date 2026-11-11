'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { money } from '../../../lib/format';
import { HitRow, searchHits, Suggestions, useSuggest, type SearchHit } from '../../../lib/suggest';
import { dateTime } from '../../../lib/stock-api';
import { api, errorText, ORDER_STATUS, type OrderSummary } from '../../../lib/woo-api';

// Web orders from WooCommerce. Counter sales are under Invoices (B5); picking and dispatch are under Fulfilment (B6).

const TABS = [
  { status: '', label: 'All' },
  { status: 'attention', label: 'Needs attention' },
  { status: 'ready_to_pick', label: 'Ready to pick' },
  { status: 'dispatched', label: 'Dispatched' },
  { status: 'on_hold', label: 'On hold' },
  { status: 'awaiting_payment', label: 'Awaiting payment' },
  { status: 'completed', label: 'Completed' },
  { status: 'cancelled', label: 'Cancelled' },
] as const;

function OrdersPage() {
  const router = useRouter();
  const params = useSearchParams();
  const status = params.get('status') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const sg = useSuggest<SearchHit>({ q, load: (t) => searchHits(t, ['order']) });
  const openHit = (h: SearchHit) => router.push(h.href);
  const [items, setItems] = useState<OrderSummary[] | null>(null);
  const [counts, setCounts] = useState<{ attention: number; ready: number } | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async (cursor?: string) => {
    setError('');
    const qs = new URLSearchParams({ limit: '25', channel: 'woocommerce' });
    if (status) qs.set('status', status);
    if (params.get('q')) qs.set('q', params.get('q')!);
    if (cursor) qs.set('cursor', cursor);
    try {
      const { data } = await api<{ items: OrderSummary[]; counts: { attention: number; ready: number }; nextCursor: string | null }>(`/orders?${qs}`);
      setItems(data.items); setCounts(data.counts); setNext(data.nextCursor);
    } catch (e) { setError(errorText(e)); setItems([]); }
  };
  useEffect(() => { setCursors([]); load(); }, [params]);

  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    router.replace(`/orders?${p}`);
  };

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div><h1 className="ui-h1">Online orders</h1>
          {counts && <div className="ui-caption">{counts.ready} ready to pick{counts.attention ? ` · ${counts.attention} need attention` : ''}</div>}
        </div>
      </div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

      <div className="ui-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.status} className="ui-tab" role="tab" type="button" aria-selected={status === t.status} onClick={() => setParam('status', t.status)}>
            {t.label}{t.status === 'attention' && counts?.attention ? ` (${counts.attention})` : ''}
          </button>
        ))}
      </div>

      <div className="ui-panel">
        <form className="ui-toolbar" role="search" onSubmit={(e) => { e.preventDefault(); setParam('q', q.trim()); }}>
          <div className="gp-suggest">
            <input className="ui-input ui-search" placeholder="Order number, customer name or phone" aria-label="Search orders" value={q} onChange={(e) => setQ(e.target.value)}
              {...sg.inputProps} onKeyDown={(e) => sg.onKeyDown(e, openHit)} />
            <Suggestions s={sg} onPick={openHit} render={(h) => <HitRow hit={h} />} label="Matching orders" />
          </div>
        </form>
        {items === null ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 160 }} /></div>
          : items.length === 0 ? (
            <div className="ui-empty">
              <p className="ui-h3">{status || params.get('q') ? 'No orders here' : 'No online orders yet'}</p>
              {!status && !params.get('q') && <p className="ui-muted">Orders placed in your WooCommerce shop appear here within seconds once the shop is connected.</p>}
            </div>
          ) : (
            <div className="ui-table-wrap"><table className="ui-table" data-collapse>
              <thead><tr><th scope="col">Order</th><th scope="col">Customer</th><th scope="col">Status</th><th scope="col" className="ui-num">Items</th><th scope="col" className="ui-money">Total</th></tr></thead>
              <tbody>{items.map((o) => {
                const [tone, label] = ORDER_STATUS[o.status] ?? ['', o.status];
                return (
                  <tr key={o.id}>
                    <td data-primary><Link className="ui-cell-title" href={`/orders/${o.id}`}>#{o.number}</Link><div className="ui-cell-sub">{dateTime(o.placedAt)}</div></td>
                    <td data-label="Customer">{o.customerName ?? <span className="ui-muted">Guest</span>}</td>
                    <td data-label="Status"><span className={`ui-badge${tone ? ` ui-badge--${tone}` : ''}`}>{label}</span>
                      {o.exceptionReason && <div className="ui-cell-sub">{o.exceptionReason}</div>}</td>
                    <td className="ui-num" data-label="Items">{o.itemCount}</td>
                    <td className="ui-money" data-label="Total">{money(o.total)}<div className="ui-cell-sub">{o.paymentMethod ?? ''}</div></td>
                  </tr>
                );
              })}</tbody>
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
  return <Suspense fallback={<div className="ui-content"><div className="ui-skeleton" style={{ height: 240 }} /></div>}><OrdersPage /></Suspense>;
}
