'use client';

import { useEffect, useState } from 'react';
import { money } from '../../../lib/format';
import { fmtTime } from '../../../lib/datetime';
import { api, errorText, type CartInput, type HeldBill, type ResumedBill } from '../../../lib/sales-api';

// Held bills (v2, D105): park the bill on screen so the next customer isn't kept waiting, and pick it up later from any
// till at this outlet. Nothing is set aside in stock; the bill is priced again when it comes back.

export function HoldDialog({ cart, onClose, onHeld }: { cart: CartInput; onClose: () => void; onHeld: () => void }) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const hold = async () => {
    setBusy(true); setError('');
    try {
      const { approvalId: _skip, ...rest } = cart;
      await api('/pos/held', { method: 'POST', body: { cart: rest, ...(label.trim() ? { label: label.trim() } : {}) } });
      onHeld();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="ui-backdrop" role="presentation" onClick={onClose}>
      <div className="ui-dialog" role="dialog" aria-modal aria-labelledby="hold-title" onClick={(e) => e.stopPropagation()}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="hold-title">Hold this bill</h2></div>
        <div className="ui-dialog-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
          <label className="ui-field"><span className="ui-label">Note (optional)</span>
            <input className="ui-input" autoFocus maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Blue shirt man, card not working" onKeyDown={(e) => { if (e.key === 'Enter') hold(); }} /></label>
          <span className="ui-help">The bill goes to Held bills and the counter is free for the next customer. Stock is not set aside, and prices are checked again when you pick it up.</span>
        </div>
        <div className="ui-dialog-foot">
          <button className="ui-btn" type="button" onClick={onClose}>Cancel</button>
          <button className="ui-btn ui-btn--primary" type="button" disabled={busy} aria-busy={busy} onClick={hold}>Hold bill</button>
        </div>
      </div>
    </div>
  );
}

export function HeldList({ outletId, busyCart, onResume, onClose, onCount }: {
  outletId: string; busyCart: boolean; onResume: (b: ResumedBill) => void; onClose: () => void; onCount: (n: number) => void;
}) {
  const [items, setItems] = useState<HeldBill[] | null>(null);
  const [error, setError] = useState('');
  const load = () => api<{ items: HeldBill[] }>(`/pos/held?outletId=${outletId}`)
    .then((r) => { setItems(r.data.items); onCount(r.data.items.length); }).catch((e) => setError(errorText(e)));
  useEffect(() => { load(); }, [outletId]);

  const resume = async (h: HeldBill) => {
    setError('');
    try { const { data } = await api<ResumedBill>(`/pos/held/${h.id}/resume`, { method: 'POST', body: { outletId } }); onResume(data); }
    catch (e) { setError(errorText(e)); load(); }
  };
  const discard = async (h: HeldBill) => {
    if (!window.confirm(`Discard the held bill${h.label ? ` “${h.label}”` : ''}? Its items are not sold.`)) return;
    setError('');
    try { await api(`/pos/held/${h.id}?outletId=${outletId}`, { method: 'DELETE' }); } catch (e) { setError(errorText(e)); }
    load();
  };

  return (
    <div className="ui-backdrop" role="presentation" onClick={onClose}>
      <div className="ui-dialog" role="dialog" aria-modal aria-labelledby="held-title" onClick={(e) => e.stopPropagation()} style={{ width: 'min(640px, 100%)' }}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="held-title">Held bills</h2></div>
        <div className="ui-dialog-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
          {busyCart && <div className="ui-alert ui-alert--warning"><div className="ui-alert-body">Hold or clear the bill on screen before picking up another.</div></div>}
          {!items ? <div className="ui-skeleton" style={{ height: 120 }} /> : items.length === 0 ? <p className="ui-muted" style={{ margin: 0 }}>No bills on hold.</p> : (
            <div className="gp-held">{items.map((h) => (
              <div key={h.id} className="gp-held-row">
                <div style={{ minWidth: 0 }}>
                  <div className="ui-cell-title">{h.label || h.customer || 'Bill'}{h.label && h.customer ? <span className="ui-muted"> · {h.customer}</span> : null}</div>
                  <div className="ui-cell-sub">{h.itemCount} item{h.itemCount === 1 ? '' : 's'} · held {fmtTime(h.heldAt)}{h.heldBy ? ` by ${h.heldBy}` : ''}</div>
                </div>
                <span className="ui-money">{h.total ? money(h.total) : '—'}</span>
                <div className="ui-actions">
                  <button className="ui-btn ui-btn--sm ui-btn--primary" type="button" disabled={busyCart} onClick={() => resume(h)}>Pick up</button>
                  <button className="ui-btn ui-btn--sm" type="button" onClick={() => discard(h)}>Discard</button>
                </div>
              </div>
            ))}</div>
          )}
        </div>
        <div className="ui-dialog-foot"><button className="ui-btn" type="button" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
