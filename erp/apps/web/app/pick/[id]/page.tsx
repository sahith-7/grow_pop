'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { attrLabel } from '../../../lib/format';
import { api, beep, errorText, ApiError, type PickLine, type PickList } from '../../../lib/fulfil-api';

// Picking (B6, J13). Walk the list in shelf order and scan each item; the screen says which order's bag it goes in.
// A wrong item or one too many flashes red with a low beep and changes nothing. Picking moves no stock.

type Flash = { state: 'ok' | 'error'; text: string } | null;

export default function PickPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [list, setList] = useState<PickList | null>(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [flash, setFlash] = useState<Flash>(null);
  const [editing, setEditing] = useState<PickLine | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => { api<PickList>(`/pick-lists/${id}`).then((r) => setList(r.data)).catch((e) => setError(errorText(e))); }, [id]);

  const show = (f: NonNullable<Flash>) => {
    setFlash(f); beep(f.state === 'ok');
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash((cur) => (cur === f ? null : cur)), f.state === 'ok' ? 2500 : 6000);
  };

  // Scanners can send the next code before the last one is answered: clear the box at once and send scans one at a time.
  const chain = useRef(Promise.resolve());
  const scan = (e: React.FormEvent) => {
    e.preventDefault();
    const text = code.trim();
    if (!text) return;
    setCode('');
    chain.current = chain.current.then(async () => {
      try {
        const { data } = await api<PickList>(`/pick-lists/${id}/scan`, { method: 'POST', body: { code: text } });
        setList(data);
        show({ state: 'ok', text: `${data.scanned!.sku} → ${data.scanned!.into.map((i) => `bag #${i.orderNumber}${i.qty !== '1' ? ` × ${i.qty}` : ''}`).join(', ')}` });
      } catch (err) {
        show({ state: 'error', text: err instanceof ApiError ? err.message : errorText(err) });
      }
      scanRef.current?.focus();
    });
  };

  const setPicked = async (line: PickLine, qtyPicked: string) => {
    try { setList((await api<PickList>(`/pick-lists/${id}/lines/${line.id}`, { method: 'PATCH', body: { qtyPicked } })).data); setEditing(null); }
    catch (e) { show({ state: 'error', text: errorText(e) }); }
    scanRef.current?.focus();
  };

  if (!list) return <div className="ui-content">{error ? <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div> : <div className="ui-skeleton" style={{ height: 240 }} />}</div>;

  const live = list.lines.filter((l) => !l.removed);
  const pct = Number(list.progress.required) ? Math.round((Number(list.progress.picked) / Number(list.progress.required)) * 100) : 0;
  const removedOrders = list.orders.filter((o) => o.removed);
  const closed = list.status === 'cancelled';

  return (
    <div className="ui-content" style={{ maxWidth: 720, margin: '0 auto', gap: 'var(--space-4)' }}>
      <div className="ui-page-header">
        <div style={{ flex: 1 }}>
          <Link className="ui-caption" href="/fulfilment?stage=picking">Fulfilment /</Link>
          <h1 className="ui-h1">{list.number}</h1>
          <div className="ui-caption">{list.orders.filter((o) => !o.removed).length} order{list.orders.length > 1 ? 's' : ''} · {list.progress.picked} of {list.progress.required} picked</div>
        </div>
        {!closed && <button className="ui-btn ui-btn--ghost ui-btn--sm" type="button" onClick={() => setCancelling(true)}>Cancel list</button>}
      </div>
      <div className="ui-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Picked"><span style={{ width: `${pct}%` }} /></div>

      {removedOrders.length > 0 && (
        <div className="ui-alert ui-alert--warning" role="alert"><div className="ui-alert-body">
          <strong>Taken off this list:</strong> {removedOrders.map((o) => `#${o.number}`).join(', ')}. The shop changed or cancelled {removedOrders.length > 1 ? 'them' : 'it'}; put anything already picked for {removedOrders.length > 1 ? 'them' : 'it'} back on the shelf.
        </div></div>
      )}

      {closed ? (
        <div className="ui-alert ui-alert--info" role="status"><div className="ui-alert-body">This pick list is closed. <Link href="/fulfilment">Back to fulfilment</Link></div></div>
      ) : list.status === 'picked' ? (
        <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body">
          <strong>Everything is picked.</strong> Pack each bag next. <Link className="ui-btn ui-btn--sm ui-btn--primary" href="/fulfilment?stage=picking">Go to packing</Link>
        </div></div>
      ) : (
        <form onSubmit={scan}>
          <div className="ui-scan" data-state={flash?.state}>
            <span className="ui-scan-dot" aria-hidden />
            <input ref={scanRef} autoFocus autoComplete="off" inputMode="search" enterKeyHint="go" placeholder="Scan a barcode or type a SKU" aria-label="Scan an item" value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
        </form>
      )}
      <div role="status" aria-live="assertive" style={{ minHeight: 28 }}>
        {flash && <div className={flash.state === 'error' ? 'ui-error' : 'ui-muted'} style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: flash.state === 'ok' ? 'var(--success)' : undefined }}>{flash.state === 'ok' ? '✓ ' : '✕ '}{flash.text}</div>}
      </div>

      <div className="ui-panel">
        <div className="ui-table-wrap"><table className="ui-table ui-table--touch">
          <thead><tr><th scope="col">Item</th><th scope="col">Bag</th><th scope="col" className="ui-num">Picked</th></tr></thead>
          <tbody>{live.map((l, i) => {
            const done = l.qtyPicked === l.qtyRequired;
            const newShelf = i === 0 || live[i - 1].location !== l.location;
            return (
              <tr key={l.id} style={done ? { opacity: 0.55 } : undefined}>
                <td>
                  {newShelf && <div className="ui-eyebrow">{l.location}</div>}
                  <div className="ui-cell-title">{l.name}{Object.keys(l.attributes).length > 0 && <span className="ui-muted"> · {attrLabel(l.attributes)}</span>}</div>
                  <div className="ui-cell-sub"><span className="ui-code">{l.sku}</span>{l.barcode && <> · {l.barcode}</>}</div>
                </td>
                <td><strong>#{l.orderNumber}</strong></td>
                <td className="ui-num">
                  <button className="ui-btn ui-btn--sm" type="button" disabled={closed} onClick={() => setEditing(l)} aria-label={`Change picked quantity for ${l.sku} in #${l.orderNumber}`}>
                    {done ? '✓ ' : ''}{l.qtyPicked} / {l.qtyRequired}
                  </button>
                </td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </div>

      {editing && <QtyDialog line={editing} onClose={() => { setEditing(null); scanRef.current?.focus(); }} onSave={(q) => setPicked(editing, q)} />}
      {cancelling && <CancelDialog onClose={() => setCancelling(false)} onCancel={async (reason) => {
        await api(`/pick-lists/${id}/cancel`, { method: 'POST', body: { reason } });
        router.push('/fulfilment');
      }} />}
    </div>
  );
}

/** Set a line by hand: an item without a barcode, or undoing a mis-scan. */
function QtyDialog({ line, onClose, onSave }: { line: PickLine; onClose: () => void; onSave: (q: string) => void }) {
  const [q, setQ] = useState(line.qtyPicked);
  return (
    <div className="ui-backdrop" role="presentation" onClick={onClose}>
      <form className="ui-dialog" role="dialog" aria-modal aria-labelledby="qty-title" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSave(q.trim() || '0'); }}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="qty-title">{line.sku} for #{line.orderNumber}</h2></div>
        <div className="ui-dialog-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <label className="ui-field"><span className="ui-label">Picked (of {line.qtyRequired})</span>
            <input className="ui-input ui-input--num" autoFocus inputMode={line.allowFraction ? 'decimal' : 'numeric'} value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="ui-btn" type="button" onClick={() => setQ('0')}>None</button>
            <button className="ui-btn" type="button" onClick={() => setQ(line.qtyRequired)}>All {line.qtyRequired}</button>
          </div>
        </div>
        <div className="ui-dialog-foot"><button className="ui-btn" type="button" onClick={onClose}>Cancel</button><button className="ui-btn ui-btn--primary" type="submit">Save</button></div>
      </form>
    </div>
  );
}

function CancelDialog({ onClose, onCancel }: { onClose: () => void; onCancel: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="ui-backdrop" role="presentation" onClick={onClose}>
      <form className="ui-dialog" role="dialog" aria-modal aria-labelledby="cancel-title" onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(''); try { await onCancel(reason.trim()); } catch (err) { setError(errorText(err)); setBusy(false); } }}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="cancel-title">Cancel this pick list?</h2></div>
        <div className="ui-dialog-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
          <p className="ui-muted" style={{ margin: 0 }}>Its orders go back to “Ready to pick” with their stock still held. Put anything already picked back on the shelf.</p>
          <label className="ui-field"><span className="ui-label">Why <span className="ui-req">*</span></span>
            <input className="ui-input" autoFocus required minLength={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        </div>
        <div className="ui-dialog-foot"><button className="ui-btn" type="button" onClick={onClose}>Keep picking</button>
          <button className="ui-btn ui-btn--danger" type="submit" disabled={busy || reason.trim().length < 3} aria-busy={busy}>Cancel list</button></div>
      </form>
    </div>
  );
}
