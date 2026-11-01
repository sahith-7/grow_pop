'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { money } from '../../../../lib/format';
import { api, dateTime, errorText, idemKey, signed, type Stocktake, type StocktakeLine, STOCKTAKE_STATUS, type StockMeta } from '../../../../lib/stock-api';
import { ItemCell } from '../../stock/_components/item-picker';

const SHOW_MAX = 300;   // rows drawn at once; search narrows the rest

export default function StocktakePage() {
  const { id } = useParams<{ id: string }>();
  const [st, setSt] = useState<Stocktake | null>(null);
  const [meta, setMeta] = useState<StockMeta | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'all' | 'uncounted' | 'variance'>('all');
  const [q, setQ] = useState('');
  const [confirmPost, setConfirmPost] = useState(false);

  const load = () => api<Stocktake>(`/stocktakes/${id}`).then((r) => setSt(r.data)).catch((e) => setError(errorText(e)));
  useEffect(() => { load(); api<StockMeta>('/stock/meta').then((r) => setMeta(r.data)).catch(() => {}); }, [id]);

  /** Apply saved counts from the API to the lines on screen. */
  const applySaved = (saved: { progress: Stocktake['progress']; lines: { variantId: string; countedQty: string }[] }) => setSt((cur) => cur && {
    ...cur, progress: saved.progress,
    lines: cur.lines.map((l) => { const s = saved.lines.find((x) => x.variantId === l.variantId); return s ? { ...l, countedQty: s.countedQty, countedAt: new Date().toISOString() } : l; }),
  });

  const action = async (name: 'submit' | 'reopen' | 'cancel' | 'post') => {
    setBusy(true); setError('');
    try { setSt((await api<Stocktake>(`/stocktakes/${id}/${name}`, { method: 'POST', headers: name === 'post' ? idemKey() : undefined })).data); setConfirmPost(false); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  const shown = useMemo(() => {
    if (!st) return [];
    const term = q.trim().toLowerCase();
    return st.lines.filter((l) =>
      (filter === 'all' || (filter === 'uncounted' ? l.countedQty === null : l.variance != null && l.variance !== '0'))
      && (!term || l.name.toLowerCase().includes(term) || l.sku.toLowerCase().includes(term) || l.barcode === q.trim()));
  }, [st, filter, q]);

  if (!st) return <div className="ui-content">{error ? <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div> : <div className="ui-skeleton" style={{ height: 240 }} />}</div>;

  const [tone, label] = STOCKTAKE_STATUS[st.status];
  const counting = st.status === 'counting';
  const approve = !!meta?.can.approve;
  const review = st.canSeeExpected;
  const varianceLines = st.lines.filter((l) => l.variance != null && l.variance !== '0');
  const pct = st.progress.total ? Math.round((st.progress.counted / st.progress.total) * 100) : 0;

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div>
          <Link className="ui-caption" href="/stocktakes">Stocktakes /</Link>
          <h1 className="ui-h1">{st.number} · {st.locationName} <span className={`ui-badge${tone ? ` ui-badge--${tone}` : ''}`}>{label}</span></h1>
          <div className="ui-caption">Started {dateTime(st.snapshotAt)}{st.blind ? ' · blind count' : ''}</div>
        </div>
        <div className="ui-actions">
          {counting && <button className="ui-btn ui-btn--primary" type="button" disabled={busy || !st.progress.counted} onClick={() => action('submit')}>Send for approval</button>}
          {st.status === 'review' && approve && <>
            <button className="ui-btn" type="button" disabled={busy} onClick={() => action('reopen')}>Back to counting</button>
            <button className="ui-btn ui-btn--primary" type="button" disabled={busy} onClick={() => setConfirmPost(true)}>Approve and post</button>
          </>}
          {(counting || st.status === 'review') && approve && <button className="ui-btn ui-btn--ghost" type="button" disabled={busy} onClick={() => action('cancel')}>Cancel stocktake</button>}
        </div>
      </div>

      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      {st.status === 'review' && !approve && <div className="ui-alert ui-alert--info" role="status"><div className="ui-alert-body">Sent for approval. A manager or the owner reviews and posts it.</div></div>}
      {st.status === 'posted' && (
        <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body">
          Posted. Stock now matches the count for counted items; uncounted items were left as they were. <Link href={`/stock/movements?sourceId=${st.id}`}>See the movements</Link>
        </div></div>
      )}

      <div className="ui-panel">
        <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{st.progress.counted} of {st.progress.total} items counted</span><span className="ui-muted">{pct}%</span></div>
          <div className="ui-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Counted"><span style={{ width: `${pct}%` }} /></div>
          {counting && <Scanner st={st} onSaved={applySaved} />}
        </div>
      </div>

      <div className="ui-panel">
        <div className="ui-toolbar">
          <input className="ui-input ui-search" placeholder="Find an item" aria-label="Find an item" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="ui-segmented" role="group" aria-label="Show">
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button>
            <button type="button" aria-pressed={filter === 'uncounted'} onClick={() => setFilter('uncounted')}>Not counted</button>
            {review && <button type="button" aria-pressed={filter === 'variance'} onClick={() => setFilter('variance')}>Differences ({varianceLines.length})</button>}
          </div>
        </div>
        <div className="ui-table-wrap"><table className="ui-table ui-table--touch" data-collapse>
          <thead><tr>
            <th scope="col">Item</th>
            {review && <th scope="col" className="ui-num">Expected</th>}
            {review && <th scope="col" className="ui-num" title="Sold, received or moved here after the count started and before this item was counted">Moved meanwhile</th>}
            <th scope="col" className="ui-num">Counted</th>
            {review && <th scope="col" className="ui-num">Difference</th>}
            {review && meta?.can.seeCost && <th scope="col" className="ui-money">Value</th>}
          </tr></thead>
          <tbody>{shown.slice(0, SHOW_MAX).map((l) => (
            <tr key={l.variantId}>
              <td data-primary><ItemCell item={l} /></td>
              {review && <td className="ui-num" data-label="Expected">{l.expectedQty}</td>}
              {review && <td className="ui-num ui-muted" data-label="Moved meanwhile">{l.movedDuringCount === '0' ? '0' : signed(l.movedDuringCount ?? '0')}</td>}
              <td className="ui-num" data-label="Counted">{counting ? <CountInput st={st} line={l} onSaved={applySaved} /> : (l.countedQty ?? <span className="ui-muted">not counted</span>)}</td>
              {review && <td className="ui-num" data-label="Difference" style={{ color: l.variance && l.variance !== '0' ? (l.variance.startsWith('-') ? 'var(--danger)' : 'var(--success)') : undefined }}>
                {l.variance == null ? <span className="ui-muted">—</span> : l.variance === '0' ? '0' : signed(l.variance)}</td>}
              {review && meta?.can.seeCost && <td className="ui-money" data-label="Value">{l.varianceValue ? money(l.varianceValue) : '—'}</td>}
            </tr>
          ))}</tbody>
        </table></div>
        {shown.length > SHOW_MAX && <div className="ui-panel-body ui-caption">Showing {SHOW_MAX} of {shown.length}. Search to find the rest.</div>}
        {shown.length === 0 && <div className="ui-empty"><p className="ui-muted">Nothing to show</p></div>}
      </div>

      {confirmPost && (
        <div className="ui-backdrop" role="presentation" onClick={() => setConfirmPost(false)}>
          <div className="ui-dialog" role="dialog" aria-modal aria-labelledby="post-title" onClick={(e) => e.stopPropagation()}>
            <div className="ui-dialog-head"><h2 className="ui-h3" id="post-title">Post {st.number}?</h2></div>
            <div className="ui-dialog-body">
              <p>{varianceLines.length ? `${varianceLines.length} item${varianceLines.length === 1 ? '' : 's'} will change to match the count.` : 'Every counted item matches. Nothing changes.'}</p>
              {st.progress.counted < st.progress.total && <p className="ui-muted">{st.progress.total - st.progress.counted} items were not counted and stay as they are.</p>}
              <p className="ui-muted">This cannot be undone. A later count or an adjustment can correct mistakes.</p>
            </div>
            <div className="ui-dialog-foot">
              <button className="ui-btn" type="button" onClick={() => setConfirmPost(false)}>Not yet</button>
              <button className="ui-btn ui-btn--primary" type="button" aria-busy={busy} disabled={busy} onClick={() => action('post')}>Post</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type OnSaved = (saved: { progress: Stocktake['progress']; lines: { variantId: string; countedQty: string }[] }) => void;

/** Each scan adds 1 to that item's count on the server, so two people can scan the same aisle. */
function Scanner({ st, onSaved }: { st: Stocktake; onSaved: OnSaved }) {
  const [code, setCode] = useState('');
  const [state, setState] = useState<'' | 'ok' | 'error'>('');
  const [message, setMessage] = useState('');
  const byCode = useMemo(() => {
    const m = new Map<string, StocktakeLine>();
    for (const l of st.lines) { m.set(l.sku.toLowerCase(), l); if (l.barcode) m.set(l.barcode, l); }
    return m;
  }, [st.lines]);

  const scan = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    setCode('');
    if (!c) return;
    const line = byCode.get(c) ?? byCode.get(c.toLowerCase());
    if (!line) { setState('error'); setMessage(`${c} is not part of this count. Put it aside and add it with an adjustment later.`); return; }
    try {
      const { data } = await api(`/stocktakes/${st.id}/counts`, { method: 'PUT', body: { counts: [{ variantId: line.variantId, addQty: '1' }] } });
      onSaved(data);
      setState('ok'); setMessage(`${line.sku} · ${line.name}: ${data.lines[0]?.countedQty}`);
    } catch (err) { setState('error'); setMessage(`Not saved: ${errorText(err)} Scan it again.`); }
  };

  return (
    <form onSubmit={scan} role="search">
      <label className="ui-scan" data-state={state || undefined}>
        <span className="ui-scan-dot" aria-hidden />
        <input value={code} onChange={(e) => { setCode(e.target.value); setState(''); }} placeholder="Scan an item to add 1" aria-label="Scan item" autoFocus autoComplete="off" />
      </label>
      <div className="ui-help" aria-live="polite" style={{ minHeight: 18, color: state === 'error' ? 'var(--danger)' : undefined }}>{message}</div>
    </form>
  );
}

/** A typed count replaces the number. It saves when the field loses focus or on Enter. */
function CountInput({ st, line, onSaved }: { st: Stocktake; line: StocktakeLine; onSaved: OnSaved }) {
  const [value, setValue] = useState(line.countedQty ?? '');
  const [state, setState] = useState<'' | 'saving' | 'error'>('');
  const [title, setTitle] = useState('');
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setValue(line.countedQty ?? ''); }, [line.countedQty]);

  const save = async () => {
    editing.current = false;
    const v = value.trim();
    if (v === (line.countedQty ?? '') || v === '') { setValue(line.countedQty ?? ''); return; }
    setState('saving');
    try {
      const { data } = await api(`/stocktakes/${st.id}/counts`, { method: 'PUT', body: { counts: [{ variantId: line.variantId, countedQty: v }] } });
      onSaved(data); setState(''); setTitle('');
    } catch (err) { setState('error'); setTitle(errorText(err)); }
  };
  return (<>
    <input className="ui-input ui-input--num" style={{ width: 100 }} inputMode="decimal" value={value} aria-label={`Count for ${line.sku}`}
      aria-invalid={state === 'error'} aria-busy={state === 'saving'} placeholder="—"
      onFocus={() => { editing.current = true; }} onChange={(e) => setValue(e.target.value)} onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
    {state === 'error' && <div className="ui-error">{title}</div>}
  </>);
}
