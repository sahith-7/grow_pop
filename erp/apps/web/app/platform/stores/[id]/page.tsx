'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { papi, perr, ApiError, type PlanRow, type StoreDetail } from '@/lib/platform-api';
import { fmtDate, fmtDateTime, todayIST } from '@/lib/datetime';

// One store in the console (B7): its subscription, a manual payment, state changes, and the support view while the
// owner allows it. Nothing here reads the store's business records.

const LABEL: Record<string, string> = { trial: 'Trial', active: 'Active', past_due: 'Payment due', suspended: 'Read-only', closed: 'Closed' };
const TONE: Record<string, string> = { trial: 'info', active: 'success', past_due: 'warning', suspended: 'danger', closed: '' };
const day = (iso: string | null) => fmtDate(iso);
const when = (iso: string | null) => fmtDateTime(iso);
const inr = (paise: number | null) => (paise === null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(paise / 100));
const today = () => todayIST();

function Err({ text }: { text: string }) {
  return text ? <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{text}</div></div> : null;
}

function PaymentForm({ store, plans, gstPercent, onDone }: { store: StoreDetail; plans: PlanRow[]; gstPercent: number | null; onDone: () => void }) {
  const [planId, setPlanId] = useState(store.planId);
  const [cycle, setCycle] = useState<'month' | 'year'>('month');
  const plan = plans.find((p) => p.id === planId);
  const suggested = plan ? (cycle === 'year' ? plan.priceYearPaise : plan.priceMonthPaise) : null;
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('upi');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const [months, setMonths] = useState('1');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const withGst = suggested === null ? null : Math.round(suggested * (1 + (gstPercent ?? 0) / 100));
  return (
    <form className="ui-panel" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError(''); setFieldErrors({});
      try {
        await papi(`/tenants/${store.id}/payments`, { method: 'POST', body: {
          amountPaise: Math.round(Number(amount) * 100), method, reference: reference.trim(), paidOn, planId, months: Number(months), note: note.trim() || undefined } });
        setReference(''); setNote(''); setAmount(''); onDone();
      } catch (err) { setError(perr(err)); if (err instanceof ApiError) setFieldErrors(err.fieldErrors); } finally { setBusy(false); }
    }}>
      <div className="ui-panel-head"><h2 className="ui-h3" style={{ margin: 0 }}>Record a payment</h2></div>
      <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <p className="ui-muted" style={{ margin: 0 }}>Check the money is in your account first. Look for store code <strong className="ui-code">{store.storeCode}</strong> in the UPI note. The store becomes active straight away and the paid period is extended.</p>
        <Err text={error} />
        <div className="ui-form-grid" style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <label className="ui-field"><span className="ui-label">Plan</span>
            <select className="ui-select" value={planId} onChange={(e) => setPlanId(e.target.value)}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="ui-field"><span className="ui-label">Billing</span>
            <select className="ui-select" value={cycle} onChange={(e) => { const c = e.target.value as 'month' | 'year'; setCycle(c); setMonths(c === 'year' ? '12' : '1'); }}>
              <option value="month">Monthly</option><option value="year">Yearly</option></select></label>
          <label className="ui-field"><span className="ui-label">Months covered</span>
            <input className="ui-input ui-input--num" type="number" min={1} max={36} required value={months} onChange={(e) => setMonths(e.target.value)} /></label>
          <label className="ui-field"><span className="ui-label">Amount received (₹)</span>
            <input className="ui-input ui-input--num" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!fieldErrors.amountPaise}
              placeholder={withGst === null ? '' : String(withGst / 100)} />
            {withGst !== null && <span className="ui-help">{gstPercent ? <>List price {inr(suggested)} + {gstPercent}% GST = {inr(withGst)}</> : <>List price {inr(suggested)}</>}</span>}</label>
          <label className="ui-field"><span className="ui-label">Method</span>
            <select className="ui-select" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="upi">UPI</option><option value="bank">Bank transfer</option><option value="cash">Cash</option><option value="other">Other</option></select></label>
          <label className="ui-field"><span className="ui-label">Transaction id (UTR) or reference</span>
            <input className="ui-input" required minLength={4} maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} aria-invalid={!!fieldErrors.reference} />
            {fieldErrors.reference && <span className="ui-error">{fieldErrors.reference.join(' ')}</span>}</label>
          <label className="ui-field"><span className="ui-label">Paid on</span>
            <input className="ui-input" type="date" required value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></label>
        </div>
        <label className="ui-field"><span className="ui-label">Note (optional, only you see it)</span>
          <input className="ui-input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <div><button className="ui-btn ui-btn--primary" type="submit" disabled={busy} aria-busy={busy}>Record payment</button></div>
      </div>
    </form>
  );
}

function Actions({ store, plans, onDone }: { store: StoreDetail; plans: PlanRow[]; onDone: () => void }) {
  const [action, setAction] = useState('');
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [planId, setPlanId] = useState(store.planId);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const choices: [string, string][] = [
    ...(store.state !== 'suspended' && store.state !== 'closed' ? [['suspended', 'Make read-only (suspend)']] as [string, string][] : []),
    // The API refuses 'active' without paid time left, so only offer it when there is some (e.g. suspended for abuse).
    ...((store.state === 'suspended' || store.state === 'past_due') && store.paidUntil && new Date(store.paidUntil) > new Date()
      ? [['active', 'Reactivate (paid time left)']] as [string, string][] : []),
    ...(store.state !== 'closed' ? [['closed', 'Close the store']] as [string, string][] : [['suspended', 'Reopen (read-only until paid)']] as [string, string][]),
    ...(['trial', 'past_due', 'suspended'].includes(store.state) ? [['trial', 'Set the trial end date']] as [string, string][] : []),
    ['plan', 'Change plan without a payment'],
  ];
  const submit = async () => {
    setBusy(true); setError('');
    try {
      if (action === 'trial') await papi(`/tenants/${store.id}/trial`, { method: 'POST', body: { until, reason } });
      else if (action === 'plan') await papi(`/tenants/${store.id}/plan`, { method: 'POST', body: { planId, reason } });
      else await papi(`/tenants/${store.id}/state`, { method: 'POST', body: { state: action, reason } });
      setAction(''); setReason(''); onDone();
    } catch (e) { setError(perr(e)); } finally { setBusy(false); }
  };
  return (
    <section className="ui-panel">
      <div className="ui-panel-head"><h2 className="ui-h3" style={{ margin: 0 }}>Change state or plan</h2></div>
      <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <Err text={error} />
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="ui-field"><span className="ui-label">Action</span>
            <select className="ui-select" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">Choose…</option>{choices.map(([v, l]) => <option key={`${v}${l}`} value={v}>{l}</option>)}</select></label>
          {action === 'trial' && <label className="ui-field"><span className="ui-label">Trial ends on</span>
            <input className="ui-input" type="date" value={until} min={today()} onChange={(e) => setUntil(e.target.value)} /></label>}
          {action === 'plan' && <label className="ui-field"><span className="ui-label">Plan</span>
            <select className="ui-select" value={planId} onChange={(e) => setPlanId(e.target.value)}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
          {action && <label className="ui-field" style={{ flex: 1, minWidth: 220 }}><span className="ui-label">Reason (kept in the log)</span>
            <input className="ui-input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></label>}
          {action && <button className={`ui-btn ${action === 'closed' ? 'ui-btn--danger' : 'ui-btn--primary'}`} type="button"
            disabled={busy || reason.trim().length < 3 || (action === 'trial' && !until)} onClick={submit}>Apply</button>}
        </div>
        {action === 'closed' && <p className="ui-muted" style={{ margin: 0 }}>A closed store can only sign in to download its data, for 30 days. Its web orders are refused. Deleting the data afterwards is a manual step in the runbook.</p>}
      </div>
    </section>
  );
}

/** Extra outlets (v2, D101): one is included; switch more on after the owner has paid for them. */
function Outlets({ store, onDone }: { store: StoreDetail; onDone: () => void }) {
  const o = store.outlets;
  const open = o.outlets.filter((x) => x.active).length;
  const [extra, setExtra] = useState(String(o.extraOutlets));
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setError('');
    try { await papi(`/tenants/${store.id}/outlets`, { method: 'POST', body: { extraOutlets: Number(extra), reason } }); setReason(''); onDone(); }
    catch (e) { setError(perr(e)); } finally { setBusy(false); }
  };
  return (
    <section className="ui-panel">
      <div className="ui-panel-head"><h2 className="ui-h3" style={{ margin: 0 }}>Outlets</h2></div>
      <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <p style={{ margin: 0 }}>{open} open of {1 + o.extraOutlets} allowed (1 included + {o.extraOutlets} extra). {o.outlets.map((x) => `${x.name}${x.main ? ' (main)' : ''}${x.active ? '' : ' (closed)'}`).join(' · ')}</p>
        <Err text={error} />
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="ui-field"><span className="ui-label">Extra outlets paid for</span>
            <input className="ui-input ui-input--num" type="number" min={0} max={50} style={{ width: 120 }} value={extra} onChange={(e) => setExtra(e.target.value)} /></label>
          <label className="ui-field" style={{ flex: 1, minWidth: 220 }}><span className="ui-label">Reason (kept in the log)</span>
            <input className="ui-input" value={reason} maxLength={300} placeholder="e.g. paid for 1 extra outlet, receipt R-000012" onChange={(e) => setReason(e.target.value)} /></label>
          <button className="ui-btn ui-btn--primary" type="button" disabled={busy || reason.trim().length < 3 || Number(extra) === o.extraOutlets || !/^\d{1,2}$/.test(extra)} onClick={submit}>Save</button>
        </div>
      </div>
    </section>
  );
}

function SupportView({ store }: { store: StoreDetail }) {
  const [v, setV] = useState<any>(null);
  const [error, setError] = useState('');
  if (!store.supportGrant) return (
    <section className="ui-panel"><div className="ui-panel-body"><p className="ui-muted" style={{ margin: 0 }}>Support view: the owner has not allowed it. They can, from their Account page, for up to 3 days.</p></div></section>
  );
  return (
    <section className="ui-panel">
      <div className="ui-panel-head" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
        <h2 className="ui-h3" style={{ margin: 0, flex: 1 }}>Support view</h2>
        <button className="ui-btn" type="button" onClick={() => papi(`/tenants/${store.id}/support`).then(setV).catch((e) => setError(perr(e)))}>Open (the owner sees this)</button>
      </div>
      <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <p className="ui-muted" style={{ margin: 0 }}>Allowed until {when(store.supportGrant.expiresAt)}{store.supportGrant.reason ? `: “${store.supportGrant.reason}”` : ''}.</p>
        <Err text={error} />
        {v && <>
          <p style={{ margin: 0 }}>{Object.entries(v.counts).map(([k, n]) => `${k} ${n}`).join(' · ')}</p>
          {v.woo && <p style={{ margin: 0 }}>Shop {v.woo.siteUrl}: {v.woo.status}{v.woo.webhooksOk === false ? ', webhooks off' : ''}{v.woo.lastError ? `, last error “${v.woo.lastError}” at ${when(v.woo.lastErrorAt)}` : ''}; last success {when(v.woo.lastSuccessAt)}</p>}
          <div className="ui-table-wrap"><table className="ui-table">
            <thead><tr><th scope="col">Job</th><th scope="col">State</th><th scope="col" className="ui-num">Count</th><th scope="col">Oldest</th></tr></thead>
            <tbody>{v.jobs.map((j: any, i: number) => <tr key={i}><td>{j.kind}</td><td>{j.status}</td><td className="ui-num">{j.count}</td><td>{when(j.oldest)}</td></tr>)}</tbody>
          </table></div>
          {!!v.failedJobs.length && <ul style={{ margin: 0 }}>{v.failedJobs.map((j: any, i: number) => <li key={i}><span className="ui-code">{j.kind}</span> ({j.status}, {j.attempts} tries): {j.lastError}</li>)}</ul>}
          <details><summary>Recent actions</summary><ul>{v.recentAudit.map((a: any, i: number) => <li key={i}>{when(a.at)} {a.action}</li>)}</ul></details>
        </>}
      </div>
    </section>
  );
}

export default function StorePage() {
  const { id } = useParams<{ id: string }>();
  const [store, setStore] = useState<StoreDetail | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [gstPercent, setGstPercent] = useState<number | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => papi<StoreDetail>(`/tenants/${id}`).then(setStore).catch((e) => setError(perr(e))), [id]);
  useEffect(() => { load(); papi<{ items: PlanRow[]; gstPercent: number | null }>('/plans').then((r) => { setPlans(r.items); setGstPercent(r.gstPercent); }).catch(() => {}); }, [load]);
  if (error) return <Err text={error} />;
  if (!store) return <div className="ui-skeleton" style={{ height: 240 }} />;
  return (
    <>
      <p><Link href="/platform">← Stores</Link></p>
      <div className="ui-page-header"><h1 className="ui-h1">{store.name}</h1></div>
      <section className="ui-panel"><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <p style={{ margin: 0 }}><span className={`ui-badge ui-badge--${TONE[store.state]}`}>{LABEL[store.state]}</span> {plans.find((p) => p.id === store.planId)?.name ?? store.planId} · store code <strong className="ui-code">{store.storeCode}</strong></p>
        <p style={{ margin: 0 }}>{store.state === 'trial' ? `Trial ends ${day(store.trialEndsAt)}` : `Paid until ${day(store.paidUntil)}`}{store.pastDueSince ? ` · payment due since ${day(store.pastDueSince)}` : ''}{store.closedAt ? ` · closed ${day(store.closedAt)}` : ''}</p>
        <p className="ui-muted" style={{ margin: 0 }}>Owner {store.owner?.name} ({store.owner?.email}) · {store.users} users · legal name {store.legalName} · signed up {day(store.createdAt)}</p>
      </div></section>
      <div style={{ display: 'grid', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
        {store.state !== 'closed' && <PaymentForm store={store} plans={plans} gstPercent={gstPercent} onDone={load} />}
        <Actions store={store} plans={plans} onDone={load} />
        <Outlets store={store} onDone={load} />
        <SupportView store={store} />
        <section className="ui-panel">
          <div className="ui-panel-head"><h2 className="ui-h3" style={{ margin: 0 }}>Payments</h2></div>
          {!store.payments.length ? <div className="ui-empty"><p className="ui-muted">None yet.</p></div> : (
            <div className="ui-table-wrap"><table className="ui-table">
              <thead><tr><th scope="col">Receipt</th><th scope="col">Paid on</th><th scope="col">Reference</th><th scope="col">Plan</th><th scope="col" className="ui-num">Months</th><th scope="col">Until</th><th scope="col" className="ui-num">Amount</th><th scope="col">Recorded by</th></tr></thead>
              <tbody>{store.payments.map((p) => <tr key={p.receiptNo}><td>{p.receiptNo}</td><td>{day(p.paidOn)}</td><td className="ui-code">{p.method.toUpperCase()} {p.reference}</td><td>{p.planId}</td><td className="ui-num">{p.months}</td><td>{day(p.periodTo)}</td><td className="ui-num">{inr(p.amountPaise)}</td><td>{p.recordedBy.replace('admin:', '')}</td></tr>)}</tbody>
            </table></div>
          )}
        </section>
        <section className="ui-panel">
          <div className="ui-panel-head"><h2 className="ui-h3" style={{ margin: 0 }}>History</h2></div>
          <div className="ui-panel-body"><ul style={{ margin: 0 }}>{store.events.map((e, i) => <li key={i}>{when(e.at)}: {e.from ? `${LABEL[e.from]} → ` : ''}{LABEL[e.to]} by {e.actor.replace('admin:', '')}{e.reason ? ` (${e.reason})` : ''}</li>)}</ul></div>
        </section>
      </div>
    </>
  );
}
