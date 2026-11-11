'use client';

import { useEffect, useState } from 'react';
import { ApiError, api, errorText, KIND_LABEL, type PaymentMethod } from '../../../../lib/cash-api';
import { CashTabs } from '../_components/cash-ui';

// Payment methods (v2 phase 3, D109): what the counter takes. Cash, UPI, Card and Other come with every store; add your
// own ("Paytm machine 2"), rename them, switch one off for the whole store or at some outlets. A method switched off
// leaves the counter at once. Only cash counts in the drawer.

interface Data { items: PaymentMethod[]; outlets: { id: string; name: string }[] }

export default function MethodsPage() {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [adding, setAdding] = useState<{ name: string; kind: 'upi' | 'card' | 'other' } | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const load = () => api<Data>('/payment-methods').then((r) => setD(r.data)).catch((e) => setError(errorText(e)));
  useEffect(() => { load(); }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError(''); setFields({});
    try { await fn(); await load(); return true; } catch (e) { setError(errorText(e)); if (e instanceof ApiError) setFields(e.fieldErrors); return false; }
  };
  const patch = (id: string, body: Record<string, unknown>) => run(() => api(`/payment-methods/${id}`, { method: 'PATCH', body }));
  const add = () => adding && run(() => api('/payment-methods', { method: 'POST', body: { name: adding.name.trim(), kind: adding.kind } })).then((ok) => ok && setAdding(null));
  const move = (i: number, by: number) => {
    if (!d) return;
    const a = d.items[i], b = d.items[i + by];
    if (!b) return;
    run(async () => {
      await api(`/payment-methods/${a.id}`, { method: 'PATCH', body: { position: b.position } });
      await api(`/payment-methods/${b.id}`, { method: 'PATCH', body: { position: a.position === b.position ? a.position + by : a.position } });
    });
  };

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div><h1 className="ui-h1">Payment methods</h1><div className="ui-caption">What the counter takes, in this order. Switch one off for the whole store, or only at an outlet where the machine is broken.</div></div>
        <div className="ui-actions"><button className="ui-btn ui-btn--primary" type="button" onClick={() => { setAdding({ name: '', kind: 'upi' }); setFields({}); }}>Add method</button></div>
      </div>
      <CashTabs />
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      {adding && (
        <div className="ui-panel" style={{ marginBottom: 'var(--space-4)' }}><div className="ui-panel-body" style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="ui-field" style={{ flex: '1 1 220px' }}><span className="ui-label">Name on the counter</span>
            <input className="ui-input" autoFocus maxLength={40} placeholder="e.g. Paytm machine 2" value={adding.name} aria-invalid={!!fields.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
            {fields.name && <span className="ui-error">{fields.name[0]}</span>}</label>
          <label className="ui-field" style={{ width: 160 }}><span className="ui-label">It takes</span>
            <select className="ui-select" value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value as 'upi' })}>
              <option value="upi">UPI</option><option value="card">Cards</option><option value="other">Other</option></select></label>
          <button className="ui-btn ui-btn--primary" type="button" disabled={!adding.name.trim()} onClick={add}>Add</button>
          <button className="ui-btn" type="button" onClick={() => setAdding(null)}>Cancel</button>
          <span className="ui-help" style={{ flexBasis: '100%' }}>Reports add up takings by these kinds. Cash has one method: the drawer.</span>
        </div></div>
      )}
      {!d ? <div className="ui-skeleton" style={{ height: 240 }} /> : (
        <div className="ui-panel">{d.items.map((m, i) => (
          <div key={m.id} className="gp-method-row" style={{ alignItems: 'start' }}>
            <div>
              {editing?.id === m.id ? (
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <input className="ui-input" style={{ maxWidth: 240 }} autoFocus maxLength={40} value={editing.name} aria-label="Method name"
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') patch(m.id, { name: editing.name.trim() }).then((ok) => ok && setEditing(null)); if (e.key === 'Escape') setEditing(null); }} />
                  <button className="ui-btn ui-btn--sm ui-btn--primary" type="button" disabled={!editing.name.trim()} onClick={() => patch(m.id, { name: editing.name.trim() }).then((ok) => ok && setEditing(null))}>Save</button>
                  <button className="ui-btn ui-btn--sm" type="button" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              ) : (
                <div className="ui-cell-title">{m.name} <span className="ui-badge" style={{ marginLeft: 6 }}>{KIND_LABEL[m.kind]}</span>{!m.active && <span className="ui-badge ui-badge--warning" style={{ marginLeft: 6 }}>Off everywhere</span>}</div>
              )}
              {m.active && d.outlets.length > 1 && (
                <div className="gp-offat" role="group" aria-label={`Outlets where ${m.name} is on`}>
                  {d.outlets.map((o) => {
                    const on = !m.offAt.includes(o.id);
                    return (
                      <label key={o.id} className="ui-check"><input type="checkbox" checked={on}
                        onChange={() => patch(m.id, { offAt: on ? [...m.offAt, o.id] : m.offAt.filter((x) => x !== o.id) })} /> {o.name}</label>
                    );
                  })}
                </div>
              )}
              {m.active && d.outlets.length === 1 && m.offAt.length > 0 && <div className="ui-cell-sub">Off at {d.outlets[0].name}</div>}
            </div>
            <div className="ui-actions" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button className="ui-btn ui-btn--sm" type="button" aria-label={`Move ${m.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button className="ui-btn ui-btn--sm" type="button" aria-label={`Move ${m.name} down`} disabled={i === d.items.length - 1} onClick={() => move(i, 1)}>↓</button>
              {editing?.id !== m.id && <button className="ui-btn ui-btn--sm" type="button" onClick={() => setEditing({ id: m.id, name: m.name })}>Rename</button>}
              <button className="ui-btn ui-btn--sm" type="button" onClick={() => patch(m.id, { active: !m.active })}>{m.active ? 'Switch off' : 'Switch on'}</button>
            </div>
          </div>
        ))}</div>
      )}
    </div>
  );
}
