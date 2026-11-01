'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorText, type Ref } from '../../../../lib/catalog-api';

function RefList({ kind }: { kind: 'categories' | 'brands' }) {
  const [items, setItems] = useState<Ref[]>([]);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState('');

  const load = () => api<{ items: Ref[] }>(`/${kind}?includeArchived=true`).then((r) => setItems(r.data.items)).catch((e) => setError(errorText(e)));
  useEffect(() => { load(); }, []);

  const run = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); await load(); } catch (e) { setError(errorText(e)); } };
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    run(async () => { await api(`/${kind}`, { method: 'POST', body: kind === 'categories' ? { name, parentId: parentId || null } : { name } }); setName(''); });
  };
  const patch = (r: Ref, body: Record<string, unknown>) => run(() => api(`/${kind}/${r.id}`, { method: 'PATCH', body: { name: r.name, ...body } }));

  const tops = items.filter((i) => !i.parentId);
  const ordered = kind === 'categories' ? tops.flatMap((t) => [t, ...items.filter((c) => c.parentId === t.id)]) : items;

  return (
    <div className="ui-panel">
      <div className="ui-panel-head"><span className="ui-h3">{kind === 'categories' ? 'Categories' : 'Brands'}</span></div>
      <form className="ui-toolbar" onSubmit={add}>
        <input className="ui-input" placeholder={kind === 'categories' ? 'New category' : 'New brand'} aria-label="Name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        {kind === 'categories' && (
          <select className="ui-select" aria-label="Under" value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">Top level</option>
            {tops.filter((t) => !t.archivedAt).map((t) => <option key={t.id} value={t.id}>Under {t.name}</option>)}
          </select>
        )}
        <button className="ui-btn ui-btn--primary" type="submit">Add</button>
      </form>
      {error && <div className="ui-error" role="alert" style={{ padding: '0 var(--space-4)' }}>{error}</div>}
      {ordered.map((r) => (
        <div className="ui-list-row" key={r.id} style={{ paddingLeft: r.parentId ? 'var(--space-8)' : undefined, opacity: r.archivedAt ? 0.6 : 1 }}>
          {editing?.id === r.id ? (
            <form style={{ display: 'flex', gap: 'var(--space-2)', flex: 1 }} onSubmit={(e) => { e.preventDefault(); patch(r, { name: editing.name }); setEditing(null); }}>
              <input className="ui-input" aria-label="Rename" value={editing.name} maxLength={80} autoFocus onChange={(e) => setEditing({ id: r.id, name: e.target.value })} />
              <button className="ui-btn ui-btn--sm" type="submit">Save</button>
            </form>
          ) : <span style={{ flex: 1 }}>{r.name}{r.archivedAt && <span className="ui-badge" style={{ marginLeft: 8 }}>Archived</span>}</span>}
          <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => setEditing({ id: r.id, name: r.name })}>Rename</button>
          <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => patch(r, { archived: !r.archivedAt })}>{r.archivedAt ? 'Restore' : 'Archive'}</button>
        </div>
      ))}
    </div>
  );
}

export default function CategoriesPage() {
  return (
    <div className="ui-content">
      <div className="ui-page-header"><div><Link className="ui-caption" href="/products">Products /</Link><h1 className="ui-h1">Categories &amp; brands</h1></div></div>
      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', alignItems: 'start' }}>
        <RefList kind="categories" />
        <RefList kind="brands" />
      </div>
    </div>
  );
}
