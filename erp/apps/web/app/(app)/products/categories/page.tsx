'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorText, type Ref } from '../../../../lib/catalog-api';
import { Icon } from '@/lib/icons';

function RefList({ kind }: { kind: 'categories' | 'brands' }) {
  const [items, setItems] = useState<Ref[]>([]);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => api<{ items: Ref[] }>(`/${kind}?includeArchived=true`).then((r) => setItems(r.data.items)).catch((e) => setError(errorText(e)));
  useEffect(() => { load(); }, []);

  const run = async (fn: () => Promise<unknown>) => { setError(''); setNotice(''); try { await fn(); await load(); } catch (e) { setError(errorText(e)); } };
  // v2 (D89): delete only while nothing uses it. The API checks products (archived ones too) and sub-categories in the
  // same transaction and answers 409 with the count, which is shown as the error.
  const remove = (r: Ref) => {
    const what = kind === 'categories' ? 'category' : 'brand';
    if (!window.confirm(`Delete the ${what} “${r.name}”? This cannot be undone. It is only allowed when no product uses it.`)) return;
    run(async () => { await api(`/${kind}/${r.id}`, { method: 'DELETE' }); setNotice(`Deleted “${r.name}”.`); });
  };
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
      {error && <div className="ui-alert ui-alert--danger" role="alert" style={{ margin: 'var(--space-3) var(--space-4) 0' }}><div className="ui-alert-body">{error}</div></div>}
      {notice && <div className="ui-alert ui-alert--success" role="status" style={{ margin: 'var(--space-3) var(--space-4) 0' }}><div className="ui-alert-body">{notice}</div></div>}
      {!ordered.length && <div className="ui-panel-body ui-muted">{kind === 'categories' ? 'No categories yet.' : 'No brands yet.'}</div>}
      {ordered.map((r) => (
        <div className="ui-list-row" key={r.id} style={{ flexWrap: 'wrap', paddingLeft: r.parentId ? 'var(--space-8)' : undefined, opacity: r.archivedAt ? 0.6 : 1 }}>
          {editing?.id === r.id ? (
            <form style={{ display: 'flex', gap: 'var(--space-2)', flex: '1 1 200px' }} onSubmit={(e) => { e.preventDefault(); patch(r, { name: editing.name }); setEditing(null); }}>
              <input className="ui-input" aria-label="Rename" value={editing.name} maxLength={80} autoFocus onChange={(e) => setEditing({ id: r.id, name: e.target.value })} />
              <button className="ui-btn ui-btn--sm" type="submit">Save</button>
            </form>
          ) : <span style={{ flex: '1 1 140px', minWidth: 0, overflowWrap: 'anywhere' }}>{r.name}{r.archivedAt && <span className="ui-badge" style={{ marginLeft: 8 }}>Archived</span>}
              {kind === 'categories' && (r.noReturns || (r.parentId && items.find((t) => t.id === r.parentId)?.noReturns)) && (
                <span className="ui-badge ui-badge--warning" style={{ marginLeft: 8 }} title={r.noReturns ? 'Items in it can’t be returned' : 'Its parent category takes no returns'}>No returns</span>)}</span>}
          {kind === 'categories' && (
            <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => patch(r, { noReturns: !r.noReturns })}
              title={r.noReturns ? 'Allow returns of items in this category again' : 'Items in this category (and its sub-categories) can’t be returned, except by the owner'}>
              {r.noReturns ? 'Allow returns' : 'No returns'}</button>
          )}
          <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => setEditing({ id: r.id, name: r.name })}>Rename</button>
          <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => patch(r, { archived: !r.archivedAt })}>{r.archivedAt ? 'Restore' : 'Archive'}</button>
          <button className="ui-btn ui-btn--sm ui-btn--ghost gp-danger-ghost" type="button" onClick={() => remove(r)} aria-label={`Delete ${r.name}`}><Icon name="trash" size={15} /> Delete</button>
        </div>
      ))}
    </div>
  );
}

export default function CategoriesPage() {
  return (
    <div className="ui-content">
      <div className="ui-page-header"><div><nav className="gp-crumbs" aria-label="Breadcrumb"><Link href="/products">Products</Link><span aria-hidden="true">/</span><span>Categories &amp; brands</span></nav><h1 className="ui-h1">Categories &amp; brands</h1>
        <p className="ui-caption" style={{ margin: 0 }}>Delete works only for a category or brand no product uses. Otherwise move its products first, or archive it. “No returns” covers a category’s sub-categories too.</p></div></div>
      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', alignItems: 'start' }}>
        <RefList kind="categories" />
        <RefList kind="brands" />
      </div>
    </div>
  );
}
