'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { fmtDate } from '../../../../../lib/datetime';
import { money } from '../../../../../lib/format';
import { api, errorText, ROLE_LABEL, ROOM_LABEL, type OutletDetail } from '../../../../../lib/outlets-api';
import { OutletForm, toBody, type OutletValues } from '../_components/outlet-form';

// One outlet (v2, D101): today's bills, its details and bill numbers, its stock rooms and who sells there.

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="ui-panel ui-kpi"><span className="ui-caption">{label}</span><span className="ui-kpi-value" style={{ fontSize: 'var(--text-xl)' }}>{value}</span>{sub && <span className="ui-caption">{sub}</span>}</div>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 200px) 1fr', gap: 'var(--space-3)', padding: 'var(--space-2) 0', borderBottom: '1px solid var(--border)' }}>
    <span className="ui-muted">{label}</span><span>{children}</span></div>;
}

function Staff({ d, onSaved }: { d: OutletDetail; onSaved: (d: OutletDetail) => void }) {
  const people = d.staff ?? [];
  const pickable = people.filter((p) => p.role !== 'owner' && p.role !== 'manager');
  const [chosen, setChosen] = useState(() => new Set(pickable.filter((p) => p.assigned).map((p) => p.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = pickable.some((p) => p.assigned !== chosen.has(p.id));
  const save = async () => {
    setBusy(true); setError('');
    try { const { data } = await api<OutletDetail>(`/outlets/${d.outlet.id}/staff`, { method: 'PUT', body: { userIds: [...chosen] } }); onSaved(data); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <section className="ui-panel" aria-labelledby="staff-title">
      <div className="ui-panel-head" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <h2 className="ui-h3" id="staff-title" style={{ flex: 1, margin: 0 }}>Who sells here</h2>
        {d.can.staff && pickable.length > 0 && <button className="ui-btn ui-btn--sm" type="button" disabled={!dirty || busy} aria-busy={busy} onClick={save}>{dirty ? 'Save' : 'Saved'}</button>}
      </div>
      <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <p className="ui-help" style={{ margin: 0 }}>Owners and managers work at every outlet. Tick the staff who work at this one: they bill here, post stock here, and see only this outlet’s bills, stock and reports. Staff who aren’t ticked at any outlet work at all of them.</p>
        {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
        {people.map((p) => {
          const fixed = p.role === 'owner' || p.role === 'manager';
          return (
            <label key={p.id} className="ui-check" style={{ opacity: fixed ? 0.75 : 1 }}>
              <input type="checkbox" disabled={fixed || !d.can.staff} checked={fixed || chosen.has(p.id)}
                onChange={(e) => setChosen((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />
              {p.name} <span className="ui-muted">· {ROLE_LABEL[p.role] ?? p.role}{fixed ? ', every outlet' : !chosen.has(p.id) && !p.elsewhere ? ', every outlet (not assigned anywhere)' : !chosen.has(p.id) ? ', other outlets only' : ''}</span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function OutletPage() {
  const { id } = useParams<{ id: string }>();
  const created = useSearchParams().get('created') === '1';
  const [d, setD] = useState<OutletDetail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => api<OutletDetail>(`/outlets/${id}`).then((r) => setD(r.data)).catch((e) => setError(errorText(e)));
  useEffect(() => { load(); }, [id]);

  const setActive = async (active: boolean) => {
    if (!active && !window.confirm(`Close ${d!.outlet.name}? Its counter stops billing. Its bills, stock and stock rooms stay, and you can reopen it later.`)) return;
    setBusy(true); setError('');
    try { const { data } = await api<OutletDetail>(`/outlets/${id}`, { method: 'PATCH', body: { active } }); setD(data); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  if (!d) return <div className="ui-content">{error ? <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div> : <div className="ui-skeleton" style={{ height: 240 }} />}</div>;
  const o = d.outlet;
  const initial: OutletValues = {
    name: o.name, address: o.address ?? '', city: o.city ?? '', stateCode: o.stateCode ?? '', postalCode: o.postalCode ?? '', phone: o.phone ?? '',
    gstin: o.gstin ?? '', invoicePrefix: o.invoicePrefix, creditNotePrefix: o.creditNotePrefix, backRoom: false,
  };

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div>
          <Link className="ui-caption" href="/account">Account /</Link>
          <h1 className="ui-h1">{o.name} {o.isMain && <span className="ui-badge">Main</span>} {!o.active && <span className="ui-badge ui-badge--danger">Closed</span>}</h1>
          <div className="ui-caption">{[d.seller.address, d.seller.city, d.seller.stateName, d.seller.postalCode].filter(Boolean).join(', ') || 'No address yet'}</div>
        </div>
        {d.can.manage && !o.isMain && (
          <div className="ui-actions">
            <button className="ui-btn ui-btn--ghost" type="button" disabled={busy} onClick={() => setActive(!o.active)}>{o.active ? 'Close outlet' : 'Reopen outlet'}</button>
            <button className="ui-btn" type="button" onClick={() => setEditing(true)}>Edit</button>
          </div>
        )}
        {d.can.manage && o.isMain && <div className="ui-actions"><Link className="ui-btn" href="/settings">Edit in Settings</Link></div>}
      </div>
      {created && <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body">{o.name} is ready. Its counter sells from {d.stockRooms[0]?.name ?? 'its shop floor'}; move stock there with a transfer or a goods receipt.</div></div>}
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      {o.active && !d.ready && (
        <div className="ui-alert ui-alert--warning" role="alert"><div className="ui-alert-body">
          <strong>Bills can’t be made here yet.</strong>
          <ul style={{ margin: 'var(--space-1) 0 0', paddingLeft: '1.2em' }}>{d.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div></div>
      )}

      <div className="gp-kpis">
        <Tile label="Sales today" value={money(d.today.sales)} sub={`${d.today.bills} bill${d.today.bills === 1 ? '' : 's'}`} />
        <Tile label="Returns today" value={money(d.today.returns)} />
        <Tile label="This month" value={money(d.thisMonth.sales)} sub={`${d.thisMonth.bills} bill${d.thisMonth.bills === 1 ? '' : 's'}`} />
        <Tile label="Open since" value={fmtDate(o.createdAt)} />
      </div>

      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', alignItems: 'start' }}>
        <section className="ui-panel" aria-labelledby="details-title">
          <div className="ui-panel-head"><h2 className="ui-h3" id="details-title" style={{ margin: 0 }}>Details on its bills</h2></div>
          <div className="ui-panel-body">
            <Row label="Business">{d.seller.legalName || <span className="ui-muted">Set in Settings</span>}</Row>
            <Row label="GSTIN">{d.seller.gstin ? <span className="ui-code">{d.seller.gstin}</span> : <span className="ui-muted">{d.scheme === 'unregistered' ? 'Not registered for GST' : 'Missing'}</span>}{!o.isMain && !o.gstin && d.seller.gstin && <span className="ui-muted"> (the store’s)</span>}</Row>
            <Row label="Phone">{d.seller.phone || <span className="ui-muted">—</span>}</Row>
            <Row label="Next invoice"><span className="ui-code ui-nowrap">{d.nextNumbers.invoice}</span></Row>
            <Row label="Next credit note"><span className="ui-code ui-nowrap">{d.nextNumbers.creditNote}</span></Row>
            {o.isMain && <p className="ui-help" style={{ margin: 'var(--space-2) 0 0' }}>The main outlet’s address and GSTIN are your store’s, in Settings. Its bill prefixes are in Billing &amp; GST.</p>}
          </div>
        </section>

        <section className="ui-panel" aria-labelledby="rooms-title">
          <div className="ui-panel-head" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <h2 className="ui-h3" id="rooms-title" style={{ flex: 1, margin: 0 }}>Stock rooms</h2>
            <Link className="ui-btn ui-btn--sm" href="/stock/locations">Manage</Link>
          </div>
          <div className="ui-table-wrap"><table className="ui-table">
            <thead><tr><th scope="col">Room</th><th scope="col" className="ui-num">Items</th><th scope="col" className="ui-qty">On hand</th></tr></thead>
            <tbody>{d.stockRooms.map((r) => (
              <tr key={r.id}>
                <td><span className="ui-cell-title">{r.name}</span> {r.id === o.posLocationId && <span className="ui-badge ui-badge--info">Counter sells from here</span>} {!r.active && <span className="ui-badge">Inactive</span>}
                  <div className="ui-cell-sub">{ROOM_LABEL[r.type] ?? r.type}{r.isSellable ? '' : ', not for sale'}</div></td>
                <td className="ui-num">{r.items}</td><td className="ui-qty">{r.onHand}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      </div>

      {d.staff && <Staff key={JSON.stringify(d.staff)} d={d} onSaved={setD} />}

      {editing && (
        <div className="ui-backdrop" role="presentation" onClick={() => setEditing(false)}>
          <div className="ui-dialog" role="dialog" aria-modal aria-labelledby="edit-title" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760 }}>
            <div className="ui-dialog-head"><h2 className="ui-h3" id="edit-title">Edit {o.name}</h2></div>
            <div className="ui-dialog-body">
              <OutletForm initial={initial} states={d.states} mainState={d.mainStateCode} isNew={false} submitLabel="Save"
                onCancel={() => setEditing(false)}
                onSubmit={async (v) => {
                  const { data } = await api<OutletDetail>(`/outlets/${id}`, { method: 'PATCH', body: toBody(v, false) });
                  setD(data); setEditing(false);
                }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense><OutletPage /></Suspense>;
}
