'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { papi, perr } from '@/lib/platform-api';
import { fmtDateTime } from '@/lib/datetime';

interface Row { id: number; adminEmail: string | null; action: string; tenantId: string | null; detail: Record<string, unknown>; ip: string | null; at: string }

export default function ConsoleLog() {
  const [items, setItems] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { papi<{ items: Row[] }>('/audit').then((r) => setItems(r.items)).catch((e) => setError(perr(e))); }, []);
  return (
    <>
      <div className="ui-page-header"><h1 className="ui-h1">Console log</h1></div>
      <p className="ui-muted">Every sign-in, payment, state change and support look, newest first. Nobody can edit or delete it from the app.</p>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      <div className="ui-panel"><div className="ui-table-wrap"><table className="ui-table">
        <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Store</th><th scope="col">Details</th><th scope="col">Address</th></tr></thead>
        <tbody>{(items ?? []).map((r) => (
          <tr key={r.id}>
            <td>{fmtDateTime(r.at)}</td>
            <td>{r.adminEmail}</td><td>{r.action.replace('platform.', '').replace(/_/g, ' ')}</td>
            <td>{r.tenantId ? <Link href={`/platform/stores/${r.tenantId}`}>open</Link> : ''}</td>
            <td className="ui-code" style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{Object.keys(r.detail).length ? JSON.stringify(r.detail) : ''}</td>
            <td>{r.ip}</td>
          </tr>
        ))}</tbody>
      </table></div></div>
    </>
  );
}
