'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { money } from '../../../lib/format';
import { fmtDateTime, fmtTime } from '../../../lib/datetime';
import { api, errorText, type DiscountRequest } from '../../../lib/sales-api';
import { MOVEMENT_STATUS, type Movement } from '../../../lib/cash-api';

// Discount approvals (v2, D107): a cashier asked for a discount above their limit. The owner or a manager answers here,
// from a phone or a computer; the till sees the answer within a few seconds. A request nobody answers in 30 minutes lapses.
// v2 phase 3 (D111): till expenses above the cashier's limit wait here too, until answered or the register closes.

const POLL_MS = 10_000;
const STATUS: Record<DiscountRequest['status'], { label: string; tone: string }> = {
  pending: { label: 'Waiting', tone: 'warning' }, approved: { label: 'Approved', tone: 'success' }, used: { label: 'Approved, billed', tone: 'success' },
  rejected: { label: 'Not approved', tone: 'danger' }, cancelled: { label: 'Cancelled', tone: 'info' }, expired: { label: 'Lapsed', tone: 'info' },
};

export default function ApprovalsPage() {
  const [data, setData] = useState<{ waiting: DiscountRequest[]; recent: DiscountRequest[] } | null>(null);
  const [error, setError] = useState('');
  const [expenses, setExpenses] = useState<Movement[] | null>(null);
  const load = () => {
    api<{ waiting: DiscountRequest[]; recent: DiscountRequest[] }>('/approvals').then((r) => { setData(r.data); setError(''); }).catch((e) => setError(errorText(e)));
    // Only owners and managers with cash control see expenses; for anyone else this is refused and the section stays hidden.
    api<{ items: Movement[] }>('/cash-movements/waiting').then((r) => setExpenses(r.data.items)).catch(() => setExpenses(null));
  };
  useEffect(() => { load(); const t = setInterval(load, POLL_MS); return () => clearInterval(t); }, []);

  return (
    <div className="ui-content">
      <div className="ui-page-header"><div><h1 className="ui-h1">Approvals</h1>
        <div className="ui-caption">Cashiers ask here when a discount or a till expense is above their limit. This page checks for new requests every few seconds.</div></div></div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      {!data ? <div className="ui-skeleton" style={{ height: 200 }} /> : (
        <>
          {expenses && expenses.length > 0 && (
            <section style={{ display: 'grid', gap: 'var(--space-3)', marginBottom: 'var(--space-6)' }} aria-labelledby="exp-h">
              <h2 className="ui-h3" id="exp-h">Till expenses waiting ({expenses.length})</h2>
              {expenses.map((m) => <ExpenseWaiting key={m.id} m={m} onAnswered={load} />)}
            </section>
          )}
          <section style={{ display: 'grid', gap: 'var(--space-3)' }} aria-labelledby="waiting-h">
            <h2 className="ui-h3" id="waiting-h">Discounts waiting for you{data.waiting.length ? ` (${data.waiting.length})` : ''}</h2>
            {data.waiting.length === 0 ? <div className="ui-panel"><div className="ui-empty"><p className="ui-muted" style={{ margin: 0 }}>Nothing waiting.</p></div></div>
              : data.waiting.map((r) => <Waiting key={r.id} r={r} onAnswered={load} />)}
          </section>
          <section style={{ display: 'grid', gap: 'var(--space-3)', marginTop: 'var(--space-6)' }} aria-labelledby="recent-h">
            <h2 className="ui-h3" id="recent-h">Last 2 days</h2>
            <div className="ui-panel">{data.recent.length === 0 ? <div className="ui-empty"><p className="ui-muted" style={{ margin: 0 }}>No requests yet.</p></div> : (
              <div className="ui-table-wrap"><table className="ui-table" data-collapse>
                <thead><tr><th scope="col">Asked</th><th scope="col">By</th><th scope="col" className="ui-money">Discount</th><th scope="col">Reason</th><th scope="col">Answer</th></tr></thead>
                <tbody>{data.recent.map((r) => (
                  <tr key={r.id}>
                    <td data-primary className="ui-nowrap">{fmtDateTime(r.requestedAt)}</td>
                    <td data-label="By">{r.requestedBy}<div className="ui-cell-sub">{r.outlet}</div></td>
                    <td className="ui-money" data-label="Discount">{money(r.discountTotal)}<div className="ui-cell-sub">up to {r.maxPct}%</div></td>
                    <td data-label="Reason">{r.reason}</td>
                    <td data-label="Answer"><span className={`ui-badge ui-badge--${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span>
                      {r.decidedBy && <div className="ui-cell-sub">{r.decidedBy}{r.decidedVia === 'pin' ? ' (PIN at the till)' : ''}{r.note ? ` · “${r.note}”` : ''}</div>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}</div>
          </section>
          <p className="ui-help" style={{ marginTop: 'var(--space-4)' }}>You can approve up to your own discount limit. At the till you can also approve with your PIN: set it on <Link href="/security">Password &amp; sign-in</Link>.</p>
        </>
      )}
    </div>
  );
}

function ExpenseWaiting({ m, onAnswered }: { m: Movement; onAnswered: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const answer = async (approve: boolean) => {
    setBusy(true); setError('');
    try { await api(`/cash-movements/${m.id}/decide`, { method: 'POST', body: { approve, ...(note.trim() ? { note: note.trim() } : {}) } }); onAnswered(); }
    catch (e) { setError(errorText(e)); onAnswered(); } finally { setBusy(false); }
  };
  return (
    <div className="ui-panel"><div className="ui-panel-body gp-request">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span><strong>{m.recordedBy}</strong> at {m.till}, {m.outlet} · {fmtTime(m.recordedAt)}</span>
        <span className={`ui-badge ui-badge--${MOVEMENT_STATUS[m.status].tone}`}>Expense above the limit</span>
      </div>
      <div className="gp-appr-sum">
        <div><span className="ui-muted">From the drawer</span><strong>{money(m.amount)}</strong><span className="ui-cell-sub">{m.category}</span></div>
        <div><span className="ui-muted">For</span><strong style={{ fontSize: 'var(--text-md)' }}>{m.reason}</strong></div>
      </div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="ui-input" style={{ flex: '1 1 200px' }} maxLength={200} placeholder="Note to the cashier (optional)" aria-label="Note to the cashier" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="ui-btn" type="button" disabled={busy} onClick={() => answer(false)}>Don’t pay</button>
        <button className="ui-btn ui-btn--primary" type="button" disabled={busy} aria-busy={busy} onClick={() => answer(true)}>Approve</button>
      </div>
    </div></div>
  );
}

function Waiting({ r, onAnswered }: { r: DiscountRequest; onAnswered: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const answer = async (approve: boolean) => {
    setBusy(true); setError('');
    try { await api(`/approvals/${r.id}`, { method: 'POST', body: { approve, ...(note.trim() ? { note: note.trim() } : {}) } }); onAnswered(); }
    catch (e) { setError(errorText(e)); onAnswered(); } finally { setBusy(false); }
  };
  const s = r.summary;
  return (
    <div className="ui-panel"><div className="ui-panel-body gp-request">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span><strong>{r.requestedBy}</strong> at {r.outlet} · {fmtTime(r.requestedAt)}</span>
        <span className="ui-badge ui-badge--warning">Above their {s.limitPct}% limit</span>
      </div>
      <div className="gp-appr-sum">
        <div><span className="ui-muted">Discount asked</span><strong>{money(r.discountTotal)}</strong><span className="ui-cell-sub">up to {r.maxPct}% on an item</span></div>
        <div><span className="ui-muted">Customer pays</span><strong>{money(s.total)}</strong><span className="ui-cell-sub">instead of {money(s.subtotal)}{s.customer ? ` · ${s.customer}` : ''}</span></div>
      </div>
      <div className="gp-request-lines">{s.lines.map((l, i) => (
        <div key={i}><span>{l.qty} × {l.name}</span><span className="ui-money">{money(l.gross)}{Number(l.discount) > 0 ? ` − ${money(l.discount)} (${l.pct}%)` : ''}</span></div>
      ))}</div>
      <div><span className="ui-muted">Reason: </span>{r.reason}</div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="ui-input" style={{ flex: '1 1 200px' }} maxLength={200} placeholder="Note to the cashier (optional)" aria-label="Note to the cashier" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="ui-btn" type="button" disabled={busy} onClick={() => answer(false)}>Don’t allow</button>
        <button className="ui-btn ui-btn--primary" type="button" disabled={busy} aria-busy={busy} onClick={() => answer(true)}>Approve</button>
      </div>
    </div></div>
  );
}
