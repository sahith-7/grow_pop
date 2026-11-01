'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Ref } from '../../../lib/catalog-api';
import { ApiError, api, dateTime, errorText, fieldError, type Stocktake, STOCKTAKE_STATUS, type StockMeta } from '../../../lib/stock-api';

type Row = Pick<Stocktake, 'id' | 'number' | 'status' | 'locationName' | 'snapshotAt' | 'blind' | 'progress'>;

export default function StocktakesPage() {
  const router = useRouter();
  const [meta, setMeta] = useState<StockMeta | null>(null);
  const [categories, setCategories] = useState<Ref[]>([]);
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<Row[] | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  // start form
  const [locationId, setLocationId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [blind, setBlind] = useState(true);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<StockMeta>('/stock/meta').then(({ data }) => { setMeta(data); setLocationId(data.locations.find((l) => l.active)?.id ?? ''); }).catch((e) => setError(errorText(e)));
    api<{ items: Ref[] }>('/categories').then((r) => setCategories(r.data.items.filter((c) => !c.archivedAt))).catch(() => {});
  }, []);

  const load = async (cursor?: string) => {
    const qs = new URLSearchParams({ limit: '25' });
    if (status) qs.set('status', status);
    if (cursor) qs.set('cursor', cursor);
    try {
      const { data } = await api<{ items: Row[]; nextCursor: string | null }>(`/stocktakes?${qs}`);
      setItems(data.items); setNext(data.nextCursor);
    } catch (e) { setError(errorText(e)); setItems([]); }
  };
  useEffect(() => { setCursors([]); load(); }, [status]);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setErrors({});
    try {
      const { data } = await api<Stocktake>('/stocktakes', { method: 'POST', body: { locationId, blind, categoryIds: categoryId ? [categoryId] : [] } });
      router.push(`/stocktakes/${data.id}`);
    } catch (err) {
      setError(errorText(err));
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setBusy(false);
    }
  };
  const catName = (c: Ref) => { const p = categories.find((x) => x.id === c.parentId); return p ? `${p.name} › ${c.name}` : c.name; };

  return (
    <div className="ui-content">
      <div className="ui-page-header"><h1 className="ui-h1">Stocktakes</h1></div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

      <form className="ui-panel" onSubmit={start}>
        <div className="ui-panel-head"><span className="ui-h3">Start a count</span></div>
        <div className="ui-panel-body ui-form-grid">
          <label className="ui-field"><span className="ui-label">Location</span>
            <select className="ui-select" value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-invalid={!!fieldError(errors, 'locationId')}>
              {meta?.locations.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            {fieldError(errors, 'locationId') && <span className="ui-error">{fieldError(errors, 'locationId')}</span>}
          </label>
          <label className="ui-field"><span className="ui-label">What to count</span>
            <select className="ui-select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-invalid={!!fieldError(errors, 'categoryIds')}>
              <option value="">Everything at this location</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{catName(c)}</option>)}
            </select>
            {fieldError(errors, 'categoryIds') && <span className="ui-error">{fieldError(errors, 'categoryIds')}</span>}
          </label>
          <label className="ui-check ui-span-all">
            <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
            Blind count: counters don’t see the expected quantity, so they count what is really there
          </label>
        </div>
        <div className="ui-form-footer"><button className="ui-btn ui-btn--primary" type="submit" disabled={busy || !locationId} aria-busy={busy}>Start counting</button></div>
      </form>

      <div className="ui-panel">
        <div className="ui-toolbar">
          <select className="ui-select" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All stocktakes</option>
            {Object.entries(STOCKTAKE_STATUS).map(([k, [, label]]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
        {items === null ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 120 }} /></div>
          : items.length === 0 ? <div className="ui-empty"><p className="ui-h3">No stocktakes yet</p></div>
          : (
            <div className="ui-table-wrap"><table className="ui-table" data-collapse>
              <thead><tr><th scope="col">Number</th><th scope="col">Location</th><th scope="col">Started</th><th scope="col">Counted</th><th scope="col">Status</th></tr></thead>
              <tbody>{items.map((s) => {
                const [tone, label] = STOCKTAKE_STATUS[s.status];
                return (
                  <tr key={s.id}>
                    <td data-primary><Link className="ui-code" href={`/stocktakes/${s.id}`}>{s.number}</Link>{s.blind && <span className="ui-muted"> · blind</span>}</td>
                    <td data-label="Location">{s.locationName}</td>
                    <td data-label="Started" className="ui-cell-sub">{dateTime(s.snapshotAt)}</td>
                    <td data-label="Counted" className="ui-num">{s.progress.counted} of {s.progress.total}</td>
                    <td data-label="Status"><span className={`ui-badge${tone ? ` ui-badge--${tone}` : ''}`}>{label}</span></td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
        <div className="ui-pager">
          <span />
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!cursors.length} onClick={() => { const prev = cursors.slice(0, -1); setCursors(prev); load(prev.at(-1)); }}>Newer</button>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!next} onClick={() => { setCursors([...cursors, next!]); load(next!); }}>Older</button>
          </div>
        </div>
      </div>
    </div>
  );
}
