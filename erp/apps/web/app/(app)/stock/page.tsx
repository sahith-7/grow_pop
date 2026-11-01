'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { money } from '../../../lib/format';
import { api, type Balance, errorText, type StockMeta } from '../../../lib/stock-api';
import { ItemCell } from './_components/item-picker';

function StockPage() {
  const router = useRouter();
  const params = useSearchParams();
  const locationId = params.get('locationId') ?? '';
  const lowStock = params.get('lowStock') === 'true';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [meta, setMeta] = useState<StockMeta | null>(null);
  const [items, setItems] = useState<Balance[] | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { api<StockMeta>('/stock/meta').then((r) => setMeta(r.data)).catch((e) => setError(errorText(e))); }, []);

  const load = async (cursor?: string) => {
    setError('');
    const qs = new URLSearchParams({ limit: '50' });
    if (params.get('q')) qs.set('q', params.get('q')!);
    if (locationId) qs.set('locationId', locationId);
    if (lowStock) qs.set('lowStock', 'true');
    if (cursor) qs.set('cursor', cursor);
    try {
      const { data } = await api<{ items: Balance[]; nextCursor: string | null }>(`/stock/balances?${qs}`);
      setItems(data.items);
      setNext(data.nextCursor);
    } catch (e) { setError(errorText(e)); setItems([]); }
  };
  useEffect(() => { setCursors([]); load(); }, [params]);

  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    router.replace(`/stock?${p}`);
  };
  const can = meta?.can;

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <h1 className="ui-h1">Stock</h1>
        <div className="ui-actions">
          <Link className="ui-btn" href="/stock/movements">History</Link>
          {can?.manageLocations && <Link className="ui-btn" href="/stock/locations">Locations</Link>}
          {can?.adjust && <Link className="ui-btn" href="/stock/opening">Opening stock</Link>}
          {can?.transfer && <Link className="ui-btn" href="/stock/transfer">Transfer</Link>}
          {(can?.adjust || can?.writeoff) && <Link className="ui-btn ui-btn--primary" href="/stock/adjust">Adjust stock</Link>}
        </div>
      </div>

      <div className="ui-panel">
        <form className="ui-toolbar" role="search" onSubmit={(e) => { e.preventDefault(); setParam('q', q.trim()); }}>
          <input className="ui-input ui-search" placeholder="Search name, SKU or scan barcode" aria-label="Search stock" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <select className="ui-select" aria-label="Location" value={locationId} onChange={(e) => setParam('locationId', e.target.value)}>
            <option value="">All locations</option>
            {meta?.locations.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <button className="ui-chip" type="button" aria-pressed={lowStock} onClick={() => setParam('lowStock', lowStock ? '' : 'true')}>Low stock</button>
        </form>

        {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

        {items === null ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 160 }} /></div>
          : items.length === 0 ? (
            <div className="ui-empty">
              <p className="ui-h3">{lowStock ? 'Nothing is below its reorder level' : params.get('q') ? 'No items match' : 'No products yet'}</p>
              {!lowStock && !params.get('q') && <p className="ui-muted">Add products first, then set opening stock.</p>}
            </div>
          ) : (
            <div className="ui-table-wrap">
              <table className="ui-table" data-collapse>
                <thead><tr>
                  <th scope="col">Item</th><th scope="col">Where</th>
                  <th scope="col" className="ui-num">On hand</th><th scope="col" className="ui-num">Available</th>
                  <th scope="col" className="ui-num">Damaged</th><th scope="col" className="ui-num">Reorder at</th>
                  {can?.seeCost && <th scope="col" className="ui-money">Value</th>}
                  <th scope="col"><span className="ui-sr-only">Actions</span></th>
                </tr></thead>
                <tbody>
                  {items.map((b) => (
                    <tr key={b.variantId}>
                      <td data-primary><ItemCell item={b} /></td>
                      <td data-label="Where" className="ui-cell-sub">{b.locations.map((l) => `${l.name} ${l.onHand}`).join(' · ') || '—'}</td>
                      <td className="ui-num" data-label="On hand">{b.onHand}</td>
                      <td className="ui-num" data-label="Available">
                        {b.low ? <span className="ui-badge ui-badge--warning">{b.available} low</span> : b.available}
                      </td>
                      <td className="ui-num" data-label="Damaged">{b.nonSellable === '0' ? <span className="ui-muted">0</span> : b.nonSellable}</td>
                      <td className="ui-num" data-label="Reorder at">{b.reorderLevel ?? <span className="ui-muted">—</span>}</td>
                      {can?.seeCost && <td className="ui-money" data-label="Value">{money(b.value)}</td>}
                      <td><Link className="ui-btn ui-btn--sm ui-btn--ghost" href={`/stock/movements?variantId=${b.variantId}`}>History</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        <div className="ui-pager">
          <span>{items?.length ? `${items.length} shown` : ''}</span>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!cursors.length} onClick={() => { const prev = cursors.slice(0, -1); setCursors(prev); load(prev.at(-1)); }}>Previous</button>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!next} onClick={() => { setCursors([...cursors, next!]); load(next!); }}>Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense><StockPage /></Suspense>;
}
