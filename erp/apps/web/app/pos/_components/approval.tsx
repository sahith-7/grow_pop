'use client';

import { useEffect, useRef, useState } from 'react';
import { money } from '../../../lib/format';
import { ApiError, api, errorText, type Approver, type CartInput, type DiscountRequest } from '../../../lib/sales-api';

// Asking for a discount above the cashier's limit (v2, D107). The cashier sends the bill as it is; an owner or manager
// either types their PIN here at the till, or answers on their own screen (Approvals), which this dialog checks every
// few seconds. The approval covers exactly this bill: change an item, a quantity or a discount and it must be asked again.

const POLL_MS = 3000;

export function ApprovalDialog({ cart, reason: initialReason, onApproved, onClose }: {
  cart: CartInput; reason: string; onApproved: (id: string, by: string | null, reason: string) => void; onClose: () => void;
}) {
  const [reason, setReason] = useState(initialReason);
  const [req, setReq] = useState<DiscountRequest | null>(null);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [approvers, setApprovers] = useState<Approver[]>([]);
  const [who, setWho] = useState('');
  const [pin, setPin] = useState('');
  const done = useRef(false);

  useEffect(() => {
    api<{ items: Approver[] }>('/pos/approvers').then((r) => {
      setApprovers(r.data.items);
      const first = r.data.items.find((a) => a.hasPin);
      if (first) setWho(first.id);
    }).catch(() => {});
  }, []);

  // Waiting for a remote answer: check every few seconds until it is answered, or the dialog closes.
  useEffect(() => {
    if (!req || req.status !== 'pending') return;
    const t = setInterval(() => {
      api<DiscountRequest>(`/pos/discount-requests/${req.id}`).then((r) => {
        if (r.data.status === 'approved' && !done.current) { done.current = true; onApproved(r.data.id, r.data.decidedBy, r.data.reason); }
        else if (r.data.status !== 'pending') setReq(r.data);
      }).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [req?.id, req?.status]);

  const send = async () => {
    setBusy(true); setError(''); setFields({});
    try {
      const { approvalId: _old, ...rest } = cart;
      const { data } = await api<DiscountRequest>('/pos/discount-requests', { method: 'POST', body: { cart: rest, reason: reason.trim() } });
      setReq(data);
    } catch (e) { setError(errorText(e)); if (e instanceof ApiError) setFields(e.fieldErrors); } finally { setBusy(false); }
  };

  const withPin = async () => {
    if (!req) return;
    setBusy(true); setError('');
    try {
      const { data } = await api<DiscountRequest>(`/pos/discount-requests/${req.id}/pin`, { method: 'POST', body: { approverId: who, pin } });
      if (!done.current) { done.current = true; onApproved(data.id, data.decidedBy, data.reason); }
    } catch (e) { setError(errorText(e)); setPin(''); } finally { setBusy(false); }
  };

  const cancel = async () => {
    if (req?.status === 'pending') await api(`/pos/discount-requests/${req.id}/cancel`, { method: 'POST', body: {} }).catch(() => {});
    onClose();
  };

  const answered = req && req.status !== 'pending';
  return (
    <div className="ui-backdrop" role="presentation" onClick={cancel}>
      <div className="ui-dialog" role="dialog" aria-modal aria-labelledby="appr-title" onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 100%)' }}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="appr-title">Ask for approval</h2></div>
        <div className="ui-dialog-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
          {!req ? (
            <>
              <p style={{ margin: 0 }}>This discount is above your limit. An owner or manager can allow it for this bill.</p>
              <label className="ui-field"><span className="ui-label">Why this discount?</span>
                <input className="ui-input" autoFocus maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. regular customer buying 10 pieces"
                  aria-invalid={!!fields.reason} onKeyDown={(e) => { if (e.key === 'Enter' && reason.trim().length >= 3) send(); }} />
                {fields.reason && <span className="ui-error">{fields.reason[0]}</span>}</label>
            </>
          ) : (
            <>
              <div className="gp-appr-sum">
                <div><span className="ui-muted">Discount</span><strong>{money(req.discountTotal)}</strong><span className="ui-cell-sub">up to {req.maxPct}% on an item · your limit {req.summary.limitPct}%</span></div>
                <div><span className="ui-muted">Bill total</span><strong>{money(req.summary.total)}</strong><span className="ui-cell-sub">{req.reason}</span></div>
              </div>
              {answered ? (
                <div className={`ui-alert ${req.status === 'rejected' ? 'ui-alert--danger' : 'ui-alert--warning'}`} role="status"><div className="ui-alert-body">
                  {req.status === 'rejected' ? `Not approved${req.decidedBy ? ` by ${req.decidedBy}` : ''}${req.note ? `: “${req.note}”` : '.'}` : req.status === 'expired' ? 'Nobody answered in time. Ask again if the customer is still here.' : 'This request was cancelled.'}
                </div></div>
              ) : (
                <>
                  <div className="ui-panel"><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
                    <span className="ui-h3">Approve here with a PIN</span>
                    {approvers.some((a) => a.hasPin) ? (
                      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                        <label className="ui-field" style={{ flex: '1 1 160px' }}><span className="ui-label">Who is approving</span>
                          <select className="ui-select" value={who} onChange={(e) => setWho(e.target.value)}>
                            {approvers.map((a) => <option key={a.id} value={a.id} disabled={!a.hasPin}>{a.name} ({a.role}){a.hasPin ? '' : ' · no PIN set'}</option>)}
                          </select></label>
                        <label className="ui-field" style={{ width: 120 }}><span className="ui-label">Their PIN</span>
                          <input className="ui-input" type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin}
                            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter' && pin.length >= 4) withPin(); }} /></label>
                        <button className="ui-btn ui-btn--primary" type="button" disabled={busy || pin.length < 4 || !who} aria-busy={busy} onClick={withPin}>Approve</button>
                      </div>
                    ) : <span className="ui-help">No owner or manager has set a PIN yet (Password &amp; sign-in). They can still approve from their phone.</span>}
                  </div></div>
                  <div className="gp-appr-wait" role="status"><span className="gp-dot" aria-hidden /><span>Or wait: the owner or manager sees this under <strong>Approvals</strong> on their phone or computer. This screen updates by itself.</span></div>
                </>
              )}
            </>
          )}
        </div>
        <div className="ui-dialog-foot">
          <button className="ui-btn" type="button" onClick={cancel}>{req && !answered ? 'Cancel request' : 'Close'}</button>
          {(!req || answered) && <button className="ui-btn ui-btn--primary" type="button" disabled={busy || reason.trim().length < 3} aria-busy={busy} onClick={() => { setReq(null); send(); }}>{answered ? 'Ask again' : 'Send request'}</button>}
        </div>
      </div>
    </div>
  );
}
