'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { money } from '../../../../lib/format';
import { api, dateTime, errorText, idemKey, MOVEMENT_LABEL, type Movement, signed, type StockMeta } from '../../../../lib/stock-api';
import { ItemCell } from '../_components/item-picker';
import { useOutletInView, useRoomsInView } from '../../../../lib/outlet-scope';
import { istDayStart } from '@/lib/datetime';

const REVERSIBLE = new Set(['adjustment', 'transfer']);
// A local calendar day as the API's ISO range: from = start of the day, to = start of the next day.
const dayStart = (d: string, plusDays = 0) => istDayStart(d, plusDays);   // store days are Indian days (D93)

function MovementsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const posted = params.get('posted');
  const [meta, setMeta] = useState<StockMeta | null>(null);
  const rooms = useRoomsInView(meta?.locations);   // v2 (D115)
  const inView = useOutletInView();
  const [items, setItems] = useState<Movement[] | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [reversing, setReversing] = useState<Movement | null>(null);

  useEffect(() => { api<StockMeta>('/stock/meta').then((r) => setMeta(r.data)).catch((e) => setError(errorText(e))); }, []);

  const load = async (cursor?: string) => {
    setError('');
    const qs = new URLSearchParams({ limit: '50' });
    for (const k of ['variantId', 'sourceId', 'locationId', 'movementType']) if (params.get(k)) qs.set(k, params.get(k)!);
    if (params.get('from')) qs.set('from', dayStart(params.get('from')!));
    if (params.get('to')) qs.set('to', dayStart(params.get('to')!, 1));
    if (cursor) qs.set('cursor', cursor);
    try {
      const { data } = await api<{ items: Movement[]; nextCursor: string | null }>(`/stock/movements?${qs}`);
      setItems(data.items);
      setNext(data.nextCursor);
    } catch (e) { setError(errorText(e)); setItems([]); }
  };
  useEffect(() => { setCursors([]); load(); }, [params]);

  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    p.delete('posted');
    router.replace(`/stock/movements?${p}`);
  };
  const narrowed = params.get('variantId') || params.get('sourceId');
  const seeCost = meta?.can.seeCost;

  return (
    <div className="ui-content">
      <div className="ui-page-header"><div><Link className="ui-caption" href="/stock">Stock /</Link><h1 className="ui-h1">Stock history</h1></div></div>

      {posted && <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body">{posted} posted. These are the movements it made.</div></div>}

      <div className="ui-panel">
        <div className="ui-toolbar">
          <select className="ui-select" aria-label="Location" value={params.get('locationId') ?? ''} onChange={(e) => setParam('locationId', e.target.value)}>
            <option value="">{inView ? `All at ${inView.name}` : 'All locations'}</option>
            {rooms.map((l) => <option key={l.id} value={l.id}>{l.name}{l.active ? '' : ' (inactive)'}</option>)}
          </select>
          <select className="ui-select" aria-label="Type" value={params.get('movementType') ?? ''} onChange={(e) => setParam('movementType', e.target.value)}>
            <option value="">All types</option>
            {Object.entries(MOVEMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <label className="ui-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 'var(--space-2)' }}><span className="ui-label">From</span>
            <input className="ui-input" type="date" value={params.get('from') ?? ''} onChange={(e) => setParam('from', e.target.value)} /></label>
          <label className="ui-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 'var(--space-2)' }}><span className="ui-label">To</span>
            <input className="ui-input" type="date" value={params.get('to') ?? ''} onChange={(e) => setParam('to', e.target.value)} /></label>
          {narrowed && <button className="ui-chip" type="button" aria-pressed onClick={() => router.replace('/stock/movements')}>Showing one {params.get('variantId') ? 'item' : 'document'} · clear</button>}
        </div>

        {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

        {items === null ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 160 }} /></div>
          : items.length === 0 ? <div className="ui-empty"><p className="ui-h3">No stock movements match</p></div>
          : (
            <div className="ui-table-wrap">
              <table className="ui-table" data-collapse>
                <thead><tr>
                  <th scope="col">When</th><th scope="col">Item</th><th scope="col">Where</th><th scope="col">What</th>
                  <th scope="col" className="ui-num">Change</th><th scope="col" className="ui-num">Before → after</th>
                  {seeCost && <th scope="col" className="ui-money">Unit cost</th>}
                  <th scope="col">By</th><th scope="col"><span className="ui-sr-only">Actions</span></th>
                </tr></thead>
                <tbody>
                  {items.map((m) => (
                    <tr key={m.id}>
                      <td data-label="When" className="ui-cell-sub">{dateTime(m.postedAt)}</td>
                      <td data-primary><ItemCell item={m} /></td>
                      <td data-label="Where">{m.locationName}{m.bucket === 'non_sellable' && <span className="ui-badge ui-badge--warning" style={{ marginLeft: 6 }}>damaged</span>}</td>
                      <td data-label="What">
                        <div>{MOVEMENT_LABEL[m.movementType] ?? m.movementType}{m.reasonCode && m.reasonCode !== m.movementType && <span className="ui-muted"> · {m.reasonCode}</span>}</div>
                        <div className="ui-cell-sub">
                          <Link href={`/stock/movements?sourceId=${m.source.id}`} className="ui-code">{m.source.number}</Link>
                          {m.reversedById && <span className="ui-badge" style={{ marginLeft: 6 }}>reversed</span>}
                          {m.note && <span className="ui-muted"> · {m.note}</span>}
                        </div>
                      </td>
                      <td className="ui-num" data-label="Change" style={{ color: m.qtyDelta.startsWith('-') ? 'var(--danger)' : 'var(--success)' }}>{signed(m.qtyDelta)}</td>
                      <td className="ui-num ui-muted" data-label="Before → after">{m.balanceBefore} → {m.balanceAfter}</td>
                      {seeCost && <td className="ui-money" data-label="Unit cost">{m.unitCost ? money(m.unitCost) : '—'}</td>}
                      <td data-label="By" className="ui-cell-sub">{m.actor.name}</td>
                      <td>
                        {meta?.can.adjust && REVERSIBLE.has(m.source.type) && m.movementType !== 'reversal' && !m.reversedById && !m.reversalOfId &&
                          <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => setReversing(m)}>Reverse {m.source.number}</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        <div className="ui-pager">
          <span>{items?.length ? `${items.length} shown, newest first` : ''}</span>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!cursors.length} onClick={() => { const prev = cursors.slice(0, -1); setCursors(prev); load(prev.at(-1)); }}>Newer</button>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!next} onClick={() => { setCursors([...cursors, next!]); load(next!); }}>Older</button>
          </div>
        </div>
      </div>

      {reversing && <ReverseDialog movement={reversing} onClose={() => setReversing(null)}
        onDone={(number) => { setReversing(null); router.replace(`/stock/movements?sourceId=${reversing.source.id}&posted=${encodeURIComponent(`Reversal of ${number}`)}`); }} />}
    </div>
  );
}

/** Reversal posts opposite movements for the whole document. History keeps both; nothing is edited or deleted. */
function ReverseDialog({ movement, onClose, onDone }: { movement: Movement; onClose: () => void; onDone: (number: string) => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key] = useState(idemKey);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const { data } = await api<{ number: string }>(`/stock/movements/${movement.id}/reverse`, { method: 'POST', body: { note: note.trim() }, headers: key });
      onDone(data.number);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  return (
    <div className="ui-backdrop" role="presentation" onClick={onClose}>
      <form className="ui-dialog" role="dialog" aria-modal aria-labelledby="rev-title" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="rev-title">Reverse {movement.source.number}?</h2></div>
        <div className="ui-dialog-body">
          <p>Every line of {movement.source.number} gets an opposite movement. The original stays in history.</p>
          <label className="ui-field"><span className="ui-label">Why</span>
            <input className="ui-input" value={note} onChange={(e) => setNote(e.target.value)} minLength={3} maxLength={500} required autoFocus placeholder="e.g. Entered at the wrong location" />
          </label>
          {error && <div className="ui-error" role="alert">{error}</div>}
        </div>
        <div className="ui-dialog-foot">
          <button className="ui-btn" type="button" onClick={onClose}>Keep it</button>
          <button className="ui-btn ui-btn--danger" type="submit" disabled={note.trim().length < 3} aria-busy={busy}>Reverse</button>
        </div>
      </form>
    </div>
  );
}

export default function Page() {
  return <Suspense><MovementsPage /></Suspense>;
}
