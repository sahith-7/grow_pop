'use client';

import { useState } from 'react';
import { todayIST } from '../../../../../lib/datetime';
import { ApiError, errorText, type StateOption } from '../../../../../lib/outlets-api';

// Add or edit an outlet (v2, D101). The main outlet is never edited here: its address and GSTIN live in Settings.

export interface OutletValues {
  name: string; address: string; city: string; stateCode: string; postalCode: string; phone: string; gstin: string;
  invoicePrefix: string; creditNotePrefix: string; backRoom: boolean;
}
export const EMPTY: OutletValues = { name: '', address: '', city: '', stateCode: '', postalCode: '', phone: '', gstin: '', invoicePrefix: '', creditNotePrefix: '', backRoom: true };

/** "26-27" for the financial year today is in (April to March). */
function fyShort() {
  const [y, m] = todayIST().split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** A prefix from the outlet's name: "KPHB Colony" → KPHB. */
const suggest = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);

export function OutletForm({ initial, states, mainState, isNew, submitLabel, onSubmit, onCancel }: {
  initial: OutletValues; states: StateOption[]; mainState: string | null; isNew: boolean; submitLabel: string;
  onSubmit: (v: OutletValues) => Promise<void>; onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const [touched, setTouched] = useState({ inv: !isNew, cn: !isNew });
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof OutletValues>(k: K, val: OutletValues[K]) => setV((x) => ({ ...x, [k]: val }));
  const err = (k: string) => errors[k]?.[0];
  const otherState = !!v.stateCode && !!mainState && v.stateCode !== mainState;
  const fy = fyShort();

  const onName = (name: string) => setV((x) => ({
    ...x, name,
    invoicePrefix: touched.inv ? x.invoicePrefix : suggest(name),
    creditNotePrefix: touched.cn ? x.creditNotePrefix : (suggest(name) ? `${suggest(name).slice(0, 4)}CN` : ''),
  }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(''); setErrors({});
    try { await onSubmit(v); } catch (x) {
      setError(errorText(x));
      if (x instanceof ApiError) setErrors(x.fieldErrors);
    } finally { setBusy(false); }
  };

  const field = (k: keyof OutletValues, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, help?: React.ReactNode) => (
    <label className="ui-field"><span className="ui-label">{label}</span>
      <input className="ui-input" value={v[k] as string} onChange={(e) => (k === 'name' ? onName(e.target.value) : set(k, e.target.value as never))}
        aria-invalid={!!err(k)} {...props} />
      {err(k) ? <span className="ui-error">{err(k)}</span> : help ? <span className="ui-help">{help}</span> : null}</label>
  );

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 'var(--space-4)' }} noValidate>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      <div className="ui-form-grid">
        {field('name', 'Outlet name', { required: true, maxLength: 60, placeholder: 'e.g. KPHB Colony', autoFocus: isNew })}
        {field('phone', 'Phone (optional)', { inputMode: 'tel', maxLength: 20 }, 'Printed on this outlet’s bills')}
      </div>
      {field('address', 'Address', { required: true, maxLength: 300, placeholder: 'Shop number, street, area' }, 'Printed on this outlet’s bills')}
      <div className="ui-form-grid">
        {field('city', 'City', { maxLength: 80 })}
        <label className="ui-field"><span className="ui-label">State</span>
          <select className="ui-select" value={v.stateCode} required onChange={(e) => set('stateCode', e.target.value)} aria-invalid={!!err('stateCode')}>
            <option value="">Choose…</option>{states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
          {err('stateCode') && <span className="ui-error">{err('stateCode')}</span>}</label>
        {field('postalCode', 'PIN code', { inputMode: 'numeric', maxLength: 6 })}
      </div>
      {field('gstin', otherState ? 'GSTIN for this state' : 'GSTIN (only if it has its own)', { maxLength: 15, style: { textTransform: 'uppercase' } },
        otherState
          ? 'This outlet is in another state, so it needs its own GST registration (same PAN). You can add it later, but bills can’t be made here until you do.'
          : 'Leave empty to use the store’s GSTIN. Outlets in the same state usually share it.')}
      <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }}>
        <legend className="ui-label" style={{ marginBottom: 'var(--space-2)' }}>Bill numbers</legend>
        <div className="ui-form-grid">
          <label className="ui-field"><span className="ui-label">Invoice prefix</span>
            <input className="ui-input" value={v.invoicePrefix} maxLength={6} required aria-invalid={!!err('invoicePrefix')} style={{ textTransform: 'uppercase' }}
              onChange={(e) => { setTouched((t) => ({ ...t, inv: true })); set('invoicePrefix', e.target.value.toUpperCase()); }} />
            {err('invoicePrefix') ? <span className="ui-error">{err('invoicePrefix')}</span> : <span className="ui-help">First bill: <span className="ui-code">{v.invoicePrefix || '…'}/{fy}/1</span></span>}</label>
          <label className="ui-field"><span className="ui-label">Credit note prefix</span>
            <input className="ui-input" value={v.creditNotePrefix} maxLength={6} required aria-invalid={!!err('creditNotePrefix')} style={{ textTransform: 'uppercase' }}
              onChange={(e) => { setTouched((t) => ({ ...t, cn: true })); set('creditNotePrefix', e.target.value.toUpperCase()); }} />
            {err('creditNotePrefix') ? <span className="ui-error">{err('creditNotePrefix')}</span> : <span className="ui-help">First credit note: <span className="ui-code">{v.creditNotePrefix || '…'}/{fy}/1</span></span>}</label>
        </div>
        <span className="ui-help">Each outlet numbers its own bills, so the prefix must differ from every other outlet’s. {isNew ? '' : 'A new prefix applies from the next financial year if this outlet has already billed this year.'}</span>
      </fieldset>
      {isNew && <label className="ui-check"><input type="checkbox" checked={v.backRoom} onChange={(e) => set('backRoom', e.target.checked)} /> Also make a back room (godown) for this outlet’s stock. A shop floor is always made.</label>}
      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button className="ui-btn" type="button" onClick={onCancel}>Cancel</button>
        <button className="ui-btn ui-btn--primary" type="submit" disabled={busy || !v.name.trim() || !v.address.trim() || !v.stateCode || !v.invoicePrefix || !v.creditNotePrefix} aria-busy={busy}>{submitLabel}</button>
      </div>
    </form>
  );
}

/** What the API takes from the form: empty optional fields left out on create, cleared (null) on edit. */
export function toBody(v: OutletValues, isNew: boolean) {
  const opt = (x: string) => (x.trim() ? x.trim() : isNew ? undefined : null);
  return {
    name: v.name.trim(), address: v.address.trim(), city: isNew ? v.city.trim() || undefined : v.city.trim() || null, stateCode: v.stateCode,
    postalCode: opt(v.postalCode), phone: opt(v.phone), gstin: opt(v.gstin.toUpperCase()),
    invoicePrefix: v.invoicePrefix.trim(), creditNotePrefix: v.creditNotePrefix.trim(), ...(isNew ? { backRoom: v.backRoom } : {}),
  };
}
