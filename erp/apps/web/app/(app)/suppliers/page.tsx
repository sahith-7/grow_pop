'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, api, errorText, fieldError, type Supplier } from '../../../lib/stock-api';

const EMPTY = { name: '', phone: '', email: '', gstin: '', address: '' };
type Form = typeof EMPTY;

export default function SuppliersPage() {
  const [items, setItems] = useState<Supplier[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const qs = new URLSearchParams({ limit: '100' });
    if (q.trim()) qs.set('q', q.trim());
    if (showArchived) qs.set('includeArchived', 'true');
    try { setItems((await api<{ items: Supplier[] }>(`/suppliers?${qs}`)).data.items); } catch (e) { setError(errorText(e)); setItems([]); }
  };
  useEffect(() => { load(); }, [showArchived]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setBusy(true); setError(''); setErrors({});
    const body = Object.fromEntries(Object.entries(editing.form).map(([k, v]) => [k, v.trim()]));
    try {
      await api(editing.id ? `/suppliers/${editing.id}` : '/suppliers', { method: editing.id ? 'PATCH' : 'POST', body });
      setEditing(null); await load();
    } catch (err) {
      setError(errorText(err));
      if (err instanceof ApiError) setErrors(err.fieldErrors);
    } finally { setBusy(false); }
  };
  const archive = async (s: Supplier) => {
    setError('');
    try { await api(`/suppliers/${s.id}`, { method: 'PATCH', body: { archived: !s.archived } }); await load(); } catch (e) { setError(errorText(e)); }
  };
  const field = (k: keyof Form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="ui-field"><span className="ui-label">{label}</span>
      <input className="ui-input" value={editing!.form[k]} aria-invalid={!!fieldError(errors, k)} {...props}
        onChange={(e) => setEditing({ ...editing!, form: { ...editing!.form, [k]: e.target.value } })} />
      {fieldError(errors, k) && <span className="ui-error">{fieldError(errors, k)}</span>}
    </label>
  );

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div><Link className="ui-caption" href="/purchasing">Purchasing /</Link><h1 className="ui-h1">Suppliers</h1></div>
        <div className="ui-actions"><button className="ui-btn ui-btn--primary" type="button" onClick={() => { setErrors({}); setEditing({ id: null, form: EMPTY }); }}>Add supplier</button></div>
      </div>
      {error && !editing && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

      <div className="ui-panel">
        <form className="ui-toolbar" role="search" onSubmit={(e) => { e.preventDefault(); load(); }}>
          <input className="ui-input ui-search" placeholder="Search suppliers" aria-label="Search suppliers" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="ui-chip" type="button" aria-pressed={showArchived} onClick={() => setShowArchived(!showArchived)}>Show archived</button>
        </form>
        {items === null ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 120 }} /></div>
          : items.length === 0 ? <div className="ui-empty"><p className="ui-h3">No suppliers yet</p><p className="ui-muted">Add the people you buy stock from.</p></div>
          : (
            <div className="ui-table-wrap"><table className="ui-table" data-collapse>
              <thead><tr><th scope="col">Name</th><th scope="col">Phone</th><th scope="col">GSTIN</th><th scope="col">State</th><th scope="col"><span className="ui-sr-only">Actions</span></th></tr></thead>
              <tbody>{items.map((s) => (
                <tr key={s.id}>
                  <td data-primary><span className="ui-cell-title">{s.name}</span>{s.archived && <span className="ui-badge" style={{ marginLeft: 6 }}>archived</span>}{s.email && <div className="ui-cell-sub">{s.email}</div>}</td>
                  <td data-label="Phone">{s.phone ?? <span className="ui-muted">—</span>}</td>
                  <td data-label="GSTIN" className="ui-code">{s.gstin ?? <span className="ui-muted">—</span>}</td>
                  <td data-label="State">{s.stateCode ?? <span className="ui-muted">—</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => { setErrors({}); setError(''); setEditing({ id: s.id, form: { name: s.name, phone: s.phone ?? '', email: s.email ?? '', gstin: s.gstin ?? '', address: s.address ?? '' } }); }}>Edit</button>
                    <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => archive(s)}>{s.archived ? 'Restore' : 'Archive'}</button>
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
      </div>

      {editing && (
        <div className="ui-backdrop" role="presentation" onClick={() => setEditing(null)}>
          <form className="ui-dialog" role="dialog" aria-modal aria-labelledby="sup-title" onSubmit={save} onClick={(e) => e.stopPropagation()}>
            <div className="ui-dialog-head"><h2 className="ui-h3" id="sup-title">{editing.id ? 'Edit supplier' : 'Add supplier'}</h2></div>
            <div className="ui-dialog-body">
              {field('name', 'Name', { required: true, maxLength: 120, autoFocus: true })}
              {field('phone', 'Phone', { maxLength: 20, inputMode: 'tel' })}
              {field('email', 'Email', { maxLength: 200, type: 'email' })}
              {field('gstin', 'GSTIN', { maxLength: 15, placeholder: 'Optional. The state is taken from it', style: { textTransform: 'uppercase' } })}
              {field('address', 'Address', { maxLength: 500 })}
              {error && <div className="ui-error" role="alert">{error}</div>}
            </div>
            <div className="ui-dialog-foot">
              <button className="ui-btn" type="button" onClick={() => setEditing(null)}>Cancel</button>
              <button className="ui-btn ui-btn--primary" type="submit" disabled={busy || !editing.form.name.trim()} aria-busy={busy}>Save</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
