'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { attrLabel, money } from '../../../lib/format';
import { api, CARRIERS, errorText, STAGES, WEB_UPDATE, ApiError, type Queue, type QueueItem, type Stage } from '../../../lib/fulfil-api';
import { dateTime, idemKey } from '../../../lib/stock-api';
import type { Order } from '../../../lib/woo-api';

// Fulfilment of web orders (B6, J13): pick a batch, pack each order exactly as held, dispatch with the courier and tracking
// number. Stock leaves at dispatch; the shop is told "completed" in the background.

function FulfilmentPage() {
  const router = useRouter();
  const params = useSearchParams();
  const stage = (params.get('stage') as Stage) || 'ready_to_pick';
  const [q, setQ] = useState<Queue | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [packing, setPacking] = useState<QueueItem | null>(null);
  const [dispatching, setDispatching] = useState<QueueItem | null>(null);

  const load = async (cursor?: string) => {
    setError('');
    const qs = new URLSearchParams({ stage, limit: '50' });
    if (cursor) qs.set('cursor', cursor);
    try { setQ((await api<Queue>(`/fulfilment/queue?${qs}`)).data); } catch (e) { setError(errorText(e)); }
  };
  useEffect(() => { setCursors([]); setPicked([]); load(); }, [stage]);

  const startList = async () => {
    setBusy(true); setError('');
    try {
      const { data } = await api<{ id: string }>('/pick-lists', { method: 'POST', body: { orderIds: picked } });
      router.push(`/pick/${data.id}`);
    } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  const retryWeb = async (o: QueueItem) => {
    setBusy(true); setError('');
    try { await api(`/orders/${o.id}/web-update/retry`, { method: 'POST' }); await load(cursors.at(-1)); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 30 ? p : [...p, id]));
  const done = () => { setPacking(null); setDispatching(null); load(cursors.at(-1)); };

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div><h1 className="ui-h1">Fulfilment</h1>
          <div className="ui-caption">Oldest orders first. Stock stays held while you pick and pack, and leaves when you dispatch.</div></div>
        <div className="ui-actions">
          {stage === 'ready_to_pick' && (
            <button className="ui-btn ui-btn--primary" type="button" disabled={!picked.length || busy} aria-busy={busy} onClick={startList}>
              {picked.length ? `Pick ${picked.length} order${picked.length > 1 ? 's' : ''}` : 'Select orders to pick'}
            </button>
          )}
        </div>
      </div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

      <div className="ui-tabs" role="tablist">
        {STAGES.map((s) => (
          <button key={s.key} className="ui-tab" role="tab" type="button" aria-selected={stage === s.key} onClick={() => router.replace(`/fulfilment?stage=${s.key}`)}>
            {s.label}{q?.counts?.[s.key] ? ` (${q.counts[s.key]})` : ''}
          </button>
        ))}
      </div>

      <div className="ui-panel">
        {!q ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 160 }} /></div>
          : !q.items.length ? (
            <div className="ui-empty"><p className="ui-h3">Nothing here</p>
              <p className="ui-muted">{stage === 'ready_to_pick' ? 'Paid web orders with stock held for them appear here.' : stage === 'dispatched_pending_web' ? 'Every dispatched order has reached the shop.' : 'No orders at this stage.'}</p></div>
          ) : (
            <div className="ui-table-wrap"><table className="ui-table ui-table--touch" data-collapse>
              <thead><tr>
                {stage === 'ready_to_pick' && <th scope="col" style={{ width: 44 }}>
                  <input type="checkbox" className="ui-check" aria-label="Select all shown (up to 30)" checked={picked.length > 0 && picked.length === Math.min(30, q.items.length)}
                    onChange={(e) => setPicked(e.target.checked ? q.items.slice(0, 30).map((i) => i.id) : [])} /></th>}
                <th scope="col">Order</th><th scope="col">Customer</th><th scope="col" className="ui-num">Items</th><th scope="col" className="ui-money">Total</th><th scope="col">Next</th>
              </tr></thead>
              <tbody>{q.items.map((o) => (
                <tr key={o.id}>
                  {stage === 'ready_to_pick' && <td><input type="checkbox" className="ui-check" aria-label={`Select #${o.number}`} checked={picked.includes(o.id)} onChange={() => toggle(o.id)} /></td>}
                  <td data-primary><Link className="ui-cell-title" href={`/orders/${o.id}`}>#{o.number}</Link><div className="ui-cell-sub">{dateTime(o.queuedAt)}</div></td>
                  <td data-label="Customer">{o.customerName ?? <span className="ui-muted">Guest</span>}{o.city && <div className="ui-cell-sub">{o.city}</div>}</td>
                  <td className="ui-num" data-label="Items">{o.itemCount}</td>
                  <td className="ui-money" data-label="Total">{money(o.total)}<div className="ui-cell-sub">{o.paymentMethod ?? ''}</div></td>
                  <td data-label="Next">
                    {stage === 'picking' && o.pickList && (
                      o.pickList.allPicked
                        ? <button className="ui-btn ui-btn--sm ui-btn--primary" type="button" onClick={() => setPacking(o)}>Pack</button>
                        : <Link className="ui-btn ui-btn--sm" href={`/pick/${o.pickList.id}`}>Pick ({o.pickList.number})</Link>
                    )}
                    {stage === 'packed' && <button className="ui-btn ui-btn--sm ui-btn--primary" type="button" onClick={() => setDispatching(o)}>Dispatch</button>}
                    {stage === 'dispatched_pending_web' && o.shipment && (
                      <>
                        <span className={`ui-badge ui-badge--${WEB_UPDATE[o.shipment.webUpdate]?.[0] || 'info'}`}>{WEB_UPDATE[o.shipment.webUpdate]?.[1] ?? o.shipment.webUpdate}</span>
                        {o.shipment.webError && <div className="ui-cell-sub">{o.shipment.webError}</div>}
                        {o.shipment.webUpdate === 'failed' && <div><button className="ui-btn ui-btn--sm" type="button" disabled={busy} onClick={() => retryWeb(o)}>Send again</button></div>}
                      </>
                    )}
                    {stage === 'stock_exception' && <span className="ui-cell-sub">{o.exceptionReason}</span>}
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        <div className="ui-pager">
          <span>{stage === 'ready_to_pick' && picked.length ? `${picked.length} selected (30 at most per pick list)` : ''}</span>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!cursors.length} onClick={() => { const prev = cursors.slice(0, -1); setCursors(prev); load(prev.at(-1)); }}>Previous</button>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!q?.nextCursor} onClick={() => { setCursors([...cursors, q!.nextCursor!]); load(q!.nextCursor!); }}>Next</button>
          </div>
        </div>
      </div>

      {packing && <PackDialog item={packing} onClose={() => setPacking(null)} onDone={done} />}
      {dispatching && <DispatchDialog item={dispatching} onClose={() => setDispatching(null)} onDone={done} />}
    </div>
  );
}

/** Check each item into the box. Substitutions are off: the box holds exactly what was held for the order. */
function PackDialog({ item, onClose, onDone }: { item: QueueItem; onClose: () => void; onDone: () => void }) {
  const [o, setO] = useState<Order | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<Order>(`/orders/${item.id}`).then((r) => setO(r.data)).catch((e) => setError(errorText(e))); }, [item.id]);
  const lines = o?.lines.filter((l) => l.reservation === 'active') ?? [];
  const pack = async () => {
    setBusy(true); setError('');
    try { await api(`/orders/${item.id}/pack`, { method: 'POST', body: { lines: lines.map((l) => ({ lineId: l.id, qty: l.qty })) } }); onDone(); }
    catch (e) { setError(e instanceof ApiError && e.code === 'VALIDATION_ERROR' ? Object.values(e.fieldErrors).flat().join(' · ') || e.message : errorText(e)); setBusy(false); }
  };
  return (
    <div className="ui-backdrop" role="presentation" onClick={onClose}>
      <div className="ui-dialog" role="dialog" aria-modal aria-labelledby="pack-title" onClick={(e) => e.stopPropagation()}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="pack-title">Pack #{item.number}</h2></div>
        <div className="ui-dialog-body">
          {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
          {!o ? <div className="ui-skeleton" style={{ height: 120 }} /> : (
            <>
              <p className="ui-muted" style={{ marginTop: 0 }}>Tick each item as it goes in the box. Pack exactly these quantities; if something is missing or damaged, take the order off packing from the order page.</p>
              {lines.map((l) => (
                <label key={l.id} className="ui-list-row" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" className="ui-check" checked={ticked.includes(l.id)} onChange={() => setTicked((t) => (t.includes(l.id) ? t.filter((x) => x !== l.id) : [...t, l.id]))} />
                  <span style={{ flex: 1 }}><span className="ui-cell-title">{l.erp?.name ?? l.name}</span>{l.erp && Object.keys(l.erp.attributes ?? {}).length > 0 && <span className="ui-muted"> · {attrLabel(l.erp.attributes)}</span>}
                    <div className="ui-cell-sub ui-code">{l.erp?.sku ?? l.sku}</div></span>
                  <strong className="ui-num">× {l.qty}</strong>
                </label>
              ))}
            </>
          )}
        </div>
        <div className="ui-dialog-foot">
          <button className="ui-btn" type="button" onClick={onClose}>Cancel</button>
          <button className="ui-btn ui-btn--primary" type="button" disabled={!o || busy || ticked.length < lines.length} aria-busy={busy} onClick={pack}>Packed</button>
        </div>
      </div>
    </div>
  );
}

/** The parcel leaves: courier, service and tracking number go to the shop and the customer. */
function DispatchDialog({ item, onClose, onDone }: { item: QueueItem; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ carrier: '', service: '', trackingNo: '' });
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key] = useState(idemKey);   // one key per dialog: a retried click can never dispatch twice
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setErrors({});
    const body = { carrier: form.carrier.trim(), ...(form.service.trim() ? { service: form.service.trim() } : {}), ...(form.trackingNo.trim() ? { trackingNo: form.trackingNo.trim() } : {}) };
    try { await api(`/orders/${item.id}/dispatch`, { method: 'POST', body, headers: key }); onDone(); }
    catch (err) { setError(errorText(err)); if (err instanceof ApiError) setErrors(err.fieldErrors); setBusy(false); }
  };
  const hand = form.carrier.trim().toLowerCase() === 'hand delivery';
  return (
    <div className="ui-backdrop" role="presentation" onClick={onClose}>
      <form className="ui-dialog" role="dialog" aria-modal aria-labelledby="dispatch-title" onClick={(e) => e.stopPropagation()} onSubmit={go}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="dispatch-title">Dispatch #{item.number}</h2></div>
        <div className="ui-dialog-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
          <label className="ui-field"><span className="ui-label">Courier <span className="ui-req">*</span></span>
            <input className="ui-input" list="carriers" required autoFocus maxLength={60} value={form.carrier} onChange={set('carrier')} aria-invalid={!!errors.carrier} />
            <datalist id="carriers">{CARRIERS.map((c) => <option key={c} value={c} />)}</datalist>
            {errors.carrier && <span className="ui-error">{errors.carrier[0]}</span>}</label>
          <label className="ui-field"><span className="ui-label">Service</span>
            <input className="ui-input" maxLength={60} placeholder="Surface, Express …" value={form.service} onChange={set('service')} /></label>
          <label className="ui-field"><span className="ui-label">Tracking number</span>
            <input className="ui-input ui-code" maxLength={60} value={form.trackingNo} onChange={set('trackingNo')} aria-invalid={!!errors.trackingNo} />
            {!hand && !form.trackingNo.trim() && <span className="ui-help">Without one, the customer is told only which courier has it.</span>}
            {errors.trackingNo && <span className="ui-error">{errors.trackingNo[0]}</span>}</label>
          <p className="ui-muted" style={{ margin: 0 }}>This takes the held stock out, issues the GST invoice, and tells the shop the order is completed with this tracking number.</p>
        </div>
        <div className="ui-dialog-foot">
          <button className="ui-btn" type="button" onClick={onClose}>Cancel</button>
          <button className="ui-btn ui-btn--primary" type="submit" disabled={busy || !form.carrier.trim()} aria-busy={busy}>Dispatch</button>
        </div>
      </form>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="ui-content"><div className="ui-skeleton" style={{ height: 240 }} /></div>}><FulfilmentPage /></Suspense>;
}
