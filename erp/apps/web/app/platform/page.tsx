'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { papi, perr, type StoreRow } from '@/lib/platform-api';

const TONE: Record<string, string> = { trial: 'info', active: 'success', past_due: 'warning', suspended: 'danger', closed: '' };
const LABEL: Record<string, string> = { trial: 'Trial', active: 'Active', past_due: 'Payment due', suspended: 'Read-only', closed: 'Closed' };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export default function Stores() {
  const [items, setItems] = useState<StoreRow[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  useEffect(() => { papi<{ items: StoreRow[] }>('/tenants').then((r) => setItems(r.items)).catch((e) => setError(perr(e))); }, []);
  const shown = useMemo(() => (items ?? []).filter((s) => (!state || s.state === state)
    && (!q || `${s.name} ${s.storeCode} ${s.ownerEmail ?? ''}`.toLowerCase().includes(q.toLowerCase()))), [items, q, state]);
  const count = (st: string) => items?.filter((s) => s.state === st).length ?? 0;
  return (
    <>
      <div className="ui-page-header"><h1 className="ui-h1">Stores</h1></div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      <div className="ui-toolbar" style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="ui-field" style={{ flex: 1, minWidth: 200 }}><span className="ui-label">Search name, store code or owner e-mail</span>
          <input className="ui-input" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <label className="ui-field"><span className="ui-label">State</span>
          <select className="ui-select" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All ({items?.length ?? 0})</option>
            {Object.keys(LABEL).map((s) => <option key={s} value={s}>{LABEL[s]} ({count(s)})</option>)}
          </select></label>
      </div>
      <div className="ui-panel">
        {!items ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 200 }} /></div> : (
          <div className="ui-table-wrap"><table className="ui-table">
            <thead><tr><th scope="col">Store</th><th scope="col">Code</th><th scope="col">State</th><th scope="col">Plan</th><th scope="col">Trial ends / paid until</th><th scope="col">Owner</th><th scope="col" className="ui-num">Users</th><th scope="col">Last used</th><th scope="col">Signed up</th></tr></thead>
            <tbody>{shown.map((s) => (
              <tr key={s.id}>
                <td><Link href={`/platform/stores/${s.id}`}>{s.name}</Link></td>
                <td className="ui-code">{s.storeCode}</td>
                <td><span className={`ui-badge ui-badge--${TONE[s.state]}`}>{LABEL[s.state]}</span></td>
                <td>{s.planName}</td>
                <td>{day(s.state === 'trial' ? s.trialEndsAt : s.paidUntil)}</td>
                <td>{s.ownerEmail}</td>
                <td className="ui-num">{s.users}</td>
                <td>{day(s.lastSeenAt)}</td>
                <td>{day(s.createdAt)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
