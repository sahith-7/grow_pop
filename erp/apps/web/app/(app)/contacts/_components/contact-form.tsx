'use client';

import { useState } from 'react';
import { api, ApiError, errorText, type Contact, type ContactType, type State } from '../../../../lib/contacts-api';

// Add or edit a customer or a supplier. Saves through the same endpoints the POS and Purchasing use, so the same rules
// apply: a phone number belongs to one customer, a GSTIN must be valid and decides the state.

const blank = { name: '', phone: '', email: '', gstin: '', stateCode: '', address: '' };
type Form = typeof blank;

export function ContactForm({ type, contact, states, onClose, onSaved }: {
  type: ContactType; contact: Contact | null; states: State[]; onClose: () => void; onSaved: (id: string) => void;
}) {
  const [f, setF] = useState<Form>(contact
    ? { name: contact.name, phone: contact.phone ?? '', email: contact.email ?? '', gstin: contact.gstin ?? '', stateCode: contact.stateCode ?? '', address: contact.address ?? '' }
    : blank);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const noun = type === 'customer' ? 'customer' : 'supplier';

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setErrors({});
    const trimmed = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim()]));
    // New: leave empty fields out. Edit: an emptied field is cleared (null).
    const body = contact
      ? Object.fromEntries(Object.entries(trimmed).map(([k, v]) => [k, k === 'name' ? v : v || null]))
      : Object.fromEntries(Object.entries(trimmed).filter(([k, v]) => k === 'name' || v));
    if (body.gstin) delete body.stateCode; // the GSTIN's first two digits are the state
    try {
      const path = `/${type === 'customer' ? 'customers' : 'suppliers'}${contact ? `/${contact.id}` : ''}`;
      const { data } = await api<{ id: string }>(path, { method: contact ? 'PATCH' : 'POST', body });
      onSaved(data.id);
    } catch (err) {
      setError(errorText(err));
      if (err instanceof ApiError) setErrors(err.fieldErrors);
    } finally { setBusy(false); }
  };
  const field = (k: keyof Form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="ui-field"><span className="ui-label">{label}</span>
      <input className="ui-input" value={f[k]} aria-invalid={!!errors[k]} {...props} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
      {errors[k] && <span className="ui-error">{errors[k][0]}</span>}
    </label>
  );

  return (
    <div className="ui-backdrop" role="presentation" onClick={onClose}>
      <form className="ui-dialog" role="dialog" aria-modal aria-labelledby="contact-title" onSubmit={save} onClick={(e) => e.stopPropagation()}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="contact-title">{contact ? `Edit ${noun}` : `Add ${noun}`}</h2></div>
        <div className="ui-dialog-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
          {field('name', 'Name', { required: true, maxLength: type === 'customer' ? 200 : 120, autoFocus: true })}
          {field('phone', 'Phone', { maxLength: 16, inputMode: 'tel', placeholder: '9876543210' })}
          {field('email', 'Email', { maxLength: 200, type: 'email' })}
          {field('gstin', type === 'customer' ? 'GSTIN (business customers)' : 'GSTIN', { maxLength: 15, style: { textTransform: 'uppercase' } })}
          {!f.gstin.trim() && (
            <label className="ui-field"><span className="ui-label">State</span>
              <select className="ui-select" value={f.stateCode} onChange={(e) => setF({ ...f, stateCode: e.target.value })}>
                <option value="">—</option>{states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
              </select>
              {errors.stateCode && <span className="ui-error">{errors.stateCode[0]}</span>}
            </label>
          )}
          {field('address', 'Address', { maxLength: 500 })}
          {type === 'customer' && <span className="ui-help">Keep only what bills need. Customers can ask to see or remove their details.</span>}
        </div>
        <div className="ui-dialog-foot">
          <button className="ui-btn" type="button" onClick={onClose}>Cancel</button>
          <button className="ui-btn ui-btn--primary" type="submit" disabled={busy || !f.name.trim()} aria-busy={busy}>Save</button>
        </div>
      </form>
    </div>
  );
}
