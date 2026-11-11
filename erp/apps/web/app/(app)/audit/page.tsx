'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '@/lib/api';
import { fmtDateTime } from '@/lib/datetime';

type Item = { id: string; action: string; entityType: string; actor: string | null; createdAt: string; summary: object };
type Page = { items: Item[]; nextCursor: string | null };

/** "outlet.staff_changed" → "Outlet staff changed". */
const actionText = (a: string) => { const t = a.replace(/^pos\./, 'counter.').replace(/[._]/g, ' ').replace(/\bpin\b/, 'PIN').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
/** One level of the summary as "key: value" pieces; ids and nested objects stay short. */
function Detail({ summary }: { summary: object }) {
  const label = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  // Nested values read as words, not code: [{qty: 1, sku: X}] → "qty 1, sku X; …", cut at 160 characters.
  const flat = (v: unknown): string => v === null || v === undefined || v === '' ? '—'
    : Array.isArray(v) ? v.map(flat).join('; ')
    : typeof v === 'object' ? Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null && x !== undefined && x !== '').map(([k, x]) => `${label(k)} ${flat(x)}`).join(', ')
    : String(v);
  const show = (v: unknown) => { const t = flat(v); return t.length > 160 ? `${t.slice(0, 159)}…` : t; };
  return <div className="gp-audit-detail">{Object.entries(summary).map(([k, v]) => <span key={k}>{label(k)}: {show(v)}</span>)}</div>;
}

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
                <td className="gp-audit-when">{fmtDateTime(i.createdAt)}</td><td>{i.actor ?? 'System'}</td><td title={i.action}>{actionText(i.action)}</td>
                <td>{Object.keys(i.summary).length ? <Detail summary={i.summary} /> : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor && <div><button className="btn" onClick={() => load(cursor)}>Load more</button></div>}
    </div>
  );
}
