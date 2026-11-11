'use client';

import { useState } from 'react';
import { fmtDateTime } from '../../../../lib/datetime';
import { money } from '../../../../lib/format';
import { ApiError, api, errorText, type Till } from '../../../../lib/cash-api';
import { CashTabs, useTills } from '../_components/cash-ui';

// Tills (v2 phase 3, D110): the counters at each outlet, each with its own drawer. Every outlet starts with "Counter 1".
// A till with an open register can't be switched off.

export default function TillsPage() {
  const { tills, outlets, error: loadError, reload } = useTills();
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<{ outletId: string; name: string } | null>(null);
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(''); setFields({});
    try { await fn(); await reload(); return true; } catch (e) { setError(errorText(e)); if (e instanceof ApiError) setFields(e.fieldErrors); return false; }
  };
  const add = () => adding && run(() => api('/tills', { method: 'POST', body: { outletId: adding.outletId, name: adding.name.trim() } })).then((ok) => ok && setAdding(null));
  const rename = () => editing && run(() => api(`/tills/${editing.id}`, { method: 'PATCH', body: { name: editing.name.trim() } })).then((ok) => ok && setEditing(null));
  const toggle = (t: Till) => run(() => api(`/tills/${t.id}`, { method: 'PATCH', body: { active: !t.active } }));

  return (
    <div className="ui-content">
      <div className="ui-page-header"><div><h1 className="ui-h1">Tills</h1><div className="ui-caption">Each till is one cash drawer at a counter. Add one for every drawer you count separately.</div></div></div>
      <CashTabs />
      {(error || loadError) && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error || loadError}</div></div>}
      {!tills || !outlets ? <div className="ui-skeleton" style={{ height: 200 }} /> : outlets.map((o) => (
        <div key={o.id} className="ui-panel" style={{ marginBottom: 'var(--space-4)' }}>
          <div className="ui-panel-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)' }}>
            <h2 className="ui-h3">{o.name}</h2>
            <button className="ui-btn ui-btn--sm" type="button" onClick={() => { setAdding({ outletId: o.id, name: '' }); setFields({}); }}>Add till</button>
          </div>
          {tills.filter((t) => t.outletId === o.id).map((t) => (
            <div key={t.id} className="gp-method-row">
              <div>
                {editing?.id === t.id ? (
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <input className="ui-input" style={{ maxWidth: 240 }} autoFocus maxLength={40} value={editing.name} aria-label="Till name" aria-invalid={!!fields.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setEditing(null); }} />
                    <button className="ui-btn ui-btn--sm ui-btn--primary" type="button" disabled={!editing.name.trim()} onClick={rename}>Save</button>
                    <button className="ui-btn ui-btn--sm" type="button" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                ) : <div className="ui-cell-title">{t.name}{!t.active && <span className="ui-badge" style={{ marginLeft: 8 }}>Off</span>}</div>}
                <div className="ui-cell-sub">{t.open ? `Open since ${fmtDateTime(t.open.openedAt)} (${t.open.openedBy})` : t.lastKept !== null ? `Closed · ${money(t.lastKept)} left in the drawer` : 'Not used yet'}</div>
              </div>
              <div className="ui-actions" style={{ display: 'flex', gap: 'var(--space-2)' }}>
                {editing?.id !== t.id && <button className="ui-btn ui-btn--sm" type="button" onClick={() => setEditing({ id: t.id, name: t.name })}>Rename</button>}
                <button className="ui-btn ui-btn--sm" type="button" disabled={!!t.open && t.active} title={t.open && t.active ? 'Close its register first' : undefined} onClick={() => toggle(t)}>{t.active ? 'Switch off' : 'Switch on'}</button>
              </div>
            </div>
          ))}
          {adding?.outletId === o.id && (
            <div className="ui-panel-body" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label className="ui-field" style={{ flex: '1 1 200px', maxWidth: 280 }}><span className="ui-label">New till’s name</span>
                <input className="ui-input" autoFocus maxLength={40} placeholder="e.g. Counter 2" value={adding.name} aria-invalid={!!fields.name}
                  onChange={(e) => setAdding({ ...adding, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && adding.name.trim()) add(); }} />
                {fields.name && <span className="ui-error">{fields.name[0]}</span>}</label>
              <button className="ui-btn ui-btn--primary" type="button" disabled={!adding.name.trim()} onClick={add}>Add</button>
              <button className="ui-btn" type="button" onClick={() => setAdding(null)}>Cancel</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
