'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';

type Item = { id: string; action: string; entityType: string; actor: string | null; createdAt: string; summary: object };
type Page = { items: Item[]; nextCursor: string | null };

export default function Audit() {
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback((before?: string) =>
    api<Page>(`/audit?limit=50${before ? `&before=${before}` : ''}`)
      .then((p) => { setItems((cur) => (before ? [...cur, ...p.items] : p.items)); setCursor(p.nextCursor); })
      .catch((e) => setError(errorText(e))), []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="stack">
      <h1>Audit log</h1>
      {error && <div className="alert error" role="alert">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{new Date(i.createdAt).toLocaleString()}</td><td>{i.actor ?? 'System'}</td><td>{i.action}</td>
                <td className="small muted">{Object.keys(i.summary).length ? JSON.stringify(i.summary) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor && <div><button className="btn" onClick={() => load(cursor)}>Load more</button></div>}
    </div>
  );
}
