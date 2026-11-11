'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { fmtDateTime } from '@/lib/datetime';
import {
  api, contact, day, errorText, rupees, STATE_LABEL,
  type Export, type Grant, type Payment, type Plan, type StateEvent, type Subscription,
} from '../../../lib/account-api';
import { money } from '../../../lib/format';
import { perMonth, type OutletList } from '../../../lib/outlets-api';

// Account (B7), owner only: outlets (v2, D101), plan and state, how to pay, payments, a full data export, and support access.

const STATE_TEXT: Record<string, string> = {
  trial: 'free trial', active: 'active', past_due: 'payment due', suspended: 'read-only', closed: 'closed',
};
const METHOD: Record<string, string> = { upi: 'UPI', bank: 'Bank transfer', cash: 'Cash', other: 'Other' };
const size = (b: number | null) => (b === null ? '' : b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);

function Alert({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <div className={`ui-alert ui-alert--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}><div className="ui-alert-body">{children}</div></div>;
}

function PlanPanel({ s, plans, gstPercent }: { s: Subscription; plans: Plan[]; gstPercent: number | null }) {
  const [tone, label] = STATE_LABEL[s.state];
  const ends = s.state === 'trial' ? `Trial ends ${day(s.trialEndsAt)}` : s.state === 'active' ? `Paid until ${day(s.paidUntil)}`
    : s.state === 'past_due' ? `Read-only from ${day(s.suspendsAt)}` : s.state === 'closed' ? `Data can be downloaded until ${day(s.exportUntil)}` : 'Read-only until a payment is recorded';
  return (
    <section className="ui-panel" aria-labelledby="plan-title">
      <div className="ui-panel-head"><h2 className="ui-h3" id="plan-title" style={{ margin: 0 }}>Plan</h2></div>
      <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <p style={{ margin: 0 }}><span className={`ui-badge ui-badge--${tone}`}>{label}</span> <strong>{s.plan.name}</strong> · up to {s.plan.maxUsers} users{s.online ? ' · online shop included' : ''}</p>
        <p className="ui-muted" style={{ margin: 0 }}>{ends}.</p>
        {s.state === 'trial' && <p className="ui-muted" style={{ margin: 0 }}>The trial includes everything, the online shop too. Choose a plan when you pay.</p>}
        <div className="ui-table-wrap"><table className="ui-table">
          <thead><tr><th scope="col">Plan</th><th scope="col">Includes</th><th scope="col" className="ui-num">Monthly</th><th scope="col" className="ui-num">Yearly</th></tr></thead>
          <tbody>{plans.map((p) => (
            <tr key={p.id} aria-current={p.id === s.plan.id && s.state !== 'trial' ? 'true' : undefined}>
              <td>{p.name}</td>
              <td>{p.online ? 'Counter, stock, purchasing, GST invoices and the WooCommerce shop' : 'Counter, stock, purchasing and GST invoices'}, {p.maxUsers} users</td>
              <td className="ui-num">{rupees(p.priceMonthPaise)}</td><td className="ui-num">{rupees(p.priceYearPaise)}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {gstPercent ? <p className="ui-caption" style={{ margin: 0 }}>Prices are before {gstPercent}% GST.</p> : null}
      </div>
    </section>
  );
}

/** Every outlet with today's bills; open one for its details. Extra outlets are a paid add-on switched on by GroPop. */
function OutletsPanel({ closed }: { closed: boolean }) {
  const [d, setD] = useState<OutletList | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<OutletList>('/outlets').then((r) => setD(r.data)).catch((e) => setError(errorText(e))); }, []);
  const l = d?.limit;
  const full = !!l && l.open >= l.allowed;
  return (
    <section className="ui-panel" aria-labelledby="outlets-title">
      <div className="ui-panel-head" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <h2 className="ui-h3" id="outlets-title" style={{ flex: 1, margin: 0 }}>Outlets</h2>
        {l && <span className="ui-caption">{l.open} open · your plan allows {l.allowed}</span>}
        {d?.can.manage && !closed && (full
          ? <button className="ui-btn" type="button" disabled title="Your plan has no room for another outlet">Create outlet</button>
          : <Link className="ui-btn ui-btn--primary" href="/account/outlets/new">Create outlet</Link>)}
      </div>
      {error && <div className="ui-panel-body"><Alert tone="danger">{error}</Alert></div>}
      {!d ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 96 }} /></div> : (
        <div className="ui-table-wrap"><table className="ui-table" data-collapse>
          <thead><tr><th scope="col">Outlet</th><th scope="col">Address</th><th scope="col">GSTIN</th><th scope="col" className="ui-num">Bills today</th><th scope="col" className="ui-money">Sales today</th></tr></thead>
          <tbody>{d.items.map((o) => (
            <tr key={o.id}>
              <td data-primary>
                <Link className="ui-cell-title" href={`/account/outlets/${o.id}`}>{o.name}</Link>{' '}
                {o.isMain && <span className="ui-badge">Main</span>}{!o.active && <span className="ui-badge ui-badge--danger">Closed</span>}
                {o.active && !o.ready && <span className="ui-badge ui-badge--warning" title={o.problems.join(' ')}>Can’t bill yet</span>}
                <div className="ui-cell-sub">{o.stockRooms} stock room{o.stockRooms === 1 ? '' : 's'}</div>
              </td>
              <td data-label="Address">{[o.address, o.city, o.stateName].filter(Boolean).join(', ') || <span className="ui-muted">Not set</span>}</td>
              <td data-label="GSTIN" className="ui-code">{o.gstin ?? <span className="ui-muted">—</span>}</td>
              <td data-label="Bills today" className="ui-num">{o.today.bills}</td>
              <td data-label="Sales today" className="ui-money">{money(o.today.sales)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {l && full && !closed && (
        <div className="ui-panel-body">
          <p className="ui-muted" style={{ margin: 0 }}>Your plan includes {l.included} outlet{l.extra ? ` plus ${l.extra} extra` : ''}. To open another, pay for an extra outlet{perMonth(l.pricePerOutletMonthPaise) ? ` (${perMonth(l.pricePerOutletMonthPaise)})` : ''} the same way as your plan, and tell us. We switch it on the same working day.</p>
        </div>
      )}
    </section>
  );
}

function PayPanel({ s }: { s: Subscription }) {
  return (
    <section className="ui-panel" aria-labelledby="pay-title">
      <div className="ui-panel-head"><h2 className="ui-h3" id="pay-title" style={{ margin: 0 }}>How to pay</h2></div>
      <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-2)' }}>
        {s.payTo ? (
          <>
            <p style={{ margin: 0 }}>Pay by UPI to <strong className="ui-code">{s.payTo.upiId}</strong>{s.payTo.payee ? ` (${s.payTo.payee})` : ''}.</p>
            <p style={{ margin: 0 }}>Put your store code <strong className="ui-code">{s.storeCode}</strong> in the payment note, then send the transaction id (UTR) to {contact(s.support)}.</p>
            <p className="ui-muted" style={{ margin: 0 }}>We record the payment by hand, usually the same working day. You get a receipt below.</p>
          </>
        ) : (
          <p style={{ margin: 0 }}>Contact {contact(s.support)} to pay. Your store code is <strong className="ui-code">{s.storeCode}</strong>.</p>
        )}
      </div>
    </section>
  );
}

function PaymentsPanel({ payments, events }: { payments: Payment[]; events: StateEvent[] }) {
  return (
    <section className="ui-panel" aria-labelledby="payments-title">
      <div className="ui-panel-head"><h2 className="ui-h3" id="payments-title" style={{ margin: 0 }}>Payments</h2></div>
      {!payments.length ? <div className="ui-empty"><p className="ui-muted">No payments yet.</p></div> : (
        <div className="ui-table-wrap"><table className="ui-table">
          <thead><tr><th scope="col">Receipt</th><th scope="col">Paid on</th><th scope="col">Method</th><th scope="col">Reference</th><th scope="col">Covers</th><th scope="col" className="ui-num">Amount</th></tr></thead>
          <tbody>{payments.map((p) => (
            <tr key={p.receiptNo}><td>{p.receiptNo}</td><td>{day(p.paidOn)}</td><td>{METHOD[p.method] ?? p.method}</td><td className="ui-code">{p.reference}</td>
              <td>{day(p.periodFrom)} to {day(p.periodTo)}</td><td className="ui-num">{rupees(p.amountPaise)}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      {!!events.length && (
        <div className="ui-panel-body">
          <h3 className="ui-label" style={{ marginTop: 0 }}>History</h3>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {events.map((e, i) => <li key={i}>{day(e.at)}: {e.from ? `${STATE_TEXT[e.from]} → ` : ''}{STATE_TEXT[e.to]}{e.reason ? ` (${e.reason})` : ''}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

function ExportPanel() {
  const [items, setItems] = useState<Export[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ items: Export[] }>('/account/exports').then((r) => setItems(r.data.items)).catch((e) => setError(errorText(e))), []);
  useEffect(() => { load(); }, [load]);
  const working = items?.some((e) => e.status === 'pending' || e.status === 'running');
  useEffect(() => { if (!working) return; const t = setInterval(load, 3000); return () => clearInterval(t); }, [working, load]);
  const start = async () => {
    setBusy(true); setError('');
    try { await api('/account/exports', { method: 'POST' }); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <section className="ui-panel" aria-labelledby="export-title">
      <div className="ui-panel-head" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <h2 className="ui-h3" id="export-title" style={{ flex: 1, margin: 0 }}>Download all your data</h2>
        <button className="ui-btn ui-btn--primary" type="button" onClick={start} disabled={busy || working} aria-busy={busy}>Prepare a download</button>
      </div>
      <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <p className="ui-muted" style={{ margin: 0 }}>A ZIP file with one spreadsheet (CSV) per kind of record: products, stock movements, invoices, orders, customers and the rest. Passwords and shop keys are left out. Each download is kept for 7 days and recorded in the audit log.</p>
        {error && <Alert tone="danger">{error}</Alert>}
        {items?.length ? (
          <ul style={{ margin: 0, paddingLeft: '1.25rem', display: 'grid', gap: 'var(--space-2)' }}>
            {items.map((e) => (
              <li key={e.id}>
                {day(e.createdAt)}:{' '}
                {e.status === 'pending' || e.status === 'running' ? 'Preparing…'
                  : e.status === 'failed' ? <span className="ui-error">{e.error}</span>
                  : e.downloadable ? <a href={`/api/v1/account/exports/${e.id}/download`} download>Download ({size(e.sizeBytes)})</a>
                  : <span className="ui-muted">expired</span>}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function SupportPanel() {
  const [data, setData] = useState<{ items: Grant[]; views: { at: string; by: string }[] } | null>(null);
  const [hours, setHours] = useState('24');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ items: Grant[]; views: { at: string; by: string }[] }>('/account/support-access').then((r) => setData(r.data)).catch((e) => setError(errorText(e))), []);
  useEffect(() => { load(); }, [load]);
  const active = data?.items.find((g) => g.active);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  return (
    <section className="ui-panel" aria-labelledby="support-title">
      <div className="ui-panel-head"><h2 className="ui-h3" id="support-title" style={{ margin: 0 }}>Support access</h2></div>
      <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <p className="ui-muted" style={{ margin: 0 }}>If you ask us for help, you can let our support team look at your store's health for a limited time: counts of records, sync status and errors, and the most recent actions in your audit log (what was done and when, not the details). Support cannot change anything. Every look appears below and in your audit log.</p>
        {error && <Alert tone="danger">{error}</Alert>}
        {active ? (
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="ui-badge ui-badge--warning">Support can look until {fmtDateTime(active.expiresAt)}</span>
            <button className="ui-btn ui-btn--danger" type="button" disabled={busy} onClick={() => act(() => api('/account/support-access/revoke', { method: 'POST' }))}>Stop access now</button>
          </div>
        ) : (
          <form style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}
            onSubmit={(e) => { e.preventDefault(); act(() => api('/account/support-access', { method: 'POST', body: { hours: Number(hours), reason: reason.trim() || undefined } })); }}>
            <label className="ui-field"><span className="ui-label">For</span>
              <select className="ui-select" value={hours} onChange={(e) => setHours(e.target.value)}>
                <option value="2">2 hours</option><option value="24">24 hours</option><option value="72">3 days</option>
              </select></label>
            <label className="ui-field" style={{ flex: 1, minWidth: 200 }}><span className="ui-label">What's wrong (optional)</span>
              <input className="ui-input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="e.g. web orders not arriving" /></label>
            <button className="ui-btn ui-btn--primary" type="submit" disabled={busy}>Allow support access</button>
          </form>
        )}
        {!!data?.views.length && (
          <div>
            <h3 className="ui-label" style={{ marginTop: 0 }}>Looks by support</h3>
            <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>{data.views.map((v, i) => <li key={i}>{fmtDateTime(v.at)} by {v.by}</li>)}</ul>
          </div>
        )}
      </div>
    </section>
  );
}

export default function AccountPage() {
  const [s, setS] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [gstPercent, setGstPercent] = useState<number | null>(null);
  const [history, setHistory] = useState<{ payments: Payment[]; events: StateEvent[] }>({ payments: [], events: [] });
  const [error, setError] = useState('');
  useEffect(() => {
    api<Subscription>('/subscription').then((r) => setS(r.data)).catch((e) => setError(errorText(e)));
    api<{ items: Plan[]; gstPercent: number | null }>('/account/plans').then((r) => { setPlans(r.data.items); setGstPercent(r.data.gstPercent); }).catch(() => {});
    api<{ payments: Payment[]; events: StateEvent[] }>('/account/payments').then((r) => setHistory(r.data)).catch(() => {});
  }, []);
  return (
    <div className="ui-content">
      <div className="ui-page-header"><h1 className="ui-h1">Account</h1></div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!s ? <div className="ui-skeleton" style={{ height: 240 }} /> : (
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <OutletsPanel closed={s.state === 'closed'} />
          {s.state !== 'closed' && <PlanPanel s={s} plans={plans} gstPercent={gstPercent} />}
          {s.state !== 'closed' && <PayPanel s={s} />}
          <ExportPanel />
          {s.state !== 'closed' && <SupportPanel />}
          <PaymentsPanel payments={history.payments} events={history.events} />
        </div>
      )}
    </div>
  );
}
