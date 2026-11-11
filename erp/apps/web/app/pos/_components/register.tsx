'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { money } from '../../../lib/format';
import { fmtTime } from '../../../lib/datetime';
import {
  ApiError, api, CATEGORIES, countTotal, DENOMINATIONS, errorText, MOVEMENT_LABEL, MOVEMENT_STATUS, type Counts, type Movement, type Register, type Till,
} from '../../../lib/cash-api';
import type { Approver } from '../../../lib/sales-api';

// The till's register at the counter (v2 phase 3, D110–D112). Opening: count the drawer. During the day: cash added,
// cash taken out (owner or manager), expenses (above the cashier's limit an owner or manager approves, with their PIN here
// or from Approvals). Closing: count again, see short or over, say why, and leave a float for the next shift.

const rupees = (p: number) => (p / 100).toFixed(2);
const paise = (v: string) => Math.round(Number(v || '0') * 100);
const POLL_MS = 3000;

/** Notes and coins, counted. Typing a count shows the line's value and the total at once. */
export function CountGrid({ counts, onChange, label }: { counts: Counts; onChange: (c: Counts) => void; label: string }) {
  const total = countTotal(counts);
  return (
    <fieldset className="gp-count-grid" aria-label={label}>
      <legend className="ui-label">{label}</legend>
      {DENOMINATIONS.map((d) => (
        <label key={d} className="gp-count-row">
          <span className="gp-count-face">₹{d}</span>
          <span aria-hidden>×</span>
          <input className="ui-input ui-input--num" inputMode="numeric" placeholder="0" aria-label={`Number of ₹${d}`} value={counts[d] ?? ''}
            onChange={(e) => { const n = e.target.value.replace(/\D/g, '').slice(0, 6); onChange({ ...counts, [d]: n === '' ? undefined : Number(n) }); }} />
          <span className="ui-money gp-count-line">{(counts[d] ?? 0) > 0 ? money(rupees((counts[d] ?? 0) * Number(d) * 100)) : ''}</span>
        </label>
      ))}
      <label className="gp-count-row">
        <span className="gp-count-face">Other</span><span aria-hidden />
        <input className="ui-input ui-input--num" inputMode="decimal" placeholder="0.00" aria-label="Other amount (paise, damaged notes kept aside)" value={counts.other ?? ''}
          onChange={(e) => onChange({ ...counts, other: e.target.value.replace(/[^\d.]/g, '') || undefined })} />
        <span />
      </label>
      <div className="gp-count-total"><span>Total</span><span className="ui-money">{money(rupees(total))}</span></div>
    </fieldset>
  );
}

const clean = (c: Counts): Counts => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== '' && v !== 0)) as Counts;

/** Shown in place of the bill while the till's register is closed and the store requires one. */
export function OpenRegister({ till, tills, onPickTill, onOpened }: { till: Till | null; tills: Till[]; onPickTill: (id: string) => void; onOpened: () => void }) {
  const [counts, setCounts] = useState<Counts>({});
  const [byNotes, setByNotes] = useState(true);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const counted = byNotes ? countTotal(counts) : paise(amount);
  const left = till?.lastKept ? paise(till.lastKept) : null;
  const differs = left !== null && counted !== left;

  const open = async () => {
    if (!till) return;
    setBusy(true); setError(''); setFields({});
    try {
      await api<Register>('/registers', { method: 'POST', body: { tillId: till.id, ...(byNotes ? { counts: clean(counts) } : { openingCash: amount || '0' }), ...(note.trim() ? { note: note.trim() } : {}) } });
      onOpened();
    } catch (e) { setError(errorText(e)); if (e instanceof ApiError) setFields(e.fieldErrors); if (e instanceof ApiError && e.code === 'REGISTER_OPEN') onOpened(); }
    finally { setBusy(false); }
  };

  return (
    <div className="ui-panel" style={{ maxWidth: 560 }}><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <div>
        <h2 className="ui-h3" style={{ margin: 0 }}>Open the register{till ? ` · ${till.name}` : ''}</h2>
        <p className="ui-muted" style={{ margin: 'var(--space-1) 0 0' }}>Count the cash in the drawer before the first bill. Every sale, refund and expense at this till is then added to it, so at closing you can see if the cash matches.</p>
      </div>
      {tills.length > 1 && (
        <label className="ui-field"><span className="ui-label">Till</span>
          <select className="ui-select" value={till?.id ?? ''} onChange={(e) => onPickTill(e.target.value)}>
            {tills.map((t) => <option key={t.id} value={t.id}>{t.name}{t.open ? ` · open (${t.open.openedBy})` : ''}</option>)}
          </select></label>
      )}
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      <div className="ui-segmented" role="group" aria-label="How to count">
        <button type="button" aria-pressed={byNotes} onClick={() => setByNotes(true)}>Count notes and coins</button>
        <button type="button" aria-pressed={!byNotes} onClick={() => setByNotes(false)}>Type the total</button>
      </div>
      {byNotes ? <CountGrid counts={counts} onChange={setCounts} label="Cash in the drawer now" /> : (
        <label className="ui-field" style={{ maxWidth: 220 }}><span className="ui-label">Cash in the drawer now</span>
          <input className="ui-input ui-input--num" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!fields.openingCash} />
          {fields.openingCash && <span className="ui-error">{fields.openingCash[0]}</span>}</label>
      )}
      {left !== null && <div className={differs ? 'ui-caption' : 'ui-help'} style={differs ? { fontWeight: 600, color: 'var(--text)' } : undefined}>
        The last closing left {money(rupees(left))} in the drawer.{differs ? ` You counted ${money(rupees(counted))}: say why.` : ''}</div>}
      {(differs || fields.note) && (
        <label className="ui-field"><span className="ui-label">Why is it different?</span>
          <input className="ui-input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. owner took ₹500 for the bank last night" aria-invalid={!!fields.note} />
          {fields.note && <span className="ui-error">{fields.note[0]}</span>}</label>
      )}
      <button className="ui-btn ui-btn--primary" type="button" style={{ height: 48 }} disabled={busy || !till || (differs && note.trim().length < 3)} aria-busy={busy} onClick={open}>
        Open with {money(rupees(counted))}
      </button>
    </div></div>
  );
}

type Tab = 'summary' | 'cash_in' | 'cash_out' | 'expense' | 'close';

/** The register's day so far, drawer movements, and closing. */
export function RegisterDialog({ sessionId, canManage, expenseLimits, onClosed, onClose }: {
  sessionId: string; canManage: boolean; expenseLimits: { each: string; day: string } | null; onClosed: () => void; onClose: () => void;
}) {
  const [r, setR] = useState<Register | null>(null);
  const [tab, setTab] = useState<Tab>('summary');
  const [error, setError] = useState('');
  const load = () => api<Register>(`/registers/${sessionId}`).then((x) => { setR(x.data); setError(''); }).catch((e) => setError(errorText(e)));
  useEffect(() => { load(); }, [sessionId]);
  const [waiting, setWaiting] = useState<Movement | null>(null);

  const t = r?.totals;
  return (
    <div className="ui-backdrop" role="presentation" onClick={onClose}>
      <div className="ui-dialog" role="dialog" aria-modal aria-labelledby="reg-title" onClick={(e) => e.stopPropagation()} style={{ width: 'min(640px, 100%)' }}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="reg-title">Register{r ? ` · ${r.till.name}` : ''}</h2>
          {r && <div className="ui-caption">Opened by {r.openedBy} at {fmtTime(r.openedAt)} with {money(r.openingCash)}{r.status === 'closed' ? ' · closed' : ''}</div>}</div>
        <div className="ui-dialog-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
          {!r || !t ? <div className="ui-skeleton" style={{ height: 200 }} /> : r.status === 'closed' ? <Closed r={r} /> : (
            <>
              <div className="ui-tabs" role="tablist">
                {([['summary', 'Summary'], ['cash_in', 'Add cash'], ...(canManage ? [['cash_out', 'Take cash out']] : []), ['expense', 'Expense'], ['close', 'Close register']] as [Tab, string][])
                  .map(([k, label]) => <button key={k} type="button" role="tab" className="ui-tab" aria-selected={tab === k} onClick={() => { setTab(k); load(); }}>{label}</button>)}
              </div>
              {tab === 'summary' && <Summary r={r} />}
              {(tab === 'cash_in' || tab === 'cash_out' || tab === 'expense') && !waiting && (
                <MovementForm key={tab} kind={tab} sessionId={sessionId} expected={t.expected} limits={tab === 'expense' ? expenseLimits : null}
                  onDone={(m) => { load(); if (m.status === 'pending') setWaiting(m); else setTab('summary'); }} />
              )}
              {waiting && <ExpenseWait m={waiting} onAnswered={() => { setWaiting(null); load(); setTab('summary'); }} />}
              {tab === 'close' && <CloseForm r={r} onClosed={(x) => { setR(x); onClosed(); }} />}
            </>
          )}
        </div>
        <div className="ui-dialog-foot">
          {canManage && <Link className="ui-btn" href={`/cash/registers/${sessionId}`} target="_blank">Full details</Link>}
          <button className="ui-btn" type="button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function Line({ label, value, strong, sign = '' }: { label: string; value: string; strong?: boolean; sign?: string }) {
  return <div className="gp-reg-line" data-strong={strong || undefined}><span>{label}</span><span className="ui-money">{sign}{money(value)}</span></div>;
}

function Summary({ r }: { r: Register }) {
  const t = r.totals;
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <div className="gp-reg-sum">
        <Line label="Cash at opening" value={t.opening} />
        <Line label="Cash sales" value={t.cashSales} sign="+ " />
        {Number(t.cashRefunds) > 0 && <Line label="Cash given back" value={t.cashRefunds} sign="− " />}
        {Number(t.cashIn) > 0 && <Line label="Cash added" value={t.cashIn} sign="+ " />}
        {Number(t.cashOut) > 0 && <Line label="Cash taken out" value={t.cashOut} sign="− " />}
        {Number(t.expenses) > 0 && <Line label="Expenses" value={t.expenses} sign="− " />}
        <Line label="Should be in the drawer" value={t.expected} strong />
      </div>
      {Number(t.pendingExpenses) > 0 && <div className="ui-caption">{money(t.pendingExpenses)} of expenses wait for approval and are not counted yet.</div>}
      <div>
        <div className="ui-label" style={{ marginBottom: 'var(--space-1)' }}>{t.bills} bill{t.bills === 1 ? '' : 's'} · {money(t.sales)}</div>
        {t.methods.length === 0 ? <div className="ui-muted">No payments yet.</div> : t.methods.map((m) => (
          <div key={m.name} className="gp-reg-line"><span>{m.name}{m.payments ? ` · ${m.payments}` : ''}</span>
            <span className="ui-money">{money(m.received)}{Number(m.refunded) > 0 ? ` (− ${money(m.refunded)} back)` : ''}</span></div>
        ))}
      </div>
      {r.movements.length > 0 && (
        <div>
          <div className="ui-label" style={{ marginBottom: 'var(--space-1)' }}>Drawer</div>
          {r.movements.map((m) => (
            <div key={m.id} className="gp-reg-line"><span>{fmtTime(m.recordedAt)} · {MOVEMENT_LABEL[m.kind]}: {m.category} · {m.reason}
              {m.status !== 'posted' && <span className={`ui-badge ui-badge--${MOVEMENT_STATUS[m.status].tone}`} style={{ marginLeft: 6 }}>{MOVEMENT_STATUS[m.status].label}</span>}</span>
              <span className="ui-money">{m.kind === 'cash_in' ? '+ ' : '− '}{money(m.amount)}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

function MovementForm({ kind, sessionId, expected, limits, onDone }: {
  kind: 'cash_in' | 'cash_out' | 'expense'; sessionId: string; expected: string; limits: { each: string; day: string } | null; onDone: (m: Movement) => void;
}) {
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<string>(CATEGORIES[kind][0]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError(''); setFields({});
    try { const { data } = await api<Movement>(`/registers/${sessionId}/movements`, { method: 'POST', body: { kind, amount, category, reason: reason.trim() } }); onDone(data); }
    catch (e) { setError(errorText(e)); if (e instanceof ApiError) setFields(e.fieldErrors); } finally { setBusy(false); }
  };
  const help = kind === 'cash_in' ? 'Cash put into the drawer: change brought from the bank, or the owner adding a float.'
    : kind === 'cash_out' ? `Cash taken out of the drawer: a bank deposit, or the owner taking cash. The drawer should hold ${money(expected)}.`
    : `Paid from the drawer: tea, auto fare, a small repair.${limits ? ` Above ${money(limits.each)} at once, or ${money(limits.day)} in a day, an owner or manager approves it.` : ''}`;
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <span className="ui-help">{help}</span>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <label className="ui-field" style={{ width: 140 }}><span className="ui-label">Amount</span>
          <input className="ui-input ui-input--num" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!fields.amount} />
          {fields.amount && <span className="ui-error">{fields.amount[0]}</span>}</label>
        <label className="ui-field" style={{ flex: '1 1 180px' }}><span className="ui-label">What for</span>
          <select className="ui-select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES[kind].map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
      </div>
      <label className="ui-field"><span className="ui-label">Details</span>
        <input className="ui-input" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === 'expense' ? 'e.g. tea for 4 staff' : kind === 'cash_in' ? 'e.g. ₹10 coins from the bank' : 'e.g. HDFC deposit slip 4471'}
          aria-invalid={!!fields.reason} onKeyDown={(e) => { if (e.key === 'Enter' && Number(amount) > 0 && reason.trim().length >= 3) save(); }} />
        {fields.reason && <span className="ui-error">{fields.reason[0]}</span>}</label>
      <button className="ui-btn ui-btn--primary" type="button" disabled={busy || !(Number(amount) > 0) || reason.trim().length < 3} aria-busy={busy} onClick={save}>
        {kind === 'cash_in' ? 'Add to the drawer' : kind === 'cash_out' ? 'Take out of the drawer' : 'Pay the expense'}{Number(amount) > 0 ? ` · ${money(amount)}` : ''}
      </button>
    </div>
  );
}

/** An expense above the cashier's limit: an owner or manager types their PIN here, or answers from Approvals. */
function ExpenseWait({ m, onAnswered }: { m: Movement; onAnswered: () => void }) {
  const [cur, setCur] = useState(m);
  const [approvers, setApprovers] = useState<Approver[]>([]);
  const [who, setWho] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const done = useRef(false);
  useEffect(() => {
    api<{ items: Approver[] }>('/pos/approvers').then((r) => { setApprovers(r.data.items); const f = r.data.items.find((a) => a.hasPin); if (f) setWho(f.id); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (cur.status !== 'pending') return;
    const t = setInterval(() => { api<Movement>(`/cash-movements/${m.id}`).then((r) => setCur(r.data)).catch(() => {}); }, POLL_MS);
    return () => clearInterval(t);
  }, [cur.status]);
  const withPin = async () => {
    setBusy(true); setError('');
    try { const { data } = await api<Movement>(`/cash-movements/${m.id}/pin`, { method: 'POST', body: { approverId: who, pin } }); setCur(data); }
    catch (e) { setError(errorText(e)); setPin(''); } finally { setBusy(false); }
  };
  const cancel = async () => {
    await api(`/cash-movements/${m.id}/cancel`, { method: 'POST', body: {} }).catch(() => {});
    if (!done.current) { done.current = true; onAnswered(); }
  };
  const finish = () => { if (!done.current) { done.current = true; onAnswered(); } };

  if (cur.status !== 'pending') {
    return (
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <div className={`ui-alert ui-alert--${cur.status === 'posted' ? 'success' : 'danger'}`} role="status"><div className="ui-alert-body">
          {cur.status === 'posted' ? `Approved by ${cur.decidedBy}: pay ${money(cur.amount)} from the drawer.`
            : cur.status === 'rejected' ? `Not approved${cur.decidedBy ? ` by ${cur.decidedBy}` : ''}${cur.note ? `: “${cur.note}”` : '.'} Don’t pay it from the drawer.`
            : 'Cancelled.'}
        </div></div>
        <button className="ui-btn ui-btn--primary" type="button" onClick={finish}>OK</button>
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <div className="ui-alert ui-alert--warning" role="status"><div className="ui-alert-body"><strong>{money(cur.amount)} · {cur.category}</strong>: {cur.needsApproval ?? m.needsApproval}. Don’t pay it until it is approved.</div></div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
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
      ) : <span className="ui-help">No owner or manager has set a PIN yet. They can approve from their phone.</span>}
      <div className="gp-appr-wait" role="status"><span className="gp-dot" aria-hidden /><span>Or wait: the owner or manager sees it under <strong>Approvals</strong>. This updates by itself.</span></div>
      <button className="ui-btn" type="button" style={{ justifySelf: 'start' }} onClick={cancel}>Cancel the expense</button>
    </div>
  );
}

function CloseForm({ r, onClosed }: { r: Register; onClosed: (x: Register) => void }) {
  const [counts, setCounts] = useState<Counts>({});
  const [byNotes, setByNotes] = useState(true);
  const [amount, setAmount] = useState('');
  const [kept, setKept] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const counted = byNotes ? countTotal(counts) : paise(amount);
  const touched = byNotes ? Object.values(counts).some((v) => v !== undefined) : amount !== '';
  const diff = counted - paise(r.totals.expected);
  const keptP = paise(kept);
  const close = async () => {
    setBusy(true); setError(''); setFields({});
    try {
      const { data } = await api<Register>(`/registers/${r.id}/close`, { method: 'POST', body: {
        ...(byNotes ? { counts: clean(counts) } : { countedCash: amount || '0' }), keptCash: kept || '0', ...(note.trim() ? { note: note.trim() } : {}) } });
      onClosed(data);
    } catch (e) { setError(errorText(e)); if (e instanceof ApiError) setFields(e.fieldErrors); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      <div className="ui-segmented" role="group" aria-label="How to count">
        <button type="button" aria-pressed={byNotes} onClick={() => setByNotes(true)}>Count notes and coins</button>
        <button type="button" aria-pressed={!byNotes} onClick={() => setByNotes(false)}>Type the total</button>
      </div>
      {byNotes ? <CountGrid counts={counts} onChange={setCounts} label="Cash in the drawer now" /> : (
        <label className="ui-field" style={{ maxWidth: 220 }}><span className="ui-label">Cash in the drawer now</span>
          <input className="ui-input ui-input--num" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      )}
      {touched && (
        <div className={`ui-alert ui-alert--${diff === 0 ? 'success' : 'warning'}`} role="status"><div className="ui-alert-body">
          Should be {money(r.totals.expected)}, counted {money(rupees(counted))}: {diff === 0 ? 'the cash matches.' : <strong>{diff < 0 ? 'short' : 'over'} by {money(rupees(Math.abs(diff)))}</strong>}
        </div></div>
      )}
      {touched && diff !== 0 && (
        <label className="ui-field"><span className="ui-label">Why is it {diff < 0 ? 'short' : 'over'}?</span>
          <input className="ui-input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. gave ₹100 too much change on a bill" aria-invalid={!!fields.note} />
          {fields.note && <span className="ui-error">{fields.note[0]}</span>}</label>
      )}
      <label className="ui-field" style={{ maxWidth: 260 }}><span className="ui-label">Leave in the drawer for the next shift</span>
        <input className="ui-input ui-input--num" inputMode="decimal" value={kept} onChange={(e) => setKept(e.target.value)} placeholder="e.g. 2000" aria-invalid={!!fields.keptCash} />
        {fields.keptCash ? <span className="ui-error">{fields.keptCash[0]}</span>
          : touched && <span className="ui-help">{keptP > counted ? `More than the ${money(rupees(counted))} counted` : `Take out ${money(rupees(counted - keptP))} (to the owner or the bank).`}</span>}</label>
      <button className="ui-btn ui-btn--primary" type="button" style={{ height: 48 }} disabled={busy || !touched || keptP > counted || (diff !== 0 && note.trim().length < 3)} aria-busy={busy} onClick={close}>
        Close the register
      </button>
      <span className="ui-help">The owner gets the day’s totals in the app and by e-mail. Expenses still waiting for approval are not paid.</span>
    </div>
  );
}

function Closed({ r }: { r: Register }) {
  const diff = Number(r.difference ?? 0);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <div className={`ui-alert ui-alert--${diff === 0 ? 'success' : 'warning'}`} role="status"><div className="ui-alert-body">
        <strong>Closed.</strong> Should be {money(r.expectedCash)}, counted {money(r.countedCash)}: {diff === 0 ? 'the cash matched.' : `${diff < 0 ? 'short' : 'over'} by ${money((r.difference ?? '0').replace('-', ''))}.`}
        {' '}Leave {money(r.keptCash)} in the drawer{paise(r.countedCash ?? '0') > paise(r.keptCash ?? '0') ? ` and take out ${money(rupees(paise(r.countedCash ?? '0') - paise(r.keptCash ?? '0')))}` : ''}.
      </div></div>
      <Summary r={r} />
    </div>
  );
}
