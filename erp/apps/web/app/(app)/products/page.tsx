'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { api, errorText, type ProductSummary, type Ref } from '../../../lib/catalog-api';
import { priceRange } from '../../../lib/format';

const TABS = [
  { status: 'active', label: 'Active' },
  { status: 'draft', label: 'Drafts' },
  { status: 'archived', label: 'Archived' },
] as const;

const PUBLISH: Record<string, [string, string]> = {
  not_published: ['', 'Not published'], queued: ['warning', 'Queued'], synced: ['success', 'Synced'],
  failed: ['danger', 'Sync failed'], needs_review: ['warning', 'Needs review'],
};

function ProductsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const status = params.get('status') ?? 'active';
  const categoryId = params.get('categoryId') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [items, setItems] = useState<ProductSummary[] | null>(null);
  const [cursors, setCursors] = useState<string[]>([]); // stack of cursors for Previous
  const [next, setNext] = useState<string | null>(null);
  const [categories, setCategories] = useState<Ref[]>([]);
  const [error, setError] = useState('');
  const search = useRef<HTMLInputElement>(null);

  const load = async (cursor?: string) => {
    setError('');
    const qs = new URLSearchParams({ status, limit: '25' });
    if (params.get('q')) qs.set('q', params.get('q')!);
    if (categoryId) qs.set('categoryId', categoryId);
    if (cursor) qs.set('cursor', cursor);
    try {
      const { data } = await api<{ items: ProductSummary[]; nextCursor: string | null }>(`/products?${qs}`);
      setItems(data.items);
      setNext(data.nextCursor);
    } catch (e) { setError(errorText(e)); setItems([]); }
  };

  useEffect(() => { setCursors([]); load(); }, [params]);
  useEffect(() => { api<{ items: Ref[] }>('/categories').then((r) => setCategories(r.data.items)).catch(() => {}); }, []);

  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    router.replace(`/products?${p}`);
  };

  // A scanner types the code and presses Enter: an exact barcode/SKU hit opens the product directly.
  const onSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term && /^\S+$/.test(term)) {
      try {
        const { data } = await api<{ productId: string }>(`/lookup?code=${encodeURIComponent(term)}`);
        router.push(`/products/${data.productId}`);
        return;
      } catch { /* not an exact code: fall through to a name search */ }
    }
    setParam('q', term);
  };

  const catName = (c: Ref) => { const p = categories.find((x) => x.id === c.parentId); return p ? `${p.name} › ${c.name}` : c.name; };

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <h1 className="ui-h1">Products</h1>
        <div className="ui-actions">
          <Link className="ui-btn" href="/products/categories">Categories &amp; brands</Link>
          <Link className="ui-btn" href="/products/import">Import</Link>
          <a className="ui-btn" href="/api/v1/exports/products.csv">Export</a>
          <Link className="ui-btn ui-btn--primary" href="/products/new">Add product</Link>
        </div>
      </div>

      <div className="ui-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.status} className="ui-tab" role="tab" type="button" aria-selected={status === t.status} onClick={() => setParam('status', t.status)}>{t.label}</button>
        ))}
      </div>

      <div className="ui-panel">
        <form className="ui-toolbar" onSubmit={onSearch} role="search">
          <input ref={search} className="ui-input ui-search" placeholder="Search name, SKU or scan barcode" aria-label="Search products"
            value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <select className="ui-select" aria-label="Category" value={categoryId} onChange={(e) => setParam('categoryId', e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{catName(c)}</option>)}
          </select>
          {params.get('q') && <button className="ui-chip" type="button" aria-pressed="true" onClick={() => { setQ(''); setParam('q', ''); }}>“{params.get('q')}” ✕</button>}
        </form>

        {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

        {items === null ? (
          <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 160 }} /></div>
        ) : items.length === 0 ? (
          <div className="ui-empty">
            <p className="ui-h3">{params.get('q') ? 'No products match' : status === 'active' ? 'No products yet' : `No ${status} products`}</p>
            {status === 'active' && !params.get('q') && <p className="ui-muted">Add your first product, or import a CSV from your old system.</p>}
          </div>
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table" data-collapse>
              <thead><tr>
                <th scope="col">Product</th><th scope="col">SKU</th><th scope="col">Category</th>
                <th scope="col" className="ui-money">Price</th><th scope="col">Website</th>
              </tr></thead>
              <tbody>
                {items.map((p) => {
                  const [tone, label] = PUBLISH[p.publishState] ?? ['', p.publishState];
                  return (
                    <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/products/${p.id}`)}>
                      <td data-primary>
                        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
                          {p.thumbnailUrl ? <img className="ui-thumb" src={p.thumbnailUrl} alt="" loading="lazy" /> : <span className="ui-thumb" />}
                          <div>
                            <Link className="ui-cell-title" href={`/products/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.name}</Link>
                            <div className="ui-cell-sub">{p.variantCount === 1 ? '1 variant' : `${p.variantCount} variants`}</div>
                          </div>
                        </div>
                      </td>
                      <td className="ui-code" data-label="SKU">{p.skus.join(', ')}{p.variantCount > p.skus.length ? '…' : ''}</td>
                      <td data-label="Category">{p.category ?? <span className="ui-muted">—</span>}</td>
                      <td className="ui-money" data-label="Price">{priceRange(p.priceRange)}</td>
                      <td data-label="Website"><span className={`ui-badge${tone ? ` ui-badge--${tone}` : ''}`}>{label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="ui-pager">
          <span>{items?.length ? `${items.length} shown` : ''}</span>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!cursors.length}
              onClick={() => { const prev = cursors.slice(0, -1); setCursors(prev); load(prev.at(-1)); }}>Previous</button>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!next}
              onClick={() => { setCursors([...cursors, next!]); load(next!); }}>Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense><ProductsPage /></Suspense>;
}
