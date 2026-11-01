'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, api, errorText, fieldError, type Location, type StockMeta } from '../../../../lib/stock-api';

const TYPE_LABEL: Record<Location['type'], string> = { shop_floor: 'Shop floor', back_room: 'Back room', quarantine: 'Quarantine (damaged, never sold)' };

export default function LocationsPage() {
  const [meta, setMeta] = useState<StockMeta | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<Location['type']>('back_room');
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const load = () => api<StockMeta>('/stock/meta').then((r) => setMeta(r.data)).catch((e) => setError(errorText(e)));
  useEffect(() => { load(); }, []);

  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(''); setErrors({});
    try { await fn(); await load(); return true; } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      return false;
    } finally { setBusy(false); }
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await call(() => api('/locations', { method: 'POST', body: { name: name.trim(), type } }))) setName('');
  };
  const patch = (id: string, body: Partial<Pick<Location, 'name' | 'isSellable' | 'active'>>) => call(() => api(`/locations/${id}`, { method: 'PATCH', body }));

  if (meta && !meta.can.manageLocations) return <div className="ui-content"><div className="ui-alert ui-alert--warning"><div className="ui-alert-body">Only the owner can change locations.</div></div></div>;

  return (
    <div className="ui-content">
      <div className="ui-page-header"><div><Link className="ui-caption" href="/stock">Stock /</Link><h1 className="ui-h1">Locations</h1></div></div>
      <p className="ui-muted">Places inside your shop where stock sits. Only stock at sellable locations counts as available to sell.</p>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

      <div className="ui-panel">
        {!meta ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 120 }} /></div> : (
          <div className="ui-table-wrap"><table className="ui-table">
            <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Sellable</th><th scope="col">Status</th><th scope="col"><span className="ui-sr-only">Actions</span></th></tr></thead>
            <tbody>{meta.locations.map((l) => (
              <tr key={l.id}>
                <td>
                  {editing?.id === l.id ? (
                    <form style={{ display: 'flex', gap: 'var(--space-2)' }} onSubmit={async (e) => { e.preventDefault(); if (await patch(l.id, { name: editing.name.trim() })) setEditing(null); }}>
                      <input className="ui-input" value={editing.name} maxLength={60} aria-label="Location name" autoFocus onChange={(e) => setEditing({ id: l.id, name: e.target.value })} />
                      <button className="ui-btn ui-btn--sm ui-btn--primary" type="submit" disabled={busy || !editing.name.trim()}>Save</button>
                      <button className="ui-btn ui-btn--sm" type="button" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  ) : <span className="ui-cell-title">{l.name}</span>}
                </td>
                <td className="ui-cell-sub">{TYPE_LABEL[l.type]}</td>
                <td>
                  {l.type === 'quarantine' ? <span className="ui-muted">Never</span> : (
                    <label className="ui-check"><input type="checkbox" checked={l.isSellable} disabled={busy} onChange={(e) => patch(l.id, { isSellable: e.target.checked })} />{l.isSellable ? 'Yes' : 'No'}</label>
                  )}
                </td>
                <td>{l.active ? <span className="ui-badge ui-badge--success">Active</span> : <span className="ui-badge">Inactive</span>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => setEditing({ id: l.id, name: l.name })}>Rename</button>
                  <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" disabled={busy} onClick={() => patch(l.id, { active: !l.active })}>{l.active ? 'Deactivate' : 'Reactivate'}</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      <form className="ui-panel" onSubmit={add}>
        <div className="ui-panel-head"><span className="ui-h3">Add a location</span></div>
        <div className="ui-panel-body ui-form-grid">
          <label className="ui-field"><span className="ui-label">Name</span>
            <input className="ui-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Godown" aria-invalid={!!fieldError(errors, 'name')} />
            {fieldError(errors, 'name') && <span className="ui-error">{fieldError(errors, 'name')}</span>}
          </label>
          <label className="ui-field"><span className="ui-label">Type</span>
            <select className="ui-select" value={type} onChange={(e) => setType(e.target.value as Location['type'])}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        </div>
        <div className="ui-form-footer"><button className="ui-btn ui-btn--primary" type="submit" disabled={busy || !name.trim()}>Add location</button></div>
      </form>
    </div>
  );
}
